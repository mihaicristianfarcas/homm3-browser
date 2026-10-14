// Safari counterpart of driver.mjs, using safaridriver (WebDriver) since Puppeteer can't drive Safari.
// Requires Safari's "Allow Remote Automation" (Develop menu) and `safaridriver --enable` once.
//
//   node safari-driver.mjs [--port 9403] [--url http://localhost:8642/] [--seed]
//
// Same control API as driver.mjs: /shot /click /move /key /type /eval /logs /goto /quit
// /logs returns the game output collected by the launcher page (window.vcmiLog).

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]] : null).filter(Boolean));
const controlPort = Number(args.port ?? 9403);
const url = args.url ?? 'http://localhost:8642/';
const shotsDir = path.join(root, 'build', 'shots');
fs.mkdirSync(shotsDir, { recursive: true });

const WEBDRIVER_PORT = 9515;
const driverProcess = spawn('safaridriver', ['-p', String(WEBDRIVER_PORT)], { stdio: 'ignore' });
await new Promise((resolve) => setTimeout(resolve, 1500));

async function wd(method, endpoint, body) {
	const response = await fetch(`http://127.0.0.1:${WEBDRIVER_PORT}${endpoint}`, {
		method,
		headers: { 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const json = await response.json();
	if (json.value?.error)
		throw new Error(`${json.value.error}: ${json.value.message}`);
	return json.value;
}

const session = await wd('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } });
const sid = session.sessionId;
const s = (endpoint) => `/session/${sid}${endpoint}`;
await wd('POST', s('/window/rect'), { width: 1400, height: 900, x: 0, y: 0 });
await wd('POST', s('/timeouts'), { script: 600000 });

// --- game data seeding through the launcher's own import worker ---------------------------

function startDataServer() {
	const dataRoot = path.join(root, 'gamedata');
	const list = [];
	for (const dir of ['Data', 'Maps', 'Mp3'])
		for (const file of fs.readdirSync(path.join(dataRoot, dir)))
			if (!/\.vid$/i.test(file))
				list.push(`${dir}/${file}`);
	const server = http.createServer((req, res) => {
		const headers = { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' };
		const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
		if (rel === '__list') {
			res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
			res.end(JSON.stringify(list));
		} else if (list.includes(rel)) {
			res.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream' });
			fs.createReadStream(path.join(dataRoot, rel)).pipe(res);
		} else {
			res.writeHead(404, headers);
			res.end();
		}
	});
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function seed() {
	const port = await startDataServer();
	return wd('POST', s('/execute/async'), {
		script: `
			const [base, done] = arguments;
			(async () => {
				const list = await (await fetch(base + '/__list')).json();
				const files = [];
				for (const rel of list) {
					const blob = await (await fetch(base + '/' + encodeURIComponent(rel))).blob();
					files.push({ file: new File([blob], rel.split('/')[1]), dest: rel });
				}
				const worker = new Worker('import-worker.js');
				worker.onmessage = ({ data }) => { if (data.type !== 'progress') done(data.type + ' ' + (data.message ?? files.length)); };
				worker.postMessage({ type: 'import', files });
			})().catch((e) => done('error ' + e.message));`,
		args: [`http://127.0.0.1:${port}`],
	});
}

await wd('POST', s('/url'), { url });
if (args.seed) {
	console.log('seed:', await seed());
	await wd('POST', s('/url'), { url });
}

// safaridriver's input actions don't reach pages reliably (they need a frontmost window),
// so input is dispatched as DOM events - the game handles them the same way
const KEY_CODES = { Enter: ['Enter', 13], Escape: ['Escape', 27], Tab: ['Tab', 9], Backspace: ['Backspace', 8], ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39], Space: ['Space', 32] };

function dispatch(script, ...scriptArgs) {
	return wd('POST', s('/execute/async'), { script: `const done = arguments[arguments.length - 1]; (async (...a) => { ${script} })(...Array.from(arguments).slice(0, -1)).then(done, (e) => done('error: ' + e.message));`, args: scriptArgs });
}

const MOUSE = `
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const mouse = (type, x, y, button, buttons) => document.getElementById('canvas').dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, screenX: x, screenY: y, button, buttons, view: window }));`;

const KEYBOARD = `
	const key = (type, k, code, keyCode, charCode) => window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key: k, code, keyCode, which: keyCode, charCode }));`;

const routes = {
	async shot(q) {
		const file = path.join(shotsDir, `safari-${q.get('name') ?? Date.now()}.png`);
		fs.writeFileSync(file, Buffer.from(await wd('GET', s('/screenshot')), 'base64'));
		return { file };
	},
	async click(q) {
		const button = q.get('button') === 'right' ? 2 : 0;
		await dispatch(`${MOUSE}
			const [x, y, button] = a;
			mouse('mousemove', x, y, 0, 0); await sleep(50);
			mouse('mousedown', x, y, button, button === 2 ? 2 : 1); await sleep(60);
			mouse('mouseup', x, y, button, 0);`, Number(q.get('x')), Number(q.get('y')), button);
		return { ok: true };
	},
	async move(q) {
		await dispatch(`${MOUSE} mouse('mousemove', a[0], a[1], 0, 0);`, Number(q.get('x')), Number(q.get('y')));
		return { ok: true };
	},
	async key(q) {
		const name = q.get('key');
		const [code, keyCode] = KEY_CODES[name] ?? [`Key${name.toUpperCase()}`, name.toUpperCase().charCodeAt(0)];
		await dispatch(`${KEYBOARD}
			const [k, code, keyCode] = a;
			key('keydown', k, code, keyCode, 0);
			if (k === 'Enter') key('keypress', k, code, 13, 13);
			key('keyup', k, code, keyCode, 0);`, name, code, keyCode);
		return { ok: true };
	},
	async type(q) {
		await dispatch(`${KEYBOARD}
			for (const ch of a[0]) {
				const upper = ch.toUpperCase();
				const code = /[a-z]/i.test(ch) ? 'Key' + upper : (ch === ' ' ? 'Space' : 'Digit' + ch);
				key('keydown', ch, code, upper.charCodeAt(0), 0);
				key('keypress', ch, code, ch.charCodeAt(0), ch.charCodeAt(0));
				key('keyup', ch, code, upper.charCodeAt(0), 0);
				await new Promise((r) => setTimeout(r, 20));
			}`, q.get('text'));
		return { ok: true };
	},
	async eval(q) {
		return { result: await wd('POST', s('/execute/async'), { script: `const done = arguments[0]; Promise.resolve(eval(${JSON.stringify(q.get('js'))})).then(done, (e) => done('error: ' + e.message));`, args: [] }) };
	},
	async logs(q) {
		const lines = await wd('POST', s('/execute/sync'), { script: 'return window.vcmiLog ?? [];', args: [] });
		const since = Number(q.get('since') ?? 0);
		return { next: lines.length, lines: lines.slice(since) };
	},
	async goto(q) {
		await wd('POST', s('/url'), { url: q.get('url') });
		return { ok: true };
	},
	async quit() {
		setTimeout(async () => {
			await wd('DELETE', s('')).catch(() => {});
			driverProcess.kill();
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
}).listen(controlPort, '127.0.0.1', () => console.log(`safari ready, control API on http://127.0.0.1:${controlPort}`));
