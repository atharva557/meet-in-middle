// Turns RoadData into a routable graph for one region:
//   crop to a bbox → renumber nodes → directed CSR adjacency with travel-time weights,
//   plus undirected "display segments" for the animation and a largest-component mask.
import type { BBox } from '../config.ts';
import type { RoadData } from './osm.ts';

export interface Graph {
  n: number;
  lat: Float64Array;
  lon: Float64Array;
  /** CSR: outgoing edges of node u are to[off[u] .. off[u+1]). */
  off: Uint32Array;
  to: Uint32Array;
  /** Edge weight = travel time in seconds. */
  w: Float32Array;
  /** Display segments (one per road piece, regardless of direction). */
  segU: Uint32Array;
  segV: Uint32Array;
  /** Travel time U→V / V→U in seconds, or -1 if that direction is forbidden (oneway). */
  segWf: Float32Array;
  segWb: Float32Array;
  segCls: Uint8Array;
  /** 1 if the node is in the largest connected component (safe to snap to). */
  main: Uint8Array;
}

const R = 6371008.8;
const RAD = Math.PI / 180;

/** Equirectangular distance in meters; accurate to well under 1% at city scale. */
export function metersBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const x = (lon2 - lon1) * RAD * Math.cos(((lat1 + lat2) / 2) * RAD);
  const y = (lat2 - lat1) * RAD;
  return Math.sqrt(x * x + y * y) * R;
}

export function buildGraph(rd: RoadData, box: BBox): Graph {
  const [s, w, n, e] = box;
  const inside = (i: number) => rd.lat[i] >= s && rd.lat[i] <= n && rd.lon[i] >= w && rd.lon[i] <= e;

  // 1. Crop: keep segments with both ends inside, renumber the nodes they use.
  const remap = new Int32Array(rd.lat.length).fill(-1);
  const keep: number[] = [];
  let nn = 0;
  for (let k = 0; k < rd.segU.length; k++) {
    const a = rd.segU[k], b = rd.segV[k];
    if (!inside(a) || !inside(b)) continue;
    keep.push(k);
    if (remap[a] < 0) remap[a] = nn++;
    if (remap[b] < 0) remap[b] = nn++;
  }
  const lat = new Float64Array(nn);
  const lon = new Float64Array(nn);
  for (let i = 0; i < remap.length; i++) {
    const j = remap[i];
    if (j >= 0) { lat[j] = rd.lat[i]; lon[j] = rd.lon[i]; }
  }

  // 2. Segments with per-direction travel times.
  const S = keep.length;
  const segU = new Uint32Array(S), segV = new Uint32Array(S);
  const segWf = new Float32Array(S), segWb = new Float32Array(S);
  const segCls = new Uint8Array(S);
  const degree = new Uint32Array(nn + 1);
  for (let i = 0; i < S; i++) {
    const k = keep[i];
    const u = remap[rd.segU[k]], v = remap[rd.segV[k]];
    const meters = metersBetween(lat[u], lon[u], lat[v], lon[v]);
    const secs = meters / (rd.segSpeed[k] / 3.6);
    const dir = rd.segDir[k];
    segU[i] = u; segV[i] = v; segCls[i] = rd.segCls[k];
    segWf[i] = dir === 2 ? -1 : secs;
    segWb[i] = dir === 1 ? -1 : secs;
    if (segWf[i] >= 0) degree[u]++;
    if (segWb[i] >= 0) degree[v]++;
  }

  // 3. CSR adjacency via counting sort on the source node.
  const off = new Uint32Array(nn + 1);
  for (let i = 0; i < nn; i++) off[i + 1] = off[i] + degree[i];
  const cursor = off.slice(0, nn);
  const E = off[nn];
  const to = new Uint32Array(E), wt = new Float32Array(E);
  for (let i = 0; i < S; i++) {
    if (segWf[i] >= 0) { const p = cursor[segU[i]]++; to[p] = segV[i]; wt[p] = segWf[i]; }
    if (segWb[i] >= 0) { const p = cursor[segV[i]]++; to[p] = segU[i]; wt[p] = segWb[i]; }
  }

  // 4. Largest weakly-connected component (union-find), so we never snap a
  //    friend or venue onto a road fragment that's cut off from everything else.
  const uf = new Int32Array(nn);
  for (let i = 0; i < nn; i++) uf[i] = i;
  const find = (x: number): number => {
    while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; }
    return x;
  };
  for (let i = 0; i < S; i++) {
    const a = find(segU[i]), b = find(segV[i]);
    if (a !== b) uf[a] = b;
  }
  const size = new Uint32Array(nn);
  let best = 0;
  for (let i = 0; i < nn; i++) {
    const r = find(i);
    if (++size[r] > size[best]) best = r;
  }
  const main = new Uint8Array(nn);
  for (let i = 0; i < nn; i++) main[i] = find(i) === best ? 1 : 0;

  return { n: nn, lat, lon, off, to, w: wt, segU, segV, segWf, segWb, segCls, main };
}
