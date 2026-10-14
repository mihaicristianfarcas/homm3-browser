/*
 * library_vcmi.js, part of VCMI engine
 *
 * Browser-side helpers for the Emscripten build of VCMI, linked with --js-library.
 *
 * License: GNU General Public License v2.0 or later
 * Full text of license available in license.txt file, in main folder
 */

addToLibrary({
	// ---------------------------------------------------------------------------------------
	// WebSockets (see lib/network/WebNetworkHandler.cpp)
	//
	// Every socket lives on the browser main thread: it is the only thread that is guaranteed to
	// return to its event loop regularly. Calls from game threads are proxied asynchronously, which
	// keeps them in order. VCMI's TCP framing is kept as-is, the web server bridges the stream to TCP.
	// ---------------------------------------------------------------------------------------
	$VCMISockets: {
		sockets: {},
		heartbeatInterval: 10000,

		url(host, port) {
			if (Module['vcmiNetworkUrl'])
				return Module['vcmiNetworkUrl'](host, port);
			const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
			return `${proto}//${location.host}/net/${encodeURIComponent(host)}/${port}`;
		},

		closed(id, reason) {
			const entry = VCMISockets.sockets[id];
			if (!entry)
				return;
			clearInterval(entry.heartbeat);
			delete VCMISockets.sockets[id];
			_vcmi_ws_on_close(id, stringToNewUTF8(reason));
		},
	},

	vcmi_ws_open__proxy: 'async',
	vcmi_ws_open__deps: ['$VCMISockets', 'malloc', 'free', 'vcmi_ws_on_open', 'vcmi_ws_on_data', 'vcmi_ws_on_close', '$stringToNewUTF8'],
	vcmi_ws_open: (id, hostPtr, port) => {
		const host = UTF8ToString(hostPtr);
		_free(hostPtr);

		let socket;
		try {
			socket = new WebSocket(VCMISockets.url(host, port));
		} catch (e) {
			_vcmi_ws_on_close(id, stringToNewUTF8(`Failed to connect to ${host}:${port}: ${e.message}`));
			return;
		}
		socket.binaryType = 'arraybuffer';

		const entry = { socket, pending: [], heartbeat: 0 };
		VCMISockets.sockets[id] = entry;

		socket.onopen = () => {
			for (const data of entry.pending)
				socket.send(data);
			entry.pending = [];
			// same keep-alive as native connections, also keeps proxies from closing idle sockets
			entry.heartbeat = setInterval(() => socket.send(new Uint8Array(4)), VCMISockets.heartbeatInterval);
			_vcmi_ws_on_open(id);
		};
		socket.onmessage = (event) => {
			const bytes = new Uint8Array(event.data);
			const ptr = _malloc(bytes.length);
			HEAPU8.set(bytes, ptr);
			_vcmi_ws_on_data(id, ptr, bytes.length);
		};
		socket.onclose = (event) => {
			const reason = event.reason || (event.wasClean ? 'Connection closed' : `Unable to reach ${host}:${port}`);
			VCMISockets.closed(id, reason);
		};
	},

	vcmi_ws_send__proxy: 'async',
	vcmi_ws_send__deps: ['$VCMISockets', 'free'],
	vcmi_ws_send: (id, ptr, size) => {
		const data = HEAPU8.slice(ptr, ptr + size);
		_free(ptr);

		const entry = VCMISockets.sockets[id];
		if (!entry)
			return;
		if (entry.socket.readyState === WebSocket.CONNECTING)
			entry.pending.push(data);
		else if (entry.socket.readyState === WebSocket.OPEN)
			entry.socket.send(data);
	},

	vcmi_ws_close__proxy: 'async',
	vcmi_ws_close__deps: ['$VCMISockets'],
	vcmi_ws_close: (id) => {
		const entry = VCMISockets.sockets[id];
		if (!entry)
			return;
		entry.socket.onclose = null;
		entry.socket.close();
		VCMISockets.closed(id, 'Connection closed');
	},

	// ---------------------------------------------------------------------------------------
	// Notifications for the web page hosting the game (see clientapp/WebPlatform.cpp)
	// ---------------------------------------------------------------------------------------
	vcmi_web_notify__proxy: 'async',
	vcmi_web_notify__deps: ['free'],
	vcmi_web_notify: (eventPtr, detailPtr) => {
		const event = UTF8ToString(eventPtr);
		const detail = detailPtr ? UTF8ToString(detailPtr) : '';
		_free(eventPtr);
		if (detailPtr)
			_free(detailPtr);
		if (Module['onVcmiEvent'])
			Module['onVcmiEvent'](event, detail);
	},
});
