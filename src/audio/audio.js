// Procedural sound effects with WebAudio. Nothing is downloaded: every
// weapon's sound comes from the `sound` block of its DNA (waveform, pitch,
// decay, sweep), so no two weapon families sound alike.

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.volume = 0.7;
    this.enabled = true;
    this.last = new Map();
  }

  /** Must be called from a user gesture (browser autoplay rules). */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 0.5;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  configure({ volume, sfx }) {
    this.volume = volume;
    this.enabled = sfx;
    if (this.master) this.master.gain.value = volume;
  }

  suspend() {
    this.ctx?.suspend?.();
  }

  resume() {
    if (this.ctx?.state === 'suspended') this.ctx.resume();
  }

  #throttle(key, ms) {
    const now = performance.now();
    if (now - (this.last.get(key) ?? 0) < ms) return true;
    this.last.set(key, now);
    return false;
  }

  #tone({ wave = 'square', freq = 440, to = null, dur = 0.12, vol = 0.2, delay = 0 }) {
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(freq, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  #noiseBurst({ freq = 1200, q = 1, dur = 0.15, vol = 0.25, type = 'bandpass', delay = 0 }) {
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  get ready() {
    return Boolean(this.ctx && this.enabled && this.volume > 0);
  }

  /** Attack sound generated from weapon DNA. */
  weapon(sound) {
    if (!this.ready || this.#throttle('weapon', 45)) return;
    const { type, wave, pitch, decay, sweep } = sound;
    const to = pitch * (1 + sweep);
    switch (type) {
      case 'swish':
      case 'crack':
        this.#noiseBurst({ freq: pitch * 2.5, q: 2, dur: decay + 0.05, vol: 0.18, type: 'bandpass' });
        if (type === 'crack') this.#tone({ wave: 'square', freq: pitch, to: pitch * 0.5, dur: 0.05, vol: 0.12 });
        break;
      case 'chop':
      case 'thud':
        this.#noiseBurst({ freq: pitch * 2, q: 0.8, dur: decay + 0.08, vol: 0.28, type: 'lowpass' });
        this.#tone({ wave: 'triangle', freq: pitch, to: pitch * 0.5, dur: decay + 0.05, vol: 0.2 });
        break;
      case 'boom':
      case 'bang':
        this.#noiseBurst({ freq: pitch * 3, q: 0.5, dur: 0.25, vol: 0.35, type: 'lowpass' });
        this.#tone({ wave: 'sawtooth', freq: pitch, to: pitch * 0.4, dur: 0.18, vol: 0.18 });
        break;
      case 'twang':
        this.#tone({ wave: 'triangle', freq: pitch, to, dur: decay + 0.1, vol: 0.2 });
        break;
      case 'zap':
        this.#tone({ wave, freq: pitch, to: pitch * 1.8, dur: decay + 0.04, vol: 0.12 });
        break;
      case 'whirl':
      case 'hum':
      default:
        this.#tone({ wave, freq: pitch, to, dur: decay + 0.12, vol: 0.14 });
    }
    if (sound.shimmer) this.#tone({ wave: 'sine', freq: pitch * 4, to: pitch * 5, dur: 0.12, vol: 0.05, delay: 0.02 });
  }

  play(name, opts = {}) {
    if (!this.ready || this.#throttle(name, opts.throttle ?? 35)) return;
    switch (name) {
      case 'hit':
        this.#noiseBurst({ freq: 900, q: 1.5, dur: 0.06, vol: 0.16 });
        break;
      case 'crit':
        this.#tone({ wave: 'square', freq: 880, to: 1320, dur: 0.08, vol: 0.12 });
        this.#noiseBurst({ freq: 2000, q: 2, dur: 0.07, vol: 0.14 });
        break;
      case 'kill':
        this.#tone({ wave: 'square', freq: 320, to: 90, dur: 0.16, vol: 0.14 });
        break;
      case 'hurt':
        this.#tone({ wave: 'sawtooth', freq: 220, to: 110, dur: 0.18, vol: 0.2 });
        break;
      case 'pickup':
        this.#tone({ wave: 'square', freq: 660, to: 990, dur: 0.07, vol: 0.1 });
        break;
      case 'discover':
        [523, 659, 784, 1046].forEach((f, i) => this.#tone({ wave: 'square', freq: f, dur: 0.14, vol: 0.12, delay: i * 0.09 }));
        break;
      case 'levelup':
        [392, 523, 659, 784, 1046].forEach((f, i) => this.#tone({ wave: 'triangle', freq: f, dur: 0.16, vol: 0.16, delay: i * 0.07 }));
        break;
      case 'explode':
        this.#noiseBurst({ freq: 400, q: 0.6, dur: 0.35, vol: 0.32, type: 'lowpass' });
        break;
      case 'zap':
        this.#tone({ wave: 'sawtooth', freq: 1200, to: 300, dur: 0.12, vol: 0.1 });
        break;
      case 'boom':
        this.#noiseBurst({ freq: 180, q: 0.5, dur: 0.6, vol: 0.4, type: 'lowpass' });
        this.#tone({ wave: 'sine', freq: 90, to: 40, dur: 0.5, vol: 0.3 });
        break;
      case 'hum':
        this.#tone({ wave: 'sine', freq: 110, to: 60, dur: 0.8, vol: 0.2 });
        break;
      case 'whirl':
        this.#tone({ wave: 'triangle', freq: 500, to: 900, dur: 0.3, vol: 0.12 });
        break;
      case 'ui':
        this.#tone({ wave: 'square', freq: 740, dur: 0.04, vol: 0.06 });
        break;
      case 'chest':
        [440, 554, 659].forEach((f, i) => this.#tone({ wave: 'triangle', freq: f, dur: 0.1, vol: 0.12, delay: i * 0.06 }));
        break;
      case 'boss':
        this.#tone({ wave: 'sawtooth', freq: 70, to: 55, dur: 1.2, vol: 0.25 });
        break;
      default:
        break;
    }
  }
}
