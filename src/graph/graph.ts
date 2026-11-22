// Turns RoadData into a routable graph for one region:
//   crop to a bbox → renumber nodes → directed CSR adjacency with travel-time weights,
//   plus undirected "display segments" for the animation and a largest-SCC mask.
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
  /** 1 if the node is in the largest strongly-connected component (safe to snap to). */
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

  // 4. Largest strongly-connected component. Snapping only onto it guarantees every
  //    friend can drive to every venue and back; a merely *touching* (weakly connected)
  //    road can still be a one-way trap you can enter but never leave.
  const main = largestScc(nn, off, to);

  return { n: nn, lat, lon, off, to, w: wt, segU, segV, segWf, segWb, segCls, main };
}

/**
 * Kosaraju's algorithm, iterative (a city graph is far too deep for recursion):
 *   1. DFS the forward graph, recording nodes in post-order (finish time).
 *   2. Walk the reversed graph from nodes in decreasing finish time; each walk
 *      collects exactly one strongly-connected component.
 * Returns a 0/1 mask of the largest component.
 */
export function largestScc(n: number, off: Uint32Array, to: Uint32Array): Uint8Array {
  // Reverse CSR: for each node, the nodes with an edge into it.
  const roff = new Uint32Array(n + 1);
  for (let e = 0; e < to.length; e++) roff[to[e] + 1]++;
  for (let i = 0; i < n; i++) roff[i + 1] += roff[i];
  const rto = new Uint32Array(to.length);
  const cur = roff.slice(0, n);
  for (let u = 0; u < n; u++) for (let e = off[u]; e < off[u + 1]; e++) rto[cur[to[e]]++] = u;

  // Pass 1: post-order of an iterative DFS (edge[u] = next outgoing edge to try).
  const stack = new Uint32Array(n);
  const edge = new Uint32Array(n);
  const seen = new Uint8Array(n);
  const post = new Uint32Array(n);
  let pc = 0;
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    let sp = 0;
    stack[sp++] = s; seen[s] = 1; edge[s] = off[s];
    while (sp > 0) {
      const u = stack[sp - 1];
      if (edge[u] < off[u + 1]) {
        const v = to[edge[u]++];
        if (!seen[v]) { seen[v] = 1; edge[v] = off[v]; stack[sp++] = v; }
      } else {
        sp--;
        post[pc++] = u;
      }
    }
  }

  // Pass 2: components on the reversed graph, latest-finished first.
  const comp = new Int32Array(n).fill(-1);
  let best = -1, bestSize = 0, c = 0;
  for (let k = n - 1; k >= 0; k--) {
    const s = post[k];
    if (comp[s] >= 0) continue;
    let sp = 0, size = 0;
    stack[sp++] = s; comp[s] = c;
    while (sp > 0) {
      const u = stack[--sp];
      size++;
      for (let e = roff[u]; e < roff[u + 1]; e++) {
        const v = rto[e];
        if (comp[v] < 0) { comp[v] = c; stack[sp++] = v; }
      }
    }
    if (size > bestSize) { bestSize = size; best = c; }
    c++;
  }

  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = comp[i] === best ? 1 : 0;
  return mask;
}
