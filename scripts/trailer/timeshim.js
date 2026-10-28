// Injected into the page before the game boots (record.mjs). It runs on
// real time until the recorder calls __vt.freeze(); from then on the page's
// clock only moves when the recorder says so (__vt.advance(ms)), so every
// captured frame is exactly 1/fps apart however long it took to draw.
// Covers performance.now, Date.now, requestAnimationFrame, timers, CSS
// animations and transitions (through the Web Animations API) and
// Math.random (seeded, so a take can be redone).
(() => {
  const realNow = performance.now.bind(performance);
  const realDateNow = Date.now;
  const realRaf = window.requestAnimationFrame.bind(window);
  const realCaf = window.cancelAnimationFrame.bind(window);
  const realSetTimeout = window.setTimeout.bind(window);
  const realClearTimeout = window.clearTimeout.bind(window);
  const realSetInterval = window.setInterval.bind(window);
  const realClearInterval = window.clearInterval.bind(window);

  let frozen = false;
  let vt = 0; // virtual performance.now(), ms
  let dateOffset = 0;
  let rafs = new Map();
  let nextId = 1 << 24;
  const timers = new Map();
  const anims = new WeakMap();

  // A seeded Math.random (mulberry32).
  let seed = 0x5eed;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  performance.now = () => (frozen ? vt : realNow());
  Date.now = () => (frozen ? Math.floor(vt + dateOffset) : realDateNow());

  window.requestAnimationFrame = (cb) => {
    if (!frozen) return realRaf(cb);
    const id = nextId++;
    rafs.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    if (rafs.delete(id)) return;
    realCaf(id);
  };
  window.setTimeout = (fn, ms = 0, ...args) => {
    if (!frozen) return realSetTimeout(fn, ms, ...args);
    const id = nextId++;
    timers.set(id, { at: vt + Math.max(0, Number(ms) || 0), fn, args, every: 0 });
    return id;
  };
  window.setInterval = (fn, ms = 0, ...args) => {
    if (!frozen) return realSetInterval(fn, ms, ...args);
    const id = nextId++;
    const every = Math.max(1, Number(ms) || 0);
    timers.set(id, { at: vt + every, fn, args, every });
    return id;
  };
  window.clearTimeout = (id) => {
    if (!timers.delete(id)) realClearTimeout(id);
  };
  window.clearInterval = (id) => {
    if (!timers.delete(id)) realClearInterval(id);
  };

  function runTimers(until) {
    for (;;) {
      let due = null;
      let dueId = 0;
      for (const [id, t] of timers) {
        if (t.at <= until && (!due || t.at < due.at)) {
          due = t;
          dueId = id;
        }
      }
      if (!due) return;
      vt = Math.max(vt, due.at);
      if (due.every) due.at += due.every;
      else timers.delete(dueId);
      try {
        if (typeof due.fn === 'function') due.fn(...due.args);
      } catch (err) {
        console.error('[timeshim] timer failed', err);
      }
    }
  }

  /** CSS animations and transitions follow the virtual clock. */
  function stepAnimations() {
    for (const a of document.getAnimations()) {
      let e = anims.get(a);
      if (!e) {
        window.__vt.onAnimation?.(a);
        e = { base: Number(a.currentTime) || 0, t0: vt };
        anims.set(a, e);
        a.pause();
      }
      a.currentTime = e.base + (vt - e.t0) * (a.playbackRate || 1);
    }
  }

  window.__vt = {
    get now() {
      return vt;
    },
    get frozen() {
      return frozen;
    },
    freeze() {
      if (frozen) return;
      vt = realNow();
      dateOffset = realDateNow() - vt;
      frozen = true;
    },
    /** Moves the clock on by `ms`: timers, then one animation frame. */
    advance(ms, beforeFrame) {
      const until = vt + ms;
      runTimers(until);
      vt = until;
      beforeFrame?.(vt);
      const due = rafs;
      rafs = new Map();
      for (const cb of due.values()) {
        try {
          cb(vt);
        } catch (err) {
          console.error('[timeshim] frame failed', err);
        }
      }
      stepAnimations();
    },
    seed(n) {
      seed = n | 0;
    },
  };
})();
