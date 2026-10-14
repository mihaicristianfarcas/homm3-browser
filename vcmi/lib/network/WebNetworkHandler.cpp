/*
 * WebNetworkHandler.cpp, part of VCMI engine
 *
 * Authors: listed in file AUTHORS in main folder
 *
 * License: GNU General Public License v2.0 or later
 * Full text of license available in license.txt file, in main folder
 *
 */
#include "StdInc.h"
#include "WebNetworkHandler.h"

#ifdef VCMI_EMSCRIPTEN

#include "NetworkConnection.h"
#include "../CThreadHelper.h"

#include <emscripten/emscripten.h>

// Implemented in clientapp/web/library_vcmi.js. All of them run on the browser main thread,
// which owns every WebSocket. Calls from other threads are proxied asynchronously, in order.
extern "C" {
void vcmi_ws_open(int socketID, const char * host, int port);
void vcmi_ws_send(int socketID, std::byte * data, int size);
void vcmi_ws_close(int socketID);
}

VCMI_LIB_NAMESPACE_BEGIN

namespace
{

/// Outgoing connection over a WebSocket. The web server bridges it to a TCP connection,
/// so the byte stream uses the same framing as NetworkConnection: uint32 size + payload, size 0 = heartbeat.
class WebSocketConnection final : public INetworkConnection, public std::enable_shared_from_this<WebSocketConnection>
{
	static constexpr uint32_t messageMaxSize = 64 * 1024 * 1024;

	NetworkContext & context;
	INetworkClientListener & listener;
	const int socketID;

	std::vector<std::byte> readBuffer; // accessed only on network thread
	bool established = false; // accessed only on network thread
	std::atomic<bool> closed = false;

public:
	WebSocketConnection(NetworkContext & context, INetworkClientListener & listener, int socketID)
		: context(context)
		, listener(listener)
		, socketID(socketID)
	{}

	int getID() const { return socketID; }

	void sendPacket(const std::vector<std::byte> & message) override
	{
		if (closed)
			return;

		uint32_t messageSize = message.size();
		// ownership of the buffer is passed to the main thread, which frees it after sending
		auto * buffer = static_cast<std::byte *>(malloc(sizeof(messageSize) + messageSize));
		std::memcpy(buffer, &messageSize, sizeof(messageSize));
		if (messageSize)
			std::memcpy(buffer + sizeof(messageSize), message.data(), messageSize);
		vcmi_ws_send(socketID, buffer, sizeof(messageSize) + messageSize);
	}

	void setAsyncWritesEnabled(bool on) override
	{
		// sends are always asynchronous
	}

	void close() override
	{
		if (!closed.exchange(true))
			vcmi_ws_close(socketID);
	}

	// Events below are delivered on the network thread

	void onOpen()
	{
		established = true;
		listener.onConnectionEstablished(shared_from_this());
	}

	void onData(const std::vector<std::byte> & data)
	{
		if (closed)
			return;

		readBuffer.insert(readBuffer.end(), data.begin(), data.end());

		size_t offset = 0;
		while (readBuffer.size() - offset >= sizeof(uint32_t))
		{
			uint32_t messageSize;
			std::memcpy(&messageSize, readBuffer.data() + offset, sizeof(messageSize));

			if (messageSize > messageMaxSize)
			{
				onClosed("Invalid packet size!");
				close();
				return;
			}

			if (readBuffer.size() - offset - sizeof(uint32_t) < messageSize)
				break; // wait for rest of the packet

			offset += sizeof(uint32_t);
			if (messageSize != 0) // zero-sized packets are heartbeats
			{
				std::vector<std::byte> message(readBuffer.begin() + offset, readBuffer.begin() + offset + messageSize);
				offset += messageSize;
				listener.onPacketReceived(shared_from_this(), message);
				if (closed)
					return;
			}
		}
		readBuffer.erase(readBuffer.begin(), readBuffer.begin() + offset);
	}

	void onClosed(const std::string & reason)
	{
		bool wasClosed = closed.exchange(true);

		if (!established)
			listener.onConnectionFailed(reason);
		else if (!wasClosed)
			listener.onDisconnected(shared_from_this(), reason);
	}

	void post(std::function<void()> task)
	{
		boost::asio::post(context, std::move(task));
	}
};

/// All open WebSockets, so that browser events can be routed back to their connection
class WebSocketRegistry
{
	std::mutex mutex;
	std::map<int, std::shared_ptr<WebSocketConnection>> sockets;
	int nextID = 1;

public:
	static WebSocketRegistry & get()
	{
		static WebSocketRegistry instance;
		return instance;
	}

	std::shared_ptr<WebSocketConnection> create(NetworkContext & context, INetworkClientListener & listener)
	{
		std::scoped_lock lock(mutex);
		auto connection = std::make_shared<WebSocketConnection>(context, listener, nextID++);
		sockets[connection->getID()] = connection;
		return connection;
	}

	std::shared_ptr<WebSocketConnection> find(int socketID)
	{
		std::scoped_lock lock(mutex);
		auto it = sockets.find(socketID);
		return it == sockets.end() ? nullptr : it->second;
	}

	void remove(int socketID)
	{
		std::scoped_lock lock(mutex);
		sockets.erase(socketID);
	}
};

/// Server that can only accept internal connections - browsers can't listen on ports
class WebNetworkServer final : public INetworkConnectionListener, public INetworkServer
{
	NetworkContext & context;
	INetworkServerListener & listener;
	std::set<std::shared_ptr<INetworkConnection>> connections;

public:
	WebNetworkServer(INetworkServerListener & listener, NetworkContext & context)
		: context(context)
		, listener(listener)
	{}

	uint16_t start(uint16_t port) override
	{
		logNetwork->info("Browser build can't listen for TCP connections, only in-process connections are accepted");
		return port;
	}

	void receiveInternalConnection(std::shared_ptr<IInternalConnection> remoteConnection) override
	{
		auto localConnection = std::make_shared<InternalConnection>(*this, context);
		connections.insert(localConnection);
		localConnection->connectTo(remoteConnection);
		remoteConnection->connectTo(localConnection);
		listener.onNewConnection(localConnection);
	}

	void onDisconnected(const std::shared_ptr<INetworkConnection> & connection, const std::string & errorMessage) override
	{
		if (connections.erase(connection))
			listener.onDisconnected(connection, errorMessage);
	}

	void onPacketReceived(const std::shared_ptr<INetworkConnection> & connection, const std::vector<std::byte> & message) override
	{
		listener.onPacketReceived(connection, message);
	}
};

class NullServerDiscovery final : public IServerDiscovery
{
public:
	void start() override {}
	void abort() override {}
};

class NullServerDiscoveryListener final : public IServerDiscoveryListener
{
public:
	void start() override {}
	void stop() override {}
};

}

/// asio timers need a reactor, so timers are implemented with a helper thread that posts expired callbacks into the context
class WebNetworkHandler::TimerQueue
{
	using Clock = std::chrono::steady_clock;

	NetworkContext & context;
	std::mutex mutex;
	std::condition_variable condition;
	std::multimap<Clock::time_point, INetworkTimerListener *> pending;
	bool terminating = false;
	std::thread thread;

	void run()
	{
		setThreadName("networkTimers");
		std::unique_lock lock(mutex);
		while (!terminating)
		{
			if (pending.empty())
			{
				condition.wait(lock);
				continue;
			}

			auto next = pending.begin();
			if (Clock::now() < next->first)
			{
				condition.wait_until(lock, next->first);
				continue;
			}

			INetworkTimerListener * listener = next->second;
			pending.erase(next);
			boost::asio::post(context, [listener](){ listener->onTimer(); });
		}
	}

public:
	explicit TimerQueue(NetworkContext & context)
		: context(context)
		, thread([this](){ run(); })
	{}

	~TimerQueue()
	{
		{
			std::scoped_lock lock(mutex);
			terminating = true;
		}
		condition.notify_one();
		thread.join();
	}

	void add(INetworkTimerListener & listener, std::chrono::milliseconds duration)
	{
		{
			std::scoped_lock lock(mutex);
			pending.emplace(Clock::now() + duration, &listener);
		}
		condition.notify_one();
	}
};

WebNetworkHandler::WebNetworkHandler()
	: context(std::make_unique<NetworkContext>())
{}

WebNetworkHandler::~WebNetworkHandler()
{
	// stop timers before context is destroyed, so no timer can post into a dead context
	timers.reset();
}

std::unique_ptr<INetworkServer> WebNetworkHandler::createServerTCP(INetworkServerListener & listener)
{
	return std::make_unique<WebNetworkServer>(listener, *context);
}

void WebNetworkHandler::connectToRemote(INetworkClientListener & listener, const std::string & host, uint16_t port)
{
	auto connection = WebSocketRegistry::get().create(*context, listener);
	logNetwork->info("Opening WebSocket #%d to %s:%d", connection->getID(), host, port);
	// call is proxied asynchronously to the browser main thread, which frees the string
	char * hostCopy = strdup(host.c_str());
	vcmi_ws_open(connection->getID(), hostCopy, port);
}

void WebNetworkHandler::createInternalConnection(INetworkClientListener & listener, INetworkServer & server)
{
	auto localConnection = std::make_shared<InternalConnection>(listener, *context);

	server.receiveInternalConnection(localConnection);

	boost::asio::post(*context, [&listener, localConnection](){
		listener.onConnectionEstablished(localConnection);
	});
}

std::shared_ptr<INetworkConnection> WebNetworkHandler::createAsyncConnection(INetworkConnectionListener & listener)
{
	auto loopbackConnection = std::make_shared<InternalConnection>(listener, *context);
	loopbackConnection->connectTo(loopbackConnection);
	return loopbackConnection;
}

void WebNetworkHandler::createTimer(INetworkTimerListener & listener, std::chrono::milliseconds duration)
{
	if (!timers)
		timers = std::make_unique<TimerQueue>(*context);
	timers->add(listener, duration);
}

std::shared_ptr<IServerDiscovery> WebNetworkHandler::createServerDiscovery(IServerDiscoveryObserver & listener)
{
	return std::make_shared<NullServerDiscovery>();
}

std::shared_ptr<IServerDiscoveryListener> WebNetworkHandler::createServerDiscoveryListener(IServerDiscoveryAnnouncer & announcer, uint16_t port)
{
	return std::make_shared<NullServerDiscoveryListener>();
}

void WebNetworkHandler::run()
{
	boost::asio::executor_work_guard<decltype(context->get_executor())> work{context->get_executor()};
	context->run();
}

void WebNetworkHandler::stop()
{
	context->stop();
}

NetworkContext & WebNetworkHandler::getContext()
{
	return *context;
}

VCMI_LIB_NAMESPACE_END

// Called from JS on the browser main thread. Events are forwarded to the network thread of the connection owner.
extern "C" {

EMSCRIPTEN_KEEPALIVE void vcmi_ws_on_open(int socketID)
{
	auto connection = VCMI_LIB_WRAP_NAMESPACE(WebSocketRegistry)::get().find(socketID);
	if (connection)
		connection->post([connection](){ connection->onOpen(); });
}

EMSCRIPTEN_KEEPALIVE void vcmi_ws_on_data(int socketID, std::byte * data, int size)
{
	auto connection = VCMI_LIB_WRAP_NAMESPACE(WebSocketRegistry)::get().find(socketID);
	if (connection)
	{
		std::vector<std::byte> payload(data, data + size);
		connection->post([connection, payload = std::move(payload)](){ connection->onData(payload); });
	}
	free(data);
}

EMSCRIPTEN_KEEPALIVE void vcmi_ws_on_close(int socketID, const char * reason)
{
	auto & registry = VCMI_LIB_WRAP_NAMESPACE(WebSocketRegistry)::get();
	auto connection = registry.find(socketID);
	std::string reasonString = reason ? reason : "Connection closed";
	free(const_cast<char *>(reason));

	if (connection)
	{
		registry.remove(socketID);
		connection->post([connection, reasonString](){ connection->onClosed(reasonString); });
	}
}

}
#endif
