#!/usr/bin/env node
// Films the trailer: the game runs in a headless browser on a frozen clock,
// the director (director.js) sets up every shot and steps the game one frame
// at a time, each frame is captured and piped to ffmpeg, and the soundtrack
// (music.mjs) is laid under it.
//
//   node scripts/trailer/record.mjs                 → trailer/pixelgame-trailer.mp4
//   node scripts/trailer/record.mjs --stills        → a contact sheet, three frames a shot
//   node scripts/trailer/record.mjs --from 62 --to 74   (seconds; a part of it)
//   options: --out file.mp4  --size 1920x1080  --seed 20260  --no-music
//
// Needs ffmpeg on the PATH and Playwright's Chromium (npm install).

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openGame, enterWorld, capture, root } from './browser.mjs';
import { schedule, FPS, DURATION } from './timeline.js';
import { writeSoundtrack } from './music.mjs';

const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

const [width, height] = (opt('size', '1920x1080')).split('x').map(Number);
const seed = Number(opt('seed', 20260));
const outDir = join(root, 'trailer');
mkdirSync(outDir, { recursive: true });

function ffmpegAvailable() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!ffmpegAvailable()) throw new Error('ffmpeg is needed (https://ffmpeg.org) — it puts the frames and the music together');
  const session = await openGame({ width, height, worldSeed: seed });
  const { page, cdp } = session;
  try {
    await enterWorld(page, { director: '/scripts/trailer/director.js' });
    if (flag('stills')) await stills(page, cdp);
    else await film(page, cdp);
  } finally {
    await session.close();
  }
}

const stepFrame = (page) => page.evaluate(() => {
  let info = null;
  window.__vt.advance(1000 / 60, () => {
    info = window.__director.step();
  });
  return info;
});

/** Three frames of every shot on one sheet, to check the framing quickly. */
async function stills(page, cdp) {
  const dir = join(outDir, 'stills');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const only = opt('shots')?.split(',') ?? null;
  const shots = schedule().filter((s) => !only || only.includes(s.id));
  let n = 0;
  for (const shot of shots) {
    await page.evaluate((t) => window.__director.seek(t), shot.start);
    const frames = Math.round(shot.dur * FPS);
    const want = new Set([0.12, 0.5, 0.88].map((k) => Math.floor(frames * k)));
    for (let f = 0; f < frames; f++) {
      await stepFrame(page);
      if (want.has(f)) {
        writeFileSync(join(dir, `${String(n++).padStart(4, '0')}.jpg`), await capture(cdp, { quality: 80, clip: { x: 0, y: 0, width, height, scale: 0.3 } }));
      }
    }
    console.log(`  ${shot.id}`);
  }
  const rows = Math.ceil(n / 3);
  const sheets = [];
  // (At most eight rows a sheet, so each stays readable.)
  for (let r0 = 0, k = 0; r0 < rows; r0 += 8, k++) {
    const out = join(outDir, `stills-${k + 1}.jpg`);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '1', '-start_number', String(r0 * 3), '-i', join(dir, '%04d.jpg'),
      '-frames:v', '1', '-vf', `tile=3x${Math.min(8, rows - r0)}:padding=4`, out]);
    sheets.push(out);
  }
  console.log(`Contact sheets: ${sheets.join(', ')}`);
}

/** The whole trailer (or --from/--to seconds of it), frame by frame, into ffmpeg. */
async function film(page, cdp) {
  const from = Number(opt('from', 0));
  const to = Math.min(DURATION, Number(opt('to', DURATION)));
  const out = opt('out', join(outDir, from || to < DURATION ? `trailer-${from}-${to}.mp4` : 'pixelgame-trailer.mp4'));
  let music = null;
  if (!flag('no-music')) {
    music = join(outDir, 'soundtrack.wav');
    console.log('Composing the soundtrack…');
    writeSoundtrack(music);
  }
  const ff = spawn('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    ...(music ? ['-ss', String(from), '-t', String(to - from), '-i', music] : []),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    ...(music ? ['-c:a', 'aac', '-b:a', '256k', '-shortest'] : []),
    '-movflags', '+faststart', out,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => {
    ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });
  await page.evaluate((t) => window.__director.seek(t), from);
  const frames = Math.round((to - from) * FPS);
  const t0 = Date.now();
  let last = '';
  for (let f = 0; f < frames; f++) {
    const info = await stepFrame(page);
    const jpg = await capture(cdp, { quality: 94 });
    if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once('drain', r));
    if (info.shot !== last || f % 300 === 0) {
      last = info.shot;
      const eta = ((Date.now() - t0) / (f + 1)) * (frames - f - 1) / 1000;
      process.stdout.write(`  ${info.t.toFixed(1)} s  ${info.shot.padEnd(22)} ${Math.round((f / frames) * 100)} %  (about ${Math.ceil(eta / 60)} min left)\n`);
    }
  }
  ff.stdin.end();
  await done;
  console.log(`Done: ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
