// Browser driver for manual-style testing of the web build.
// Launches a browser, keeps it open and exposes a small HTTP control API, so a test session can
// be driven step by step (screenshots, clicks, keys, logs) from the command line.
//
//   node driver.mjs --browser helium|firefox [--port 9400] [--url http://localhost:8642/] [--seed]
//
// --seed copies ../gamedata into the browser's OPFS (as the launcher's import would), served from
// a local helper server, so tests don't need the folder picker.
//
// Control API (GET):
//   /shot?name=foo        save screenshot to ../build/shots/<browser>-foo.png
//   /click?x=&y=[&button=right]   click at page coordinates
//   /move?x=&y=           move the mouse
//   /key?key=Enter        press a key (puppeteer key names)
//   /type?text=hello      type text
//   /eval?js=...          evaluate JS in the page, returns JSON
//   /logs?since=N         console output since line N
//   /goto?url=...         navigate
//   /quit                 close the browser and exit

import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]] : null).filter(Boolean));

const BROWSERS = {
	helium: { browser: 'chrome', executablePath: '/Applications/Helium.app/Contents/MacOS/Helium' },
	firefox: { browser: 'firefox', executablePath: '/Applications/Firefox.app/Contents/MacOS/firefox' },
};

const name = args.browser ?? 'helium';
const controlPort = Number(args.port ?? 9400);
const url = args.url ?? 'http://localhost:8642/';
const shotsDir = path.join(root, 'build', 'shots');
const profileDir = path.join(root, 'build', 'profiles', name);
fs.mkdirSync(shotsDir, { recursive: true });
fs.mkdirSync(profileDir, { recursive: true });

const logs = [];
function record(line) {
	const entry = `${new Date().toISOString().slice(11, 23)} ${line}`;
	logs.push(entry);
	if (args.verbose)
		console.log(entry);
}

// ------------------------------------------------------------------------------------------
// Game data seeding helper: serves ../gamedata with CORS so the page can copy it into OPFS
// ------------------------------------------------------------------------------------------

function startDataServer() {
	const dataRoot = path.join(root, 'gamedata');
	const list = [];
	for (const dir of ['Data', 'Maps', 'Mp3']) {
		for (const file of fs.readdirSync(path.join(dataRoot, dir))) {
			if (!/\.vid$/i.test(file))
				list.push(`${dir}/${file}`);
		}
	}
	const server = http.createServer((req, res) => {
		const headers = { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' };
		const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
		if (rel === '__list') {
			res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
			res.end(JSON.stringify(list));
			return;
		}
		if (!list.includes(rel)) {
			res.writeHead(404, headers);
			res.end();
			return;
		}
		res.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream' });
		fs.createReadStream(path.join(dataRoot, rel)).pipe(res);
	});
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function seed(page) {
	const port = await startDataServer();
	record(`[driver] seeding OPFS from data server on port ${port}`);
	const count = await page.evaluate(async (base) => {
		const list = await (await fetch(`${base}/__list`)).json();
		const root = await navigator.storage.getDirectory();
		const h3 = await root.getDirectoryHandle('h3', { create: true });
		for (const rel of list) {
			const [dirName, fileName] = rel.split('/');
			const dir = await h3.getDirectoryHandle(dirName, { create: true });
			const handle = await dir.getFileHandle(fileName, { create: true });
			const writable = await handle.createWritable();
			const response = await fetch(`${base}/${encodeURIComponent(rel)}`);
			await response.body.pipeTo(writable);
		}
		return list.length;
	}, `http://127.0.0.1:${port}`);
	record(`[driver] seeded ${count} files`);
}

// ------------------------------------------------------------------------------------------

const config = BROWSERS[name];
const browser = await puppeteer.launch({
	...config,
	headless: false,
	userDataDir: profileDir,
	defaultViewport: null,
	args: config.browser === 'chrome' ? ['--window-size=1400,900', '--no-first-run', '--no-default-browser-check', '--enable-features=SharedArrayBuffer'] : ['--width=1400', '--height=900'],
	protocolTimeout: 600000,
});
const page = (await browser.pages())[0] ?? await browser.newPage();

page.on('console', (msg) => record(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => record(`[pageerror] ${err.message}`));
page.on('requestfailed', (req) => record(`[requestfailed] ${req.url()} ${req.failure()?.errorText}`));

await page.goto(url, { waitUntil: 'load' });
if (args.seed) {
	await seed(page);
	await page.goto(url, { waitUntil: 'load' });
}

const routes = {
	async shot(q) {
		const file = path.join(shotsDir, `${name}-${q.get('name') ?? Date.now()}.png`);
		await page.screenshot({ path: file });
		return { file };
	},
	async click(q) {
		await page.mouse.click(Number(q.get('x')), Number(q.get('y')), { button: q.get('button') ?? 'left' });
		return { ok: true };
	},
	async move(q) {
		await page.mouse.move(Number(q.get('x')), Number(q.get('y')));
		return { ok: true };
	},
	async key(q) {
		await page.keyboard.press(q.get('key'));
		return { ok: true };
	},
	async type(q) {
		await page.keyboard.type(q.get('text'), { delay: 30 });
		return { ok: true };
	},
	async eval(q) {
		return { result: await page.evaluate(q.get('js')) };
	},
	async logs(q) {
		const since = Number(q.get('since') ?? 0);
		return { next: logs.length, lines: logs.slice(since) };
	},
	async goto(q) {
		await page.goto(q.get('url'), { waitUntil: 'load' });
		return { ok: true };
	},
	async quit() {
		setTimeout(async () => {
			await browser.close();
			process.exit(0);
		}, 100);
		return { ok: true };
	},
};

http.createServer(async (req, res) => {
	const u = new URL(req.url, 'http://x');
	const handler = routes[u.pathname.slice(1)];
	try {
		const result = handler ? await handler(u.searchParams) : { error: 'unknown command' };
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(result, null, 1));
	} catch (error) {
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: error.message }));
	}
}).listen(controlPort, '127.0.0.1', () => record(`[driver] ${name} ready, control API on http://127.0.0.1:${controlPort}`));

browser.on('disconnected', () => process.exit(0));
