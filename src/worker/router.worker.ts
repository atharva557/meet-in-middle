// Routing worker: loads roads, builds the graph, runs one Dijkstra per friend,
// and scores-ready venue travel times. Keeps the UI thread free for the map.
import {
  ACCESS_SPEED_KMH, CITY, OVERPASS_ENDPOINTS, SNAP_FRIEND_M, SNAP_VENUE_M, roadQuery, type BBox,
} from '../config.ts';
import { decodeRoadData } from '../graph/codec.ts';
import { osmToRoadData, type RoadData } from '../graph/osm.ts';
import { buildGraph } from '../graph/graph.ts';
import { dijkstra } from '../graph/dijkstra.ts';
import { NodeGrid } from '../graph/spatial.ts';
import type { ComputeError, ComputeRequest, ComputeResult, ErrorCode, WorkerMessage } from './protocol.ts';

const ctx = self as unknown as {
  postMessage(msg: WorkerMessage, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ComputeRequest>) => void) | null;
};

class RouteError extends Error {
  constructor(public code: ErrorCode, message: string, public friendIndex?: number) { super(message); }
}

// ---------- data sources ----------

let baked: Promise<RoadData> | null = null;
function loadBaked(url: string): Promise<RoadData> {
  baked ??= fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    })
    .then(decodeRoadData)
    .catch((err) => { baked = null; throw err; });
  return baked;
}

const contains = (outer: BBox, inner: BBox) =>
  inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];

const overpassCache = new Map<string, RoadData>();
async function loadOverpass(box: BBox, onStage: (s: string) => void): Promise<RoadData> {
  const bb = box.map((v) => v.toFixed(4)).join(',');
  const hit = overpassCache.get(bb);
  if (hit) return hit;
  const body = 'data=' + encodeURIComponent(roadQuery(bb, 40));
  const failures: string[] = [];
  for (const [i, url] of OVERPASS_ENDPOINTS.entries()) {
    onStage(i === 0 ? 'Downloading roads from OpenStreetMap…' : `Server busy, trying mirror ${i}…`);
    try {
      const res = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(45_000) });
      if (res.status === 429) { failures.push('rate limited'); continue; }
      if (!res.ok) { failures.push(`HTTP ${res.status}`); continue; }
      const json = await res.json();
      if (json.remark && /timed out|runtime error/i.test(json.remark)) { failures.push('query timed out'); continue; }
      onStage('Parsing road network…');
      const rd = osmToRoadData(json.elements);
      overpassCache.set(bb, rd);
      return rd;
    } catch (err) {
      failures.push((err as Error).name === 'TimeoutError' ? 'timed out' : 'network error');
    }
  }
  throw new RouteError(
    'overpass',
    `Couldn't download the road network (${failures.join(', ')}). The OpenStreetMap servers are busy; try again in a minute.`,
  );
}

// ---------- main computation ----------

/** Time to cover the off-graph gap between a point and its snapped road node. */
const accessSecs = (meters: number) => meters / (ACCESS_SPEED_KMH / 3.6);

async function compute(req: ComputeRequest): Promise<ComputeResult> {
  const t: Record<string, number> = {};
  let t0 = performance.now();
  const stage = (s: string) => ctx.postMessage({ type: 'progress', id: req.id, stage: s });

  // Use the pre-baked city file when the whole region is inside it; Overpass otherwise.
  let rd: RoadData;
  let source: ComputeResult['source'] = 'baked';
  let region = req.region;
  const friendsBox: BBox = [
    Math.min(...req.friends.map((f) => f.lat)), Math.min(...req.friends.map((f) => f.lon)),
    Math.max(...req.friends.map((f) => f.lat)), Math.max(...req.friends.map((f) => f.lon)),
  ];
  const cityInner: BBox = [CITY.bbox[0] + 0.005, CITY.bbox[1] + 0.005, CITY.bbox[2] - 0.005, CITY.bbox[3] - 0.005];
  let usedBaked = false;
  if (contains(cityInner, friendsBox)) {
    try {
      stage(`Loading ${CITY.name} road network…`);
      rd = await loadBaked(req.bakedUrl);
      // Clip the padded region to what the file actually covers.
      region = [Math.max(region[0], CITY.bbox[0]), Math.max(region[1], CITY.bbox[1]),
        Math.min(region[2], CITY.bbox[2]), Math.min(region[3], CITY.bbox[3])];
      usedBaked = true;
    } catch {
      /* fall through to Overpass */
    }
  }
  if (!usedBaked) {
    source = 'overpass';
    rd = await loadOverpass(region, stage);
  }
  t.load = performance.now() - t0;

  t0 = performance.now();
  stage('Building the road graph…');
  const g = buildGraph(rd!, region);
  const grid = new NodeGrid(g);
  t.build = performance.now() - t0;

  // Snap every friend to the nearest road node.
  const snaps = req.friends.map((f, i) => {
    const s = grid.nearest(f.lat, f.lon, SNAP_FRIEND_M);
    if (!s) throw new RouteError('off-road', `No drivable road within ${SNAP_FRIEND_M} m of this location.`, i);
    return s;
  });

  // One Dijkstra per friend over the same graph.
  t0 = performance.now();
  const friends = snaps.map((s, i) => {
    stage(`Exploring roads from friend ${i + 1} of ${snaps.length}…`);
    return { snapNode: s.node, snapMeters: s.meters, accessSecs: accessSecs(s.meters), ...dijkstra(g, s.node) };
  });
  t.dijkstra = performance.now() - t0;

  // Check every pair of friends can actually reach one another's area.
  for (let i = 1; i < friends.length; i++) {
    if (!Number.isFinite(friends[i].dist[friends[0].snapNode]) && !Number.isFinite(friends[0].dist[friends[i].snapNode])) {
      throw new RouteError('unreachable', 'This location is not connected to the others by road.', i);
    }
  }

  // Candidate venues: snap to the graph and keep those every friend can drive to.
  const venues: ComputeResult['venues'] = [];
  const [s, w, n, e] = region;
  for (const v of rd!.venues) {
    if (v.lat < s || v.lat > n || v.lon < w || v.lon > e) continue;
    const snap = grid.nearest(v.lat, v.lon, SNAP_VENUE_M);
    if (!snap) continue;
    const venueAccess = accessSecs(snap.meters);
    const times = friends.map((f) => f.accessSecs + f.dist[snap.node] + venueAccess);
    if (times.every(Number.isFinite)) venues.push({ ...v, node: snap.node, times });
  }
  if (venues.length === 0) throw new RouteError('no-venues', 'No cafes, restaurants or malls are reachable by everyone here.');

  // Flatten geometry for transfer.
  const coords = new Float64Array(g.n * 2);
  for (let i = 0; i < g.n; i++) { coords[2 * i] = g.lon[i]; coords[2 * i + 1] = g.lat[i]; }
  const seg = new Uint32Array(g.segU.length * 2);
  for (let i = 0; i < g.segU.length; i++) { seg[2 * i] = g.segU[i]; seg[2 * i + 1] = g.segV[i]; }

  return {
    type: 'result', id: req.id, source, n: g.n, coords, seg,
    segWf: g.segWf, segWb: g.segWb, segCls: g.segCls,
    friends, venues, timings: t,
  };
}

ctx.onmessage = async (e) => {
  const req = e.data;
  try {
    const res = await compute(req);
    const transfer: Transferable[] = [res.coords.buffer, res.seg.buffer, res.segWf.buffer, res.segWb.buffer, res.segCls.buffer];
    for (const f of res.friends) transfer.push(f.dist.buffer, f.parent.buffer, f.order.buffer, f.orderTime.buffer);
    ctx.postMessage(res, transfer);
  } catch (err) {
    const msg: ComputeError = err instanceof RouteError
      ? { type: 'error', id: req.id, code: err.code, message: err.message, friendIndex: err.friendIndex }
      : { type: 'error', id: req.id, code: 'internal', message: String((err as Error)?.message ?? err) };
    ctx.postMessage(msg);
  }
};
