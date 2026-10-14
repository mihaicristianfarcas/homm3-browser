#!/usr/bin/env node
// Assembles the deployable web app in dist/: the launcher page plus the compiled game,
// with Brotli and gzip variants of large files for the web server to pick from.
// Usage: node scripts/package-web.mjs [build-dir]   (default build/vcmi-release)

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.resolve(root, process.argv[2] ?? 'build/vcmi-release');
const dist = path.join(root, 'dist');

const GAME_FILES = ['vcmiclient.js', 'vcmiclient.wasm', 'vcmiclient.data'];
const COMPRESS = /\.(js|wasm|data|css|html|svg|webmanifest)$/;

fs.mkdirSync(dist, { recursive: true });

function copy(from, to) {
	fs.copyFileSync(from, to);
	return to;
}

const outputs = [];
for (const name of fs.readdirSync(path.join(root, 'web')))
	outputs.push(copy(path.join(root, 'web', name), path.join(dist, name)));
for (const name of GAME_FILES) {
	const from = path.join(buildDir, 'bin', name);
	if (!fs.existsSync(from))
		throw new Error(`Missing ${from} - build the game first (scripts/build-vcmi.sh)`);
	outputs.push(copy(from, path.join(dist, name)));
}

for (const file of outputs.filter((f) => COMPRESS.test(f))) {
	const data = fs.readFileSync(file);
	fs.writeFileSync(file + '.br', zlib.brotliCompressSync(data, {
		params: {
			[zlib.constants.BROTLI_PARAM_QUALITY]: data.length > 1e6 ? 9 : 11,
			[zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
		},
	}));
	fs.writeFileSync(file + '.gz', zlib.gzipSync(data, { level: 9 }));
	const sizes = [data.length, fs.statSync(file + '.br').size].map((n) => `${(n / 1e6).toFixed(2)} MB`);
	console.log(`${path.relative(root, file)}: ${sizes[0]} (brotli ${sizes[1]})`);
}
