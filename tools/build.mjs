#!/usr/bin/env node
/**
 * Planly build — Node-only replacement for build.sh.
 *
 * build.sh needs bash, `date` and `python3`. This does the same job with nothing
 * but Node, so it runs unchanged on Cloudflare Pages, on a plain Windows box,
 * and anywhere else. Use it as the Pages build command:
 *
 *     node tools/build.mjs
 *
 * What it does, in the same order as build.sh:
 *   1. assemble index.html from build.sh's HEAD/TAIL heredocs + src/i18n.js + src/app.html
 *   2. stamp __BUILD__ with the current local time (dd.MM HH:mm)
 *   3. write dist/ — exactly what gets uploaded
 *
 * The HEAD/TAIL blocks are parsed out of build.sh rather than duplicated here, so
 * the shell and Node builds cannot drift apart. Edit build.sh to change the shell.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

/** Pull the body of a `cat <<'NAME' … NAME` heredoc out of build.sh. */
function heredoc(shell, name) {
	const m = shell.match(new RegExp("cat <<'" + name + "'\\n([\\s\\S]*?)\\n" + name + "\\n"));
	if (!m) throw new Error(`build.sh: could not find the ${name} heredoc — has build.sh changed?`);
	return m[1] + '\n';
}

const shell = read('build.sh').replace(/\r\n/g, '\n');
const head = heredoc(shell, 'HEAD');
const tail = heredoc(shell, 'TAIL');
const i18n = read('src/i18n.js');
const app = read('src/app.html');

// build.sh: grep -v '^<title>Planly</title>$' src/app.html
const appFiltered = app.split('\n').filter((l) => l !== '<title>Planly</title>').join('\n');

let html = head + '<script>\n' + i18n + '</script>\n' + appFiltered + tail;

const p = (n) => String(n).padStart(2, '0');
const now = new Date();
const stamp = `${p(now.getDate())}.${p(now.getMonth() + 1)} ${p(now.getHours())}:${p(now.getMinutes())}`;
if (!html.includes('__BUILD__')) throw new Error('build: __BUILD__ placeholder is missing from src/app.html');
html = html.replace('__BUILD__', stamp);

writeFileSync(path.join(root, 'index.html'), html, 'utf8');
console.log(`index.html  ${Buffer.byteLength(html, 'utf8')} bytes  (build ${stamp})`);

// ---------------------------------------------------------------- dist/
const dist = path.join(root, 'dist');
const cacheVer = `planly-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

writeFileSync(path.join(dist, 'index.html'), html, 'utf8');
cpSync(path.join(root, 'manifest.json'), path.join(dist, 'manifest.json'));
writeFileSync(path.join(dist, 'version.txt'), stamp, 'utf8'); // printf '%s' — no trailing newline

const sw = read('sw.js');
const swOut = sw.replace(/planly-v1/g, cacheVer);
if (swOut === sw) throw new Error('build: sw.js has no planly-v1 cache name to version');
writeFileSync(path.join(dist, 'sw.js'), swOut, 'utf8');

cpSync(path.join(root, 'icons'), path.join(dist, 'icons'), { recursive: true });

console.log(`dist/        cache ${cacheVer}`);
