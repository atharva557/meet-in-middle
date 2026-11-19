import { metersBetween, type Graph } from './graph.ts';

/** Uniform grid over node coordinates for fast nearest-node snapping. */
export class NodeGrid {
  private cells = new Map<number, number[]>();
  private readonly cell: number; // degrees

  constructor(private g: Graph, cellDeg = 0.002 /* ≈ 200 m */) {
    this.cell = cellDeg;
    for (let i = 0; i < g.n; i++) {
      if (!g.main[i]) continue; // only snap onto the main connected component
      const k = this.key(Math.floor(g.lat[i] / cellDeg), Math.floor(g.lon[i] / cellDeg));
      let list = this.cells.get(k);
      if (!list) this.cells.set(k, (list = []));
      list.push(i);
    }
  }

  private key(r: number, c: number) { return r * 100_000 + c; }

  /** Nearest node within maxMeters, or null. */
  nearest(lat: number, lon: number, maxMeters: number): { node: number; meters: number } | null {
    const r0 = Math.floor(lat / this.cell), c0 = Math.floor(lon / this.cell);
    const rings = Math.ceil(maxMeters / (this.cell * 100_000)) + 1;
    let best = -1, bestD = maxMeters;
    for (let dr = -rings; dr <= rings; dr++) {
      for (let dc = -rings; dc <= rings; dc++) {
        const list = this.cells.get(this.key(r0 + dr, c0 + dc));
        if (!list) continue;
        for (const i of list) {
          const d = metersBetween(lat, lon, this.g.lat[i], this.g.lon[i]);
          if (d < bestD) { bestD = d; best = i; }
        }
      }
    }
    return best < 0 ? null : { node: best, meters: bestD };
  }
}
