// The show when a weapon takes a step of its tree (single player and the
// multiplayer client alike): a ring and glints in its rarity's colour, a
// toast, a sound, and a flash for the great steps (Infusion, Awakening).

export function evolveFx(game, dna, node) {
  const rarity = game.data.byId.rarities.get(dna.rarity);
  const color = rarity?.color ?? '#ffd24a';
  const tier = node?.tier ?? 1;
  const big = tier >= 4;
  game.toast(node ? `${dna.name.text}: ${node.name}!` : `${dna.name.text} tempered to level ${dna.ctx?.lvl ?? 1}`, big ? 'legendary' : node ? 'epic' : 'info');
  game.audio.play(big ? 'discover' : 'levelup', { rarity: game.data.rarityIndex.get(dna.rarity) ?? 0 });
  const p = game.player;
  if (!node || !p) return;
  game.fx.add({ type: 'ring', x: p.x, y: p.y, r0: 0.3, r1: 2 + tier * 0.4, color, dur: 0.6, fill: big });
  game.fx.emit('glint', p.x, p.y - 0.5, 10 + tier * 6, 1.2, 3, [color, '#ffffff']);
  if (big) game.flash(color, 0.35);
}
