/*
 * WebNetworkHandler.h, part of VCMI engine
 *
 * Authors: listed in file AUTHORS in main folder
 *
 * License: GNU General Public License v2.0 or later
 * Full text of license available in license.txt file, in main folder
 *
 */
#pragma once

#include "NetworkInterface.h"

#ifdef VCMI_EMSCRIPTEN

VCMI_LIB_NAMESPACE_BEGIN

/// Network handler for browser builds.
/// Browsers can neither listen on TCP ports nor open raw TCP connections, so:
/// - outgoing connections are WebSockets, owned by the browser main thread and bridged to TCP by the web server
/// - incoming connections are only possible as in-process (internal) connections
/// - LAN discovery is unavailable
/// The asio io_context is only used as a task queue: no asio I/O objects are ever created,
/// so the context never needs a reactor (which can't block properly inside a browser).
class WebNetworkHandler final : public INetworkHandler
{
	class TimerQueue;

	std::unique_ptr<NetworkContext> context;
	std::unique_ptr<TimerQueue> timers;

public:
	WebNetworkHandler();
	~WebNetworkHandler();

	std::unique_ptr<INetworkServer> createServerTCP(INetworkServerListener & listener) override;
	void connectToRemote(INetworkClientListener & listener, const std::string & host, uint16_t port) override;
	void createInternalConnection(INetworkClientListener & listener, INetworkServer & server) override;
	std::shared_ptr<INetworkConnection> createAsyncConnection(INetworkConnectionListener & listener) override;
	void createTimer(INetworkTimerListener & listener, std::chrono::milliseconds duration) override;
	std::shared_ptr<IServerDiscovery> createServerDiscovery(IServerDiscoveryObserver & listener) override;
	std::shared_ptr<IServerDiscoveryListener> createServerDiscoveryListener(IServerDiscoveryAnnouncer & announcer, uint16_t port = 3030) override;

	void run() override;
	void stop() override;

	NetworkContext & getContext() override;
};

VCMI_LIB_NAMESPACE_END

#endif
