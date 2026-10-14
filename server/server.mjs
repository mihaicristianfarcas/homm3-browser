// Web server for the browser build of VCMI.
//
// - Serves the game with the cross-origin isolation headers that WebAssembly threads require
// - Serves precompressed (.br / .gz) files when the browser accepts them
// - Bridges WebSockets at /net/<host>/<port> to TCP, so the game can reach the VCMI lobby server.
//   Only targets listed in the configuration can be reached - this is not an open proxy.
// - Optionally offers Heroes III game files for download at /gamedata/, so players don't need their
//   own installation. Protected by an access key that is part of the link shared with players.
//
// Configuration (environment variables):
//   PORT          HTTP port to listen on                       (default 8642)
//   HOST          address to listen on                         (default 0.0.0.0)
//   WEB_ROOT      folder with the built web app                 (default ../dist)
//   NET_TARGETS   comma separated "name:port=host:port" routes  (default "lobby:3031=127.0.0.1:3031")
//   LOBBY         lobby the game connects to, as "name:port"     (default "lobby:3031")
//   GAMEDATA_DIR  folder with Heroes III files (Data, Maps, Mp3) offered for download (default: none)
//   GAMEDATA_KEY  key required to download them, given to players as ?key= in the link (default: none)

import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8642);
const HOST = process.env.HOST ?? '0.0.0.0';
const WEB_ROOT = path.resolve(here, process.env.WEB_ROOT ?? '../dist');
const NET_TARGETS = parseTargets(process.env.NET_TARGETS ?? 'lobby:3031=127.0.0.1:3031');
const [LOBBY_HOSTNAME, LOBBY_PORT] = (process.env.LOBBY ?? 'lobby:3031').split(':');

// Same selection as the launcher's folder import: everything the game needs, no cutscene videos
const GAMEDATA_RULES = { Data: /\.(lod|snd|pac)$/i, Maps: /\.(h3m|h3c|tut)$/i, Mp3: /\.mp3$/i };

const GAMEDATA_DIR = process.env.GAMEDATA_DIR ? path.resolve(process.env.GAMEDATA_DIR) : null;
const GAMEDATA_KEY = process.env.GAMEDATA_KEY ?? '';
const gameData = GAMEDATA_DIR ? await scanGameData(GAMEDATA_DIR) : null;

// Settings for the game, read by the launcher page
const GAME_CONFIG = JSON.stringify({
	lobbyHostname: LOBBY_HOSTNAME,
	lobbyPort: Number(LOBBY_PORT),
	gameData: gameData && { manifest: 'gamedata/manifest.json', totalSize: gameData.manifest.totalSize, keyRequired: Boolean(GAMEDATA_KEY) },
});

const MIME_TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.webmanifest': 'application/manifest+json',
	'.wasm': 'application/wasm',
	'.data': 'application/octet-stream',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
};

// Big, rarely changing files are revalidated with ETags; HTML and JS are always revalidated too,
// so a redeploy is picked up on the next page load.
const SECURITY_HEADERS = {
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Embedder-Policy': 'require-corp',
	'Cross-Origin-Resource-Policy': 'same-origin',
	'X-Content-Type-Options': 'nosniff',
	'Cache-Control': 'no-cache',
};

function parseTargets(spec) {
	const targets = new Map();
	for (const route of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
		const [from, to] = route.split('=');
		const [toHost, toPort] = to.split(/:(?=\d+$)/);
		targets.set(from.toLowerCase(), { host: toHost, port: Number(toPort) });
	}
	return targets;
}

function log(...args) {
	console.log(new Date().toISOString(), ...args);
}

// ------------------------------------------------------------------------------------------
// Game data downloads
// ------------------------------------------------------------------------------------------

function hashFile(file) {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash('sha256');
		fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
	});
}

async function scanGameData(root) {
	const files = [];
	const sources = new Map();
	for (const [dir, accept] of Object.entries(GAMEDATA_RULES)) {
		// installations differ in folder name case (MP3, Mp3)
		const folder = fs.readdirSync(root).find((name) => name.toLowerCase() === dir.toLowerCase());
		if (!folder)
			continue;
		for (const name of fs.readdirSync(path.join(root, folder)).sort()) {
			const source = path.join(root, folder, name);
			const stat = fs.statSync(source);
			if (!stat.isFile() || !accept.test(name))
				continue;
			const entry = { path: `${dir}/${name}`, size: stat.size, sha256: await hashFile(source) };
			files.push(entry);
			sources.set(entry.path, { source, size: stat.size });
		}
	}
	const version = crypto.createHash('sha256').update(files.map((f) => `${f.path}:${f.sha256}`).join('\n')).digest('hex').slice(0, 16);
	const totalSize = files.reduce((sum, f) => sum + f.size, 0);
	log(`Offering ${files.length} game data files (${Math.round(totalSize / 1e6)} MB) from ${root}, version ${version}`);
	return { manifest: { version, totalSize, files }, sources };
}

function keyMatches(given) {
	if (!GAMEDATA_KEY)
		return true;
	const a = Buffer.from(String(given ?? ''));
	const b = Buffer.from(GAMEDATA_KEY);
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function serveGameData(request, response, url) {
	const headers = { ...SECURITY_HEADERS, 'Cache-Control': 'no-store' }; // kept in browser storage, not the HTTP cache

	if (!gameData || !keyMatches(url.searchParams.get('key') ?? request.headers['x-game-key'])) {
		log(`[gamedata] refused ${url.pathname} for ${request.headers['x-forwarded-for'] ?? request.socket.remoteAddress}`);
		response.writeHead(gameData ? 403 : 404, { ...headers, 'Content-Type': 'text/plain' });
		response.end(gameData ? 'Invalid or missing game data key' : 'No game data on this server');
		return;
	}

	const relative = decodeURIComponent(url.pathname.slice('/gamedata/'.length));
	if (relative === 'manifest.json') {
		log(`[gamedata] manifest for ${request.headers['x-forwarded-for'] ?? request.socket.remoteAddress}`);
		response.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
		response.end(JSON.stringify(gameData.manifest));
		return;
	}

	const file = gameData.sources.get(relative);
	if (!file) {
		response.writeHead(404, { ...headers, 'Content-Type': 'text/plain' });
		response.end('Not found');
		return;
	}
	response.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': file.size });
	if (request.method === 'HEAD')
		response.end();
	else
		fs.createReadStream(file.source).pipe(response);
}

// ------------------------------------------------------------------------------------------
// Static files
// ------------------------------------------------------------------------------------------

function resolveFile(urlPath) {
	let decoded;
	try {
		decoded = decodeURIComponent(urlPath);
	} catch {
		return null;
	}
	const filePath = path.resolve(WEB_ROOT, '.' + path.posix.normalize(decoded));
	if (!filePath.startsWith(WEB_ROOT))
		return null;
	try {
		const stat = fs.statSync(filePath);
		if (stat.isDirectory())
			return resolveFile(path.posix.join(urlPath, 'index.html'));
		return { filePath, stat };
	} catch {
		return null;
	}
}

function pickEncoding(request, filePath) {
	const accepted = request.headers['accept-encoding'] ?? '';
	for (const [token, extension] of [['br', '.br'], ['gzip', '.gz']]) {
		if (!accepted.includes(token))
			continue;
		try {
			const stat = fs.statSync(filePath + extension);
			return { encoding: token, filePath: filePath + extension, stat };
		} catch {
			// no precompressed variant
		}
	}
	return null;
}

function serveStatic(request, response) {
	const url = new URL(request.url, 'http://localhost');

	if (url.pathname.startsWith('/gamedata/')) {
		serveGameData(request, response, url);
		return;
	}

	if (url.pathname === '/config.json') {
		response.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
		response.end(GAME_CONFIG);
		return;
	}
	const found = resolveFile(url.pathname);

	if (!found || (request.method !== 'GET' && request.method !== 'HEAD')) {
		response.writeHead(found ? 405 : 404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
		response.end(found ? 'Method not allowed' : 'Not found');
		return;
	}

	const extension = path.extname(found.filePath);
	const variant = pickEncoding(request, found.filePath);
	const served = variant ?? found;
	const etag = `"${served.stat.size.toString(16)}-${Math.floor(served.stat.mtimeMs).toString(16)}${variant ? '-' + variant.encoding : ''}"`;

	const headers = {
		...SECURITY_HEADERS,
		'Content-Type': MIME_TYPES[extension] ?? 'application/octet-stream',
		'ETag': etag,
		'Vary': 'Accept-Encoding',
	};
	if (variant)
		headers['Content-Encoding'] = variant.encoding;

	if (request.headers['if-none-match'] === etag) {
		response.writeHead(304, headers);
		response.end();
		return;
	}

	headers['Content-Length'] = served.stat.size;
	response.writeHead(200, headers);
	if (request.method === 'HEAD') {
		response.end();
		return;
	}
	fs.createReadStream(served.filePath).pipe(response);
}

// ------------------------------------------------------------------------------------------
// WebSocket to TCP bridge
// ------------------------------------------------------------------------------------------

const MAX_BUFFERED = 8 * 1024 * 1024;

function bridge(ws, target, label) {
	const socket = net.connect(target.port, target.host);
	socket.setNoDelay(true);
	let open = false;

	socket.on('connect', () => {
		open = true;
		log(`[net] ${label} connected`);
	});
	socket.on('data', (chunk) => {
		ws.send(chunk, { binary: true });
		if (ws.bufferedAmount > MAX_BUFFERED)
			socket.pause();
	});
	socket.on('drain', () => ws._socket?.resume());
	socket.on('error', (error) => log(`[net] ${label} TCP error: ${error.message}`));
	socket.on('close', () => {
		log(`[net] ${label} closed by server`);
		ws.close(1000, open ? 'Connection closed by server' : 'Server is not reachable');
	});

	ws.on('message', (data) => {
		if (!socket.write(data))
			ws._socket?.pause();
	});
	ws.on('close', () => socket.end());
	ws.on('error', () => socket.destroy());

	// resume TCP reads once the browser caught up
	const drainTimer = setInterval(() => {
		if (socket.isPaused() && ws.bufferedAmount < MAX_BUFFERED / 2)
			socket.resume();
	}, 50);
	socket.on('close', () => clearInterval(drainTimer));
}

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });

function handleUpgrade(request, socket, head) {
	const url = new URL(request.url, 'http://localhost');
	const match = url.pathname.match(/^\/net\/([^/]+)\/(\d+)$/);
	const key = match && `${decodeURIComponent(match[1]).toLowerCase()}:${match[2]}`;
	const target = key && NET_TARGETS.get(key);

	if (!target) {
		log(`[net] rejected connection to ${key ?? url.pathname}`);
		socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
		return;
	}

	wss.handleUpgrade(request, socket, head, (ws) => {
		const client = request.headers['x-forwarded-for'] ?? request.socket.remoteAddress;
		bridge(ws, target, `${client} -> ${key}`);
	});
}

// ------------------------------------------------------------------------------------------

const server = http.createServer(serveStatic);
server.on('upgrade', handleUpgrade);
server.listen(PORT, HOST, () => {
	log(`Serving ${WEB_ROOT} on http://${HOST}:${PORT}`);
	for (const [name, target] of NET_TARGETS)
		log(`Bridging ws://…/net/${name.replace(':', '/')} to ${target.host}:${target.port}`);
});
