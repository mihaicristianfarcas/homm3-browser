// Puts Heroes III files into the origin-private file system (OPFS), where the game reads them from:
// either copied from a folder picked by the player, or downloaded from the server's game data bundle.
// Runs in a worker because sync access handles are only available there, and they are the one
// OPFS write API supported by every major browser.

const PROGRESS_INTERVAL_MS = 100;
const DOWNLOAD_CONCURRENCY = 4;
// a download that receives nothing for this long is given up, instead of hanging (e.g. a stalled tunnel)
const DOWNLOAD_STALL_TIMEOUT_MS = 30000;
// how long opening a file for writing may take, see openForWriting()
const OPEN_TIMEOUT_MS = 10000;
// downloaded file versions, so that changed files on the server are fetched again
const BUNDLE_STATE = '.bundle.json';

/// An error that may go away by itself (network, server or storage hiccup): the launcher tries again
class TransientError extends Error {}

async function directoryFor(root, parts, create) {
	let dir = root;
	for (const part of parts)
		dir = await dir.getDirectoryHandle(part, { create });
	return dir;
}

/// Opens a file for writing. A file another worker had open (e.g. one stopped by a page reload)
/// can stay locked for a moment, and Chrome then sometimes never answers - so this gives up after a while
async function openForWriting(fileHandle) {
	let timedOut = false;
	let timer;
	const opening = fileHandle.createSyncAccessHandle();
	const timeout = new Promise((resolve, reject) => {
		timer = setTimeout(() => {
			timedOut = true;
			reject(new TransientError(`browser storage did not open ${fileHandle.name}`));
		}, OPEN_TIMEOUT_MS);
	});
	// a handle that arrives after giving up must not stay open
	opening.then((handle) => timedOut && handle.close(), () => {});
	try {
		return await Promise.race([opening, timeout]);
	} catch (error) {
		// locked by another worker that is still finishing
		throw error?.name === 'NoModificationAllowedError' ? new TransientError(`${fileHandle.name} is in use`) : error;
	} finally {
		clearTimeout(timer);
	}
}

/// Writes a stream of bytes to a file, returns the number of bytes written
async function writeFile(root, dest, stream, onBytes) {
	const parts = dest.split('/');
	const name = parts.pop();
	const dir = await directoryFor(root, parts, true);
	const handle = await openForWriting(await dir.getFileHandle(name, { create: true }));
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

/// Records which file versions were downloaded. Writes are queued one at a time (file handles are
/// exclusive) and merged: while one is in progress, later updates are saved together by the next one
function bundleStateWriter(root, state) {
	let queue = Promise.resolve();
	let pending = false;
	return {
		save() {
			if (pending)
				return;
			pending = true;
			queue = queue.then(() => {
				pending = false;
				return writeFile(root, BUNDLE_STATE, new Blob([JSON.stringify(state)]).stream(), () => {});
			});
		},
		finished: () => queue,
	};
}

async function downloadFiles(files, key) {
	const root = await h3Root();
	const state = await readBundleState(root);
	const stateWriter = bundleStateWriter(root, state);
	// saved right away: it marks the game files as downloaded, not the player's own
	stateWriter.save();

	const progress = progressReporter(files.reduce((sum, entry) => sum + entry.size, 0), files.length);
	const queue = [...files];
	// after a failure the other downloads are stopped, so that no file is left open
	const running = new Set();
	let failure = null;

	async function download(entry) {
		const controller = new AbortController();
		let stalled = false;
		let timer;
		const keepAlive = () => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				stalled = true;
				controller.abort();
			}, DOWNLOAD_STALL_TIMEOUT_MS);
		};
		keepAlive();
		running.add(controller);
		try {
			let response;
			try {
				response = await fetch(entry.url, { headers: key ? { 'X-Game-Key': key } : {}, cache: 'no-store', signal: controller.signal });
			} catch (error) {
				throw controller.signal.aborted ? error : new TransientError(`the server can't be reached (${error.message})`);
			}
			if (response.status === 403)
				throw new Error('the game link is missing its key or the key is wrong');
			if (!response.ok) {
				const message = `server answered ${response.status} for ${entry.path}`;
				throw response.status >= 500 ? new TransientError(message) : new Error(message);
			}
			const written = await writeFile(root, entry.path, response.body, (bytes) => {
				keepAlive();
				progress.bytes(bytes, entry.path);
			});
			if (written !== entry.size)
				throw new TransientError(`${entry.path} arrived incomplete (${written} of ${entry.size} bytes)`);
		} catch (error) {
			if (stalled)
				throw new TransientError(`the server stopped sending ${entry.path}`);
			if (controller.signal.aborted || error instanceof TransientError || !(error instanceof Error))
				throw error;
			// the connection dropped while reading
			throw error.name === 'TypeError' ? new TransientError(`the connection was lost (${error.message})`) : error;
		} finally {
			clearTimeout(timer);
			running.delete(controller);
		}
	}

	async function downloadNext() {
		while (queue.length && !failure) {
			const entry = queue.shift();
			try {
				await download(entry);
			} catch (error) {
				// the first failure is the cause, later ones are downloads it stopped
				if (!failure) {
					failure = error;
					for (const controller of running)
						controller.abort();
				}
				return;
			}
			progress.fileDone();
			state[entry.path] = entry.sha256;
			stateWriter.save();
		}
	}

	await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, files.length) }, downloadNext));
	await stateWriter.finished();
	if (failure)
		throw failure;
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
		postMessage({ type: 'error', message: error?.message ?? String(error), transient: error instanceof TransientError });
	}
};
