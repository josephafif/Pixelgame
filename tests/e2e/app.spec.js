import { test, expect } from '@playwright/test';
import { trackErrors, startGame, game } from './helpers.js';

test('boots, discovers the starter weapon and plays with keyboard + mouse', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  const weapon = await game(page, () => window.__pixelgame.game.weapon.dna);
  expect(weapon.rarity).toBe('common');
  await expect(page.locator('#hud-weapon')).toContainText(weapon.name.text);

  const before = await game(page, () => ({ ...window.__pixelgame.game.player }));
  await page.keyboard.down('KeyD');
  await page.keyboard.down('ShiftLeft');
  await page.waitForTimeout(600);
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyD');
  const after = await game(page, () => ({ ...window.__pixelgame.game.player }));
  expect(after.x).toBeGreaterThan(before.x + 1);

  await page.mouse.move(900, 300);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  expect(await game(page, () => window.__pixelgame.game.player.attackCount)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('weapons are generated in a Web Worker and drops open the discovery screen', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  expect(await game(page, () => window.__pixelgame.game.weapons.mode)).toBe('worker');
  await game(page, () => window.__pixelgame.game.debugDrop({ minRarity: 'legendary' }));
  await page.keyboard.down('KeyD');
  await expect(page.locator('.discovery')).toBeVisible({ timeout: 5000 });
  await page.keyboard.up('KeyD');
  await expect(page.locator('.weapon-card .rarity')).toHaveText('LEGENDARY');
  await expect(page.locator('.weapon-card .ability-name')).toBeVisible();
  await page.click('.discovery .btn-primary');
  await expect(page.locator('#btn-ability')).toBeAttached();
  const cast = await game(page, () => {
    const g = window.__pixelgame.game;
    return g.weapon.dna.ability !== null;
  });
  expect(cast).toBe(true);
  expect(errors).toEqual([]);
});

test('inventory, research, camp, forge and settings panels open', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  await page.keyboard.press('KeyI');
  await expect(page.locator('.inventory-panel')).toBeVisible();
  await page.click('.tab:has-text("Hero")');
  await expect(page.locator('.character')).toContainText('Critical Chance');
  await page.click('.tab:has-text("Codex")');
  await expect(page.locator('.codex')).toContainText('1 weapons discovered');
  await page.keyboard.press('Escape');

  await game(page, () => {
    const g = window.__pixelgame.game;
    g.save.player.level = 5;
    g.save.resources.essence = 500;
    g.save.resources.scrap = 200;
    g.discoverComponent('fire_core');
  });
  await page.keyboard.press('KeyR');
  await expect(page.locator('.research-panel')).toContainText('Fire Core');
  await page.click('.research-item .btn-primary');
  await expect(page.locator('.research-item .badge')).toHaveText('Researched');
  await page.keyboard.press('Escape');

  // No Forge yet: C opens the camp with the Forge highlighted.
  await page.keyboard.press('KeyC');
  await expect(page.locator('.base-panel')).toBeVisible();
  const forgeCard = page.locator('.bcard[data-building="forge"]');
  await expect(forgeCard).toHaveClass(/focus/);
  await forgeCard.locator('button:has-text("Build")').click();
  await expect(forgeCard).toContainText('Level 1');
  await expect(forgeCard.locator('button:has-text("Craft")')).toBeVisible();
  await forgeCard.locator('button:has-text("Craft")').click();

  await expect(page.locator('.forge-panel')).toBeVisible();
  // No pickaxe yet: the Forge opens on Tools first.
  await expect(page.locator('.tool-card').first()).toContainText('Iron Pickaxe');
  await page.click('.forge-panel .tab:has-text("Weapons")');
  await page.click('.forge .tile:has-text("Sword")');
  await page.click('.forge .chip:has-text("Fire Core")');
  await expect(page.locator('.forge-preview .result')).toContainText('Fire Sword');
  await page.click('.forge-preview .btn-primary');
  await expect(page.locator('.discovery')).toBeVisible();
  await expect(page.locator('.weapon-card .subtitle')).toContainText('Fire');
  await page.click('.discovery button:has-text("Keep in bag")');

  await page.keyboard.press('Escape');
  await page.click('.menu button:has-text("Settings")');
  await expect(page.locator('.settings-panel')).toContainText('Offline play');
  expect(errors).toEqual([]);
});

test('inventory: keyboard navigation, favorites, filters and quick salvage', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  await game(page, async () => {
    const g = window.__pixelgame.game;
    for (let i = 0; i < 4; i++) {
      const dna = await g.weapons.generate({ seed: 500 + i, level: 3, luck: 0, source: 'drop', unlocked: [], maxRarity: 'uncommon' });
      g.save.inventory.bag.push(dna);
      g.save.inventory.unseen.push(dna.id);
    }
  });
  await page.keyboard.press('KeyI');
  await expect(page.locator('.inv-grid .slot:not(.empty)')).toHaveCount(5);
  await expect(page.locator('.slot .badge-new')).toHaveCount(4);
  // The equipped weapon leads and starts selected.
  await expect(page.locator('.slot.selected .badge-e')).toBeVisible();
  const equippedName = await page.locator('.inv-detail .weapon-name').textContent();

  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.inv-detail .weapon-name')).not.toHaveText(equippedName);
  await expect(page.locator('.slot .badge-new')).toHaveCount(3); // seen now
  const picked = await page.locator('.inv-detail .weapon-name').textContent();

  await page.keyboard.press('KeyF');
  await expect(page.locator('.slot.selected .badge-fav')).toBeVisible();
  await page.click('.inv-toolbar .chip:has-text("★")');
  await expect(page.locator('.inv-grid .slot:not(.empty)')).toHaveCount(1);
  await page.click('.inv-toolbar .chip:has-text("All")');

  // Quick salvage keeps the equipped weapon and favorites.
  await page.click('.inv-count .chip:has-text("Quick salvage")');
  page.once('dialog', (d) => d.accept());
  await page.click('.bulk button:has-text("Uncommon and below")');
  await expect(page.locator('.inv-grid .slot:not(.empty)')).toHaveCount(2);
  const left = await game(page, () => window.__pixelgame.game.save.inventory.bag.map((w) => w.name.text));
  expect(left).toContain(equippedName);
  expect(left).toContain(picked);

  // Q/E switch tabs.
  await page.keyboard.press('KeyE');
  await expect(page.locator('.tab.active')).toContainText('Storage');
  await page.keyboard.press('KeyQ');
  await expect(page.locator('.tab.active')).toContainText('Bag');
  await page.keyboard.press('Escape');
  // Keys pressed in the panel don't leak into the game afterwards.
  expect(await game(page, () => window.__pixelgame.game.input.commands.length)).toBe(0);
  expect(errors).toEqual([]);
});

test('camp: buildings upgrade, the well pays out and the waystone recalls', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  await game(page, () => {
    const g = window.__pixelgame.game;
    g.save.player.level = 12;
    g.save.resources.essence = 2000;
    g.save.resources.scrap = 2000;
    g.save.resources.wood = 500;
    g.save.resources.stone = 500;
  });
  await expect(page.locator('#btn-base')).toHaveClass(/alert/);
  await page.keyboard.press('KeyB');
  await expect(page.locator('.base-panel')).toBeVisible();
  const hpBefore = await game(page, () => window.__pixelgame.game.pstats.maxHp);
  await page.click('.bcard[data-building="hearth"] button:has-text("Upgrade")');
  await expect(page.locator('.bcard[data-building="hearth"]')).toContainText('Level 2');
  expect(await game(page, () => window.__pixelgame.game.pstats.maxHp)).toBeGreaterThan(hpBefore);

  await page.click('.bcard[data-building="well"] button:has-text("Build")');
  await game(page, () => {
    window.__pixelgame.game.save.base.wellAt = Date.now() - 2 * 3600 * 1000;
    window.__pixelgame.game.emit('base');
  });
  const essence = await game(page, () => window.__pixelgame.game.save.resources.essence);
  await page.click('.bcard[data-building="well"] button:has-text("Collect")');
  const rate = await game(page, () => window.__pixelgame.data.base.buildings.find((b) => b.id === 'well').perLevel.essencePerHour);
  expect(await game(page, () => window.__pixelgame.game.save.resources.essence)).toBe(essence + 2 * rate);

  await page.click('.bcard[data-building="waystone"] button:has-text("Build")');
  await page.keyboard.press('Escape');
  await game(page, () => {
    const g = window.__pixelgame.game;
    g.player.x = 40;
    g.player.y = 40;
  });
  await page.keyboard.press('Escape');
  await page.click('.menu button:has-text("Recall to camp")');
  const pos = await game(page, () => ({ x: window.__pixelgame.game.player.x, y: window.__pixelgame.game.player.y }));
  expect(Math.hypot(pos.x, pos.y)).toBeLessThan(8);
  expect(errors).toEqual([]);
});

test('auto-aim: the weapon turns to the nearest enemy by itself', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  const aimed = await game(page, async () => {
    const g = window.__pixelgame.game;
    g.player.x = 60;
    g.player.y = 60;
    g.enemies.length = 0;
    const { spawnEnemy } = await import('/src/game/enemies.js');
    const e = spawnEnemy(g, 'slime', 60, 57);
    await new Promise((r) => setTimeout(r, 300));
    return { locked: g.target === e, facing: g.player.facing };
  });
  expect(aimed.locked).toBe(true);
  // Enemy straight "up" (negative y) → facing ≈ -π/2.
  expect(Math.abs(Math.sin(aimed.facing) + 1)).toBeLessThan(0.05);
  expect(errors).toEqual([]);
});

test('progress is saved to IndexedDB and restored after a reload', async ({ page }) => {
  await startGame(page);
  const id = await game(page, async () => {
    const g = window.__pixelgame.game;
    g.save.resources.essence = 321;
    await g.saveNow();
    return g.weapon.dna.id;
  });
  await page.reload();
  await expect(page.locator('#title-play')).toHaveText('Continue');
  const restored = await game(page, () => {
    const g = window.__pixelgame.game;
    return { essence: g.save.resources.essence, weapon: g.weapon?.dna.id, storage: window.__pixelgame.app.storage.kind };
  });
  expect(restored).toEqual({ essence: 321, weapon: id, storage: 'indexeddb' });
});

test('save export produces a valid file that imports back', async ({ page }) => {
  await startGame(page);
  const text = await game(page, async () => {
    const { exportSave, parseImport } = await import('/src/storage/save.js');
    const s = exportSave(window.__pixelgame.game.save);
    parseImport(s);
    return s;
  });
  expect(JSON.parse(text).format).toBe('pixelgame-save');
});

test('gathering: forge a pickaxe, chop a tree, collect the wood', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  const spot = await game(page, () => {
    const g = window.__pixelgame.game;
    g.save.player.level = 5;
    Object.assign(g.save.resources, { scrap: 500, essence: 500 });
    g.upgradeBuilding('forge');
    // Find a tree outside the camp and stand next to it.
    const w = g.world;
    for (let r = 12; r < 60; r++) {
      for (let x = -r; x <= r; x++) {
        if (w.blockAt(x, r) === 22 && w.isFree(x + 0.5, r - 0.6, 0.32)) {
          g.enemies.length = 0;
          g.player.x = x + 0.5;
          g.player.y = r - 0.6;
          g.player.facing = Math.PI / 2;
          g.renderer.snapCamera();
          return { x, y: r };
        }
      }
    }
    return null;
  });
  expect(spot).not.toBeNull();
  await page.keyboard.press('KeyC');
  await page.click('.tool-card:has-text("Iron Pickaxe") button:has-text("Forge")');
  await expect(page.locator('.tool-card').first()).toContainText('Equipped');
  await page.keyboard.press('Escape');
  await expect(page.locator('#interact-hint')).toContainText('Chop tree');
  await page.keyboard.down('Space');
  await expect.poll(() => game(page, (s) => window.__pixelgame.game.world.blockAt(s.x, s.y), spot), { timeout: 8000 }).toBe(0);
  await page.keyboard.up('Space');
  await expect.poll(() => game(page, () => window.__pixelgame.game.save.resources.wood), { timeout: 5000 }).toBeGreaterThan(0);
  expect(await game(page, (s) => Boolean(window.__pixelgame.game.save.world.harvested[`${s.x},${s.y}`]), spot)).toBe(true);
  expect(errors).toEqual([]);
});

test('building: place walls with the mouse, gates let you through, Esc leaves build mode', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  await game(page, () => {
    const g = window.__pixelgame.game;
    Object.assign(g.save.resources, { wood: 200, stone: 200, scrap: 200 });
    g.player.x = 5.5;
    g.player.y = 1.5;
    g.renderer.snapCamera();
  });
  await page.waitForTimeout(300);
  await expect(page.locator('#btn-build')).toBeVisible();
  await page.keyboard.press('KeyG');
  await expect(page.locator('#build-bar')).toBeVisible();
  await expect(page.locator('#build-bar .bitem.on')).toContainText('Wooden Wall');
  // Click on tile (8, 1) and drag to (8, 3) to build a short wall line.
  const at = (tx, ty) => game(page, ([x, y]) => window.__pixelgame.game.renderer.worldToScreen(x + 0.5, y + 0.5), [tx, ty]);
  const a = await at(8, 0);
  const b = await at(8, 2);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
  const walls = await game(page, () => window.__pixelgame.game.save.base.structures.map((s) => `${s.id}@${s.x},${s.y}`));
  expect(walls).toEqual(['wood_wall@8,0', 'wood_wall@8,1', 'wood_wall@8,2']);
  // Walls block enemies; a gate lets only you through.
  await page.keyboard.press('Digit3');
  await expect(page.locator('#build-bar .bitem.on')).toContainText('Gate');
  const c = await at(8, 3);
  await page.mouse.click(c.x, c.y);
  const blocked = await game(page, () => {
    const w = window.__pixelgame.game.world;
    return { wall: w.blockedFor(8, 1, 'enemy'), gatePlayer: w.blockedFor(8, 3, 'player'), gateEnemy: w.blockedFor(8, 3, 'enemy') };
  });
  expect(blocked).toEqual({ wall: true, gatePlayer: false, gateEnemy: true });
  // Right-click removes (with a partial refund).
  const wood = await game(page, () => window.__pixelgame.game.save.resources.wood);
  await page.mouse.click(a.x, a.y, { button: 'right' });
  expect(await game(page, () => window.__pixelgame.game.world.structureAt(8, 0))).toBeNull();
  expect(await game(page, () => window.__pixelgame.game.save.resources.wood)).toBeGreaterThan(wood);
  await page.keyboard.press('Escape');
  await expect(page.locator('#build-bar')).toBeHidden();
  await expect(page.locator('.menu-panel')).toHaveCount(0);
  // Structures survive a reload (saved to IndexedDB) and still block enemies.
  await game(page, () => window.__pixelgame.game.saveNow());
  await page.reload();
  await expect(page.locator('#title-play')).toHaveText('Continue');
  const after = await game(page, () => {
    const g = window.__pixelgame.game;
    return { ids: g.save.base.structures.map((s) => `${s.id}@${s.x},${s.y}`).sort(), blocks: g.world.blockedFor(8, 1, 'enemy') };
  });
  expect(after).toEqual({ ids: ['gate@8,3', 'wood_wall@8,1', 'wood_wall@8,2'], blocks: true });
  expect(errors).toEqual([]);
});

test('enemies only notice you within sight range; loot never lands in water', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  const result = await game(page, async () => {
    const g = window.__pixelgame.game;
    const { spawnEnemy } = await import('/src/game/enemies.js');
    g.enemies.length = 0;
    g.player.x = 80;
    g.player.y = 80;
    const far = spawnEnemy(g, 'slime', 80 + 12, 80);
    await new Promise((r) => setTimeout(r, 600));
    const farAlert = far.alert;
    const near = spawnEnemy(g, 'slime', 80 + 3, 80);
    await new Promise((r) => setTimeout(r, 400));
    // Loot dropped over water moves to dry land.
    const w = g.world;
    let water = null;
    for (let r = 10; r < 90 && !water; r++) {
      for (let x = -r; x <= r && !water; x++) if (w.blockAt(x, r) === 20) water = { x: x + 0.5, y: r + 0.5 };
    }
    const { addPickup } = await import('/src/game/loot.js');
    addPickup(g, 'essence', water.x, water.y, { value: 1, color: '#7ae0ff' });
    const it = g.pickups[g.pickups.length - 1];
    return { farAlert, nearAlert: near.alert, lootOnLand: w.isFree(it.x, it.y, 0.2) };
  });
  expect(result).toEqual({ farAlert: false, nearAlert: true, lootOnLand: true });
  expect(errors).toEqual([]);
});

test('browser safety: no context menu, no text selection, Ctrl+S saves the game', async ({ page }) => {
  await startGame(page);
  const blocked = await page.evaluate(() => {
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.querySelector('#game').dispatchEvent(ev);
    const ev2 = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.querySelector('#btn-inventory').dispatchEvent(ev2);
    return [ev.defaultPrevented, ev2.defaultPrevented, getComputedStyle(document.body).userSelect];
  });
  expect(blocked).toEqual([true, true, 'none']);
  await page.keyboard.press('Control+s');
  await expect(page.locator('.toast', { hasText: 'Game saved' })).toBeVisible();
});
