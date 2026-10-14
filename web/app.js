// Launcher for the browser build of VCMI: checks browser support, manages the player's
// Heroes III files in browser storage, starts the game and connects it to the page.

const $ = (id) => document.getElementById(id);

// Files the game can't start without, relative to the game folder. Matching is case-insensitive.
const REQUIRED_FILES = [
	['Data/H3bitmap.lod', 'Shadow of Death graphics'],
	['Data/H3sprite.lod', 'Shadow of Death sprites'],
	['Data/Heroes3.snd', 'Sound effects'],
];
const EXPANSION_FILES = [
	['Data/H3ab_bmp.lod', "Armageddon's Blade graphics"],
	['Data/H3ab_spr.lod', "Armageddon's Blade sprites"],
];

// Which parts of an installation get copied, by top-level folder
const IMPORT_RULES = {
	data: { dir: 'Data', accept: /\.(lod|snd|pac)$/i },
	maps: { dir: 'Maps', accept: /\.(h3m|h3c|tut)$/i },
	mp3: { dir: 'Mp3', accept: /\.mp3$/i },
};

const params = new URLSearchParams(location.search);
const KEY_STORAGE = 'homm3-gamedata-key';
let config = {}; // deployment settings from the server (config.json)
let gameDataKey = null; // access key for the server's game data, from the invite link
let game = null; // Emscripten module once started
let gameRunning = false;
let gameStopped = false; // quit, crashed or failed to start
let downloadRetries = 0; // automatic retries of the current game data download
const recentLog = [];

// ------------------------------------------------------------------------------------------
// Screens
// ------------------------------------------------------------------------------------------

function showScreen(name) {
	for (const screen of document.querySelectorAll('.screen'))
		screen.hidden = screen.id !== `screen-${name}`;
	$('overlay').hidden = false;
}

function hideOverlay() {
	$('overlay').hidden = true;
}

function formatSize(bytes) {
	if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
	if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
	return `${Math.round(bytes / 1e3)} KB`;
}

// ------------------------------------------------------------------------------------------
// Browser support
// ------------------------------------------------------------------------------------------

function missingFeatures() {
	const missing = [];
	if (!window.crossOriginIsolated)
		missing.push('Cross-origin isolation (the web server must send COOP/COEP headers)');
	if (typeof SharedArrayBuffer === 'undefined')
		missing.push('SharedArrayBuffer (WebAssembly threads)');
	if (!('transferControlToOffscreen' in HTMLCanvasElement.prototype))
		missing.push('OffscreenCanvas');
	if (!navigator.storage?.getDirectory)
		missing.push('Origin private file system');
	// smallest module returning a v128 (i8x16.splat + i8x16.popcnt), same probe as wasm-feature-detect
	const simd = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
	if (!WebAssembly.validate(simd))
		missing.push('WebAssembly SIMD');
	return missing;
}

// ------------------------------------------------------------------------------------------
// Game files in OPFS
// ------------------------------------------------------------------------------------------

async function opfsDirectory(path) {
	let dir = await navigator.storage.getDirectory();
	for (const part of path.split('/').filter(Boolean))
		dir = await dir.getDirectoryHandle(part);
	return dir;
}

/// Lists files of an OPFS folder as lower-case name => size
async function listFiles(path) {
	const result = new Map();
	try {
		const dir = await opfsDirectory(path);
		for await (const [name, handle] of dir.entries()) {
			if (handle.kind === 'file')
				result.set(name.toLowerCase(), (await handle.getFile()).size);
		}
	} catch {
		// folder doesn't exist yet
	}
	return result;
}

async function inspectGameFiles() {
	const data = await listFiles('h3/Data');
	const maps = await listFiles('h3/Maps');
	const music = await listFiles('h3/Mp3');
	const has = (path) => data.has(path.split('/')[1].toLowerCase());

	return {
		required: REQUIRED_FILES.map(([path, label]) => ({ label, ok: has(path) })),
		expansion: EXPANSION_FILES.map(([path, label]) => ({ label, ok: has(path) })),
		maps: maps.size,
		music: music.size,
		get ready() { return this.required.every((f) => f.ok); },
		get empty() { return data.size === 0 && maps.size === 0 && music.size === 0; },
	};
}

async function showLauncher() {
	let bundleNote = '';
	try {
		const downloads = await pendingDownloads();
		if (downloads?.length) {
			startDownload(downloads);
			return;
		}
	} catch (error) {
		bundleNote = error.message;
	}

	const files = await inspectGameFiles();
	if (files.empty) {
		showImport(false, bundleNote);
		return;
	}

	const list = $('data-status');
	list.replaceChildren();
	const add = (state, text) => {
		const li = document.createElement('li');
		li.className = state;
		li.textContent = text;
		list.append(li);
	};

	for (const f of files.required)
		add(f.ok ? 'ok' : 'missing', f.label);
	const expansionOk = files.expansion.every((f) => f.ok);
	add(expansionOk ? 'ok' : 'missing', "Armageddon's Blade & Shadow of Death content");
	add(files.maps ? 'ok' : 'missing', `${files.maps} scenario maps`);
	add(files.music ? 'ok' : 'optional', files.music ? `${files.music} music tracks` : 'No music (optional)');

	$('play').disabled = !files.ready;
	$('invite').hidden = !(config.gameData && gameDataKey);

	const estimate = await navigator.storage.estimate?.();
	const persisted = await navigator.storage.persisted?.();
	$('storage-info').textContent = estimate
		? `Using ${formatSize(estimate.usage ?? 0)} of browser storage${persisted ? '' : ' (the browser may clear it if space runs low)'}.`
		: '';

	showScreen('launcher');
	$('play').focus();
}

// ------------------------------------------------------------------------------------------
// Download from the server's game data bundle
// ------------------------------------------------------------------------------------------

/// Access key from the invite link (?key=...), remembered so that later visits work without it
function loadGameDataKey() {
	const fromLink = params.get('key');
	if (fromLink) {
		try {
			localStorage.setItem(KEY_STORAGE, fromLink);
		} catch {
			// storage unavailable - the key works for this visit only
		}
		const url = new URL(location.href);
		url.searchParams.delete('key');
		history.replaceState(null, '', url);
		return fromLink;
	}
	try {
		return localStorage.getItem(KEY_STORAGE);
	} catch {
		return null;
	}
}

async function readBundleState() {
	try {
		const file = await (await (await opfsDirectory('h3')).getFileHandle('.bundle.json')).getFile();
		return JSON.parse(await file.text());
	} catch {
		return null;
	}
}

/// Files to download from the server: missing, incomplete or changed ones.
/// Returns null when the server offers no game data or the player uses their own files
async function pendingDownloads() {
	if (!config.gameData)
		return null;

	const state = await readBundleState();
	if (!state && (await inspectGameFiles()).ready)
		return null; // the player's own game files

	if (config.gameData.keyRequired && !gameDataKey)
		throw new Error('This server can download the game for invited players. Open the invite link you were given, or use your own game files.');

	const response = await fetch(config.gameData.manifest, { headers: gameDataKey ? { 'X-Game-Key': gameDataKey } : {}, cache: 'no-store' });
	if (response.status === 403)
		throw new Error('The key in your invite link is not valid. Ask for a new link, or use your own game files.');
	if (!response.ok)
		throw new Error(`The game files could not be downloaded (server answered ${response.status}). You can use your own game files instead.`);
	const manifest = await response.json();

	const present = new Map();
	for (const dir of ['Data', 'Maps', 'Mp3'])
		for (const [name, size] of await listFiles(`h3/${dir}`))
			present.set(`${dir}/${name}`.toLowerCase(), size);

	const base = new URL(config.gameData.manifest, location.href);
	return manifest.files
		.filter((file) => present.get(file.path.toLowerCase()) !== file.size || (state?.[file.path] && state[file.path] !== file.sha256))
		.map((file) => ({ ...file, url: new URL(file.path.split('/').map(encodeURIComponent).join('/'), base).href }));
}

const MAX_DOWNLOAD_RETRIES = 3;

async function startDownload(files) {
	const total = files.reduce((sum, file) => sum + file.size, 0);
	$('download-size').textContent = formatSize(total);
	$('download-error').hidden = true;
	$('download-retry').hidden = true;
	$('download-bar').style.width = '0';
	$('download-label').textContent = 'Starting…';
	showScreen('download');

	const estimate = await navigator.storage.estimate?.();
	if (estimate?.quota && estimate.quota - (estimate.usage ?? 0) < total) {
		$('download-error').textContent = `This browser only allows ${formatSize(estimate.quota - (estimate.usage ?? 0))} more storage for this site, ${formatSize(total)} are needed. Free up disk space and try again.`;
		$('download-error').hidden = false;
		$('download-retry').hidden = false;
		return;
	}
	navigator.storage.persist?.();

	const started = performance.now();
	try {
		await runImportWorker({ type: 'download', files, key: gameDataKey }, ({ copied, file, index, count }) => {
			const seconds = (performance.now() - started) / 1000;
			const speed = seconds > 1 ? ` · ${formatSize(copied / seconds)}/s` : '';
			$('download-bar').style.width = `${(copied / total) * 100}%`;
			$('download-label').textContent = file
				? `${formatSize(copied)} of ${formatSize(total)}${speed} — ${file} (${Math.min(index + 1, count)} of ${count})`
				: 'Finishing…';
		});
	} catch (error) {
		// connection or storage hiccups: continue by itself a few times, with the files still missing
		if (error.transient && downloadRetries < MAX_DOWNLOAD_RETRIES) {
			downloadRetries++;
			$('download-label').textContent = `Interrupted (${error.message}), continuing…`;
			await new Promise((resolve) => setTimeout(resolve, 2000 * downloadRetries));
			await showLauncher();
			return;
		}
		$('download-error').textContent = `The download stopped: ${error.message}. Downloaded files are kept, trying again continues where it stopped.`;
		$('download-error').hidden = false;
		$('download-retry').hidden = false;
		return;
	}
	downloadRetries = 0;

	await showLauncher();
	if (params.has('autostart') && !$('play').disabled)
		startGame();
}

function setupDownload() {
	$('download-retry').addEventListener('click', () => {
		downloadRetries = 0;
		showLauncher();
	});
	$('download-own').addEventListener('click', () => showImport(true));
	$('invite').addEventListener('click', async () => {
		const link = `${location.origin}${location.pathname}?key=${encodeURIComponent(gameDataKey)}`;
		try {
			await navigator.clipboard.writeText(link);
			$('invite').textContent = 'Invite link copied';
		} catch {
			prompt('Send this link to your friends:', link);
		}
	});
}

// ------------------------------------------------------------------------------------------
// Import
// ------------------------------------------------------------------------------------------

function showImport(canGoBack, note = '') {
	$('import-note').textContent = note;
	$('import-note').hidden = !note;
	$('import-back').hidden = !canGoBack;
	$('clear-data').hidden = !canGoBack;
	$('import-error').hidden = true;
	$('import-progress').hidden = true;
	$('dropzone').classList.remove('disabled');
	showScreen('import');
}

/// Maps a path inside the chosen folder to its place in game storage, or null to skip the file
function importTarget(relativePath) {
	const parts = relativePath.split('/').filter(Boolean);
	// the chosen folder may be the game folder itself or any folder containing it
	for (let i = 0; i < parts.length - 1; i++) {
		const rule = IMPORT_RULES[parts[i].toLowerCase()];
		if (!rule || i !== parts.length - 2)
			continue;
		const name = parts[parts.length - 1];
		if (rule.accept.test(name))
			return `${rule.dir}/${name}`;
	}
	return null;
}

async function importSelection(entries) {
	const files = [];
	const seen = new Set();
	for (const { file, path } of entries) {
		const dest = importTarget(path);
		if (dest && !seen.has(dest.toLowerCase())) {
			seen.add(dest.toLowerCase());
			files.push({ file, dest });
		}
	}

	const names = new Set(files.map((f) => f.dest.toLowerCase()));
	const missing = REQUIRED_FILES.filter(([path]) => !names.has(path.toLowerCase()));
	if (missing.length) {
		$('import-error').textContent = files.length
			? `This folder is missing ${missing.map(([p]) => p).join(', ')}. Choose the Heroes III Complete installation folder.`
			: 'No Heroes III files found in this folder. Choose the folder that contains Data, Maps and Mp3.';
		$('import-error').hidden = false;
		return;
	}

	navigator.storage.persist?.();

	$('import-error').hidden = true;
	$('import-progress').hidden = false;
	$('dropzone').classList.add('disabled');
	$('import-back').hidden = true;
	$('clear-data').hidden = true;

	try {
		await runImportWorker({ type: 'import', files }, ({ copied, total, file, index, count }) => {
			$('import-bar').style.width = `${(copied / total) * 100}%`;
			$('import-label').textContent = file
				? `Copying ${file} (${index + 1} of ${count}) — ${formatSize(copied)} of ${formatSize(total)}`
				: 'Finishing…';
		});
		await showLauncher();
	} catch (error) {
		$('import-error').textContent = `Copying failed: ${error.message}`;
		$('import-error').hidden = false;
		$('dropzone').classList.remove('disabled');
		$('import-back').hidden = false;
	}
}

function runImportWorker(message, onProgress) {
	return new Promise((resolve, reject) => {
		const worker = new Worker('import-worker.js');
		worker.onmessage = ({ data }) => {
			if (data.type === 'progress')
				onProgress?.(data);
			else {
				worker.terminate();
				if (data.type === 'done')
					resolve();
				else
					reject(Object.assign(new Error(data.message), { transient: data.transient }));
			}
		};
		worker.onerror = (event) => {
			worker.terminate();
			reject(new Error(event.message || 'Import worker failed'));
		};
		worker.postMessage(message);
	});
}

/// Recursively collects files from a dropped folder
async function collectDropped(items) {
	const result = [];
	const readEntries = (reader) => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
	const fileOf = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));

	async function walk(entry, path) {
		if (entry.isFile) {
			result.push({ file: await fileOf(entry), path: `${path}${entry.name}` });
		} else if (entry.isDirectory) {
			const reader = entry.createReader();
			for (let batch = await readEntries(reader); batch.length; batch = await readEntries(reader)) {
				for (const child of batch)
					await walk(child, `${path}${entry.name}/`);
			}
		}
	}

	const roots = [...items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
	for (const entry of roots)
		await walk(entry, '');
	return result;
}

function setupImport() {
	$('folder-input').addEventListener('change', (event) => {
		const entries = [...event.target.files].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
		event.target.value = '';
		importSelection(entries);
	});

	const zone = $('dropzone');
	zone.addEventListener('dragover', (event) => {
		event.preventDefault();
		zone.classList.add('dragging');
	});
	zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
	zone.addEventListener('drop', async (event) => {
		event.preventDefault();
		zone.classList.remove('dragging');
		importSelection(await collectDropped(event.dataTransfer.items));
	});

	$('import-back').addEventListener('click', showLauncher);
	$('manage').addEventListener('click', () => showImport(true));
	$('clear-data').addEventListener('click', async () => {
		if (!confirm('Remove the Heroes III files from this browser? Saved games are kept.'))
			return;
		await runImportWorker({ type: 'clear' });
		await showLauncher();
	});
}

// ------------------------------------------------------------------------------------------
// Game
// ------------------------------------------------------------------------------------------

function loadScript(src) {
	return new Promise((resolve, reject) => {
		const script = document.createElement('script');
		script.src = src;
		script.onload = resolve;
		script.onerror = () => reject(new Error(`Failed to load ${src}`));
		document.head.append(script);
	});
}

// recent game output, for diagnostics from devtools or test automation
window.vcmiLog = recentLog;

function log(text, isError) {
	recentLog.push(text);
	if (recentLog.length > 200)
		recentLog.shift();
	(isError ? console.warn : console.log)(text);
}

function onGameEvent(event, detail) {
	switch (event) {
		case 'running':
			gameRunning = true;
			hideOverlay();
			$('fullscreen').hidden = false;
			$('canvas').focus();
			break;
		case 'exit':
			stopGame('Thanks for playing', '');
			break;
		case 'fatal':
			stopGame('The game stopped because of an error', detail, true);
			break;
	}
}

/// Shows why the game stopped. Only the first report counts: a stopped game can cause
/// follow-up errors (e.g. from its remaining threads) that would hide the actual reason
function stopGame(title, message, showLog = false) {
	if (gameStopped)
		return;
	gameStopped = true;
	// a crashed game can't close its audio itself
	game?.SDL2?.audioContext?.close().catch(() => {});
	if (isOutOfMemory(message))
		showOutOfMemory();
	else
		endGame(title, message, showLog);
}

function endGame(title, message, showLog = false) {
	gameRunning = false;
	$('ended-title').textContent = title;
	$('ended-message').textContent = message;
	$('ended-log').hidden = !showLog;
	$('ended-log').textContent = recentLog.slice(-60).join('\n');
	$('new-tab').hidden = true;
	$('restart').hidden = false;
	$('fullscreen').hidden = true;
	if (document.fullscreenElement)
		document.exitFullscreen?.();
	showScreen('ended');
}

// ------------------------------------------------------------------------------------------
// Memory
// ------------------------------------------------------------------------------------------

const MB = 1024 * 1024;
const WASM_PAGE_SIZE = 65536;

/// Sizes to try for the game's memory, in MB: [initial, maximum]. It grows on demand up to the maximum.
/// The maximum is reserved up front, which phones may refuse. The initial size must be at least the
/// game's INITIAL_MEMORY (vcmi/clientapp/CMakeLists.txt)
const MEMORY_SIZES = [[256, 2048], [128, 1024], [64, 768]];

/// Creates the game's WebAssembly memory, the largest the browser allows. Returns null if it refuses all.
/// Phones limit the memory of a tab, and Safari frees the memory of a page only some time after it was
/// reloaded, so a few reloads in a row can exhaust it. A new tab starts with a fresh allowance
function createGameMemory() {
	for (const [initial, maximum] of MEMORY_SIZES) {
		try {
			return new WebAssembly.Memory({ initial: (initial * MB) / WASM_PAGE_SIZE, maximum: (maximum * MB) / WASM_PAGE_SIZE, shared: true });
		} catch (error) {
			log(`Could not reserve ${maximum} MB of memory: ${error.message}`, true);
		}
	}
	return null;
}

function isOutOfMemory(text) {
	return /out of memory|\bOOM\b|bad_alloc|Array buffer allocation failed/i.test(String(text ?? ''));
}

function showOutOfMemory() {
	endGame('Not enough memory',
		'The browser did not give the game enough memory. This mostly happens on phones and tablets, '
		+ 'often after reloading the page a few times, because the memory of the previous game is freed only later. '
		+ 'Open the game in a new tab and close this one.');
	$('new-tab').href = location.href;
	$('new-tab').hidden = false;
	$('restart').hidden = true;
}

/// Game files in browser storage can only be opened by one tab at a time
function acquireGameLock() {
	if (!navigator.locks)
		return Promise.resolve(true);
	return new Promise((resolve) => {
		navigator.locks.request('homm3-game', { ifAvailable: true }, (lock) => {
			resolve(Boolean(lock));
			// held until the page closes
			return lock ? new Promise(() => {}) : undefined;
		});
	});
}

async function startGame() {
	const memory = createGameMemory();
	if (!memory) {
		showOutOfMemory();
		return;
	}

	if (!(await acquireGameLock())) {
		endGame('The game is already open', 'Heroes III is already running in another tab or window of this browser. Close it first, or continue playing there.');
		$('restart').textContent = 'Try again';
		return;
	}

	showScreen('loading');
	$('loading-label').textContent = 'Loading game engine…';

	try {
		const gameConfig = { ...config };
		// ?debug: verbose game logging in the browser console
		if (params.has('debug'))
			gameConfig.logLevel = params.get('debug') || 'debug';

		await loadScript('vcmiclient.js');
		// the module object is filled in while the game loads, keep it from the start for stopping it
		game = {
			wasmMemory: memory,
			vcmiConfig: gameConfig,
			canvas: $('canvas'),
			mainScriptUrlOrBlob: new URL('vcmiclient.js', location.href).href,
			print: (text) => log(text, false),
			printErr: (text) => log(text, true),
			setStatus: (text) => {
				if (text)
					$('loading-label').textContent = text.replace(/\((\d+)\/(\d+)\)/, (_, a, b) => `(${formatSize(+a)} of ${formatSize(+b)})`);
			},
			onVcmiEvent: onGameEvent,
			preRun: [(module) => {
				// ?audio=off runs without sound, e.g. for browsers with broken audio
				if (params.get('audio') === 'off')
					module.ENV.SDL_AUDIODRIVER = 'dummy';
			}],
			onAbort: (reason) => stopGame('The game stopped because of an error', String(reason ?? ''), true),
		};
		await createVcmiModule(game);
		$('loading-label').textContent = 'Starting VCMI…';
	} catch (error) {
		stopGame('The game could not start', error?.message ?? String(error), true);
	}
}

// ------------------------------------------------------------------------------------------
// Input integration
// ------------------------------------------------------------------------------------------

/// Keys the browser keeps while playing; everything else goes to the game only
function browserKeepsKey(event) {
	const mod = event.ctrlKey || event.metaKey;
	if (event.key === 'F11' || event.key === 'F12')
		return true;
	if (mod && event.shiftKey && ['i', 'j', 'c'].includes(event.key.toLowerCase()))
		return true; // developer tools
	if (mod && ['r', 'q', 'w', 't', 'n'].includes(event.key.toLowerCase()))
		return true; // reload, quit, tabs and windows
	return false;
}

/// Heroes III is pixel art: on screens with a whole-number pixel ratio, scale it without blurring
function setupPixelScaling() {
	const canvas = $('canvas');
	const update = () => {
		const ratio = window.devicePixelRatio;
		canvas.style.imageRendering = ratio > 1 && Number.isInteger(ratio) ? 'pixelated' : 'auto';
		matchMedia(`(resolution: ${ratio}dppx)`).addEventListener('change', update, { once: true });
	};
	update();
}

function setupInput() {
	const canvas = $('canvas');

	// The game receives key events through SDL in its worker, so they can't be cancelled there.
	// Printable keys must not be cancelled on keydown: that suppresses the keypress event,
	// which SDL turns into text input. Cancelling keypress still blocks e.g. Firefox's quick find.
	const printable = (event) => event.key.length === 1 && !event.ctrlKey && !event.metaKey;
	window.addEventListener('keydown', (event) => {
		if (gameRunning && !browserKeepsKey(event) && !printable(event))
			event.preventDefault();
	});
	for (const type of ['keyup', 'keypress']) {
		window.addEventListener(type, (event) => {
			if (gameRunning && !browserKeepsKey(event))
				event.preventDefault();
		});
	}

	// right click opens info popups in Heroes III
	canvas.addEventListener('contextmenu', (event) => event.preventDefault());
	canvas.addEventListener('pointerdown', () => canvas.focus());

	// browsers only allow audio after user interaction
	const resumeAudio = () => {
		const context = game?.SDL2?.audioContext;
		if (context?.state === 'suspended')
			context.resume();
	};
	window.addEventListener('pointerdown', resumeAudio, true);
	window.addEventListener('keydown', resumeAudio, true);

	window.addEventListener('beforeunload', (event) => {
		if (gameRunning) {
			event.preventDefault();
			event.returnValue = '';
		}
	});
	// End the game's threads right away when the page goes (also on reload and "Back to launcher").
	// The browser does it as well, but later, and the game's memory is only freed once all of them ended:
	// on phones a few reloads in a row could otherwise leave too little memory for the next start
	window.addEventListener('pagehide', (event) => {
		if (!event.persisted)
			game?.PThread?.terminateAllThreads();
	});

	$('fullscreen').addEventListener('click', () => {
		if (document.fullscreenElement)
			document.exitFullscreen();
		else
			document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
		canvas.focus();
	});
}

// ------------------------------------------------------------------------------------------

async function main() {
	const missing = missingFeatures();
	if (missing.length) {
		const list = $('unsupported-list');
		for (const text of missing) {
			const li = document.createElement('li');
			li.textContent = text;
			list.append(li);
		}
		showScreen('unsupported');
		return;
	}

	// deployment settings, such as the lobby server address and downloadable game data. Optional
	config = await fetch('config.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
	gameDataKey = loadGameDataKey();

	setupImport();
	setupDownload();
	setupInput();
	setupPixelScaling();
	$('play').addEventListener('click', startGame);
	$('restart').addEventListener('click', () => location.reload());

	await showLauncher();
	// when game files are being downloaded first, the download starts the game once it is done
	if (params.has('autostart') && !$('screen-launcher').hidden && !$('play').disabled)
		startGame();
}

main();
