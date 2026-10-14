// Smoke test for the web server (server/server.mjs), without the built game or a browser:
// isolation headers, static files, game data access key, WebSocket bridge allow-list.
//
//   (cd server && npm ci) && node tests/server-smoke.mjs

import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WebSocket = createRequire(path.join(root, 'server', 'package.json'))('ws');

const KEY = 'smoke-test-key';

function listen(server) {
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function freePort() {
	const server = net.createServer();
	const port = await listen(server);
	await new Promise((resolve) => server.close(resolve));
	return port;
}

// a web root and a Heroes III folder with stand-in files
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'homm3-smoke-'));
const webRoot = path.join(tmp, 'web');
const gameDir = path.join(tmp, 'HoMM 3 Complete');
fs.mkdirSync(webRoot);
fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>smoke</title>');
fs.mkdirSync(path.join(gameDir, 'DATA'), { recursive: true });
fs.mkdirSync(path.join(gameDir, 'MP3'));
fs.writeFileSync(path.join(gameDir, 'DATA', 'H3bitmap.lod'), 'lod archive');
fs.writeFileSync(path.join(gameDir, 'DATA', 'VIDEO.VID'), 'cutscenes are not offered');
fs.writeFileSync(path.join(gameDir, 'MP3', 'MAINMENU.MP3'), 'music');
fs.writeFileSync(path.join(tmp, 'secret.txt'), 'outside the web root');

// TCP echo service standing in for the lobby
const echo = net.createServer((socket) => socket.pipe(socket));
const echoPort = await listen(echo);

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(root, 'server', 'server.mjs')], {
	env: {
		...process.env,
		PORT: String(port),
		HOST: '127.0.0.1',
		WEB_ROOT: webRoot,
		NET_TARGETS: `echo:7=127.0.0.1:${echoPort}`,
		LOBBY: 'echo:7',
		GAMEDATA_DIR: gameDir,
		GAMEDATA_KEY: KEY,
	},
	stdio: ['ignore', 'pipe', 'inherit'],
});
let output = '';
await new Promise((resolve, reject) => {
	server.stdout.on('data', (chunk) => {
		output += chunk;
		if (output.includes('Serving'))
			resolve();
	});
	server.on('exit', (code) => reject(new Error(`server exited with ${code}:\n${output}`)));
});

const tests = {
	async 'serves files with cross-origin isolation headers'() {
		const response = await fetch(`${base}/`);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
		assert.equal(response.headers.get('cross-origin-embedder-policy'), 'require-corp');
		assert.match(await response.text(), /smoke/);
	},

	async 'does not serve files outside the web root'() {
		for (const url of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt']) {
			const response = await fetch(`${base}${url}`);
			assert.equal(response.status, 404, url);
		}
	},

	async 'tells the launcher about the lobby and the game data'() {
		const config = await (await fetch(`${base}/config.json`)).json();
		assert.equal(config.lobbyHostname, 'echo');
		assert.equal(config.lobbyPort, 7);
		assert.equal(config.gameData.keyRequired, true);
	},

	async 'requires the key for game data'() {
		assert.equal((await fetch(`${base}/gamedata/manifest.json`)).status, 403);
		assert.equal((await fetch(`${base}/gamedata/manifest.json`, { headers: { 'X-Game-Key': 'wrong' } })).status, 403);
		assert.equal((await fetch(`${base}/gamedata/Data/H3bitmap.lod`)).status, 403);
	},

	async 'offers game data without videos, with normalized folder names'() {
		const manifest = await (await fetch(`${base}/gamedata/manifest.json`, { headers: { 'X-Game-Key': KEY } })).json();
		assert.deepEqual(manifest.files.map((f) => f.path).sort(), ['Data/H3bitmap.lod', 'Mp3/MAINMENU.MP3']);
		const file = await fetch(`${base}/gamedata/Data/H3bitmap.lod?key=${KEY}`);
		assert.equal(file.status, 200);
		assert.equal(await file.text(), 'lod archive');
	},

	async 'bridges WebSockets to allowed TCP services'() {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/net/echo/7`);
		const reply = await new Promise((resolve, reject) => {
			ws.on('open', () => ws.send(Buffer.from('hello lobby')));
			ws.on('message', (data) => resolve(data.toString()));
			ws.on('error', reject);
		});
		ws.close();
		assert.equal(reply, 'hello lobby');
	},

	async 'refuses WebSockets to other destinations'() {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/net/localhost/22`);
		const result = await new Promise((resolve) => {
			ws.on('open', () => resolve('open'));
			ws.on('error', () => resolve('refused'));
		});
		assert.equal(result, 'refused');
	},
};

let failed = 0;
for (const [name, test] of Object.entries(tests)) {
	try {
		await test();
		console.log(`ok - ${name}`);
	} catch (error) {
		failed++;
		console.log(`not ok - ${name}\n  ${error.message.replaceAll('\n', '\n  ')}`);
	}
}

server.kill();
echo.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
