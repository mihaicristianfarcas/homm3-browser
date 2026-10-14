// Puts Heroes III files into the origin-private file system (OPFS), where the game reads them from:
// either copied from a folder picked by the player, or downloaded from the server's game data bundle.
// Runs in a worker because sync access handles are only available there, and they are the one
// OPFS write API supported by every major browser.

const PROGRESS_INTERVAL_MS = 100;
const DOWNLOAD_CONCURRENCY = 4;
// downloaded file versions, so that changed files on the server are fetched again
const BUNDLE_STATE = '.bundle.json';

async function directoryFor(root, parts, create) {
	let dir = root;
	for (const part of parts)
		dir = await dir.getDirectoryHandle(part, { create });
	return dir;
}

/// Writes a stream of bytes to a file, returns the number of bytes written
async function writeFile(root, dest, stream, onBytes) {
	const parts = dest.split('/');
	const name = parts.pop();
	const dir = await directoryFor(root, parts, true);
	const handle = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
	let offset = 0;
	try {
		handle.truncate(0);
		const reader = stream.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done)
				break;
			offset += handle.write(value, { at: offset });
			onBytes(value.byteLength);
		}
		handle.flush();
	} finally {
		handle.close();
	}
	return offset;
}

function progressReporter(total, count) {
	let copied = 0;
	let finished = 0;
	let lastReport = 0;
	return {
		bytes(bytes, file) {
			copied += bytes;
			const now = performance.now();
			if (now - lastReport > PROGRESS_INTERVAL_MS) {
				lastReport = now;
				postMessage({ type: 'progress', copied, total, file, index: finished, count });
			}
		},
		fileDone() {
			finished++;
		},
		end() {
			postMessage({ type: 'progress', copied: total, total, file: '', index: count, count });
		},
	};
}

async function h3Root() {
	return directoryFor(await navigator.storage.getDirectory(), ['h3'], true);
}

async function importFiles(files) {
	const root = await h3Root();
	const progress = progressReporter(files.reduce((sum, entry) => sum + entry.file.size, 0), files.length);
	for (const entry of files) {
		await writeFile(root, entry.dest, entry.file.stream(), (bytes) => progress.bytes(bytes, entry.dest));
		progress.fileDone();
	}
	// the player's own files replace whatever was downloaded before
	await root.removeEntry(BUNDLE_STATE).catch(() => {});
	progress.end();
}

async function readBundleState(root) {
	try {
		return JSON.parse(await (await (await root.getFileHandle(BUNDLE_STATE)).getFile()).text());
	} catch {
		return {};
	}
}

async function writeBundleState(root, state) {
	await writeFile(root, BUNDLE_STATE, new Blob([JSON.stringify(state)]).stream(), () => {});
}

async function downloadFiles(files, key) {
	const root = await h3Root();
	const state = await readBundleState(root);
	const progress = progressReporter(files.reduce((sum, entry) => sum + entry.size, 0), files.length);
	const queue = [...files];
	let stateWrites = Promise.resolve();

	async function downloadNext() {
		while (queue.length) {
			const entry = queue.shift();
			const response = await fetch(entry.url, { headers: key ? { 'X-Game-Key': key } : {}, cache: 'no-store' });
			if (!response.ok)
				throw new Error(response.status === 403 ? 'the game link is missing its key or the key is wrong' : `server answered ${response.status} for ${entry.path}`);

			const written = await writeFile(root, entry.path, response.body, (bytes) => progress.bytes(bytes, entry.path));
			if (written !== entry.size)
				throw new Error(`${entry.path} arrived incomplete (${written} of ${entry.size} bytes)`);
			progress.fileDone();

			// sync access handles are exclusive, so state updates are written one at a time
			state[entry.path] = entry.sha256;
			stateWrites = stateWrites.then(() => writeBundleState(root, state));
		}
	}

	await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, files.length) }, downloadNext));
	await stateWrites;
	progress.end();
}

async function removeAll() {
	const root = await navigator.storage.getDirectory();
	await root.removeEntry('h3', { recursive: true }).catch(() => {});
}

onmessage = async ({ data }) => {
	try {
		if (data.type === 'import')
			await importFiles(data.files);
		else if (data.type === 'download')
			await downloadFiles(data.files, data.key);
		else if (data.type === 'clear')
			await removeAll();
		postMessage({ type: 'done' });
	} catch (error) {
		postMessage({ type: 'error', message: error?.message ?? String(error) });
	}
};
