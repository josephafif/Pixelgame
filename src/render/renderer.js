// Renders the game into a small low-resolution buffer (a few hundred game
// pixels across) that is then scaled up by an integer factor. Everything —
// including rotated weapons — lands on the same pixel grid, it stays cheap
// on phones, and the view adapts to any screen size or orientation.

import { createCanvas, ctx2d } from './canvas.js';
import { renderChunk, TILE_PX } from './tiles-art.js';
import { CHUNK } from '../game/world.js';
import { playerSprites, objectSprite, pickupSprite, tintedSprite } from './sprites.js';
import { weaponSprite, weaponIcon } from './weapon-sprite.js';
import { drawPixelText } from './font.js';

const T = TILE_PX;
const TARGET_SHORT_SIDE = 230; // game pixels on the shorter screen side
const NEW_CHUNKS_PER_FRAME = 4;
const TAU = Math.PI * 2;

const glowCache = new Map();
function glowSprite(color) {
  let c = glowCache.get(color);
  if (!c) {
    c = createCanvas(32, 32);
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    glowCache.set(color, c);
  }
  return c;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = ctx2d(canvas);
    this.view = createCanvas(1, 1);
    this.v = ctx2d(this.view);
    this.resolution = 1;
    this.camX = 0;
    this.camY = 0;
    this.camInit = false;
    this.iconCache = new Map();
    this.resize();
    addEventListener('resize', () => this.resize());
    screen.orientation?.addEventListener?.('change', () => setTimeout(() => this.resize(), 100));
  }

  setResolution(r) {
    this.resolution = r;
    this.resize();
  }

  resize() {
    const cssW = this.canvas.clientWidth || innerWidth;
    const cssH = this.canvas.clientHeight || innerHeight;
    const dpr = this.resolution < 1 ? 1 : Math.min(devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(cssW * dpr));
    this.canvas.height = Math.max(1, Math.round(cssH * dpr));
    this.scale = Math.max(2, Math.round(Math.min(this.canvas.width, this.canvas.height) / TARGET_SHORT_SIDE));
    this.view.width = Math.ceil(this.canvas.width / this.scale);
    this.view.height = Math.ceil(this.canvas.height / this.scale);
    this.ctx = ctx2d(this.canvas);
    this.v = ctx2d(this.view);
  }

  /** World (tile units) → CSS pixels, used for mouse/touch aiming. */
  worldToScreen(x, y) {
    return {
      x: ((x * T - this.camX) * this.scale) / this.dpr,
      y: ((y * T - this.camY) * this.scale) / this.dpr,
    };
  }

  #icon(dna) {
    let c = this.iconCache.get(dna.id);
    if (!c) {
      c = weaponIcon(dna, 32);
      this.iconCache.set(dna.id, c);
      if (this.iconCache.size > 80) this.iconCache.delete(this.iconCache.keys().next().value);
    }
    return c;
  }

  draw(game) {
    this.game = game;
    const v = this.v;
    const W = this.view.width;
    const H = this.view.height;
    const p = game.player;

    // Camera follows the player smoothly; shake is cosmetic only.
    const tx = p.x * T - W / 2;
    const ty = p.y * T - H / 2;
    if (!this.camInit) {
      this.camX = tx;
      this.camY = ty;
      this.camInit = true;
    }
    this.camX += (tx - this.camX) * 0.18;
    this.camY += (ty - this.camY) * 0.18;
    let sx = 0;
    let sy = 0;
    if (game.shake > 0 && game.save.settings.screenShake) {
      sx = (Math.random() - 0.5) * game.shake * 10;
      sy = (Math.random() - 0.5) * game.shake * 10;
    }
    const cx = Math.round(this.camX + sx);
    const cy = Math.round(this.camY + sy);
    this.cx = cx;
    this.cy = cy;

    v.globalAlpha = 1;
    v.globalCompositeOperation = 'source-over';
    v.fillStyle = '#10101a';
    v.fillRect(0, 0, W, H);

    this.#drawWorld(game, cx, cy, W, H);
    this.#drawAreas(game);
    this.#drawEntities(game);
    this.#drawProjectiles(game);
    this.#drawShapes(game);
    this.#drawParticles(game);
    this.#drawTexts(game);
    this.#drawCompass(game, W, H);
    if (p.hurtFlash > 0) {
      v.fillStyle = `rgba(255,40,40,${p.hurtFlash})`;
      v.fillRect(0, 0, W, H);
    }

    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.view, 0, 0, W * this.scale, H * this.scale);
  }

  #sx(x) {
    return Math.round(x * T - this.cx);
  }

  #sy(y) {
    return Math.round(y * T - this.cy);
  }

  #drawWorld(game, cx, cy, W, H) {
    const size = CHUNK * T;
    const c0 = Math.floor(cx / size);
    const c1 = Math.floor((cx + W) / size);
    const r0 = Math.floor(cy / size);
    const r1 = Math.floor((cy + H) / size);
    let rendered = 0;
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const chunk = game.world.getChunk(col, row);
        if (!chunk.canvas && rendered < NEW_CHUNKS_PER_FRAME) {
          chunk.canvas = renderChunk(chunk);
          rendered += 1;
        }
        if (chunk.canvas) this.v.drawImage(chunk.canvas, col * size - cx, row * size - cy);
      }
    }
  }

  #glow(x, y, color, radius) {
    if (!this.game?.quality.glow) return;
    const v = this.v;
    v.globalCompositeOperation = 'lighter';
    v.globalAlpha = 0.5;
    v.drawImage(glowSprite(color), x - radius, y - radius, radius * 2, radius * 2);
    v.globalAlpha = 1;
    v.globalCompositeOperation = 'source-over';
  }

  #circle(x, y, r, fill, stroke, alpha = 1) {
    const v = this.v;
    v.globalAlpha = alpha;
    v.beginPath();
    v.arc(x, y, Math.max(0.5, r), 0, TAU);
    if (fill) {
      v.fillStyle = fill;
      v.fill();
    }
    if (stroke) {
      v.strokeStyle = stroke;
      v.lineWidth = 1;
      v.stroke();
    }
    v.globalAlpha = 1;
  }

  #drawAreas(game) {
    const v = this.v;
    for (const a of game.areas) {
      const x = this.#sx(a.x);
      const y = this.#sy(a.y);
      const r = a.r * T;
      const fade = Math.min(1, (a.dur - a.t) * 3);
      switch (a.kind) {
        case 'portal': {
          this.#circle(x, y, r * (a.big ? 1 : 0.8), 'rgba(20,6,40,0.75)', null, 0.8 * fade);
          v.strokeStyle = a.color;
          v.globalAlpha = fade;
          for (let k = 0; k < 3; k++) {
            v.beginPath();
            const rot = a.t * 4 + k * 2.1;
            v.arc(x, y, r * (0.35 + k * 0.22), rot, rot + 2);
            v.stroke();
          }
          v.globalAlpha = 1;
          this.#glow(x, y, a.color, r);
          break;
        }
        case 'cloud':
        case 'hazard':
          this.#circle(x, y, r, a.lava || a.element === 'fire' ? '#ff5a1a' : a.color, null, 0.28 * fade);
          this.#circle(x, y, r * 0.6, a.lava || a.element === 'fire' ? '#ffb040' : a.color, null, 0.18 * fade);
          break;
        case 'timewarp':
          this.#circle(x, y, r, a.color, a.color, 0.12 * fade);
          v.strokeStyle = a.color;
          v.globalAlpha = 0.6 * fade;
          v.beginPath();
          v.moveTo(x, y);
          v.lineTo(x + Math.cos(a.t * 2) * r * 0.8, y + Math.sin(a.t * 2) * r * 0.8);
          v.stroke();
          v.globalAlpha = 1;
          break;
        case 'bladering': {
          const n = a.count ?? 3;
          for (let k = 0; k < n; k++) {
            const ang = a.t * 5 + (k / n) * TAU;
            const bx = x + Math.cos(ang) * r;
            const by = y + Math.sin(ang) * r;
            v.save();
            v.translate(bx, by);
            v.rotate(ang + Math.PI);
            v.fillStyle = '#161622';
            v.fillRect(-4, -2, 9, 4);
            v.fillStyle = a.color;
            v.fillRect(-3, -1, 7, 2);
            v.restore();
            this.#glow(bx, by, a.color, 6);
          }
          break;
        }
        case 'quake': {
          const rr = r * Math.min(1, a.t / a.dur);
          this.#circle(x, y, rr, null, '#e8c890', 1 - a.t / a.dur);
          this.#circle(x, y, rr - 2, null, '#a8804a', 1 - a.t / a.dur);
          break;
        }
        case 'telegraph': {
          const k = a.t / a.dur;
          v.globalAlpha = 0.25 + 0.35 * k;
          if (a.shape === 'line') {
            const x2 = this.#sx(a.x2);
            const y2 = this.#sy(a.y2);
            v.strokeStyle = '#ff3a3a';
            v.lineWidth = a.r * T * 2;
            v.beginPath();
            v.moveTo(x, y);
            v.lineTo(x2, y2);
            v.stroke();
            v.lineWidth = 1;
          } else {
            this.#circle(x, y, r, '#ff3a3a', null, 0.18 + 0.3 * k);
            this.#circle(x, y, r * k, '#ff7a3a', null, 0.25);
            this.#circle(x, y, r, null, '#ffd0d0', 0.8);
          }
          v.globalAlpha = 1;
          break;
        }
        default:
          break;
      }
    }
  }

  #shadow(x, y, w) {
    const v = this.v;
    v.globalAlpha = 0.28;
    v.fillStyle = '#000';
    v.beginPath();
    v.ellipse(x, y, w, Math.max(1, w * 0.4), 0, 0, TAU);
    v.fill();
    v.globalAlpha = 1;
  }

  #drawEntities(game) {
    const list = [];
    const p = game.player;
    for (const o of game.world.objectsNear(p.x, p.y, 2)) list.push({ y: o.y, kind: 'object', o });
    for (const it of game.pickups) list.push({ y: it.y, kind: 'pickup', o: it });
    for (const e of game.enemies) if (!e.dead) list.push({ y: e.y, kind: 'enemy', o: e });
    for (const a of game.allies) list.push({ y: a.y, kind: 'ally', o: a });
    if (!p.dead) list.push({ y: p.y, kind: 'player', o: p });
    list.sort((a, b) => a.y - b.y);
    const W = this.view.width;
    const H = this.view.height;
    for (const d of list) {
      const x = this.#sx(d.o.x);
      const y = this.#sy(d.o.y);
      if (x < -48 || y < -64 || x > W + 48 || y > H + 64) continue;
      switch (d.kind) {
        case 'object': this.#drawObject(game, d.o, x, y); break;
        case 'pickup': this.#drawPickup(game, d.o, x, y); break;
        case 'enemy': this.#drawEnemy(game, d.o, x, y); break;
        case 'ally': this.#drawCharacter(game, d.o, x, y, true); break;
        case 'player': this.#drawCharacter(game, p, x, y, false); break;
        default: break;
      }
    }
    if (game.interactTarget) {
      const o = game.interactTarget;
      const x = this.#sx(o.x);
      const y = this.#sy(o.y) - 20 + Math.round(Math.sin(game.time * 6) * 2);
      const v = this.v;
      v.fillStyle = '#161622';
      v.fillRect(x - 3, y - 1, 7, 5);
      v.fillStyle = '#ffe890';
      v.fillRect(x - 2, y, 5, 1);
      v.fillRect(x - 1, y + 1, 3, 1);
      v.fillRect(x, y + 2, 1, 1);
    }
  }

  #drawObject(game, o, x, y) {
    const v = this.v;
    switch (o.type) {
      case 'chest': {
        const open = game.save.world.chests.includes(o.key);
        const s = objectSprite(open ? 'chestOpen' : 'chest');
        this.#shadow(x, y + 3, 6);
        v.drawImage(s, x - 6, y - 7);
        if (!open) this.#glow(x, y - 2, '#ffd24a', 10);
        break;
      }
      case 'shrine': {
        const used = game.save.world.shrines.includes(o.key);
        const s = objectSprite('shrine', used ? '#6a6a7a' : '#7ae0ff');
        this.#shadow(x, y + 5, 5);
        v.drawImage(s, x - 5, y - 11);
        if (!used) {
          this.#glow(x, y - 8, '#7ae0ff', 12);
          if (Math.random() < 0.1) game.fx.emit('holy', o.x, o.y - 0.6, 1, 0.3, 0.5);
        }
        break;
      }
      case 'altar': {
        const boss = game.data.byId.bosses.get(o.bossId);
        const defeated = game.save.bosses.defeated[o.bossId];
        const s = objectSprite('altar', boss.color);
        v.drawImage(s, x - 8, y - 6);
        this.#glow(x, y - 2, boss.color, defeated ? 8 : 16 + Math.sin(game.time * 3) * 3);
        if (!game.boss && Math.random() < 0.15) game.fx.emit(game.data.byId.elements.get(boss.element)?.particles ?? 'sparkle', o.x, o.y - 0.3, 1, 0.8, 0.6);
        break;
      }
      case 'camp': {
        const s = objectSprite('campfire');
        v.drawImage(s, x - 5, y - 6);
        this.#glow(x, y - 3, '#ff9a3a', 18 + Math.sin(game.time * 9) * 2);
        if (Math.random() < 0.3) game.fx.emit('ember', o.x, o.y - 0.3, 1, 0.2, 0.4);
        break;
      }
      default:
        break;
    }
  }

  #drawPickup(game, it, x, y) {
    const v = this.v;
    const bob = Math.round(Math.sin(it.t * 4 + x) * 1.5);
    if (it.kind === 'weapon') {
      const icon = this.#icon(it.dna);
      this.#shadow(x, y + 4, 6);
      this.#glow(x, y - 6 + bob, it.color, 14);
      v.drawImage(icon, x - 16, y - 22 + bob);
      return;
    }
    const kind = it.kind === 'essence' ? 'essence' : it.kind;
    const s = pickupSprite(kind, it.color);
    this.#shadow(x, y + 2, 2);
    v.drawImage(s, x - (s.width >> 1), y - s.height - 1 + bob);
    if (it.kind === 'component') this.#glow(x, y - 4 + bob, it.color, 10);
  }

  #healthBar(x, y, w, frac, color) {
    const v = this.v;
    v.fillStyle = '#161622';
    v.fillRect(x - (w >> 1) - 1, y - 1, w + 2, 4);
    v.fillStyle = '#3a2a2a';
    v.fillRect(x - (w >> 1), y, w, 2);
    v.fillStyle = color;
    v.fillRect(x - (w >> 1), y, Math.max(1, Math.round(w * frac)), 2);
  }

  #drawEnemy(game, e, x, y) {
    const v = this.v;
    const set = e.sprites;
    let img = e.facing < 0 ? set.left : set.right;
    if (e.flash > 0) img = set.flash;
    else if (e.tint) img = tintedSprite(img, e.tint, e.frozen ? 0.7 : 0.4);
    else if (e.elite) img = tintedSprite(img, '#ffd24a', 0.18);
    const bob = e.boss ? Math.round(Math.sin(game.time * 3) * 1.5) : e.stunned ? 0 : Math.round(Math.sin(game.time * 8 + e.phase) * 1);
    const scale = e.scale ?? 1;
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    this.#shadow(x, y + 1, Math.max(4, w * 0.4));
    if (e.state === 'windup' && Math.floor(game.time * 16) % 2) v.globalAlpha = 0.6;
    v.drawImage(img, x - (w >> 1), y - h + 2 + bob, w, h);
    v.globalAlpha = 1;
    if (e.boss || e.elite || (e.element && e.element !== 'physical')) {
      const glow = game.data.byId.elements.get(e.element)?.glow;
      if (glow && (e.boss || e.elite)) this.#glow(x, y - h / 2, glow, e.boss ? 30 : 10);
    }
    if (!e.boss && e.hp < e.maxHp) this.#healthBar(x, y - h - 2, e.elite ? 16 : 12, e.hp / e.maxHp, e.elite ? '#ffd24a' : '#ff5050');
  }

  #drawCharacter(game, c, x, y, isClone) {
    const v = this.v;
    const sprites = playerSprites(isClone ? '#9a5cff' : '#3f6fd8');
    const right = Math.cos(c.facing) >= 0;
    const frame = c.moving ? 1 + (Math.floor(c.walkT) % 2) : 0;
    let img = (right ? sprites.right : sprites.left)[isClone ? 0 : frame];
    if (!isClone && c.hurtFlash > 0) img = sprites.flash;
    const bob = c.moving ? (Math.floor(c.walkT) % 2) : 0;
    this.#shadow(x, y + 1, 5);
    const facingUp = Math.sin(c.facing) < -0.4;
    if (isClone) v.globalAlpha = 0.65;
    else if (c.invuln > 0 && Math.floor(game.time * 20) % 2) v.globalAlpha = 0.5;
    if (facingUp) this.#drawHeldWeapon(game, c, x, y - 6 - bob, isClone);
    v.drawImage(img, x - 5, y - 12 - bob);
    if (!facingUp) this.#drawHeldWeapon(game, c, x, y - 6 - bob, isClone);
    v.globalAlpha = 1;
  }

  #drawHeldWeapon(game, c, x, y, isClone) {
    const w = game.weapon;
    if (!w) return;
    const v = this.v;
    const spr = weaponSprite(w.dna);
    const anim = isClone ? (game.time - (c.attackT ?? -1) < 0.15 ? { t: game.time - c.attackT, dur: 0.15, angle: c.facing } : null) : c.attackAnim;
    let angle = c.facing;
    let reach = 3;
    const pattern = w.attack.pattern;
    if (anim) {
      const k = Math.min(1, anim.t / anim.dur);
      angle = anim.angle;
      if (pattern === 'swing' || pattern === 'lash') {
        const arc = ((w.attack.arc ?? 120) * Math.PI) / 180;
        angle += -arc / 2 + arc * k;
      } else if (pattern === 'thrust') {
        reach += Math.sin(k * Math.PI) * 8;
      } else if (pattern === 'slam') {
        angle += (k < 0.5 ? -1.2 + k * 2.4 : 0);
      } else {
        reach -= Math.sin(k * Math.PI) * 2;
      }
    }
    const hx = x + Math.cos(angle) * reach;
    const hy = y + Math.sin(angle) * reach;
    const drawAt = (ox, oy, alpha) => {
      v.save();
      v.globalAlpha *= alpha;
      v.translate(hx + ox, hy + oy);
      v.rotate(angle + Math.PI / 2);
      v.scale(0.75, 0.75);
      v.drawImage(spr.canvas, -spr.pivotX, -spr.pivotY);
      v.restore();
    };
    if (w.dna.visual.distortion && game.quality.glow) {
      drawAt((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, 0.35);
    }
    drawAt(0, 0, 1);
    if (w.dna.visual.glow && w.dna.visual.palette.glow) {
      this.#glow(hx + Math.cos(angle) * 10, hy + Math.sin(angle) * 10, w.dna.visual.palette.glow, 12);
    }
  }

  #drawProjectiles(game) {
    const v = this.v;
    for (const p of game.projectiles) {
      const x = this.#sx(p.x);
      const y = this.#sy(p.y) - 4 - Math.round((p.z ?? 0) * T);
      const ang = Math.atan2(p.vy, p.vx);
      const enemy = p.owner === 'enemy';
      const color = p.color;
      if (enemy) {
        this.#circle(x, y, p.size + 1, '#161622', null, 1);
        this.#circle(x, y, p.size, color, null, 1);
        this.#circle(x, y, Math.max(0.5, p.size - 1.5), '#ffffff', null, 0.8);
        this.#glow(x, y, color, 8);
        continue;
      }
      if (p.kind === 'lob') this.#shadow(this.#sx(p.x), this.#sy(p.y), 3);
      v.save();
      v.translate(x, y);
      switch (p.sprite) {
        case 'arrow':
        case 'bolt':
        case 'knife':
        case 'blade':
        case 'leafblade':
        case 'shard':
          v.rotate(ang);
          v.fillStyle = '#161622';
          v.fillRect(-5, -1, 10, 3);
          v.fillStyle = p.sprite === 'arrow' ? '#c8a878' : color;
          v.fillRect(-4, 0, 7, 1);
          v.fillStyle = '#ffffff';
          v.fillRect(3, 0, 2, 1);
          break;
        case 'bullet':
          v.fillStyle = '#161622';
          v.fillRect(-2, -2, 4, 4);
          v.fillStyle = '#fff4c0';
          v.fillRect(-1, -1, 2, 2);
          break;
        case 'boomerang':
        case 'chakram':
          v.rotate(p.spin);
          v.fillStyle = '#161622';
          v.fillRect(-5, -2, 10, 4);
          v.fillRect(-2, -5, 4, 10);
          v.fillStyle = color;
          v.fillRect(-4, -1, 8, 2);
          v.fillRect(-1, -4, 2, 8);
          break;
        case 'wave':
          v.rotate(ang);
          v.strokeStyle = color;
          v.lineWidth = 2;
          v.beginPath();
          v.arc(-4, 0, 6, -1, 1);
          v.stroke();
          v.lineWidth = 1;
          break;
        case 'ball':
          this.#circle(0, 0, 3, '#161622', null);
          this.#circle(-1, -1, 1, '#8a8a96', null);
          break;
        default: {
          const r = Math.max(1.5, p.size * 0.9);
          this.#circle(0, 0, r + 1, '#161622', null, 0.9);
          this.#circle(0, 0, r, color, null, 1);
          this.#circle(0, 0, Math.max(0.5, r - 1.5), '#ffffff', null, 0.9);
        }
      }
      v.restore();
      this.#glow(x, y, color, 7 + p.size);
    }
  }

  #drawShapes(game) {
    const v = this.v;
    for (const s of game.fx.shapes) {
      const k = s.t / s.dur;
      const x = this.#sx(s.x ?? 0);
      const y = this.#sy(s.y ?? 0);
      const alpha = (1 - k) * (s.ghost ? 0.45 : 1);
      v.globalAlpha = Math.max(0, alpha);
      switch (s.type) {
        case 'slash': {
          const r = s.r * T * 0.85;
          v.strokeStyle = s.color;
          v.lineWidth = s.thin ? 1 : Math.max(1, 3 - k * 3);
          v.beginPath();
          const start = s.angle - s.arc / 2;
          v.arc(x, y - 5, r, start, start + s.arc * Math.min(1, k * 2.5));
          v.stroke();
          v.strokeStyle = '#ffffff';
          v.lineWidth = 1;
          v.beginPath();
          v.arc(x, y - 5, r - 1, start, start + s.arc * Math.min(1, k * 2.5));
          v.stroke();
          break;
        }
        case 'thrust': {
          const len = s.r * T;
          v.strokeStyle = s.color;
          v.lineWidth = 2;
          v.beginPath();
          v.moveTo(x, y - 5);
          v.lineTo(x + Math.cos(s.angle) * len, y - 5 + Math.sin(s.angle) * len);
          v.stroke();
          v.lineWidth = 1;
          break;
        }
        case 'ring': {
          const r = (s.r0 + (s.r1 - s.r0) * Math.min(1, k * 1.6)) * T;
          if (s.fill) this.#circle(x, y, r, s.color, null, 0.25 * (1 - k));
          v.globalAlpha = 1 - k;
          this.#circle(x, y, r, null, s.color, 1 - k);
          this.#glow(x, y, s.color, r);
          break;
        }
        case 'line': {
          v.strokeStyle = s.color;
          v.lineWidth = 2;
          v.beginPath();
          s.points.forEach(([px, py], i) => {
            let lx = this.#sx(px);
            let ly = this.#sy(py) - 5;
            if (s.jagged && i > 0) {
              const [qx, qy] = s.points[i - 1];
              const mx = (this.#sx(qx) + lx) / 2 + (Math.random() - 0.5) * 8;
              const my = (this.#sy(qy) - 5 + ly) / 2 + (Math.random() - 0.5) * 8;
              v.lineTo(mx, my);
            }
            if (i === 0) v.moveTo(lx, ly);
            else v.lineTo(lx, ly);
          });
          v.stroke();
          v.lineWidth = 1;
          break;
        }
        case 'bolt': {
          v.strokeStyle = s.color;
          v.lineWidth = 2;
          v.beginPath();
          let bx = x;
          v.moveTo(bx, y - 60);
          for (let i = 1; i <= 6; i++) {
            bx = x + (Math.random() - 0.5) * 8;
            v.lineTo(bx, y - 60 + i * 10);
          }
          v.stroke();
          v.lineWidth = 1;
          this.#glow(x, y, s.color, 16);
          break;
        }
        case 'pillar': {
          const w = Math.max(4, s.r * T);
          v.fillStyle = s.color;
          v.fillRect(x - w / 2, y - 64, w, 64);
          v.fillStyle = '#ffffff';
          v.fillRect(x - w / 6, y - 64, w / 3, 64);
          this.#glow(x, y, s.color, 18);
          break;
        }
        case 'spike': {
          const h = Math.round(Math.sin(Math.min(1, k * 2) * Math.PI) * 10);
          v.fillStyle = '#161622';
          v.beginPath();
          v.moveTo(x - 5, y);
          v.lineTo(x, y - h - 1);
          v.lineTo(x + 5, y);
          v.fill();
          v.fillStyle = s.color;
          v.beginPath();
          v.moveTo(x - 4, y);
          v.lineTo(x, y - h);
          v.lineTo(x + 4, y);
          v.fill();
          break;
        }
        case 'marker':
          v.globalAlpha = 0.7;
          this.#circle(x, y, s.r * T, null, s.color, 0.8);
          this.#circle(x, y, s.r * T * k, s.color, null, 0.25);
          break;
        case 'meteor': {
          const mx = x + (1 - k) * 60;
          const my = y - (1 - k) * 90;
          v.globalAlpha = 1;
          this.#circle(mx, my, 5, '#161622', null);
          this.#circle(mx, my, 4, s.color, null);
          this.#glow(mx, my, s.color, 16);
          game.fx.emit('ember', (mx + this.cx) / T, (my + this.cy) / T, 1, 0.2, 0.5);
          break;
        }
        case 'beam':
          v.globalAlpha = 0.35 * (1 - k);
          v.fillStyle = s.color;
          v.fillRect(x - 2, y - 80, 5, 80);
          break;
        case 'flash':
          this.#circle(x, y, s.r * T, s.color, null, 0.7 * (1 - k));
          break;
        default:
          break;
      }
      v.globalAlpha = 1;
    }
  }

  #drawParticles(game) {
    const v = this.v;
    for (const p of game.fx.particles) {
      v.globalAlpha = Math.min(1, p.life / p.max + 0.2);
      v.fillStyle = p.color;
      v.fillRect(Math.round(p.x * T - this.cx), Math.round(p.y * T - this.cy), p.size, p.size);
    }
    v.globalAlpha = 1;
  }

  #drawTexts(game) {
    for (const t of game.fx.texts) {
      drawPixelText(this.v, t.text, t.x * T - this.cx, t.y * T - this.cy - 8, t.color);
    }
  }

  #drawCompass(game, W, H) {
    const hud = game.lastCompass;
    if (!hud || hud.dist < 18) return;
    const v = this.v;
    const r = Math.min(W, H) / 2 - 14;
    const x = W / 2 + Math.cos(hud.angle) * r;
    const y = H / 2 + Math.sin(hud.angle) * r;
    v.save();
    v.translate(Math.round(x), Math.round(y));
    v.rotate(hud.angle);
    v.fillStyle = '#161622';
    v.beginPath();
    v.moveTo(7, 0);
    v.lineTo(-5, -5);
    v.lineTo(-5, 5);
    v.fill();
    v.fillStyle = hud.color ?? '#ffd24a';
    v.beginPath();
    v.moveTo(5, 0);
    v.lineTo(-4, -3);
    v.lineTo(-4, 3);
    v.fill();
    v.restore();
  }
}
