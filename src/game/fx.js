// Visual effects: a pooled particle system plus short-lived shapes (rings,
// slashes, lightning lines, pillars) and floating damage numbers. Budgets
// shrink automatically on slower devices (see Game quality handling).

const PARTICLE_KINDS = {
  ember: { colors: ['#ffd36b', '#ff7b25', '#ff4a1a'], rise: -1.2, life: 0.6 },
  frost: { colors: ['#ffffff', '#bfeaff', '#8fd6ff'], rise: 0.3, life: 0.8 },
  spark: { colors: ['#fffbd0', '#ffe45c'], rise: 0, life: 0.25, jitter: 4 },
  toxic: { colors: ['#b8ff7a', '#79d23c'], rise: -0.5, life: 0.8 },
  blood: { colors: ['#ff3450', '#b01830'], rise: 1.5, life: 0.5 },
  void: { colors: ['#cdb2ff', '#9a5cff', '#3a1f6e'], rise: 0, life: 0.9, swirl: true },
  dust: { colors: ['#d9b27a', '#a8804a'], rise: 0.2, life: 0.6 },
  leaf: { colors: ['#bfffe6', '#7ad8a8'], rise: -0.2, life: 0.9, drift: 1.5 },
  holy: { colors: ['#fffef0', '#ffe9a3'], rise: -1.4, life: 0.7 },
  arcane: { colors: ['#ffd8fc', '#e05ce0', '#ff8cf5'], rise: -0.4, life: 0.7, swirl: true },
  sparkle: { colors: ['#ffffff', '#ffe890'], rise: -0.6, life: 0.6 },
  hit: { colors: ['#ffffff', '#ffe0a0'], rise: 0, life: 0.2 },
  smoke: { colors: ['#6a6470', '#4a4450'], rise: -0.8, life: 0.9 },
};

export class Fx {
  constructor() {
    this.maxParticles = 600;
    this.particles = [];
    this.free = [];
    this.shapes = [];
    this.texts = [];
    this.damageNumbers = true;
  }

  setBudget(max) {
    this.maxParticles = max;
    if (this.particles.length > max) this.particles.length = max;
  }

  emit(kind, x, y, count = 1, spread = 0.3, speed = 1.5) {
    const k = PARTICLE_KINDS[kind] ?? PARTICLE_KINDS.hit;
    for (let i = 0; i < count; i++) {
      if (this.particles.length >= this.maxParticles) return;
      const p = this.free.pop() ?? {};
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.8);
      p.x = x + (Math.random() - 0.5) * spread;
      p.y = y + (Math.random() - 0.5) * spread;
      p.vx = Math.cos(a) * s + (k.drift ? (Math.random() - 0.5) * k.drift : 0);
      p.vy = Math.sin(a) * s + k.rise;
      p.life = p.max = k.life * (0.6 + Math.random() * 0.6);
      p.color = k.colors[(Math.random() * k.colors.length) | 0];
      p.swirl = Boolean(k.swirl);
      p.jitter = k.jitter ?? 0;
      p.size = Math.random() < 0.25 ? 2 : 1;
      this.particles.push(p);
    }
  }

  /** Shapes: ring | slash | line | pillar | spike | flash. */
  add(shape) {
    shape.t = 0;
    this.shapes.push(shape);
    if (this.shapes.length > 160) this.shapes.shift();
  }

  number(x, y, value, { crit = false, color = '#ffffff', heal = false } = {}) {
    if (!this.damageNumbers && !heal) return;
    if (this.texts.length > 60) this.texts.shift();
    this.texts.push({
      x: x + (Math.random() - 0.5) * 0.4,
      y,
      vy: -1.6,
      life: crit ? 0.9 : 0.6,
      text: heal ? `+${value}` : crit ? `${value}!` : String(value),
      color: heal ? '#6cff8a' : crit ? '#ffd24a' : color,
    });
  }

  update(dt) {
    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.free.push(p);
        ps[i] = ps[ps.length - 1];
        ps.pop();
        continue;
      }
      if (p.swirl) {
        const vx = p.vx;
        p.vx = vx * 0.96 - p.vy * 0.08;
        p.vy = p.vy * 0.96 + vx * 0.08;
      }
      p.x += p.vx * dt + (p.jitter ? (Math.random() - 0.5) * p.jitter * dt : 0);
      p.y += p.vy * dt;
      p.vx *= 0.97;
      p.vy *= 0.97;
    }
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      const s = this.shapes[i];
      s.t += dt;
      if (s.t >= s.dur) this.shapes.splice(i, 1);
    }
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i];
      t.life -= dt;
      t.y += t.vy * dt;
      t.vy += 2.5 * dt;
      if (t.life <= 0) this.texts.splice(i, 1);
    }
  }

  clear() {
    this.particles.length = 0;
    this.shapes.length = 0;
    this.texts.length = 0;
  }
}
