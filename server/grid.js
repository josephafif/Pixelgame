// A spatial hash: things bucketed by position, rebuilt once per tick, so
// "who is near (x, y)?" looks at a few cells instead of every player or
// monster in the world. Things move a little after a rebuild; queries pad
// their radius by PAD so nothing in reach is missed, and callers check the
// exact distance.

export const PAD = 1.5;

export class SpatialGrid {
  constructor(cell = 8) {
    this.cell = cell;
    this.cells = new Map();
    this.spare = [];
  }

  static key(cx, cy) {
    return (cx + 0x8000) * 0x10000 + (cy + 0x8000);
  }

  clear() {
    for (const list of this.cells.values()) {
      list.length = 0;
      this.spare.push(list);
    }
    this.cells.clear();
  }

  insert(o) {
    const k = SpatialGrid.key(Math.floor(o.x / this.cell), Math.floor(o.y / this.cell));
    let list = this.cells.get(k);
    if (!list) {
      list = this.spare.pop() ?? [];
      this.cells.set(k, list);
    }
    list.push(o);
  }

  rebuild(items, keep = () => true) {
    this.clear();
    for (const o of items) if (keep(o)) this.insert(o);
  }

  /** How many cells a query of radius r looks at. */
  cellsFor(r) {
    const n = Math.floor((2 * (r + PAD)) / this.cell) + 2;
    return n * n;
  }

  /** Calls fn(o) for everything in the cells that cover the circle (x, y, r). */
  each(x, y, r, fn) {
    const c = this.cell;
    const x0 = Math.floor((x - r) / c);
    const x1 = Math.floor((x + r) / c);
    const y0 = Math.floor((y - r) / c);
    const y1 = Math.floor((y + r) / c);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const list = this.cells.get(SpatialGrid.key(cx, cy));
        if (!list) continue;
        for (let i = 0; i < list.length; i++) fn(list[i]);
      }
    }
  }

  /** Everything within r of (x, y) (exact distance, padded for movement since the rebuild). */
  *near(x, y, r) {
    const c = this.cell;
    const rr = (r + PAD) * (r + PAD);
    const x0 = Math.floor((x - r - PAD) / c);
    const x1 = Math.floor((x + r + PAD) / c);
    const y0 = Math.floor((y - r - PAD) / c);
    const y1 = Math.floor((y + r + PAD) / c);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const list = this.cells.get(SpatialGrid.key(cx, cy));
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const o = list[i];
          const dx = o.x - x;
          const dy = o.y - y;
          if (dx * dx + dy * dy <= rr) yield o;
        }
      }
    }
  }
}
