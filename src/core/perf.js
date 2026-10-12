// A frame profiler for hunting hitches. Off unless switched on (?perf=1 on
// your own machine, or `perf.on = true` from the console): then every frame
// is split into its parts (the simulation's and the drawing's), and the slow
// frames are kept with what took the time, newest last (`perf.slow`).

const now = () => performance.now();

export const perf = {
  on: false,
  /** Frames slower than this (ms) are kept. */
  threshold: 22,
  slow: [],
  frames: 0,
  cur: null,
  t: 0,

  frameStart() {
    if (!this.on) return;
    this.cur = { at: now(), parts: {}, counts: {} };
    this.t = this.cur.at;
  },

  /** Time since the last lap goes to `name`. */
  lap(name) {
    if (!this.cur) return;
    const t = now();
    this.cur.parts[name] = (this.cur.parts[name] ?? 0) + (t - this.t);
    this.t = t;
  },

  /** Counts something that happened this frame (chunks drawn, sprites made …). */
  count(name, n = 1) {
    if (this.cur) this.cur.counts[name] = (this.cur.counts[name] ?? 0) + n;
  },

  frameEnd() {
    const f = this.cur;
    if (!f) return;
    this.cur = null;
    this.frames++;
    const total = now() - f.at;
    if (total < this.threshold) return;
    const parts = Object.entries(f.parts).filter(([, ms]) => ms >= 1).sort((a, b) => b[1] - a[1])
      .map(([k, ms]) => `${k} ${ms.toFixed(1)}`);
    this.slow.push({ frame: this.frames, ms: +total.toFixed(1), parts: parts.join(', '), counts: f.counts });
    if (this.slow.length > 60) this.slow.shift();
  },
};
