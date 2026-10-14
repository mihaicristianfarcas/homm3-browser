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
	data: { dir: 'Data', accept: /\.(lod|snd|pac)$/i, video: /\.vid$/i },
	maps: { dir: 'Maps', accept: /\.(h3m|h3c|tut)$/i },
	mp3: { dir: 'Mp3', accept: /\.mp3$/i },
};

const params = new URLSearchParams(location.search);
let game = null; // Emscripten module once started
let gameRunning = false;
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
		video: data.has('video.vid'),
		get ready() { return this.required.every((f) => f.ok); },
		get empty() { return data.size === 0 && maps.size === 0 && music.size === 0; },
	};
}

async function showLauncher() {
	const files = await inspectGameFiles();
	if (files.empty) {
		showImport(false);
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
	add(files.video ? 'ok' : 'optional', files.video ? 'Cutscene videos' : 'No cutscene videos (optional)');

	$('play').disabled = !files.ready;

	const estimate = await navigator.storage.estimate?.();
	const persisted = await navigator.storage.persisted?.();
	$('storage-info').textContent = estimate
		? `Using ${formatSize(estimate.usage ?? 0)} of browser storage${persisted ? '' : ' (the browser may clear it if space runs low)'}.`
		: '';

	showScreen('launcher');
	$('play').focus();
}

// ------------------------------------------------------------------------------------------
// Import
// ------------------------------------------------------------------------------------------

function showImport(canGoBack) {
	$('import-back').hidden = !canGoBack;
	$('clear-data').hidden = !canGoBack;
	$('import-error').hidden = true;
	$('import-progress').hidden = true;
	$('dropzone').classList.remove('disabled');
	showScreen('import');
}

/// Maps a path inside the chosen folder to its place in game storage, or null to skip the file
function importTarget(relativePath, includeVideo) {
	const parts = relativePath.split('/').filter(Boolean);
	// the chosen folder may be the game folder itself or any folder containing it
	for (let i = 0; i < parts.length - 1; i++) {
		const rule = IMPORT_RULES[parts[i].toLowerCase()];
		if (!rule || i !== parts.length - 2)
			continue;
		const name = parts[parts.length - 1];
		if (rule.accept.test(name) || (includeVideo && rule.video?.test(name)))
			return `${rule.dir}/${name}`;
	}
	return null;
}

async function importSelection(entries) {
	const includeVideo = $('include-video').checked;
	const files = [];
	const seen = new Set();
	for (const { file, path } of entries) {
		const dest = importTarget(path, includeVideo);
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
					reject(new Error(data.message));
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
		showImport(false);
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
			endGame('Thanks for playing', '');
			break;
		case 'fatal':
			endGame('The game stopped because of an error', detail, true);
			break;
	}
}

function endGame(title, message, showLog = false) {
	gameRunning = false;
	$('ended-title').textContent = title;
	$('ended-message').textContent = message;
	$('ended-log').hidden = !showLog;
	$('ended-log').textContent = recentLog.slice(-60).join('\n');
	$('fullscreen').hidden = true;
	if (document.fullscreenElement)
		document.exitFullscreen?.();
	showScreen('ended');
}

async function startGame() {
	showScreen('loading');
	$('loading-label').textContent = 'Loading game engine…';

	try {
		// deployment settings, such as the lobby server address. Optional
		const config = await fetch('config.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));

		await loadScript('vcmiclient.js');
		game = await createVcmiModule({
			vcmiConfig: config,
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
			onAbort: (reason) => endGame('The game stopped because of an error', String(reason ?? ''), true),
		});
		$('loading-label').textContent = 'Starting VCMI…';
	} catch (error) {
		endGame('The game could not start', error?.message ?? String(error), true);
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

	setupImport();
	setupInput();
	$('play').addEventListener('click', startGame);
	$('restart').addEventListener('click', () => location.reload());

	await showLauncher();
	if (params.has('autostart') && !$('play').disabled)
		startGame();
}

main();
