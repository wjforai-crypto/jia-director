#!/usr/bin/env node
// Offline regression guard for GHSA-68fv-2mgg-jv7q; npm audit is still required.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(process.argv[2] || fileURLToPath(new URL('../', import.meta.url)));
const required = [
  'assets/livecanvas-remotion/package-lock.json',
  'assets/review/jia-video原文快照/assets/livecanvas-remotion/package-lock.json',
];
const failures = [];
const checked = [];
async function walk(directory) {
  const files = [];
  for (const item of await fs.readdir(directory, {withFileTypes: true})) {
    if (item.isSymbolicLink() || ['node_modules', '.git'].includes(item.name)) continue;
    const file = path.join(directory, item.name);
    if (item.isDirectory()) files.push(...await walk(file));
    else if (item.isFile() && item.name === 'package-lock.json') files.push(file);
  }
  return files;
}
const files = await walk(root);
for (const relative of required) {
  if (!files.includes(path.join(root, relative))) failures.push(`Missing template lock: ${relative}`);
}
for (const file of files) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  const lock = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  const matches = Object.entries(lock.packages || {}).filter(([key]) => key.endsWith('/source-map-js'));
  if (required.includes(relative) && !matches.length) failures.push(`Missing source-map-js resolution: ${relative}`);
  for (const [entry, pkg] of matches) {
    const version = pkg.version;
    const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version || '');
    const safe = parts && (+parts[1] > 1 || (+parts[1] === 1 && (+parts[2] > 2 || (+parts[2] === 2 && +parts[3] >= 2))));
    checked.push({file: relative, entry, version});
    if (!safe) failures.push(`${relative}: ${entry}@${version} is below stable 1.2.2`);
  }
}
console.log(JSON.stringify({advisory: 'GHSA-68fv-2mgg-jv7q', passed: failures.length === 0, checked, failures}, null, 2));
if (failures.length) process.exitCode = 1;
