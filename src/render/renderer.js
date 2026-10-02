// Renders the game into a small low-resolution buffer (a few hundred game
// pixels across) that is then scaled up by an integer factor. Everything —
// including rotated weapons — lands on the same pixel grid, it stays cheap
// on phones, and the view adapts to any screen size or orientation.

import { createCanvas, ctx2d } from './canvas.js';
import { renderChunk, TILE_PX } from './tiles-art.js';
import { boatSprite } from './boats.js';
import { CHUNK } from '../game/world.js';
import { playerSprites, objectSprite, pickupSprite, tintedSprite } from './sprites.js';
import { weaponSprite, weaponIcon } from './weapon-sprite.js';
import { weaponPose } from './weapon-anim.js';
import { buildingSprite, BUILDING_W, BUILDING_H } from './buildings.js';
import { buildingLevel, wellPending } from '../game/base.js';
import {
  structureSprite, isFlat, drawFlame, drawTurretHead, pickaxeSprite, STRUCT_H, LEFT, RIGHT, UP, DOWN,
} from './structures.js';
import { structureDef } from '../game/construction.js';
import { currentPickaxe } from '../game/gathering.js';
import { palSpecies } from '../game/pals.js';
import { palSprites } from './creatures.js';
import { drawPixelText } from './font.js';

const T = TILE_PX;
const shadeCache = new Map();
/** A lighter shade of a colour (cached; used for serpent scales). */
function shadeColor(hex) {
  let c = shadeCache.get(hex);
  if (!c) {
    const n = parseInt(hex.slice(1), 16);
    const lift = (v) => Math.min(255, Math.round(v + (255 - v) * 0.35));
    c = `rgb(${lift(n >> 16)},${lift((n >> 8) & 255)},${lift(n & 255)})`;
    shadeCache.set(hex, c);
  }
  return c;
}

const TARGET_SHORT_SIDE = 230; // game pixels on the shorter screen side
// View size setting → game pixels across the shorter side. 'auto' shows a
// little more on phones held upright, where the screen is narrow.
const VIEW_TARGETS = { close: 190, normal: TARGET_SHORT_SIDE, wide: 300 };
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

// Vertical light beam: bright at the bottom, fading upwards.
const beamCache = new Map();
function beamSprite(color, height) {
  const key = `${color}:${height}`;
  let c = beamCache.get(key);
  if (!c) {
    c = createCanvas(1, height);
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, height, 0, 0);
    grad.addColorStop(0, color);
    grad.addColorStop(0.6, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 1, height);
    beamCache.set(key, c);
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
    this.viewSize = 'auto';
    this.pan = { x: 0, y: 0 };
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

  setViewSize(size) {
    if (size === this.viewSize) return;
    this.viewSize = size;
    this.resize();
  }

  resize() {
    const cssW = this.canvas.clientWidth || innerWidth;
    const cssH = this.canvas.clientHeight || innerHeight;
    const dpr = this.resolution < 1 ? 1 : Math.min(devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(cssW * dpr));
    this.canvas.height = Math.max(1, Math.round(cssH * dpr));
    const phonePortrait = cssW <= 640 && cssH > cssW;
    const target = VIEW_TARGETS[this.viewSize] ?? (phonePortrait ? 270 : TARGET_SHORT_SIDE);
    this.scale = Math.max(2, Math.round(Math.min(this.canvas.width, this.canvas.height) / target));
    this.view.width = Math.ceil(this.canvas.width / this.scale);
    this.view.height = Math.ceil(this.canvas.height / this.scale);
    this.ctx = ctx2d(this.canvas);
    this.v = ctx2d(this.view);
  }

  /** Jump the camera to the player (after teleports). */
  snapCamera() {
    this.camInit = false;
  }

  /** CSS pixels → world (tile units). */
  screenToWorld(x, y) {
    return {
      x: ((x * this.dpr) / this.scale + (this.cx ?? 0)) / T,
      y: ((y * this.dpr) / this.scale + (this.cy ?? 0)) / T,
    };
  }

  /** World (tile units) → CSS pixels. */
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

    // Camera follows the player smoothly; shake is cosmetic only. `pan`
    // offsets it (the main menu drifts slowly across the world).
    const tx = (p.x + this.pan.x) * T - W / 2;
    const ty = (p.y + this.pan.y) * T - H / 2;
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
    this.#drawFlatStructures(game, W, H);
    if (game.zoneRings) this.#drawZoneRings(game);
    this.#drawHarvestTarget(game);
    this.#drawAreas(game);
    this.#drawEntities(game);
    if (game.build.active) this.#drawBuildOverlay(game, W, H);
    this.#drawProjectiles(game);
    this.#drawShapes(game);
    this.#drawParticles(game);
    this.#drawTexts(game);
    this.#drawCompass(game, W, H);
    if (p.hurtFlash > 0) {
      v.fillStyle = `rgba(255,40,40,${p.hurtFlash})`;
      v.fillRect(0, 0, W, H);
    }
    if (game.screenFlash) {
      v.globalAlpha = 0.35 * (game.screenFlash.t / game.screenFlash.dur);
      v.fillStyle = game.screenFlash.color;
      v.fillRect(0, 0, W, H);
      v.globalAlpha = 1;
    }

    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.view, 0, 0, W * this.scale, H * this.scale);
  }

  #sx(x) {
    return Math.round(x * T - this.cx);
  }

  /** Multiplayer: dashed borders of the safe town and clan claims nearby. */
  #drawZoneRings(game) {
    const v = this.v;
    const p = game.player;
    v.save();
    v.setLineDash([4, 4]);
    v.lineDashOffset = -Math.floor(game.time * 6);
    v.lineWidth = 1;
    for (const ring of game.zoneRings) {
      const d = Math.hypot(p.x - ring.x, p.y - ring.y);
      if (Math.abs(d - ring.r) > 30) continue;
      v.globalAlpha = ring.alpha ?? 0.55;
      v.strokeStyle = ring.color;
      v.beginPath();
      v.arc(this.#sx(ring.x), this.#sy(ring.y), ring.r * T, 0, TAU);
      v.stroke();
    }
    v.restore();
    v.globalAlpha = 1;
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
        case 'field': {
          // A swirling disc with spinning arcs (and a flower for Venom Bloom).
          this.#circle(x, y, r, a.color, null, 0.16 * fade);
          v.strokeStyle = a.color;
          v.globalAlpha = 0.7 * fade;
          for (let k = 0; k < 4; k++) {
            v.beginPath();
            const rot = a.t * (a.spin ?? 3) + k * (Math.PI / 2);
            v.arc(x, y, r * (0.45 + 0.13 * k), rot, rot + 1.1);
            v.stroke();
          }
          if (a.flower) {
            const open = Math.min(1, a.t * 3);
            for (let k = 0; k < 6; k++) {
              const ang = (k / 6) * Math.PI * 2 + a.t * 0.4;
              this.#circle(x + Math.cos(ang) * 7 * open, y + Math.sin(ang) * 7 * open - 4, 5 * open, '#ff7ad8', '#161622', fade);
            }
            this.#circle(x, y - 4, 5 * open, '#ffe45c', '#161622', fade);
          }
          v.globalAlpha = 1;
          this.#glow(x, y, a.color, r * 0.8);
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
        case 'orbit': {
          const n = a.count ?? 3;
          for (let k = 0; k < n; k++) {
            const ang = a.t * 2.2 + (k / n) * TAU;
            const bx = x + Math.cos(ang) * r;
            const by = y + Math.sin(ang) * r;
            this.#circle(bx, by, 4, '#161622', null, fade);
            this.#circle(bx, by, 3, a.color, null, fade);
            this.#circle(bx, by, 1.5, '#ffffff', null, fade);
            this.#glow(bx, by, a.color, 10);
          }
          break;
        }
        case 'gravity': {
          const grow = Math.min(1, a.t * 3);
          this.#circle(x, y, r * 1.6 * grow, 'rgba(40,10,70,0.35)', null, fade);
          this.#circle(x, y, 7, '#0a0412', a.color, fade);
          v.strokeStyle = a.color;
          v.globalAlpha = 0.8 * fade;
          for (let k = 0; k < 3; k++) {
            const rot = -a.t * 5 + k * 2.1;
            v.beginPath();
            v.arc(x, y, r * (0.4 + k * 0.35) * grow, rot, rot + 1.8);
            v.stroke();
          }
          v.globalAlpha = 1;
          this.#glow(x, y, a.color, r * 0.8);
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
    for (const st of game.structuresForDraw()) {
      if (!isFlat(st.id)) list.push({ y: st.y + 0.95, kind: 'structure', o: st });
    }
    for (const n of game.markets.npcs) if (!n.dead) list.push({ y: n.y, kind: 'npc', o: n });
    for (const e of game.enemies) if (!e.dead) list.push({ y: e.y, kind: 'enemy', o: e });
    for (const a of game.allies) list.push({ y: a.y, kind: 'ally', o: a });
    if (game.pal && !game.pal.hidden) list.push({ y: game.pal.y, kind: 'pal', o: game.pal });
    for (const o of game.others ?? []) if (!o.dead) list.push({ y: o.y, kind: 'remote', o });
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
        case 'structure': this.#drawStructure(game, d.o); break;
        case 'npc': this.#drawNpc(game, d.o, x, y); break;
        case 'pickup': this.#drawPickup(game, d.o, x, y); break;
        case 'enemy': this.#drawEnemy(game, d.o, x, y); break;
        case 'ally': this.#drawCharacter(game, d.o, x, y, true); break;
        case 'pal': this.#drawPal(game, d.o, x, y); break;
        case 'player': this.#drawCharacter(game, p, x, y, false); break;
        case 'remote': this.#drawRemote(game, d.o, x, y); break;
        default: break;
      }
    }
    this.#drawReticle(game);
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

  // --- Structures -------------------------------------------------------------------

  #mask(game, st) {
    const w = game.world;
    const joins = (tx, ty) => {
      const o = w.structureAt(tx, ty);
      return o && (o.def.kind === 'wall' || o.def.kind === 'gate');
    };
    if (st.def.kind !== 'wall') return 0;
    return (joins(st.x - 1, st.y) ? LEFT : 0) | (joins(st.x + 1, st.y) ? RIGHT : 0)
      | (joins(st.x, st.y - 1) ? UP : 0) | (joins(st.x, st.y + 1) ? DOWN : 0);
  }

  #drawFlatStructures(game, W, H) {
    const v = this.v;
    // Floors first, then traps on top of them.
    const flat = game.structuresForDraw().filter((st) => isFlat(st.id));
    flat.sort((a, b) => (a.def?.kind === 'floor' ? 0 : 1) - (b.def?.kind === 'floor' ? 0 : 1));
    for (const st of flat) {
      const x = this.#sx(st.x);
      const y = this.#sy(st.y);
      if (x < -16 || y < -16 || x > W || y > H) continue;
      const up = st.id === 'spikes' && game.time - st.rt.trig < 0.35 ? 1 : 0;
      v.drawImage(structureSprite(st.id, 0, up), x, y);
      if (st.rt.flash > 0) this.#flashRect(x, y, 16, 16);
    }
  }

  #flashRect(x, y, w, h) {
    const v = this.v;
    v.globalAlpha = 0.5;
    v.fillStyle = '#ffffff';
    v.fillRect(x, y, w, h);
    v.globalAlpha = 1;
  }

  #drawStructure(game, st) {
    const v = this.v;
    const x = this.#sx(st.x);
    const y = this.#sy(st.y + 1) - STRUCT_H;
    const t = game.time;
    const id = st.id;
    const state = id === 'gate' && st.rt.open > 0.5 ? 1 : 0;
    const img = structureSprite(id, this.#mask(game, st), state, id === 'stall' ? st.color : null);
    v.drawImage(img, x, y);
    if (st.rt.flash > 0 && st.def.kind !== 'turret') this.#flashRect(x, y + 2, 16, STRUCT_H - 2);
    if (id === 'arrow_turret') {
      drawTurretHead(v, x + 8, y + 7, st.rt.aim, st.rt.flash > 0 ? 2 : 0);
    } else if (id === 'flame_turret') {
      drawFlame(v, x + 8, y + 7, t + st.x, st.rt.flash > 0 ? 3 : 2);
      this.#glow(x + 8, y + 4, '#ff7a2a', 14);
      if (Math.random() < 0.08) game.fx.emit('ember', st.x + 0.5, st.y + 0.2, 1, 0.3, 0.4);
    } else if (id === 'torch') {
      drawFlame(v, x + 8, y + 7, t + st.x * 3, 1);
      this.#glow(x + 8, y + 5, '#ffb040', 22 + Math.sin(t * 9 + st.y) * 2);
      if (Math.random() < 0.05) game.fx.emit('ember', st.x + 0.5, st.y + 0.25, 1, 0.2, 0.3);
    }
    if (st.hp < st.def.hp) this.#healthBar(x + 8, y - 2, 12, st.hp / st.def.hp, '#6cd66c');
  }

  /** Market people: merchants behind stalls, villagers strolling about. */
  #drawNpc(game, n, x, y) {
    const v = this.v;
    const sprites = playerSprites(n.cloak);
    const right = Math.cos(n.facing) >= 0;
    const frame = n.moving ? 1 + (Math.floor(n.walkT) % 2) : 0;
    let img = (right ? sprites.right : sprites.left)[frame];
    if (n.hurtFlash > 0) img = sprites.flash;
    this.#shadow(x, y + 1, 5);
    v.drawImage(img, x - 5, y - 12 - (n.moving ? Math.floor(n.walkT) % 2 : 0));
    const p = game.player;
    const near = (p.x - n.x) ** 2 + (p.y - n.y) ** 2 < 20;
    const hostile = game.markets.isHostile(n.marketId);
    if (hostile) {
      drawPixelText(v, '!', x, y - 22, '#ff5050');
    } else if (n.role === 'merchant') {
      // A little coin above traders.
      const bob = Math.round(Math.sin(game.time * 3 + n.x) * 1);
      v.fillStyle = '#161622';
      v.fillRect(x - 2, y - 21 + bob, 5, 5);
      v.fillStyle = '#ffd24a';
      v.fillRect(x - 1, y - 20 + bob, 3, 3);
    }
    if (near) drawPixelText(v, n.name.toUpperCase(), x, y - 29, n.role === 'merchant' ? '#ffe890' : '#c8c8d8');
    if (n.hp < n.maxHp) this.#healthBar(x, y - 16, 12, n.hp / n.maxHp, '#6cd66c');
  }

  #drawHarvestTarget(game) {
    const o = game.interactTarget;
    if (o?.type !== 'harvest') return;
    const v = this.v;
    const x = this.#sx(o.tx);
    const y = this.#sy(o.ty);
    const pulse = Math.floor(game.time * 4) % 2;
    // Corner brackets around the tile (red when your pickaxe is too weak).
    const tier = currentPickaxe(game.data, game.save)?.tier ?? 0;
    const tooHard = o.info.tier > tier;
    v.fillStyle = tooHard ? (pulse ? '#ff6a6a' : '#b83a3a') : pulse ? '#ffe890' : '#ffffff';
    for (const [cx, cy] of [[0, 0], [15, 0], [0, 15], [15, 15]]) {
      v.fillRect(x + cx - (cx ? 2 : 0), y + cy, 3, 1);
      v.fillRect(x + cx, y + cy - (cy ? 2 : 0), 1, 3);
    }
    // Cracks grow as the tile takes damage.
    const dmg = game.harvestDamage.get(`${o.tx},${o.ty}`)?.dmg ?? 0;
    const k = Math.min(1, dmg / o.info.hp);
    if (k > 0) {
      v.strokeStyle = '#161622';
      v.lineWidth = 1;
      v.beginPath();
      const n = 1 + Math.floor(k * 4);
      for (let i = 0; i < n; i++) {
        const a = i * 1.7 + o.tx;
        v.moveTo(x + 8, y + 8);
        v.lineTo(x + 8 + Math.round(Math.cos(a) * 6 * k), y + 8 + Math.round(Math.sin(a) * 6 * k));
      }
      v.stroke();
    }
  }

  /** Build mode: camp border, ghost preview, reach. */
  #drawBuildOverlay(game, W, H) {
    const v = this.v;
    const b = game.build;
    const radius = game.buildRadius();
    // Single player: the camp around the Hearth; multiplayer: your clan's claim.
    const c = game.buildCenter ?? { x: 0, y: 0 };
    const inside = (tx, ty) => radius > 0 && Math.hypot(tx - c.x, ty - c.y) <= radius;
    const tx0 = Math.floor(this.cx / T) - 1;
    const ty0 = Math.floor(this.cy / T) - 1;
    const tx1 = tx0 + Math.ceil(W / T) + 2;
    const ty1 = ty0 + Math.ceil(H / T) + 2;
    // Dashed camp border.
    v.fillStyle = '#ffd24a';
    const dash = Math.floor(game.time * 8) % 4;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (!inside(tx, ty)) continue;
        const x = this.#sx(tx);
        const y = this.#sy(ty);
        for (let i = dash; i < 16; i += 4) {
          if (!inside(tx, ty - 1)) v.fillRect(x + i, y, 2, 1);
          if (!inside(tx, ty + 1)) v.fillRect(x + i, y + 15, 2, 1);
          if (!inside(tx - 1, ty)) v.fillRect(x, y + i, 1, 2);
          if (!inside(tx + 1, ty)) v.fillRect(x + 15, y + i, 1, 2);
        }
      }
    }
    const g = b.ghost;
    if (!g) return;
    const x = this.#sx(g.tx);
    const y = this.#sy(g.ty);
    const ok = !b.reason;
    // Soft grid around the ghost.
    v.globalAlpha = 0.18;
    v.fillStyle = '#ffffff';
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (!inside(g.tx + dx, g.ty + dy)) continue;
        v.fillRect(x + dx * 16, y + dy * 16, 16, 1);
        v.fillRect(x + dx * 16, y + dy * 16, 1, 16);
      }
    }
    v.globalAlpha = 1;
    const color = b.tool === 'remove' ? (ok ? '#ff6a7a' : '#8a8a96') : ok ? '#6cd66c' : '#ff5050';
    if (b.tool === 'place') {
      const def = structureDef(game.data, b.selected);
      if (def) {
        v.globalAlpha = 0.55 + 0.15 * Math.sin(game.time * 6);
        const img = structureSprite(def.id, 0, def.id === 'spikes' ? 1 : 0);
        v.drawImage(img, x, isFlat(def.id) ? y : y + 16 - STRUCT_H);
        v.globalAlpha = 1;
      }
    }
    v.globalAlpha = 0.25;
    v.fillStyle = color;
    v.fillRect(x, y, 16, 16);
    v.globalAlpha = 1;
    v.strokeStyle = color;
    v.strokeRect(x + 0.5, y + 0.5, 15, 15);
    if (game.input.mode === 'touch') {
      // The picked tile breathes: tap it again (or the hammer) to build there.
      const k = 1 + Math.round(1 + Math.sin(game.time * 6));
      v.fillStyle = color;
      for (const [cx, cy, dx, dy] of [[x - k, y - k, 1, 1], [x + 16 + k, y - k, -1, 1], [x - k, y + 16 + k, 1, -1], [x + 16 + k, y + 16 + k, -1, -1]]) {
        v.fillRect(cx, cy, 5 * dx, dy);
        v.fillRect(cx, cy, dx, 5 * dy);
      }
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
        if (game.altarSpent(o)) {
          // A spent altar: cold grey stone, no light.
          v.globalAlpha = 0.75;
          v.drawImage(objectSprite('altar', '#6a6a76'), x - 8, y - 6);
          v.globalAlpha = 1;
          break;
        }
        const s = objectSprite('altar', boss.color);
        // Great altars stand on a wider dais of light.
        if (!o.lesser) this.#glow(x, y + 2, boss.color, 26 + Math.sin(game.time * 2) * 3);
        v.drawImage(s, x - 8, y - 6);
        this.#glow(x, y - 2, boss.color, 16 + Math.sin(game.time * 3) * 3);
        if (!game.boss && Math.random() < 0.15) game.fx.emit(game.data.byId.elements.get(boss.element)?.particles ?? 'sparkle', o.x, o.y - 0.3, 1, 0.8, 0.6);
        break;
      }
      case 'bones':
      case 'signpost':
      case 'mushrooms':
      case 'camp':
      case 'bottle':
      case 'wreck':
      case 'idol':
      case 'treasure':
        this.#drawCuriosity(game, o, x, y);
        break;
      case 'building': {
        const level = buildingLevel(game.data, game.save, o.buildingId);
        const s = buildingSprite(o.buildingId, level);
        this.#shadow(x, y + 1, 12);
        if (level === 0) v.globalAlpha = 0.85;
        v.drawImage(s, x - (BUILDING_W >> 1), y - BUILDING_H + 3);
        v.globalAlpha = 1;
        if (level > 0) this.#buildingAmbience(game, o, level, x, y);
        break;
      }
      default:
        break;
    }
  }

  /** Small points of interest (discoveries.js); dimmed once used. */
  #drawCuriosity(game, o, x, y) {
    const v = this.v;
    const found = game.save.world.found?.includes(o.key);
    const t = game.time;
    let kind = o.type;
    let accent;
    if (kind === 'camp') kind = found ? 'campOut' : 'campfire';
    if (kind === 'treasure' && found) kind = 'hole';
    if (kind === 'mushrooms') accent = found ? '#6a6a7a' : '#5affc8';
    if (kind === 'idol') accent = found ? '#5d5a6e' : '#ffd24a';
    if (found && (o.type === 'mushrooms' || o.type === 'bottle')) return; // eaten / taken
    const s = objectSprite(kind, accent);
    const w = s.width;
    const h = s.height;
    if (h > 6) this.#shadow(x, y + 2, Math.max(3, w >> 2));
    if (found && o.type !== 'camp' && o.type !== 'treasure') v.globalAlpha = 0.6;
    const bob = o.type === 'bottle' ? Math.round(Math.sin(t * 2 + o.x) * 1) : 0;
    v.drawImage(s, x - (w >> 1), y + 3 - h + bob);
    v.globalAlpha = 1;
    if (found) return;
    switch (o.type) {
      case 'mushrooms':
        this.#glow(x, y - 2, '#5affc8', 10 + Math.sin(t * 3 + o.x) * 2);
        break;
      case 'camp':
        this.#glow(x, y - 4, '#ff9a3a', 10 + Math.sin(t * 9) * 1.5);
        if (Math.random() < 0.08) game.fx.emit('ember', o.x, o.y - 0.3, 1, 0.2, 0.5);
        break;
      case 'idol':
        this.#glow(x, y - 10, '#ffd24a', 8 + Math.sin(t * 2) * 2);
        break;
      case 'treasure':
      case 'bottle':
        if (Math.random() < 0.04) game.fx.emit('glint', o.x, o.y - 0.2, 1, 0.3, 0.4, ['#ffffff', '#ffe890']);
        break;
      default:
        break;
    }
  }

  #buildingAmbience(game, o, level, x, y) {
    const v = this.v;
    const flicker = Math.sin(game.time * 9) * 2;
    switch (o.buildingId) {
      case 'hearth':
        this.#glow(x, y - 5, '#ff9a3a', 18 + level * 2 + flicker);
        if (Math.random() < 0.3) game.fx.emit('ember', o.x, o.y - 0.4, 1, 0.2, 0.4);
        break;
      case 'forge':
        this.#glow(x - 6, y - 8, '#ff7a2a', 10 + flicker);
        if (Math.random() < 0.08) game.fx.emit('smoke', o.x + (level >= 5 ? 0.5 : -0.4), o.y - 1.6, 1, 0.2, 0.3);
        break;
      case 'well': {
        this.#glow(x, y - 10, '#7ae0ff', 10 + level * 2);
        if (wellPending(game.data, game.save) > 0) {
          const gem = pickupSprite('essence', '#7ae0ff');
          const bob = Math.round(Math.sin(game.time * 4) * 2);
          v.drawImage(gem, x - 2, y - BUILDING_H - 4 + bob);
          this.#glow(x, y - BUILDING_H - 1 + bob, '#7ae0ff', 8);
        }
        break;
      }
      case 'waystone':
        this.#glow(x, y - 14, '#cdb2ff', 10 + level * 4 + flicker);
        if (Math.random() < 0.1) game.fx.emit('arcane', o.x, o.y - 1, 1, 0.4, 0.4);
        break;
      case 'library':
        if (level >= 5) this.#glow(x, y - 18, '#cdb2ff', 10);
        break;
      default:
        break;
    }
  }

  #drawPickup(game, it, x, y) {
    const v = this.v;
    // Phase from the world position: a screen-space phase jumps every time the
    // camera scrolls, which made drops shake while you walked sideways.
    const bob = Math.round(Math.sin(it.t * 4 + it.x * 1.7) * 1.5);
    if (it.kind === 'weapon') {
      this.#drawWeaponDrop(game, it, x, y, bob);
      return;
    }
    const kind = it.kind === 'essence' ? 'essence' : it.kind;
    const s = pickupSprite(kind, it.color);
    this.#shadow(x, y + 2, 2);
    v.drawImage(s, x - (s.width >> 1), y - s.height - 1 + bob);
    if (it.kind === 'component') this.#glow(x, y - 4 + bob, it.color, 10);
    if (it.kind === 'egg') {
      this.#glow(x, y - 4 + bob, it.color, 14 + Math.sin(game.time * 4) * 2);
      if (Math.random() < 0.08) game.fx.emit('glint', it.x, it.y - 0.4, 1, 0.4, 0.6, [it.color, '#ffffff']);
    }
    if (it.kind === 'shard') {
      this.#glow(x, y - 4 + bob, '#ffd24a', 16 + Math.sin(game.time * 5) * 3);
      if (Math.random() < 0.1) game.fx.emit('glint', it.x, it.y - 0.4, 1, 0.4, 0.6, ['#ffd24a', '#ffffff']);
    }
  }

  /**
   * A weapon on the ground shows its rarity from afar: common ones just
   * glint, uncommon ones glow, rare+ send up a light beam (taller and
   * brighter per tier), epic+ get orbiting sparks and legendaries radiate.
   */
  #drawWeaponDrop(game, it, x, y, bob) {
    const v = this.v;
    const r = it.rarity ?? game.data.rarityIndex.get(it.dna.rarity) ?? 0;
    const c = it.color;
    const t = game.time;
    const lift = Math.round((it.z ?? 0) * T);
    const pulse = 0.5 + 0.5 * Math.sin(t * 3 + it.x * 1.7);
    // Ground marker.
    if (r >= 1) {
      v.globalAlpha = 0.35 + 0.25 * pulse;
      v.strokeStyle = c;
      v.beginPath();
      v.ellipse(x, y + 3, 6 + r + pulse * 2, 3 + r * 0.4, 0, 0, TAU);
      v.stroke();
      v.globalAlpha = 1;
    }
    // Light beam.
    if (r >= 2) {
      // Coloured column (normal blending keeps the rarity hue true on any
      // ground), with an additive white core.
      const h = [0, 0, 34, 52, 80][r];
      const w = [0, 0, 5, 7, 9][r];
      v.globalAlpha = 0.5 + 0.2 * pulse;
      v.drawImage(beamSprite(c, h), x - (w >> 1), y + 2 - h, w, h);
      v.globalCompositeOperation = 'lighter';
      v.globalAlpha = 0.8;
      v.drawImage(beamSprite('#ffffff', h), x, y + 2 - Math.round(h * 0.85), 1, Math.round(h * 0.85));
      v.globalAlpha = 1;
      v.globalCompositeOperation = 'source-over';
    }
    // Legendary: rotating rays behind the weapon.
    if (r >= 4 && this.game.quality.glow) {
      v.save();
      v.translate(x, y - 8 + bob - lift);
      v.rotate(t * 0.8);
      v.globalCompositeOperation = 'lighter';
      v.globalAlpha = 0.35;
      v.fillStyle = c;
      for (let k = 0; k < 6; k++) {
        v.rotate(TAU / 6);
        v.beginPath();
        v.moveTo(0, 0);
        v.lineTo(18, -2);
        v.lineTo(18, 2);
        v.fill();
      }
      v.restore();
      v.globalAlpha = 1;
      v.globalCompositeOperation = 'source-over';
    }
    this.#shadow(x, y + 4, 6 - Math.min(3, lift / 6));
    this.#glow(x, y - 6 + bob - lift, c, 10 + r * 3 + pulse * 2);
    v.drawImage(this.#icon(it.dna), x - 16, y - 22 + bob - lift);
    // Orbiting sparks.
    if (r >= 3) {
      for (let k = 0; k < r - 1; k++) {
        const a = t * 2.4 + (k / (r - 1)) * TAU;
        const sx = Math.round(x + Math.cos(a) * 10);
        const sy = Math.round(y - 8 + Math.sin(a) * 4 + bob - lift);
        v.fillStyle = k % 2 ? '#ffffff' : c;
        v.fillRect(sx, sy, 1, 1);
        this.#glow(sx, sy, c, 4);
      }
    }
    if (r >= 2 && Math.random() < 0.04 * r) game.fx.emit('glint', it.x, it.y - 0.6, 1, 0.5, 0.6, [c, '#ffffff']);
    // Rarity label: always for rare+, for everything when you are close.
    const p = game.player;
    const near = (p.x - it.x) ** 2 + (p.y - it.y) ** 2 < 25;
    if (r >= 2 || near) {
      const name = game.data.byId.rarities.get(it.dna.rarity)?.name ?? '';
      drawPixelText(v, name.toUpperCase(), x, y - 32 + bob - lift - (r >= 2 ? 4 : 0), c);
    }
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

  /** Sharks and serpents: half under water, with a wake; serpents trail a body. */
  #drawSeaCreature(game, e, x, y) {
    const v = this.v;
    const t = game.time;
    const right = e.facing >= 0;
    if (e.kind === 'serpent') {
      // Body segments along the path the head has taken, tail first.
      const segs = 8;
      for (let k = segs; k >= 1; k--) {
        const pt = e.trail[Math.min(e.trail.length - 1, k * 3)];
        if (!pt) continue;
        const sx = this.#sx(pt.x);
        const sy = this.#sy(pt.y) + Math.round(Math.sin(t * 5 - k * 0.8) * 1.5);
        const r = Math.max(2, 6.5 - k * 0.55);
        if (e.submerged) {
          this.#circle(sx, sy, r + 1, '#0e2a50', null, 0.35);
          continue;
        }
        this.#circle(sx, sy, r + 1, '#161622', null, 1);
        this.#circle(sx, sy, r, e.flash > 0 ? '#ffffff' : e.color, null, 1);
        this.#circle(sx - 1, sy - 1, Math.max(1, r * 0.45), shadeColor(e.color), null, 0.9);
        if (k % 2 === 0) {
          v.fillStyle = '#e8364a';
          v.fillRect(Math.round(sx), Math.round(sy - r - 2), 1, 2);
        }
      }
      if (e.submerged) {
        this.#circle(x, y, 7, '#0e2a50', null, 0.4);
        if (Math.random() < 0.3) game.fx.emit('splash', e.x, e.y, 1, 0.5, 0.6);
        return;
      }
    }
    const set = e.sprites;
    let img = right ? set.right : set.left;
    if (e.flash > 0) img = set.flash;
    const scale = e.kind === 'serpent' ? 1.5 : 1.3;
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const bob = Math.round(Math.sin(t * 3 + e.phase) * 1);
    const top = y - h + 3 + bob;
    v.drawImage(img, x - (w >> 1), top, w, h);
    // The water line: everything below it is seen through the waves.
    const line = e.kind === 'shark' ? top + Math.round(h * 0.55) : top + Math.round(h * 0.75);
    v.globalAlpha = 0.45;
    v.fillStyle = '#2a78b8';
    v.fillRect(x - (w >> 1) - 1, line, w + 2, top + h - line);
    v.globalAlpha = 0.7;
    v.fillStyle = '#e8f8ff';
    const foam = Math.floor(t * 6) % 2;
    v.fillRect(x - (w >> 1) + foam, line, w - 1, 1);
    v.globalAlpha = 1;
    if (Math.abs(e.vx) + Math.abs(e.vy) > 0.5 && Math.random() < 0.35) {
      game.fx.emit('splash', e.x - (right ? 0.5 : -0.5), e.y, 1, 0.2, 0.4);
    }
    if (e.hp < e.maxHp) this.#healthBar(x, top - 3, e.kind === 'serpent' ? 22 : 12, e.hp / e.maxHp, '#ff5050');
  }

  #drawEnemy(game, e, x, y) {
    const v = this.v;
    if (e.def?.sea) {
      this.#drawSeaCreature(game, e, x, y);
      return;
    }
    const t = game.time;
    if (e.boss && e.submerged) {
      // Under the ground: only a rumbling mound shows where it is.
      const k = Math.sin(t * 20) > 0 ? 1 : 0;
      this.#shadow(x, y + 1, 10);
      v.fillStyle = '#161622';
      v.fillRect(Math.round(x) - 8 + k, Math.round(y) - 3, 16, 4);
      v.fillStyle = e.color;
      v.fillRect(Math.round(x) - 7 + k, Math.round(y) - 2, 14, 2);
      if (Math.random() < 0.4) game.fx.emit('dust', e.x, e.y, 1, 0.8, 1);
      return;
    }
    const set = e.sprites;
    const right = e.facing >= 0;
    const body = e.def?.body ?? 'walk';
    const moving = !e.stunned && Math.hypot(e.vx, e.vy) > 0.15;
    const attacking = e.state === 'windup' || e.state === 'charge' || (e.castT !== undefined && t - e.castT < 0.35);
    let img;
    let lift = 0; // pixels above the ground (flyers, hops)
    let sx = 1; // squash and stretch
    let sy = 1;
    let jx = 0;
    let alpha = 1;
    if (set.walk) {
      // Animated creature: pick attack, walk or idle frames.
      const airborne = body === 'fly' || body === 'float';
      const frames = attacking ? set.attack : moving || airborne ? set.walk : set.idle;
      const list = right ? frames.right : frames.left;
      const rate = e.stunned ? 0 : body === 'fly' ? 11 : body === 'float' ? 5 : moving ? 7 : 2;
      img = list[Math.floor(t * rate + e.phase) % list.length];
      if (body === 'hop') {
        // Slimes hop along, squashing as they land; idle ones breathe.
        if (moving) {
          const h = (t * 2.6 + e.phase) % 1;
          lift = Math.round(Math.sin(h * Math.PI) * 4);
          const land = h > 0.85 || h < 0.1 ? 1 : 0;
          sx = 1 + land * 0.18 - (lift > 2 ? 0.08 : 0);
          sy = 1 - land * 0.16 + (lift > 2 ? 0.1 : 0);
        } else {
          const b = Math.sin(t * 3 + e.phase) * 0.05;
          sx = 1 + b;
          sy = 1 - b;
        }
      } else if (body === 'fly') {
        lift = 5 + Math.round(Math.sin(t * 7 + e.phase) * 2);
      } else if (body === 'float') {
        lift = 4 + Math.round(Math.sin(t * 2.4 + e.phase) * 1.5);
      } else if (moving && !attacking) {
        lift = Math.floor(t * 7 + e.phase) % 2; // a step bounce
      }
      if (e.state === 'windup') {
        // Telegraph: crouch and shiver before the charge.
        sx *= 1.08;
        sy *= 0.9;
        jx = Math.floor(t * 30) % 2 ? 1 : -1;
      } else if (e.state === 'charge') {
        sx *= 1.12;
        sy *= 0.94;
      }
      if (e.state === 'fade') alpha = Math.max(0.08, 1 - e.stateT / 0.6);
      else if (e.def?.behavior === 'blinker') alpha = 0.88;
    } else {
      img = right ? set.right : set.left;
      lift = e.boss ? Math.round(Math.sin(t * 3) * 1.5) : e.stunned ? 0 : Math.round(Math.sin(t * 8 + e.phase) * 1);
    }
    if (e.flash > 0) img = set.walk ? tintedSprite(img, '#ffffff', 1) : set.flash;
    else if (e.tint) img = tintedSprite(img, e.tint, e.frozen ? 0.7 : 0.4);
    else if (e.elite) img = tintedSprite(img, '#ffd24a', 0.18);
    const scale = e.scale ?? 1;
    const squash = e.squash ?? 0;
    const w = Math.round(img.width * scale * sx * (1 + 0.22 * squash));
    const h = Math.round(img.height * scale * sy * (1 - 0.18 * squash));
    const airborne = body === 'fly' || body === 'float';
    this.#shadow(x, y + 1, Math.max(3, w * (airborne ? 0.28 : 0.4)) * (alpha < 0.5 ? 0.5 : 1));
    if (e.state === 'windup' && !set.walk && Math.floor(t * 16) % 2) alpha *= 0.6;
    v.globalAlpha = alpha;
    const top = y - h + 2 - lift;
    v.drawImage(img, x - (w >> 1) + jx, top, w, h);
    v.globalAlpha = 1;
    if (e.state === 'windup' && set.walk) {
      // A "!" flicker over chargers about to dash.
      v.fillStyle = Math.floor(t * 12) % 2 ? '#ffd24a' : '#ff5050';
      v.fillRect(Math.round(x) - 1, top - 7, 2, 4);
      v.fillRect(Math.round(x) - 1, top - 2, 2, 1);
    }
    if (e.boss || e.elite || (e.element && e.element !== 'physical')) {
      const glow = game.data.byId.elements.get(e.element)?.glow;
      if (glow && (e.boss || e.elite)) this.#glow(x, top + h / 2, glow, e.boss ? 30 : 10);
    }
    // Shades carry a faint halo so they stand out on dark ground.
    if (e.def?.behavior === 'blinker' && alpha > 0.3) this.#glow(x, top + h / 2, '#b48cff', 9);
    if (!e.boss && e.hp < e.maxHp && alpha > 0.5) this.#healthBar(x, top - 4, e.elite ? 16 : 12, e.hp / e.maxHp, e.elite ? '#ffd24a' : '#ff5050');
  }

  /** Your pal: trots along, bites or zaps, chops, and naps when knocked out. */
  #drawPal(game, pal, x, y) {
    const v = this.v;
    const t = game.time;
    const set = palSprites(pal.species, palSpecies(game.data, pal.species)?.color ?? '#6ad35a');
    const right = pal.facing >= 0;
    const down = pal.state === 'down';
    const moving = !down && Math.hypot(pal.vx, pal.vy) > 0.2;
    const busy = t - pal.attackT < 0.22 || t - pal.workT < 0.22;
    let frames = set.idle;
    let rate = 1.6;
    if (down) {
      frames = set.sleep;
      rate = 0;
    } else if (busy) {
      frames = set.attack;
      rate = 0;
    } else if (moving) {
      frames = set.walk;
      rate = 8;
    }
    const list = right ? frames.right : frames.left;
    let img = list[Math.floor(t * rate + pal.phase) % list.length];
    if (pal.flash > 0) img = tintedSprite(img, '#ffffff', 1);
    const hop = moving ? Math.floor(t * 8 + pal.phase) % 2 : 0;
    const lunge = t - pal.attackT < 0.12 || t - pal.workT < 0.12 ? (right ? 2 : -2) : 0;
    this.#shadow(x, y + 1, 4);
    // A friendly ring on the ground tells your pal apart from the monsters.
    v.globalAlpha = 0.6;
    v.strokeStyle = '#bff4ff';
    v.beginPath();
    v.ellipse(x, y + 1.5, 7, 3, 0, 0, TAU);
    v.stroke();
    v.globalAlpha = 1;
    if (down) v.globalAlpha = 0.8;
    v.drawImage(img, x - (img.width >> 1) + lunge, y - img.height + 2 - hop);
    v.globalAlpha = 1;
    const top = y - img.height - hop;
    if (down) {
      // Zz: little letters drifting up.
      v.fillStyle = '#e8f0ff';
      for (let i = 0; i < 2; i++) {
        const k = (t * 0.8 + i * 0.5) % 1;
        const zx = Math.round(x + 3 + k * 5);
        const zy = Math.round(top - 2 - k * 8);
        v.globalAlpha = 1 - k;
        v.fillRect(zx, zy, 3, 1);
        v.fillRect(zx + 1, zy + 1, 1, 1);
        v.fillRect(zx, zy + 2, 3, 1);
      }
      v.globalAlpha = 1;
    } else if (pal.hp < pal.stats.maxHp) {
      this.#healthBar(x, top - 2, 10, pal.hp / pal.stats.maxHp, '#7ad85a');
    }
  }

  /** Another player (multiplayer): their character, name, clan tag and health. */
  #drawRemote(game, c, x, y) {
    const v = this.v;
    if (c.asleep) v.globalAlpha = 0.55;
    this.#drawCharacter(game, c, x, y, false);
    v.globalAlpha = 1;
    const label = c.tag ? `[${c.tag}] ${c.name}` : c.name;
    drawPixelText(v, label.toUpperCase(), x, y - 27, c.nameColor ?? '#e8e8f0');
    if (c.hp < c.maxHp) this.#healthBar(x, y - 18, 14, Math.max(0, c.hp) / c.maxHp, c.friendly ? '#6cd66c' : '#ff6a5a');
    if (c.asleep) {
      v.fillStyle = '#e8f0ff';
      const k = (game.time * 0.8) % 1;
      v.globalAlpha = 1 - k;
      v.fillRect(Math.round(x + 4 + k * 4), Math.round(y - 16 - k * 6), 3, 1);
      v.globalAlpha = 1;
    }
  }

  #drawCharacter(game, c, x, y, isClone) {
    const v = this.v;
    const remote = Boolean(c.remote);
    const sprites = playerSprites(isClone ? '#9a5cff' : remote ? c.cloak ?? '#c8364a' : '#3f6fd8');
    const w = remote ? c.weapon : game.weapon;
    const anim = isClone
      ? (game.time - (c.attackT ?? -1) < 0.22 ? { t: game.time - c.attackT, dur: 0.22, angle: c.facing, dir: 1 } : null)
      : c.attackAnim;
    const pattern = w?.attack.pattern ?? 'swing';
    const pose = w ? weaponPose(pattern, anim, c.facing, {
      arc: ((w.attack.arc ?? 120) * Math.PI) / 180,
      time: game.time,
      moving: c.moving,
      walkT: c.walkT ?? 0,
      guard: c.guard ?? 1,
    }) : null;
    // The body leans into lunges and thrusts.
    const lungeAngle = anim?.angle ?? c.facing;
    const lx = pose ? Math.round(Math.cos(lungeAngle) * pose.lunge) : 0;
    const ly = pose ? Math.round(Math.sin(lungeAngle) * pose.lunge) : 0;
    const right = Math.cos(c.facing) >= 0;
    const frame = c.moving ? 1 + (Math.floor(c.walkT) % 2) : 0;
    let img = (right ? sprites.right : sprites.left)[isClone ? 0 : frame];
    if (!isClone && c.hurtFlash > 0) img = sprites.flash;
    const bob = c.moving ? (Math.floor(c.walkT) % 2) : 0;
    const sailing = !remote && game.sailing;
    const toolActive = remote ? c.slot === 'tool' : game.toolActive;
    const handsEmpty = remote ? c.slot === 'none' : game.handsEmpty;
    if (isClone || !sailing) this.#shadow(x + lx, y + 1 + ly, 5);
    // Ascension: a radiant aura while the power lasts.
    if (!isClone && game.ascend && game.ascend.until > game.time) {
      this.#glow(x, y - 6, game.ascend.color, 20 + Math.sin(game.time * 8) * 3);
      if (Math.random() < 0.4) game.fx.emit('arcane', c.x, c.y - 0.3, 1, 0.5, 1.5);
    }
    const behind = pose && Math.sin(pose.angle) < -0.35;
    const baseAlpha = v.globalAlpha;
    if (isClone) v.globalAlpha = 0.65;
    else if (c.invuln > 0 && Math.floor(game.time * 20) % 2) v.globalAlpha = 0.5 * baseAlpha;
    const hand = { x: x + lx + (right ? 1 : -1), y: y - 6 - bob + ly };
    if (!isClone && sailing) {
      this.#drawSailor(game, c, x, y, img, right, pose, anim);
      v.globalAlpha = 1;
      return;
    }
    if (!isClone && (c.toolAnim || toolActive)) {
      v.drawImage(img, x - 5 + lx, y - 12 - bob + ly);
      this.#drawPickaxe(game, c, hand, remote ? c.pickaxeDef : null);
      v.globalAlpha = 1;
      return;
    }
    if (!isClone && handsEmpty) {
      v.drawImage(img, x - 5 + lx, y - 12 - bob + ly);
      v.globalAlpha = 1;
      return;
    }
    if (behind) this.#drawHeldWeapon(game, pose, hand, isClone, w, remote);
    v.drawImage(img, x - 5 + lx, y - 12 - bob + ly);
    if (!behind) this.#drawHeldWeapon(game, pose, hand, isClone, w, remote);
    v.globalAlpha = 1;
  }

  /** You in your boat: mast and sails behind, hull in front of your legs. */
  #drawSailor(game, c, x, y, img, right, pose) {
    const v = this.v;
    const boat = game.boat;
    if (!boat) return;
    const art = boatSprite(boat.id, boat.color);
    const side = right ? art.right : art.left;
    const rock = Math.round(Math.sin(game.time * 2.2) * 1);
    const left = x - (art.w >> 1);
    const deck = y - 2 + rock; // deck line (sailor stands on it)
    // Ripples around the hull.
    v.globalAlpha = 0.5;
    v.fillStyle = '#e8f8ff';
    const ripple = Math.floor(game.time * 3) % 3;
    v.fillRect(left - 2 - ripple, deck + art.hullY + 5, 3, 1);
    v.fillRect(left + art.w - 1 + ripple, deck + art.hullY + 5, 3, 1);
    v.globalAlpha = 1;
    v.drawImage(side.back, left, deck + art.hullY - art.backH + 2);
    // The sailor from the waist up.
    const hand = { x: x + (right ? 1 : -1), y: deck - 4 };
    const behind = pose && Math.sin(pose.angle) < -0.35;
    if (behind && !game.handsEmpty) this.#drawHeldWeapon(game, pose, hand, false);
    v.drawImage(img, 0, 0, img.width, 9, x - 5, deck - 9, img.width, 9);
    if (!behind && !game.handsEmpty && !game.toolActive) this.#drawHeldWeapon(game, pose, hand, false);
    v.drawImage(side.hull, left, deck + art.hullY - 2);
  }

  /** Pickaxe swing: raised overhead, then down onto the target. */
  #drawPickaxe(game, c, hand, def = null) {
    const tool = def ?? currentPickaxe(game.data, game.save);
    if (!tool) return;
    const a = c.toolAnim;
    const facing = a ? a.angle : c.facing;
    const side = Math.cos(facing) >= 0 ? 1 : -1;
    let angle;
    if (a) {
      const k = Math.min(1, a.t / a.dur);
      // Swing from raised back (-110°) to striking forward (+40°) relative to aim.
      const swing = k < 0.4 ? -1.9 + k * 0.5 : -1.7 + Math.min(1, (k - 0.4) / 0.25) * 2.4;
      angle = a.angle + swing * side * (Math.sin(a.angle) < -0.5 ? -1 : 1);
    } else {
      // Resting on the shoulder, bobbing a little while walking.
      angle = -Math.PI / 2 + side * (0.55 + (c.moving ? Math.sin((c.walkT ?? 0) * Math.PI) * 0.1 : 0));
    }
    const v = this.v;
    v.save();
    v.translate(Math.round(hand.x + Math.cos(angle) * 3), Math.round(hand.y + Math.sin(angle) * 3));
    v.rotate(angle + Math.PI / 2);
    v.drawImage(pickaxeSprite(tool.color), -6, -13);
    v.restore();
  }

  #boomerangInFlight(game) {
    return game.projectiles.some((p) => p.kind === 'boomerang' && p.owner === 'player' && p.depth === 0);
  }

  #drawHeldWeapon(game, pose, hand, isClone, weapon = game.weapon, remote = false) {
    const w = weapon;
    if (!w || !pose) return;
    if (!isClone && !remote && w.attack.pattern === 'boomerang' && this.#boomerangInFlight(game)) return;
    const v = this.v;
    const spr = weaponSprite(w.dna);
    // Bows are held across the aim (belly forward); everything else points along it.
    const across = spr.hold === 'across';
    const scale = across ? 0.62 : 0.75;
    const turn = across ? Math.PI : Math.PI / 2;
    // A bow is held out at arm's length so it never covers the archer.
    const reach = pose.reach + (across ? 5 : 0);
    const at = (angle) => ({
      x: hand.x + Math.cos(angle) * reach,
      y: hand.y + Math.sin(angle) * reach + pose.lift,
    });
    const drawAt = (img, angle, alpha, ox = 0, oy = 0) => {
      const p = at(angle);
      v.save();
      v.globalAlpha *= alpha;
      v.translate(Math.round(p.x + ox), Math.round(p.y + oy));
      v.rotate(angle + turn);
      v.scale(scale, scale);
      v.drawImage(img, -spr.pivotX, -spr.pivotY);
      v.restore();
    };
    // Motion trail: fading after-images in the weapon's trail colour.
    if (pose.trail.length) {
      const ghost = tintedSprite(spr.canvas, w.trail, 0.85);
      pose.trail.forEach((angle, i) => drawAt(ghost, angle, 0.34 - i * 0.07));
    }
    if (w.dna.visual.distortion && game.quality.glow) {
      drawAt(tintedSprite(spr.canvas, '#6b3fc6', 0.6), pose.angle, 0.35, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3);
    }
    drawAt(spr.canvas, pose.angle, 1);
    const base = at(pose.angle);
    if (across && !pose.flash) {
      // A nocked arrow from the string to just past the grip.
      const dx = Math.cos(pose.angle);
      const dy = Math.sin(pose.angle);
      v.fillStyle = '#d8c090';
      for (let k = -3; k <= 3; k++) v.fillRect(Math.round(base.x + dx * k), Math.round(base.y + dy * k), 1, 1);
      v.fillStyle = '#eef2f8';
      v.fillRect(Math.round(base.x + dx * 4), Math.round(base.y + dy * 4), 1, 1);
    }
    const tipLen = spr.hold === 'across' ? 4 : spr.pivotY - 4;
    const tipX = base.x + Math.cos(pose.angle) * tipLen * scale;
    const tipY = base.y + Math.sin(pose.angle) * tipLen * scale;
    if (w.dna.visual.glow && w.dna.visual.palette.glow) {
      this.#glow((base.x + tipX) / 2, (base.y + tipY) / 2, w.dna.visual.palette.glow, pose.striking ? 16 : 11);
    }
    if (pose.flash > 0) {
      // Muzzle flash / cast burst at the tip for ranged weapons.
      const r = 2 + pose.flash * 3;
      this.#circle(tipX, tipY, r + 1, w.trail, null, 0.6 * pose.flash);
      this.#circle(tipX, tipY, r * 0.6, '#ffffff', null, pose.flash);
      this.#glow(tipX, tipY, w.trail, 12 + pose.flash * 8);
    }
  }

  #drawReticle(game) {
    const t = game.target;
    if (!t || t.dead || game.player.dead) return;
    const v = this.v;
    const x = this.#sx(t.x);
    const y = this.#sy(t.y) - Math.round(t.r * T * 0.9);
    const size = Math.round(t.r * T + 5 + Math.sin(game.time * 8) * 1.5);
    const arm = Math.max(3, Math.round(size / 3));
    const color = t.boss || t.cloneOf ? '#ff5a3a' : '#ffd24a';
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const cx = x + sx * size;
      const cy = y + sy * size;
      v.fillStyle = '#161622';
      v.fillRect(cx - (sx > 0 ? arm : 0) - 1, cy - 1, arm + 2, 3);
      v.fillRect(cx - 1, cy - (sy > 0 ? arm : 0) - 1, 3, arm + 2);
      v.fillStyle = color;
      v.fillRect(cx - (sx > 0 ? arm - 1 : 0), cy, arm, 1);
      v.fillRect(cx, cy - (sy > 0 ? arm - 1 : 0), 1, arm);
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
          // A travelling crescent: thick in the middle, tapered at both ends,
          // sweeping in the swing's direction.
          const r = s.r * T * 0.9;
          const dir = s.dir ?? 1;
          const sweep = Math.min(1, k * 2.2);
          const tail = Math.max(0, k * 2.2 - 0.55);
          const a0 = s.angle - dir * s.arc / 2;
          const span = dir * s.arc;
          const from = a0 + span * tail;
          const to = a0 + span * sweep;
          const n = 14;
          const thick = Math.max(3, r * 0.34) * (1 - k * 0.6);
          const cy = y - 5;
          v.globalAlpha = Math.max(0, (1 - k) * (s.ghost ? 0.4 : 0.85));
          v.fillStyle = s.color;
          v.beginPath();
          for (let i = 0; i <= n; i++) {
            const a = from + (to - from) * (i / n);
            v.lineTo(x + Math.cos(a) * r, cy + Math.sin(a) * r);
          }
          for (let i = n; i >= 0; i--) {
            const a = from + (to - from) * (i / n);
            const w = thick * Math.sin((i / n) * Math.PI);
            v.lineTo(x + Math.cos(a) * (r - w), cy + Math.sin(a) * (r - w));
          }
          v.closePath();
          v.fill();
          v.strokeStyle = s.core ?? '#ffffff';
          v.lineWidth = 1;
          v.beginPath();
          v.arc(x, cy, r, Math.min(from, to), Math.max(from, to));
          v.stroke();
          const tipA = to;
          this.#glow(x + Math.cos(tipA) * r, cy + Math.sin(tipA) * r, s.color, 10);
          break;
        }
        case 'whip': {
          // A lash that uncoils towards the target, then relaxes.
          const len = s.r * T * Math.min(1, k * 3);
          const cy = y - 5;
          const ex = x + Math.cos(s.angle) * len;
          const ey = cy + Math.sin(s.angle) * len;
          const bend = (1 - Math.min(1, k * 2)) * len * 0.45 * (s.dir ?? 1);
          const mx = (x + ex) / 2 - Math.sin(s.angle) * bend;
          const my = (cy + ey) / 2 + Math.cos(s.angle) * bend;
          v.globalAlpha = s.ghost ? 0.45 : 1 - k * 0.7;
          v.strokeStyle = '#161622';
          v.lineWidth = 3;
          v.beginPath();
          v.moveTo(x, cy);
          v.quadraticCurveTo(mx, my, ex, ey);
          v.stroke();
          v.strokeStyle = s.color;
          v.lineWidth = 1.5;
          v.stroke();
          if (k < 0.5) {
            this.#circle(ex, ey, 2, s.tip, null, 1);
            this.#glow(ex, ey, s.tip, 10);
          }
          v.lineWidth = 1;
          break;
        }
        case 'thrust': {
          // A spear-shaped streak that shoots out and thins.
          const len = s.r * T * Math.min(1, k * 3);
          const cy = y - 5;
          const nx = Math.cos(s.angle);
          const ny = Math.sin(s.angle);
          const w = 3 * (1 - k);
          v.globalAlpha = Math.max(0, (1 - k) * (s.ghost ? 0.4 : 0.9));
          v.fillStyle = s.color;
          v.beginPath();
          v.moveTo(x - ny * w, cy + nx * w);
          v.lineTo(x + nx * len, cy + ny * len);
          v.lineTo(x + ny * w, cy - nx * w);
          v.closePath();
          v.fill();
          v.strokeStyle = s.core ?? '#ffffff';
          v.beginPath();
          v.moveTo(x, cy);
          v.lineTo(x + nx * len, cy + ny * len);
          v.stroke();
          this.#glow(x + nx * len, cy + ny * len, s.color, 9);
          break;
        }
        case 'cracks': {
          // Ground cracks radiating from a slam.
          v.globalAlpha = Math.max(0, 1 - k) * 0.8;
          v.strokeStyle = s.color;
          const r = s.r * T;
          for (let i = 0; i < 6; i++) {
            let a = s.seed + i * 1.05;
            let px = x;
            let py = y;
            v.beginPath();
            v.moveTo(px, py);
            for (let j = 0; j < 3; j++) {
              a += Math.sin(s.seed * (i + 1) * (j + 2)) * 0.5;
              px += Math.cos(a) * r * 0.33;
              py += Math.sin(a) * r * 0.2;
              v.lineTo(Math.round(px), Math.round(py));
            }
            v.stroke();
          }
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
