// The trailer's soundtrack, written in code: an epic chiptune piece in D
// minor at the trailer's tempo, its parts following the sections in
// timeline.js, with hits on the cuts and a few sound effects on the titles
// and the weapon's evolution. Pure synthesis (oscillators, noise, filters,
// a delay and a reverb), rendered offline to a 16-bit stereo WAV.
//
//   node scripts/trailer/music.mjs [out.wav]

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { schedule, TITLES, BAR, BPM, DURATION } from './timeline.js';

const RATE = 44100;
const BEAT = 60 / BPM;
const TAIL = 3; // seconds of ring-out after the last frame (cut by the video)
const TAU = Math.PI * 2;

// --- A tiny deterministic noise source ------------------------------------------------

let seed = 0x9e3779b9;
function rnd() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) / 4294967296) * 2 - 1;
}

const mtof = (m) => 440 * 2 ** ((m - 69) / 12);

// --- Buses -----------------------------------------------------------------------------

class Bus {
  constructor(seconds) {
    this.n = Math.ceil(seconds * RATE);
    this.L = new Float32Array(this.n);
    this.R = new Float32Array(this.n);
  }

  add(i, v, pan = 0) {
    if (i < 0 || i >= this.n) return;
    // Constant-power panning.
    const a = ((pan + 1) * Math.PI) / 4;
    this.L[i] += v * Math.cos(a);
    this.R[i] += v * Math.sin(a);
  }
}

const LEN = DURATION + TAIL;
const dry = new Bus(LEN);
const verb = new Bus(LEN); // into the reverb
const echo = new Bus(LEN); // into the delay (the arpeggio)

/** Sends one sample of a voice to the mix (dry + reverb + delay sends). */
function out(i, v, { pan = 0, rev = 0.2, del = 0 } = {}) {
  dry.add(i, v, pan);
  if (rev) verb.add(i, v * rev, pan);
  if (del) echo.add(i, v * del, pan);
}

// --- Envelopes and filters ---------------------------------------------------------------

/** Attack-decay-sustain-release, `t` seconds into a note held for `dur`. */
function adsr(t, dur, a, d, s, r) {
  if (t < 0) return 0;
  let v;
  if (t < a) v = t / a;
  else if (t < a + d) v = 1 - (1 - s) * ((t - a) / d);
  else v = s;
  if (t > dur) v *= Math.max(0, 1 - (t - dur) / r);
  return v;
}

/** A two-pole low-pass (state variable), its cutoff changeable per sample. */
function svf() {
  let low = 0;
  let band = 0;
  return (x, cutoff, q = 0.7) => {
    const f = 2 * Math.sin((Math.PI * Math.min(cutoff, RATE / 6)) / RATE);
    low += f * band;
    const high = x - low - q * band;
    band += f * high;
    return low;
  };
}

/** Band-limited-ish waves (polyBLEP saw and pulse). */
function blep(t, dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

function saw(phase, dt) {
  return 2 * phase - 1 - blep(phase, dt);
}

function pulse(phase, dt, width = 0.5) {
  let v = phase < width ? 1 : -1;
  v += blep(phase, dt);
  v -= blep((phase + 1 - width) % 1, dt);
  return v - (2 * width - 1); // (no DC: a narrow pulse would thump on every note)
}

/** A one-pole high-pass (DC blocker at low cutoffs). */
function highpass(buf, cutoff) {
  const a = Math.exp((-TAU * cutoff) / RATE);
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const y = a * (y1 + x - x1);
    x1 = x;
    y1 = y;
    buf[i] = y;
  }
}

// --- Instruments -------------------------------------------------------------------------------

/** Each instrument renders one note: start time, length, pitch, velocity, options. */
const inst = {
  /** Warm pad: three detuned saws, a slow filter swell. */
  pad(t0, dur, m, vel, { pan = 0, bright = 1, attack = 0.6 } = {}) {
    const f = mtof(m);
    const det = [0.996, 1, 1.0045];
    const ph = [rnd() * 0.5 + 0.5, 0.3, 0.7];
    const lp = svf();
    const lp2 = svf();
    const n = Math.ceil((dur + 1.2) * RATE);
    const i0 = Math.round(t0 * RATE);
    for (let k = 0; k < n; k++) {
      const t = k / RATE;
      let v = 0;
      for (let j = 0; j < 3; j++) {
        const dt = (f * det[j]) / RATE;
        ph[j] = (ph[j] + dt) % 1;
        v += saw(ph[j], dt);
      }
      const env = adsr(t, dur, attack, 0.4, 0.85, 1.1);
      const cut = (400 + 1500 * bright * env) * (1 + 0.15 * Math.sin(t * 1.3));
      v = lp2(lp(v, cut, 0.5), cut * 1.5, 0.7);
      out(i0 + k, v * env * vel * 0.06, { pan, rev: 0.55 });
    }
  },

  /** Chiptune bass: a square with a quick pluck over a sine at the same pitch. */
  bass(t0, dur, m, vel, { drive = 1 } = {}) {
    const f = mtof(m);
    let ph = 0;
    const lp = svf();
    const n = Math.ceil((dur + 0.08) * RATE);
    const i0 = Math.round(t0 * RATE);
    for (let k = 0; k < n; k++) {
      const t = k / RATE;
      const dt = f / RATE;
      ph = (ph + dt) % 1;
      const env = adsr(t, dur, 0.004, 0.12, 0.6, 0.06);
      let v = pulse(ph, dt, 0.42) * 0.7 + Math.sin(ph * TAU) * 0.45;
      v = lp(v, 300 + 1900 * env * drive, 0.9);
      out(i0 + k, Math.tanh(v * 1.3) * env * vel * 0.14, { rev: 0.05 });
    }
  },

  /** Arpeggio: a thin pulse with a fast decay, into the delay. */
  arp(t0, dur, m, vel, { pan = 0, width = 0.25 } = {}) {
    const f = mtof(m);
    let ph = 0;
    const lp = svf();
    const n = Math.ceil((dur + 0.05) * RATE);
    const i0 = Math.round(t0 * RATE);
    for (let k = 0; k < n; k++) {
      const t = k / RATE;
      const dt = f / RATE;
      ph = (ph + dt) % 1;
      const env = adsr(t, dur, 0.002, 0.09, 0.25, 0.05);
      const v = lp(pulse(ph, dt, width), 1200 + 4200 * env, 0.6);
      out(i0 + k, v * env * vel * 0.05, { pan, rev: 0.25, del: 0.45 });
    }
  },

  /** The lead: a square with vibrato that grows as the note is held. */
  lead(t0, dur, m, vel, { pan = 0, tone = 'square', octave = 0 } = {}) {
    const f = mtof(m + 12 * octave);
    let ph = 0;
    let ph2 = 0.5;
    const lp = svf();
    const n = Math.ceil((dur + 0.25) * RATE);
    const i0 = Math.round(t0 * RATE);
    for (let k = 0; k < n; k++) {
      const t = k / RATE;
      const vib = 1 + 0.006 * Math.min(1, t / 0.35) * Math.sin(TAU * 5.5 * t);
      const glide = 1 + 0.012 * Math.exp(-t * 40); // a little scoop into the note
      const dt = (f * vib / glide) / RATE;
      ph = (ph + dt) % 1;
      ph2 = (ph2 + dt * 1.003) % 1;
      const env = adsr(t, dur, 0.008, 0.15, 0.75, 0.18);
      let v;
      if (tone === 'tri') v = 1 - 4 * Math.abs(ph - 0.5) + 0.3 * (1 - 4 * Math.abs(ph2 - 0.5));
      else v = pulse(ph, dt, 0.5) * 0.6 + pulse(ph2, dt, 0.3) * 0.4;
      v = lp(v, tone === 'tri' ? 3000 : 2200 + 2600 * env, 0.6);
      out(i0 + k, v * env * vel * 0.075, { pan, rev: 0.35, del: 0.12 });
    }
  },

  /** Brass stab: a stack of saws with a punchy filter, for the big sections. */
  brass(t0, dur, m, vel, { pan = 0 } = {}) {
    const f = mtof(m);
    const ph = [0, 0.33, 0.66];
    const det = [0.995, 1, 1.006];
    const lp = svf();
    const n = Math.ceil((dur + 0.3) * RATE);
    const i0 = Math.round(t0 * RATE);
    for (let k = 0; k < n; k++) {
      const t = k / RATE;
      let v = 0;
      for (let j = 0; j < 3; j++) {
        const dt = (f * det[j]) / RATE;
        ph[j] = (ph[j] + dt) % 1;
        v += saw(ph[j], dt);
      }
      const env = adsr(t, dur, 0.03, 0.25, 0.7, 0.25);
      v = lp(v, 500 + 2600 * adsr(t, dur, 0.05, 0.35, 0.45, 0.25), 0.8);
      out(i0 + k, v * env * vel * 0.05, { pan, rev: 0.4 });
    }
  },

  /** A glassy bell for the sparkle moments. */
  bell(t0, dur, m, vel, { pan = 0 } = {}) {
    const f = mtof(m);
    const n = Math.ceil((dur + 1.5) * RATE);
    const i0 = Math.round(t0 * RATE);
    for (let k = 0; k < n; k++) {
      const t = k / RATE;
      const env = Math.exp(-t * 3.2);
      const v = Math.sin(TAU * f * t + 1.8 * Math.sin(TAU * f * 3.5 * t) * Math.exp(-t * 5)) * env;
      out(i0 + k, v * vel * 0.07, { pan, rev: 0.6, del: 0.2 });
    }
  },
};

// --- Drums and effects ---------------------------------------------------------------------------------

const drum = {
  kick(t0, vel = 1) {
    const i0 = Math.round(t0 * RATE);
    let ph = 0;
    const n = Math.round(0.45 * RATE);
    for (let k = 0; k < n; k++) {
      const t = k / RATE;
      const f = 50 + 150 * Math.exp(-t * 28);
      ph += f / RATE;
      const v = Math.sin(TAU * ph) * Math.exp(-t * 9) + rnd() * 0.3 * Math.exp(-t * 180);
      out(i0 + k, Math.tanh(v * 1.6) * vel * 0.3, { rev: 0.04 });
    }
  },
  snare(t0, vel = 1, { pan = 0 } = {}) {
    const i0 = Math.round(t0 * RATE);
    const lp = svf();
    let ph = 0;
    const n = Math.round(0.32 * RATE);
    for (let k = 0; k < n; k++) {
      const t = k / RATE;
      ph += (190 + 60 * Math.exp(-t * 30)) / RATE;
      const noise = rnd();
      const hp = noise - lp(noise, 1800, 0.7);
      const v = hp * Math.exp(-t * 16) * 0.9 + Math.sin(TAU * ph) * Math.exp(-t * 22) * 0.6;
      out(i0 + k, v * vel * 0.2, { pan, rev: 0.3 });
    }
  },
  hat(t0, vel = 1, { open = false, pan = 0.25 } = {}) {
    const i0 = Math.round(t0 * RATE);
    const lp = svf();
    const n = Math.round((open ? 0.3 : 0.06) * RATE);
    for (let k = 0; k < n; k++) {
      const t = k / RATE;
      const x = rnd();
      const v = (x - lp(x, 7000, 0.6)) * Math.exp(-t * (open ? 12 : 70));
      out(i0 + k, v * vel * 0.07, { pan, rev: 0.12 });
    }
  },
  tom(t0, m, vel = 1, { pan = 0 } = {}) {
    const i0 = Math.round(t0 * RATE);
    let ph = 0;
    const f0 = mtof(m);
    const n = Math.round(0.5 * RATE);
    for (let k = 0; k < n; k++) {
      const t = k / RATE;
      ph += (f0 * (1 + 0.6 * Math.exp(-t * 20))) / RATE;
      const v = Math.sin(TAU * ph) * Math.exp(-t * 6) + rnd() * 0.15 * Math.exp(-t * 60);
      out(i0 + k, v * vel * 0.24, { pan, rev: 0.35 });
    }
  },
  crash(t0, vel = 1, { pan = 0, len = 2.2 } = {}) {
    const i0 = Math.round(t0 * RATE);
    const lp = svf();
    const n = Math.round(len * RATE);
    for (let k = 0; k < n; k++) {
      const t = k / RATE;
      const x = rnd();
      const v = (x - lp(x, 4500, 0.5)) * Math.exp(-t * (3 / len) * 1.6);
      out(i0 + k, v * vel * 0.11, { pan, rev: 0.5 });
    }
  },
  /** The big trailer hit: a falling sub boom, a burst of noise, a long tail. */
  impact(t0, vel = 1) {
    const i0 = Math.round(t0 * RATE);
    let ph = 0;
    const lp = svf();
    const n = Math.round(3.2 * RATE);
    for (let k = 0; k < n; k++) {
      const t = k / RATE;
      ph += (38 + 90 * Math.exp(-t * 6)) / RATE;
      const boom = Math.sin(TAU * ph) * Math.exp(-t * 1.5);
      const x = rnd();
      const burst = lp(x, 300 + 5000 * Math.exp(-t * 4), 0.7) * Math.exp(-t * 2.2);
      const tail = Math.min(1, (n - k) / (0.3 * RATE));
      out(i0 + k, Math.tanh((boom * 1.1 + burst * 0.9) * 1.2) * vel * 0.4 * tail, { rev: 0.45 });
    }
  },
  /** A riser: noise whose filter climbs, swelling into `t1`. */
  riser(t0, t1, vel = 1) {
    const i0 = Math.round(t0 * RATE);
    const lp = svf();
    const n = Math.round((t1 - t0) * RATE);
    let ph = 0;
    for (let k = 0; k < n; k++) {
      const p = k / n;
      const x = rnd();
      const cut = 200 + 9000 * p * p;
      ph += (110 + 660 * p * p) / RATE;
      const v = lp(x, cut, 0.4) * 0.8 + Math.sin(TAU * ph) * 0.12;
      out(i0 + k, v * p * p * vel * 0.16, { rev: 0.4, pan: Math.sin(p * 9) * 0.3 });
    }
  },
  /** A whoosh for the titles: a short swept noise. */
  whoosh(t0, vel = 1) {
    const i0 = Math.round(t0 * RATE);
    const lp = svf();
    const n = Math.round(0.7 * RATE);
    for (let k = 0; k < n; k++) {
      const t = k / RATE;
      const p = t / 0.7;
      const x = rnd();
      const env = Math.sin(Math.PI * Math.min(1, p * 1.25)) ** 2;
      const v = lp(x, 400 + 3800 * Math.sin(Math.PI * p), 1.2);
      out(i0 + k, v * env * vel * 0.12, { rev: 0.5, pan: (p - 0.5) * 1.2 });
    }
  },
};

// --- The score ---------------------------------------------------------------------------------------------

const CHORDS = {
  Dm: { bass: 38, tones: [50, 53, 57, 62] },
  Bb: { bass: 34, tones: [50, 53, 58, 62] },
  F: { bass: 41, tones: [53, 57, 60, 65] },
  C: { bass: 36, tones: [52, 55, 60, 64] },
  Gm: { bass: 43, tones: [50, 55, 58, 62] },
  A: { bass: 45, tones: [52, 57, 61, 64] },
};

const shots = schedule();
const sectionAt = (bar) => shots.find((s) => bar >= s.bar - 1e-6 && bar < s.bar + s.bars - 1e-6)?.section ?? 'end';
const TOTAL = Math.round(DURATION / BAR);

/** The chord of every bar. */
const plan = [];
{
  const epic = ['Dm', 'Bb', 'F', 'C'];
  const far = ['Gm', 'Bb', 'Dm', 'A', 'Gm', 'Bb', 'A'];
  let farI = 0;
  for (let b = 0; b < TOTAL; b++) {
    const sec = sectionAt(b + 0.01);
    let c;
    if (sec === 'intro') c = ['Dm', 'Dm', 'Bb', 'C'][b] ?? 'Dm';
    else if (sec === 'logo') c = 'Dm';
    else if (sec === 'far') c = far[farI++ % far.length];
    else if (sec === 'rise') c = ['Bb', 'C', 'A'][b - 28] ?? 'A';
    else if (sec === 'build') c = ['Bb', 'C'][(b - 43) % 2];
    else if (sec === 'montage') c = ['Bb', 'A'][(b - 49) % 2];
    else if (sec === 'end') c = ['Dm', 'Bb', 'C', 'Dm'][b - 51] ?? 'Dm';
    else c = epic[(b - (sec === 'explore' ? 6 : sec === 'weapons' ? 23 : sec === 'drop' ? 31 : 45)) % 4];
    plan.push({ bar: b, chord: c, section: sec });
  }
}

// The theme, in eighths: [midi, length]. Phrase A over Dm Bb F C, phrase B answers it.
const THEME_A = [
  [74, 3], [69, 1], [74, 2], [76, 2],
  [77, 4], [76, 2], [74, 2],
  [72, 3], [69, 1], [72, 2], [77, 2],
  [76, 4], [79, 2], [76, 2],
];
const THEME_B = [
  [74, 3], [69, 1], [74, 2], [76, 2],
  [77, 3], [79, 1], [77, 2], [74, 2],
  [81, 4], [79, 2], [77, 2],
  [76, 6], [null, 2],
];
// The far lands' melody: long, high and open.
const FAR_LINE = [
  [74, 8], [77, 6], [79, 2], [81, 8], [76, 8],
  [74, 6], [77, 2], [77, 8],
];
const END_LINE = [[74, 4], [77, 6], [79, 2], [76, 6], [72, 2], [74, 10]];

function playLine(line, bar0, opts = {}) {
  let t = bar0 * BAR;
  const e = BEAT / 2;
  for (const [m, len] of line) {
    if (m !== null) {
      inst.lead(t, len * e * 0.92, m, opts.vel ?? 1, opts);
      if (opts.harmony) inst.lead(t, len * e * 0.92, m - (opts.harmony ?? 0), (opts.vel ?? 1) * 0.55, { ...opts, pan: -(opts.pan ?? 0) - 0.3 });
    }
    t += len * e;
  }
}

function brassLine(line, bar0, vel = 1) {
  let t = bar0 * BAR;
  const e = BEAT / 2;
  for (const [m, len] of line) {
    if (m !== null) inst.brass(t, len * e * 0.9, m - 12, vel, { pan: -0.2 });
    t += len * e;
  }
}

function compose() {
  for (const { bar, chord, section } of plan) {
    const c = CHORDS[chord];
    const t = bar * BAR;
    const next = plan[bar + 1]?.section;
    // Pads: everywhere, louder in the big parts.
    const padVel = { intro: 0.7 + 0.15 * bar, logo: 1.2, explore: 0.8, far: 1, weapons: 0.7, rise: 1.1, drop: 0.9, build: 0.9, defend: 0.8, montage: 0.9, end: 1.1 }[section] ?? 0.8;
    const attack = section === 'intro' ? 1.4 : section === 'end' ? 0.05 : 0.25;
    c.tones.forEach((m, i) => inst.pad(t, BAR * 0.98, m, padVel, { pan: (i - 1.5) * 0.35, bright: section === 'drop' ? 1.4 : 1, attack }));
    if (section === 'end' && bar === TOTAL - 1) c.tones.forEach((m, i) => inst.pad(t + BAR, BAR, m, 0.9, { pan: (i - 1.5) * 0.35, attack: 0.05 }));

    // Bass.
    if (['explore', 'drop', 'defend', 'weapons', 'montage'].includes(section)) {
      for (let k = 0; k < 8; k++) {
        const oct = section === 'drop' && k % 2 ? 12 : 0;
        if (section === 'weapons' && bar < 26 && k % 2) continue;
        inst.bass(t + k * BEAT / 2, BEAT / 2 * 0.85, c.bass + oct, section === 'drop' ? 1.1 : 0.9, { drive: section === 'drop' ? 1.4 : 1 });
      }
    } else if (['far', 'build', 'rise'].includes(section)) {
      inst.bass(t, BAR * 0.95, c.bass, 0.8, { drive: 0.5 });
    } else if (section === 'logo' && bar === 4) {
      inst.bass(t, BAR * 1.9, c.bass, 1.1, { drive: 0.6 });
    }

    // Arpeggio: 16ths up and down the chord.
    if (section !== 'logo' && !(section === 'intro' && bar < 2) && section !== 'end') {
      const notes = [...c.tones, c.tones[1] + 12, c.tones[2] + 12, c.tones[3] + 12];
      const order = [0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1, 2, 3, 4, 5];
      const step = section === 'intro' || section === 'build' ? 2 : 1;
      for (let k = 0; k < 16; k += step) {
        const vel = (section === 'intro' ? 0.55 : section === 'far' ? 0.75 : 0.95) * (k % 4 === 0 ? 1 : 0.75);
        inst.arp(t + k * BEAT / 4, BEAT / 4 * 0.8, notes[order[k]] + 12, vel, { pan: Math.sin(k * 0.7) * 0.4, width: section === 'far' ? 0.12 : 0.25 });
      }
    }

    // Drums.
    const beats = (fn) => {
      for (let k = 0; k < 4; k++) fn(t + k * BEAT, k);
    };
    if (section === 'explore' || section === 'defend') {
      beats((bt, k) => {
        if (k === 0 || k === 2) drum.kick(bt);
        if (k === 1 || k === 3) drum.snare(bt, 0.9);
        drum.hat(bt, 0.8);
        drum.hat(bt + BEAT / 2, 0.55);
      });
      if (bar % 2 === 1) drum.kick(t + BEAT * 2.5, 0.7);
    } else if (section === 'drop') {
      beats((bt, k) => {
        drum.kick(bt, k % 2 ? 0.85 : 1.05);
        if (k === 1 || k === 3) drum.snare(bt, 1.1);
        for (let h = 0; h < 4; h++) drum.hat(bt + (h * BEAT) / 4, h === 2 ? 0.9 : 0.5);
      });
      // Every cut in this part is a hit.
      drum.crash(t, bar % 2 ? 0.6 : 1);
      if (bar === 31 || bar === 37) drum.impact(t, 0.9);
      else drum.tom(t, 40, 0.8);
    } else if (section === 'far') {
      beats((bt, k) => {
        if (k === 0) drum.kick(bt, 0.8);
        drum.hat(bt + BEAT / 2, 0.45, { pan: -0.3 });
      });
      drum.tom(t + BEAT * 3, 45, 0.5);
      drum.tom(t + BEAT * 3.5, 41, 0.6);
    } else if (section === 'weapons') {
      beats((bt) => {
        drum.kick(bt, bar < 26 ? 0.8 : 1);
        drum.hat(bt + BEAT / 2, 0.6);
      });
      if (bar >= 26) for (let k = 0; k < (bar === 27 ? 16 : 8); k++) drum.snare(t + (k * BAR) / (bar === 27 ? 16 : 8), 0.35 + 0.5 * (k / 16), { pan: 0.1 });
    } else if (section === 'rise') {
      // A timpani-like roll that grows into the drop.
      const hits = 8 + (bar - 28) * 8;
      for (let k = 0; k < hits; k++) drum.tom(t + (k * BAR) / hits, 38, 0.3 + 0.6 * ((bar - 28) * hits + k) / (3 * hits));
    } else if (section === 'build') {
      drum.kick(t, 0.8);
      drum.kick(t + BEAT * 2.5, 0.6);
      drum.snare(t + BEAT * 2, 0.5);
      beats((bt) => drum.hat(bt + BEAT / 2, 0.4));
    } else if (section === 'montage') {
      // A kick on every cut, a snare roll on top.
      beats((bt) => drum.kick(bt, 1));
      for (let k = 0; k < 16; k++) drum.snare(t + (k * BAR) / 16, 0.4 + 0.4 * ((bar - 49) * 16 + k) / 32);
    }

    // The end of a part leads into the next: a riser, or a fill.
    if (next && next !== section) {
      if (['drop', 'end', 'logo'].includes(next)) drum.riser(t + BAR * 0.15, t + BAR, next === 'logo' ? 0.9 : 1.1);
      else if (next !== 'rise' && section !== 'rise') {
        drum.tom(t + BEAT * 3, 47, 0.7);
        drum.tom(t + BEAT * 3.25, 45, 0.7);
        drum.tom(t + BEAT * 3.5, 43, 0.8);
        drum.tom(t + BEAT * 3.75, 40, 0.9);
      }
    }
    if (next && next !== section && ['explore', 'far', 'weapons', 'defend', 'build'].includes(next)) drum.crash(t + BAR, 0.8);
  }

  // The logo and the end card: big hits.
  drum.impact(4 * BAR, 1.15);
  drum.crash(4 * BAR, 1, { len: 3.5 });
  inst.brass(4 * BAR, BAR * 1.6, 50, 1.3);
  inst.brass(4 * BAR, BAR * 1.6, 57, 1.1, { pan: 0.3 });
  inst.brass(4 * BAR, BAR * 1.6, 62, 1.0, { pan: -0.3 });
  // A drum fill out of the logo into the music.
  for (let k = 0; k < 8; k++) drum.tom(5 * BAR + BAR / 2 + (k * BAR) / 16, 50 - k * 1.5, 0.5 + k * 0.06, { pan: (k / 7 - 0.5) * 0.8 });
  drum.impact(51 * BAR, 1.2);
  drum.crash(51 * BAR, 1, { len: 4 });
  inst.brass(51 * BAR, BAR * 1.5, 50, 1.2);
  inst.brass(51 * BAR, BAR * 1.5, 57, 1.0, { pan: 0.3 });
  drum.impact((TOTAL - 1) * BAR + BAR * 0.5, 0.5);

  // Intro: a soft opening bell motif, and the swell into the logo.
  [[74, 0.5], [69, 1.25], [77, 2.0], [76, 2.75], [74, 4.5], [81, 5.2], [79, 6.0]].forEach(([m, at]) => inst.bell(at, 0.6, m, 0.8, { pan: Math.sin(at) * 0.4 }));

  // Melodies.
  playLine(THEME_A, 8, { vel: 0.9, pan: 0.1 });
  playLine(THEME_B, 12, { vel: 0.95, pan: 0.1 });
  playLine(FAR_LINE, 16, { vel: 0.75, tone: 'tri', pan: -0.1 });
  playLine(THEME_A, 31, { vel: 1, pan: 0.1, harmony: 3 });
  playLine(THEME_B, 35, { vel: 1.05, pan: 0.1, harmony: 3 });
  playLine(THEME_A, 39, { vel: 1.05, pan: 0.1, harmony: 4 });
  brassLine(THEME_A, 31, 0.6);
  brassLine(THEME_B, 35, 0.65);
  brassLine(THEME_A, 39, 0.7);
  playLine(THEME_A, 45, { vel: 0.8, tone: 'tri', pan: 0.1 });
  playLine(END_LINE, 51.5, { vel: 0.85, tone: 'tri' });

  // Sound effects on the picture: a whoosh for each title, chimes as the weapon grows.
  for (const title of TITLES) drum.whoosh(title.at * BAR - 0.25, 0.8);
  const evolve = shots.find((s) => s.id === 'evolve');
  if (evolve) {
    for (let k = 0; k < 5; k++) {
      const at = evolve.start + 0.35 + k * 0.95;
      [0, 4, 7, 12].forEach((iv, j) => inst.bell(at + j * 0.03, 0.5, 74 + k * 2 + iv, 0.6 + k * 0.1, { pan: (j - 1.5) * 0.3 }));
      if (k >= 3) drum.impact(at, 0.35 + (k - 3) * 0.25);
    }
  }
  // The chest's roll ticks, then the reveal.
  const chest = shots.find((s) => s.id === 'chest');
  if (chest) {
    for (let k = 0; k < 40; k++) {
      const p = k / 40;
      const at = chest.start + 0.9 + 2.6 * (1 - (1 - p) ** 2);
      inst.bell(at, 0.05, 98, 0.18, { pan: 0.2 });
    }
    [74, 78, 81, 86].forEach((m, j) => inst.bell(chest.start + 4.0 + j * 0.07, 0.8, m, 0.9, { pan: (j - 1.5) * 0.3 }));
  }
}

// --- Effects and the master -----------------------------------------------------------------------------------

/** A ping-pong delay (dotted eighth), fed from the echo bus into the mix. */
function delay() {
  const d = Math.round(BEAT * 0.75 * RATE);
  const L = new Float32Array(echo.n);
  const R = new Float32Array(echo.n);
  for (let i = 0; i < echo.n; i++) {
    const fbL = i >= d ? R[i - d] * 0.42 : 0;
    const fbR = i >= d ? L[i - d] * 0.42 : 0;
    L[i] = echo.L[i] + fbR;
    R[i] = echo.R[i] * 0.3 + fbL;
    dry.L[i] += L[i] * 0.35;
    dry.R[i] += R[i] * 0.35;
    verb.L[i] += L[i] * 0.1;
    verb.R[i] += R[i] * 0.1;
  }
}

/** A Schroeder reverb: four combs and two all-passes a side. */
function reverb() {
  // (Only the mids and highs ring: a reverb full of bass is mud.)
  highpass(verb.L, 180);
  highpass(verb.R, 180);
  const combs = [1557, 1617, 1491, 1422];
  const aps = [225, 556];
  for (const [src, side] of [[verb.L, 0], [verb.R, 1]]) {
    const outBuf = new Float32Array(src.length);
    for (const c of combs) {
      const len = c + side * 23;
      const buf = new Float32Array(len);
      let idx = 0;
      let lp = 0;
      for (let i = 0; i < src.length; i++) {
        const y = buf[idx];
        lp = y * 0.75 + lp * 0.25;
        buf[idx] = src[i] + lp * 0.84;
        idx = (idx + 1) % len;
        outBuf[i] += y * 0.25;
      }
    }
    for (const a of aps) {
      const len = a + side * 11;
      const buf = new Float32Array(len);
      let idx = 0;
      for (let i = 0; i < outBuf.length; i++) {
        const b = buf[idx];
        const x = outBuf[i];
        buf[idx] = x + b * 0.5;
        outBuf[i] = b - x * 0.5;
        idx = (idx + 1) % len;
      }
    }
    const dst = side ? dry.R : dry.L;
    for (let i = 0; i < dst.length; i++) dst[i] += outBuf[i] * 0.9;
  }
}

function master() {
  highpass(dry.L, 28);
  highpass(dry.R, 28);
  // A gentle bus compressor, a soft clip, then normalise to -1 dBFS.
  let env = 0;
  const att = Math.exp(-1 / (0.005 * RATE));
  const rel = Math.exp(-1 / (0.2 * RATE));
  for (let i = 0; i < dry.n; i++) {
    const lvl = Math.max(Math.abs(dry.L[i]), Math.abs(dry.R[i]));
    env = lvl > env ? att * env + (1 - att) * lvl : rel * env + (1 - rel) * lvl;
    const over = Math.max(0, env - 0.5);
    const gain = 1 / (1 + over * 1.5);
    dry.L[i] = Math.tanh(dry.L[i] * gain * 1.1);
    dry.R[i] = Math.tanh(dry.R[i] * gain * 1.1);
  }
  let peak = 0;
  for (let i = 0; i < dry.n; i++) peak = Math.max(peak, Math.abs(dry.L[i]), Math.abs(dry.R[i]));
  const g = peak > 0 ? 0.89 / peak : 1;
  // Fade in from silence and out at the very end.
  const fadeOut = Math.round(1.2 * RATE);
  const endAt = Math.round(DURATION * RATE);
  for (let i = 0; i < dry.n; i++) {
    let f = g;
    if (i > endAt - fadeOut) f *= Math.max(0, (endAt - i) / fadeOut) ** 0.5;
    dry.L[i] *= f;
    dry.R[i] *= f;
  }
}

function wav(path) {
  const n = dry.n;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, dry.L[i])) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, dry.R[i])) * 32767), 46 + i * 4);
  }
  writeFileSync(path, buf);
}

let written = false;
/** Composes and writes the soundtrack (once per run). */
export function writeSoundtrack(path) {
  if (!written) {
    compose();
    delay();
    reverb();
    master();
    written = true;
  }
  wav(path);
  return path;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2] ?? 'soundtrack.wav';
  const t0 = Date.now();
  writeSoundtrack(path);
  console.log(`${path}: ${DURATION.toFixed(1)} s in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
