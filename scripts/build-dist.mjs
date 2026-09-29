#!/usr/bin/env node
// Copies exactly the files the app serves into dist/ (the deploy folder):
// the Service Worker, its precache manifest, and every precached file.
// Tests, scripts and node_modules never get published.
//
//   node scripts/build-dist.mjs

import { cpSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildManifest } from './build-precache.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const manifest = buildManifest();

const committed = readFileSync(join(root, 'precache-manifest.js'), 'utf8');
if (committed !== manifest.source) {
  console.error('precache-manifest.js is out of date. Run: npm run build');
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
const files = ['sw.js', 'precache-manifest.js', ...manifest.shell, ...manifest.data];
for (const file of files) {
  const from = join(root, file);
  if (!existsSync(from)) throw new Error(`Missing file: ${file}`);
  const to = join(dist, file);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}
console.log(`dist/ ready: ${files.length} files (version ${manifest.version})`);
