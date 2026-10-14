// Copies Heroes III files picked by the player into the origin-private file system (OPFS),
// where the game reads them from. Runs in a worker because sync access handles are only
// available there, and they are the one OPFS write API supported by every major browser.

const PROGRESS_INTERVAL_MS = 100;

async function directoryFor(root, parts, create) {
	let dir = root;
	for (const part of parts)
		dir = await dir.getDirectoryHandle(part, { create });
	return dir;
}

async function copyFile(root, { file, dest }, onBytes) {
	const parts = dest.split('/');
	const name = parts.pop();
	const dir = await directoryFor(root, parts, true);
	const handle = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
	try {
		handle.truncate(0);
		let offset = 0;
		const reader = file.stream().getReader();
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
}

async function importFiles(files) {
	const root = await directoryFor(await navigator.storage.getDirectory(), ['h3'], true);
	const total = files.reduce((sum, entry) => sum + entry.file.size, 0);
	let copied = 0;
	let lastReport = 0;

	for (const [index, entry] of files.entries()) {
		await copyFile(root, entry, (bytes) => {
			copied += bytes;
			const now = performance.now();
			if (now - lastReport > PROGRESS_INTERVAL_MS) {
				lastReport = now;
				postMessage({ type: 'progress', copied, total, file: entry.dest, index, count: files.length });
			}
		});
	}
	postMessage({ type: 'progress', copied: total, total, file: '', index: files.length, count: files.length });
}

async function removeAll() {
	const root = await navigator.storage.getDirectory();
	await root.removeEntry('h3', { recursive: true }).catch(() => {});
}

onmessage = async ({ data }) => {
	try {
		if (data.type === 'import')
			await importFiles(data.files);
		else if (data.type === 'clear')
			await removeAll();
		postMessage({ type: 'done' });
	} catch (error) {
		postMessage({ type: 'error', message: error?.message ?? String(error) });
	}
};
