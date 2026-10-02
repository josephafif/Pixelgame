import { test, expect } from '@playwright/test';
import { trackErrors, startGame, game, stubSupabase } from './helpers.js';

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
  // Forged weapons are revealed with a case roll; Skip jumps to the result.
  await expect(page.locator('.case-roll')).toBeVisible();
  await page.click('.case-roll .skip');
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
  expect(await game(page, () => window.__pixelgame.game.atCamp())).toBe(true);
  expect(Math.hypot(pos.x, pos.y)).toBeLessThan(10);
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
    // The slime may have shuffled a little: aim is checked against where it is now.
    const want = Math.atan2(e.y - g.player.y, e.x - g.player.x);
    return { locked: g.target === e, facing: g.player.facing, want };
  });
  expect(aimed.locked).toBe(true);
  // Enemy above (negative y; it may spawn a tile aside if that spot is blocked),
  // and the weapon points right at it.
  expect(Math.sin(aimed.facing)).toBeLessThan(-0.5);
  expect(Math.abs(Math.sin((aimed.facing - aimed.want) / 2))).toBeLessThan(0.05);
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
  // The pickaxe lives in slot 3: switch to it before chopping.
  const target = () => game(page, () => window.__pixelgame.game.interactTarget?.type ?? null);
  expect(await target()).not.toBe('harvest');
  await page.keyboard.press('Digit3');
  await expect(page.locator('#slot-tool')).toHaveClass(/\bon\b/);
  // The tree is outlined, but no text box covers the view.
  await expect.poll(target).toBe('harvest');
  await expect(page.locator('#interact-hint')).toBeHidden();
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

test('loadout: main, secondary and a reserved pickaxe slot on the hotbar', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  await expect(page.locator('#hotbar')).toBeVisible();
  await expect(page.locator('#slot-main')).toHaveClass(/\bon\b/);
  const mainId = await game(page, () => window.__pixelgame.game.weapon.dna.id);

  // A new weapon can go straight into the secondary slot.
  await game(page, async () => {
    const g = window.__pixelgame.game;
    const dna = await g.weapons.generate({ seed: 91, level: 3, luck: 0, source: 'drop', unlocked: [], minRarity: 'rare', maxRarity: 'rare' });
    g.discoverWeapon(dna);
  });
  await expect(page.locator('.discovery')).toBeVisible();
  await page.click('.discovery button:has-text("Secondary")');
  await expect(page.locator('.discovery')).toBeHidden();
  const secId = await game(page, () => window.__pixelgame.game.save.inventory.secondary);
  expect(secId).toBeTruthy();
  expect(await game(page, () => window.__pixelgame.game.save.inventory.equipped)).toBe(mainId);

  await page.keyboard.press('Digit2');
  await expect(page.locator('#slot-secondary')).toHaveClass(/\bon\b/);
  expect(await game(page, () => window.__pixelgame.game.weapon.dna.id)).toBe(secId);

  // No pickaxe yet: slot 3 is locked (wait until the game has handled the key).
  await page.keyboard.press('Digit3');
  await expect(page.locator('#toasts')).toContainText('No pickaxe');
  expect(await game(page, () => window.__pixelgame.game.toolActive)).toBe(false);
  await game(page, () => {
    const g = window.__pixelgame.game;
    g.save.tools.pickaxe = 1;
    g.emit('tools');
  });
  await page.keyboard.press('Digit3');
  await expect(page.locator('#slot-tool')).toHaveClass(/\bon\b/);
  expect(await game(page, () => window.__pixelgame.game.toolActive)).toBe(true);
  await expect(page.locator('#hud-weapon')).toContainText('Pickaxe');

  await page.click('#slot-main');
  expect(await game(page, () => window.__pixelgame.game.activeSlot)).toBe('main');
  expect(await game(page, () => window.__pixelgame.game.weapon.dna.id)).toBe(mainId);
  expect(errors).toEqual([]);
});

test('legendaries are revealed with a case roll and have a gold value', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  await game(page, async () => {
    const g = window.__pixelgame.game;
    const dna = await g.weapons.generate({ seed: 777, level: 12, luck: 0, source: 'drop', unlocked: [], minRarity: 'legendary' });
    g.discoverWeapon(dna, { caseRoll: { min: 'uncommon', max: 'legendary', title: 'Opening chest…' } });
  });
  await expect(page.locator('.case-roll')).toBeVisible();
  await expect(page.locator('.case-item').first()).toBeVisible();
  // The strip ends on the weapon that was decided before the roll.
  await expect(page.locator('.case-roll.legendary .case-item.win')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.discovery')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.discovery .jackpot')).toContainText('gold');
  await expect(page.locator('.discovery .value-row')).toContainText('gold');
  await page.click('.discovery button:has-text("Keep in bag")');
  await expect(page.locator('.discovery')).toBeHidden();
  expect(errors).toEqual([]);
});

test('markets: trade with merchants, sell loot, and anger the guards', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  const m = await game(page, () => {
    const g = window.__pixelgame.game;
    const m = g.world.firstMarket;
    g.save.resources.gold = 5000;
    g.save.resources.wood = 50;
    g.player.x = m.x + 0.5;
    g.player.y = m.y + m.r + 4;
    g.renderer.snapCamera();
    return { id: m.id, x: m.x, y: m.y, name: m.name };
  });
  await expect.poll(() => game(page, () => window.__pixelgame.game.markets.npcs.length)).toBeGreaterThan(3);
  expect(await game(page, (id) => window.__pixelgame.game.save.markets[id]?.seen, m.id)).toBe(true);
  // Monsters never spawn inside the market.
  expect(await game(page, (mm) => window.__pixelgame.game.world.marketAt(mm.x + 0.5, mm.y + 0.5, 0) !== null, m)).toBe(true);

  // Stand across the counter from a merchant.
  await game(page, () => {
    const g = window.__pixelgame.game;
    const n = g.markets.npcs.find((v) => v.role === 'merchant');
    g.player.x = n.x;
    g.player.y = n.y + 1.85;
    g.renderer.snapCamera();
  });
  await expect(page.locator('#interact-hint')).toContainText('Trade with');
  await page.keyboard.press('KeyE');
  await expect(page.locator('.market-panel')).toBeVisible();
  await expect(page.locator('.market-head')).toContainText('5,000');
  await expect(page.locator('.market-panel .mrow').first()).not.toContainText('Unpacking', { timeout: 10000 });

  // Buy a bundle of wood.
  const woodRow = page.locator('.market-panel .mrow', { hasText: 'Wood' }).first();
  await woodRow.locator('button:has-text("Buy")').click();
  expect(await game(page, () => window.__pixelgame.game.save.resources.wood)).toBe(70);
  expect(await game(page, () => window.__pixelgame.game.save.resources.gold)).toBeLessThan(5000);
  await expect(woodRow).toContainText('Sold');

  // Sell a spare weapon.
  await game(page, async () => {
    const g = window.__pixelgame.game;
    const dna = await g.weapons.generate({ seed: 55, level: 3, luck: 0, source: 'drop', unlocked: [], maxRarity: 'rare' });
    g.addWeapon(dna);
  });
  await page.click('.market-panel .tab:has-text("Sell")');
  const goldBefore = await game(page, () => window.__pixelgame.game.save.resources.gold);
  const weapons = await game(page, () => window.__pixelgame.game.allWeapons().length);
  await page.locator('.market-panel .mrow button:has-text("Sell")').first().click();
  expect(await game(page, () => window.__pixelgame.game.allWeapons().length)).toBe(weapons - 1);
  expect(await game(page, () => window.__pixelgame.game.save.resources.gold)).toBeGreaterThan(goldBefore);
  await page.keyboard.press('Escape');
  await expect(page.locator('.market-panel')).toBeHidden();

  // Hurting someone turns the turrets hostile and closes the stalls.
  await game(page, () => {
    const g = window.__pixelgame.game;
    const n = g.markets.npcs.find((v) => v.role === 'villager');
    g.hitNpcs({ kind: 'circle', x: n.x, y: n.y, r: 0.5 }, 5);
  });
  expect(await game(page, (id) => window.__pixelgame.game.markets.isHostile(id), m.id)).toBe(true);
  await expect(page.locator('#interact-hint')).toContainText("won't trade");
  const hp = await game(page, () => window.__pixelgame.game.player.hp);
  await expect.poll(() => game(page, () => window.__pixelgame.game.player.hp), { timeout: 6000 }).toBeLessThan(hp);
  await page.keyboard.press('KeyE');
  await expect(page.locator('.market-panel')).toBeHidden();
  expect(errors).toEqual([]);
});

test('map: shows explored areas, hotspots and your own pins', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  await expect.poll(() => game(page, () => window.__pixelgame.game.save.world.explored.length)).toBeGreaterThan(0);
  await page.keyboard.press('KeyM');
  await expect(page.locator('.map-panel')).toBeVisible();
  await expect(page.locator('.map-status')).toContainText('explored');
  // Let the panel's opening animation finish so the canvas stays put.
  await page.waitForFunction(() => document.querySelector('.map-panel').getAnimations().length === 0);
  const canvas = page.locator('.map-canvas');
  const box = await canvas.boundingBox();
  expect(box.width).toBeGreaterThan(200);
  // The canvas actually drew explored ground.
  const painted = await page.evaluate(() => {
    const c = document.querySelector('.map-canvas');
    const d = c.getContext('2d').getImageData(c.width / 2 - 20, c.height / 2 - 20, 40, 40).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 120) lit++;
    return lit;
  });
  expect(painted).toBeGreaterThan(50);

  await page.click('.map-tools button:has-text("Pin")');
  await canvas.click({ position: { x: box.width / 2 + 60, y: box.height / 2 + 30 } });
  expect(await game(page, () => window.__pixelgame.game.save.world.pins.length)).toBe(1);
  await canvas.click({ position: { x: box.width / 2 + 60, y: box.height / 2 + 30 } });
  expect(await game(page, () => window.__pixelgame.game.save.world.pins.length)).toBe(0);
  await page.click('.map-tools button:has-text("+")');
  await page.keyboard.press('KeyM');
  await expect(page.locator('.map-panel')).toBeHidden();
  expect(errors).toEqual([]);
});

test('empty hands: pressing your slot again puts it away', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  // Away from the camp, so Space has nothing to use.
  await game(page, () => {
    const g = window.__pixelgame.game;
    g.enemies.length = 0;
    const spot = g.world.findFreeSpot(60.5, 60.5);
    g.player.x = spot.x;
    g.player.y = spot.y;
    g.renderer.snapCamera();
  });
  await page.keyboard.press('Digit1');
  await expect.poll(() => game(page, () => window.__pixelgame.game.activeSlot)).toBe('none');
  await expect(page.locator('#hud-weapon')).toContainText('Empty hands');
  await expect(page.locator('#hotbar .hslot.on')).toHaveCount(0);
  const before = await game(page, () => window.__pixelgame.game.player.attackCount);
  await page.keyboard.down('Space');
  await page.waitForTimeout(500);
  await page.keyboard.up('Space');
  expect(await game(page, () => window.__pixelgame.game.player.attackCount)).toBe(before);
  await page.keyboard.press('Digit1');
  await expect.poll(() => game(page, () => window.__pixelgame.game.activeSlot)).toBe('main');
  await expect(page.locator('#slot-main')).toHaveClass(/\bon\b/);
  expect(errors).toEqual([]);
});

test('loot odds: the menu shows the chance of every rarity', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  await page.keyboard.press('Escape');
  await page.click('.menu button:has-text("Loot odds")');
  const table = page.locator('.odds-table');
  await expect(table).toBeVisible();
  for (const r of ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary']) await expect(table.locator('thead')).toContainText(r);
  const monster = table.locator('tbody tr', { hasText: 'Monster' }).first();
  await expect(monster).toContainText('%');
  await expect(table.locator('tbody tr', { hasText: 'Golden Catalyst' })).toContainText('100%');
  expect(errors).toEqual([]);
});

test('sailing: build a raft, set sail from the beach and go ashore again', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  const beach = await game(page, async () => {
    const g = window.__pixelgame.game;
    const { T } = await import('/src/game/world.js');
    g.godMode = true;
    Object.assign(g.save.resources, { wood: 500, essence: 500 });
    g.save.base.buildings.forge = 1;
    const w = g.world;
    for (let r = 175; r < 900; r += 3) {
      for (let a = 0; a < 96; a++) {
        const x = Math.round(Math.cos((a / 96) * Math.PI * 2) * r);
        const y = Math.round(Math.sin((a / 96) * Math.PI * 2) * r);
        if (w.blockAt(x, y) !== 0 || !w.isFree(x + 0.5, y + 0.5, 0.35)) continue;
        // Nothing else to use nearby (a find would take the prompt).
        if (w.objectsNear(x, y, 1).some((o) => Math.hypot(o.x - x - 0.5, o.y - y - 0.5) < 3)) continue;
        if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => w.blockAt(x + dx, y + dy) === T.SEA)) {
          g.enemies.length = 0;
          g.player.x = x + 0.5;
          g.player.y = y + 0.5;
          g.renderer.snapCamera();
          return { x, y };
        }
      }
    }
    return null;
  });
  expect(beach).not.toBeNull();
  await expect(page.locator('#interact-hint')).toContainText('Build a boat');
  await page.keyboard.press('KeyC');
  await page.click('.forge-panel .tab:has-text("Tools")');
  await page.click('.tool-card:has-text("Log Raft") button:has-text("Build")');
  await expect(page.locator('.tool-card', { hasText: 'Log Raft' })).toContainText('Yours');
  await page.keyboard.press('Escape');
  await expect(page.locator('#interact-hint')).toContainText('Set sail');
  await page.keyboard.press('KeyE');
  await expect.poll(() => game(page, () => window.__pixelgame.game.sailing)).toBe(true);
  expect(await game(page, () => {
    const g = window.__pixelgame.game;
    return g.world.blockedFor(Math.floor(g.player.x), Math.floor(g.player.y), 'player');
  })).toBe(true);
  await expect(page.locator('#interact-hint')).toContainText('Go ashore');
  await page.keyboard.press('KeyE');
  await expect.poll(() => game(page, () => window.__pixelgame.game.sailing)).toBe(false);
  expect(await game(page, () => {
    const g = window.__pixelgame.game;
    return g.world.isFree(g.player.x, g.player.y, g.player.r);
  })).toBe(true);
  expect(errors).toEqual([]);
});

test('bosses fight differently: ice rings, meteors and mirror images', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  const result = await game(page, async () => {
    const g = window.__pixelgame.game;
    g.godMode = true;
    const { spawnBoss } = await import('/src/game/enemies.js');
    const out = {};
    for (const [id, pat] of [['frost_warden', 'icering'], ['inferno_titan', 'meteors'], ['void_herald', 'clones']]) {
      g.enemies.length = 0;
      g.areas.length = 0;
      g.projectiles.length = 0;
      const lm = g.world.landmarks.find((l) => l.bossId === id);
      g.player.x = lm.x;
      g.player.y = lm.y + 1;
      const b = spawnBoss(g, id, lm.x, lm.y - 4);
      b.bossDef = { ...b.bossDef, patterns: [pat] };
      b.patternCd = 0;
      await new Promise((r) => setTimeout(r, 900));
      out[pat] = {
        projectiles: g.projectiles.length,
        telegraphs: g.areas.filter((a) => a.kind === 'telegraph').length,
        clones: g.enemies.filter((e) => e.cloneOf === b && !e.dead).length,
      };
      g.enemies.length = 0;
    }
    return out;
  });
  expect(result.icering.projectiles).toBeGreaterThan(10);
  expect(result.meteors.telegraphs).toBeGreaterThan(2);
  expect(result.clones.clones).toBeGreaterThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('map: zooms far out and frames everything explored', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  await game(page, () => {
    const g = window.__pixelgame.game;
    for (let x = -60; x <= 60; x++) g.save.world.explored.push(`${x},0`);
    g.explored = new Set(g.save.world.explored);
  });
  await page.keyboard.press('KeyM');
  await expect(page.locator('.map-panel')).toBeVisible();
  await page.click('.map-tools button:has-text("All")');
  for (let i = 0; i < 12; i++) await page.click('.map-tools button[aria-label="Zoom out"]');
  await page.waitForTimeout(200);
  const painted = await page.evaluate(() => {
    const c = document.querySelector('.map-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 120) lit++;
    return lit;
  });
  expect(painted).toBeGreaterThan(20);
  expect(errors).toEqual([]);
});

test('the sea has sharks and serpents: they stay in the water, dive, and their loot floats', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  const spot = await game(page, () => {
    const g = window.__pixelgame.game;
    g.save.tools.boat = 2;
    g.pstats.maxHp = 100000;
    g.player.hp = 100000;
    const w = g.world;
    for (let r = 200; r < 1600; r += 4) {
      for (let a = 0; a < 128; a++) {
        const x = Math.round(Math.cos((a / 128) * Math.PI * 2) * r);
        const y = Math.round(Math.sin((a / 128) * Math.PI * 2) * r);
        if (w.isFree(x + 0.5, y + 0.5, 3, 'deepswim')) {
          g.enemies.length = 0;
          g.save.player.sailing = true;
          g.player.x = x + 0.5;
          g.player.y = y + 0.5;
          g.renderer.snapCamera();
          return { x, y };
        }
      }
    }
    return null;
  });
  expect(spot).not.toBeNull();
  // The spawner fills the sea around you with sharks.
  await expect.poll(() => game(page, () => window.__pixelgame.game.enemies.filter((e) => e.kind === 'shark').length), { timeout: 8000 }).toBeGreaterThan(0);
  const serpent = await game(page, async () => {
    const g = window.__pixelgame.game;
    const { spawnEnemy } = await import('/src/game/enemies.js');
    const p = g.player;
    const at = g.world.findFreeSpot(p.x, p.y - 4, 0.6, 'deepswim', null);
    const e = spawnEnemy(g, 'serpent', at.x, at.y, { level: 5 });
    e.alert = true;
    e.phaseT = 0.5;
    e.underTest = true; // the spawner may add a serpent of its own
    return Boolean(e);
  });
  expect(serpent).toBe(true);
  await expect.poll(() => game(page, () => window.__pixelgame.game.enemies.find((e) => e.underTest)?.submerged ?? false), { timeout: 5000 }).toBe(true);
  const underWater = await game(page, () => {
    const g = window.__pixelgame.game;
    const s = g.enemies.find((e) => e.underTest);
    return { hit: g.damageEnemy(s, 50, {}), wet: g.enemies.filter((e) => e.def.sea).every((e) => g.world.isSea(e.x, e.y)) };
  });
  expect(underWater.hit).toBe(0);
  expect(underWater.wet).toBe(true);
  await game(page, () => {
    const g = window.__pixelgame.game;
    const shark = g.enemies.find((e) => e.kind === 'shark');
    g.damageEnemy(shark, 99999, {});
  });
  await expect.poll(() => game(page, () => window.__pixelgame.game.pickups.length)).toBeGreaterThan(0);
  expect(await game(page, () => {
    const g = window.__pixelgame.game;
    return g.pickups.every((p) => g.world.isSea(p.x, p.y) || g.world.isFree(p.x, p.y, 0.2));
  })).toBe(true);
  expect(errors).toEqual([]);
});

test('settings: the view size changes how much of the world you see', async ({ page }) => {
  await startGame(page);
  const tiles = () => game(page, () => window.__pixelgame.game.renderer.view.width);
  const normal = await tiles();
  await game(page, () => window.__pixelgame.game.updateSettings({ viewSize: 'wide' }));
  const wide = await tiles();
  await game(page, () => window.__pixelgame.game.updateSettings({ viewSize: 'close' }));
  const close = await tiles();
  expect(wide).toBeGreaterThan(normal);
  expect(close).toBeLessThan(normal);
});

test('main menu: settings and how to play before you start; multiplayer opens its lobby', async ({ page }) => {
  const errors = trackErrors(page);
  await stubSupabase(page);
  await page.goto('/?debug=1');
  await expect(page.locator('#title')).toBeVisible();
  for (const id of ['#title-play', '#title-multiplayer', '#title-settings', '#title-howto']) await expect(page.locator(id)).toBeVisible();
  await page.click('#title-multiplayer');
  const modal = page.locator('.modal, [role="dialog"]').last();
  await expect(modal).toContainText('Spela på en väns server');
  // No official server yet: its place says so (and Google login shows once it's switched on).
  await expect(modal.locator('.mp-official')).toContainText('inte igång än');
  await expect(modal).toContainText('Fristaden');
  await page.keyboard.press('Escape');
  await expect(page.locator('.mp-lobby')).toBeHidden();
  await page.click('#title-settings');
  await expect(page.locator('.settings')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.settings')).toBeHidden();
  await page.click('#title-howto');
  await expect(page.locator('.tutorial')).toContainText('Pal Den');
  await page.click('.tutorial button');
  // Still on the title: nothing started behind the menus.
  await expect(page.locator('#title')).toBeVisible();
  expect(await game(page, () => window.__pixelgame.app.started)).toBeFalsy();
  expect(errors).toEqual([]);
});

test('monsters differ per biome and are animated', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  const result = await game(page, async () => {
    const g = window.__pixelgame.game;
    const { spawnEnemy } = await import('/src/game/enemies.js');
    g.spawnTimer = 1e9;
    g.enemies.length = 0;
    const out = {};
    for (const kind of ['wolf', 'scorpion', 'shade', 'crab']) {
      const spot = g.world.findFreeSpot(g.player.x + 4, g.player.y, 0.4, 'enemy', null);
      const e = spawnEnemy(g, kind, spot.x, spot.y, { level: 1 });
      out[kind] = { frames: e.sprites.walk.right.length, attack: e.sprites.attack.right.length };
    }
    return out;
  });
  for (const r of Object.values(result)) expect(r.frames).toBeGreaterThanOrEqual(2);
  expect(result.wolf.attack).toBe(1);
  // A charger winds up, then dashes.
  const states = await game(page, async () => {
    const g = window.__pixelgame.game;
    const wolf = g.enemies.find((e) => e.kind === 'wolf');
    wolf.x = g.player.x + 2;
    wolf.y = g.player.y;
    wolf.alert = true;
    wolf.atkCd = 0;
    const seen = new Set();
    for (let i = 0; i < 90; i++) {
      g.update(1 / 60);
      seen.add(wolf.state);
    }
    return [...seen];
  });
  expect(states).toContain('windup');
  expect(states).toContain('charge');
  expect(errors).toEqual([]);
});

test('pals: an egg hatches at the Pal Den, the pal gathers and fights, and upgrades make it stronger', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  await game(page, () => {
    const g = window.__pixelgame.game;
    g.godMode = true;
    g.save.player.level = 20;
    Object.assign(g.save.resources, { scrap: 9000, essence: 9000, wood: 9000, stone: 9000 });
    g.data.pals.eggChance.elite = 1;
    g.dropEgg('elite', g.player.x + 1, g.player.y);
  });
  await expect.poll(() => game(page, () => window.__pixelgame.game.save.pals.eggs.length)).toBe(1);
  // A Mossling: the quickest gatherer, so the test doesn't wait on a slow chopper.
  await game(page, () => { window.__pixelgame.game.save.pals.eggs[0].species = 'mossling'; });
  await expect(page.locator('#toasts')).toContainText('Pal Egg');
  // No den yet: the panel says so.
  await page.keyboard.press('KeyH');
  await expect(page.locator('.pals-panel')).toBeVisible();
  await expect(page.locator('.pals-panel .notice')).toContainText('Pal Den');
  await game(page, () => window.__pixelgame.game.upgradeBuilding('den'));
  await page.click('.pals-panel [data-action="hatch"]');
  await expect(page.locator('.pals-panel .egg-card')).toContainText('hatches in');
  await game(page, () => { for (const e of window.__pixelgame.game.save.pals.eggs) e.hatchAt = Date.now() - 1; });
  await expect(page.locator('.pals-panel .pal-card.active')).toBeVisible({ timeout: 4000 });
  const palId = await game(page, () => window.__pixelgame.game.save.pals.active);
  expect(palId).toBeTruthy();
  const hp = await game(page, () => window.__pixelgame.game.pal.stats.maxHp);
  await page.click('.pals-panel [data-action="upgrade"]');
  await expect.poll(() => game(page, () => window.__pixelgame.game.save.pals.owned[0].level)).toBe(2);
  expect(await game(page, () => window.__pixelgame.game.pal.stats.maxHp)).toBeGreaterThan(hp);
  // The Den (level 1) stops it at level 2.
  await expect(page.locator('.pals-panel [data-action="upgrade"]')).toBeDisabled();
  await page.click('.pals-panel [data-mode="gather"]');
  expect(await game(page, () => window.__pixelgame.game.save.pals.mode)).toBe('gather');
  await page.keyboard.press('Escape');
  await expect(page.locator('.pals-panel')).toBeHidden();
  await expect(page.locator('#hud-pal')).toBeVisible();
  // Out among the trees your pal chops wood and hands it over.
  const wood = await game(page, () => {
    const g = window.__pixelgame.game;
    g.enemies.length = 0;
    g.spawnTimer = 1e9;
    const w = g.world;
    for (let r = 20; r < 200; r += 2) {
      for (let a = 0; a < 32; a++) {
        const x = Math.round(Math.cos((a / 32) * 6.283) * r);
        const y = Math.round(Math.sin((a / 32) * 6.283) * r);
        if (w.blockAt(x + 2, y) === 22 && w.isFree(x + 0.5, y + 0.5, 0.4, 'player')) {
          g.player.x = x + 0.5;
          g.player.y = y + 0.5;
          g.renderer.snapCamera();
          return g.save.resources.wood;
        }
      }
    }
    return null;
  });
  expect(wood).not.toBeNull();
  await expect.poll(() => game(page, () => window.__pixelgame.game.save.resources.wood), { timeout: 20000 }).toBeGreaterThan(wood);
  // In fight mode it bites the monsters around you.
  await game(page, async () => {
    const g = window.__pixelgame.game;
    const { spawnEnemy } = await import('/src/game/enemies.js');
    g.setPalMode('fight');
    const spot = g.world.findFreeSpot(g.player.x + 2, g.player.y, 0.4, 'enemy', null);
    const e = spawnEnemy(g, 'slime', spot.x, spot.y, { level: 1 });
    e.alert = true;
    window.__slime = e;
  });
  await expect.poll(() => game(page, () => window.__slime.hp < window.__slime.maxHp || window.__slime.dead), { timeout: 10000 }).toBe(true);
  expect(errors).toEqual([]);
});

test('forge: options run from basic to best with prices, and each pick is explained', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  await game(page, () => {
    const g = window.__pixelgame.game;
    Object.assign(g.save.resources, { scrap: 9000, essence: 9000 });
    g.save.base.buildings.forge = 4;
    for (const c of g.data.components) g.save.components[c.id] = { researched: true };
    g.emit('ui', { name: 'crafting', tab: 'weapons' });
  });
  const panel = page.locator('.forge-panel');
  await expect(panel.locator('.forge-guide')).toContainText('basic');
  await expect(panel.locator('.explain').first()).toContainText('damage');
  // Materials: the first is free and basic, the last costs the most.
  const mats = panel.locator('.step').nth(1).locator('.chips.ranked .chip');
  await expect(mats.first()).toContainText('Free');
  const before = await game(page, () => window.__pixelgame.game.data.crafting.essenceCost);
  await mats.last().click();
  await expect(panel.locator('.step').nth(1).locator('.explain')).toContainText('%');
  await page.click('.forge-panel .price-breakdown summary');
  await expect(panel.locator('.price-breakdown li')).toHaveCount(2);
  const total = await panel.locator('.forge-preview .cost-row').textContent();
  expect(Number(total.replace(/\D+/g, ' ').trim().split(' ').pop())).toBeGreaterThan(before);
  // Element cores explain what their element does.
  await panel.locator('.step').nth(2).locator('.chip', { hasText: 'Ice Core' }).click();
  await expect(panel.locator('.step').nth(2).locator('.explain')).toContainText('freeze');
  expect(errors).toEqual([]);
});

test('altars: beat a boss once and its altar falls silent; the compass points to the next', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  const first = await game(page, async () => {
    const g = window.__pixelgame.game;
    g.godMode = true;
    const a = g.world.greatAltars()[0];
    g.player.x = a.x;
    g.player.y = a.y + 1.2;
    g.renderer.snapCamera();
    return a;
  });
  await expect.poll(() => game(page, () => window.__pixelgame.game.interactTarget?.type)).toBe('altar');
  await page.keyboard.press('KeyE');
  await expect.poll(() => game(page, () => Boolean(window.__pixelgame.game.boss))).toBe(true);
  await game(page, () => {
    const g = window.__pixelgame.game;
    g.damageEnemy(g.boss, 1e9, {});
  });
  await expect.poll(() => game(page, (k) => window.__pixelgame.game.save.world.altars.includes(k), first.key)).toBe(true);
  await expect(page.locator('#toasts')).toContainText('falls silent', { timeout: 8000 });
  // If the boss's weapon got revealed meanwhile, keep it.
  const reveal = page.locator('.discovery button:has-text("Keep in bag")');
  if (await reveal.isVisible().catch(() => false)) await reveal.click();
  await expect(page.locator('.discovery')).toBeHidden();
  // Coming back to it: nothing wakes up.
  await game(page, () => {
    const g = window.__pixelgame.game;
    g.enemies.length = 0;
    g.pickups.length = 0;
  });
  await expect.poll(() => game(page, () => window.__pixelgame.game.interactTarget?.type)).toBe('altar');
  await expect(page.locator('#interact-hint')).toContainText('silent altar');
  await page.keyboard.press('KeyE');
  await expect(page.locator('#toasts')).toContainText('guardian is gone');
  expect(await game(page, () => Boolean(window.__pixelgame.game.boss))).toBe(false);
  const next = await game(page, () => window.__pixelgame.game.nearestAltar());
  expect(next.key).not.toBe(first.key);
  expect(errors).toEqual([]);
});

test('legendaries carry a signature power shown on the card and cast with Q', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  const info = await game(page, async () => {
    const g = window.__pixelgame.game;
    g.godMode = true;
    let dna = null;
    for (let seed = 1; seed < 40 && !dna?.ability; seed++) {
      dna = await g.weapons.generate({ seed, level: 12, luck: 0, source: 'drop', unlocked: [], minRarity: 'legendary' });
    }
    g.addWeapon(dna);
    g.equip(dna.id);
    g.enemies.length = 0;
    return { ability: g.weapon.ability, id: dna.id };
  });
  expect(info.ability.legendary).toBe(true);
  await game(page, () => window.__pixelgame.game.emit('ui', { name: 'inventory' }));
  await expect(page.locator('.weapon-card .legendary-power').first()).toHaveText(info.ability.name);
  await page.keyboard.press('Escape');
  await page.keyboard.press('KeyQ');
  await expect.poll(() => game(page, (id) => (window.__pixelgame.game.abilityReadyAt.get(id) ?? 0) > window.__pixelgame.game.time, info.id)).toBe(true);
  expect(errors).toEqual([]);
});

test('camp: turrets stand on floors, and vertical walls join into one wall', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  await game(page, () => {
    const g = window.__pixelgame.game;
    Object.assign(g.save.resources, { wood: 500, stone: 500, scrap: 500, essence: 500 });
    g.save.base.buildings.training = 1;
    g.player.x = 3.5;
    g.player.y = 9.5;
    g.renderer.snapCamera();
  });
  await page.waitForTimeout(300);
  await page.keyboard.press('KeyG');
  await expect(page.locator('#build-bar')).toBeVisible();
  const at = (tx, ty) => game(page, ([x, y]) => window.__pixelgame.game.renderer.worldToScreen(x + 0.5, y + 0.5), [tx, ty]);
  const pick = (id) => game(page, (s) => window.__pixelgame.game.selectStructure(s), id);
  // A stone floor, then a turret on it.
  await pick('stone_floor');
  const f = await at(2, 8);
  await page.mouse.click(f.x, f.y);
  await pick('arrow_turret');
  await page.mouse.click(f.x, f.y);
  const layers = await game(page, () => {
    const w = window.__pixelgame.game.world;
    return [w.floorAt(2, 8)?.id, w.structureAt(2, 8)?.id];
  });
  expect(layers).toEqual(['stone_floor', 'arrow_turret']);
  // A wall drawn top to bottom is one continuous wall: no gaps, no tips in between.
  const seams = await game(page, async () => {
    const { structureSprite, UP, DOWN } = await import('/src/render/structures.js');
    const opaqueRows = (c, rows) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      return rows.map((y) => [...Array(c.width).keys()].filter((x) => d[(y * c.width + x) * 4 + 3] > 0).length);
    };
    return {
      woodMiddle: opaqueRows(structureSprite('wood_wall', UP | DOWN), [0, 23]),
      woodAlone: opaqueRows(structureSprite('wood_wall', 0), [0, 23]),
      stoneMiddle: opaqueRows(structureSprite('stone_wall', UP | DOWN), [0, 23]),
    };
  });
  expect(seams.woodMiddle).toEqual([16, 16]);
  expect(seams.stoneMiddle).toEqual([16, 16]);
  expect(seams.woodAlone[0]).toBeLessThan(16);
  expect(errors).toEqual([]);
});
