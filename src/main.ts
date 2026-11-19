import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import maplibregl from 'maplibre-gl';
import {
  BASEMAP_STYLE, CITY, CLASS_WIDTH, MAX_SPAN_KM, MIN_FRIENDS, PAD_FRACTION, PAD_KM, type BBox,
} from './config.ts';
import { Panel, type Friend } from './ui/panel.ts';
import { ResultCard } from './ui/result.ts';
import { reverseLabel } from './geo/geocode.ts';
import { rankVenues, type Mode } from './scoring.ts';
import { decodeState, encodeState } from './share.ts';
import { pathTo } from './graph/dijkstra.ts';
import { metersBetween } from './graph/graph.ts';
import { WaveLayer, SEG_STRIDE, hexToRgb, toMercator, type Route } from './render/waveLayer.ts';
import {
  FriendMarkers, VenueLights, WinnerMarker, installLayers, setDim,
} from './render/overlays.ts';
import { FINALE_MS, Show, easeInOut, easeOut } from './render/show.ts';
import type { ComputeRequest, ComputeResult, WorkerMessage } from './worker/protocol.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const isDesktop = () => window.matchMedia('(min-width: 900px)').matches;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------- state

type Located = Friend & { lat: number; lon: number };
type Phase = 'edit' | 'loading' | 'show' | 'result';
let phase: Phase = 'edit';
let mode: Mode = 'max';

/** Everything derived from one worker run. Mode switches only touch `ranked`/`chosen`. */
interface Run {
  key: string;
  res: ComputeResult;
  people: { name: string; color: string; lat: number; lon: number }[];
  ranked: number[];
  chosen: number;
  routes: Route[];
  tEnd: number;
}
let run: Run | null = null;

// ---------------------------------------------------------------- map

const map = new maplibregl.Map({
  container: 'map',
  style: BASEMAP_STYLE,
  center: CITY.center,
  zoom: CITY.zoom,
  attributionControl: false,
  dragRotate: false,
  pitchWithRotate: false,
  fadeDuration: 0,
});
map.touchZoomRotate.disableRotation();
// On phones the bottom sheet covers ~60% of the screen: start with the city centre in the visible strip.
if (!isDesktop()) map.panBy([0, window.innerHeight * 0.3], { duration: 0 });
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'top-right');

const waves = new WaveLayer();
const venueLights = new VenueLights(map);
const winner = new WinnerMarker(map);
const markers = new FriendMarkers(map, (id, lat, lon) => {
  // Moving someone invalidates the shown result: go back to editing.
  if (phase === 'result') setPhase('edit');
  panel.setLocation(id, lat, lon, 'Pinned on map');
  labelPin(id, lat, lon);
  friendsChanged();
});
// Our layers only need the style parsed ('style.load'), not every basemap tile
// downloaded ('load'), which can take seconds on a slow connection.
let styleLoaded = false;
const mapReady = new Promise<void>((resolve) => map.once('style.load', () => {
  styleLoaded = true;
  installLayers(map, waves);
  resolve();
}));

// If the CARTO basemap can't load, fall back to a plain background: the waves
// draw the road network themselves, so the app still works.
const basemapTimer = window.setTimeout(() => {
  if (styleLoaded) return;
  console.warn('Basemap did not load; using a plain background.');
  map.setStyle({ version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0b0c12' } }] });
}, 12_000);
void mapReady.then(() => clearTimeout(basemapTimer));

// ---------------------------------------------------------------- panel + result

const panel = new Panel({
  onChange: friendsChanged,
  onPick: setPicking,
  onRun: () => void start(),
  onMode: setMode,
  onDemo: loadDemo,
});
const card = new ResultCard({
  onMode: setMode,
  onAlt: (i) => { if (run) { run.chosen = i; applyChoice(); } },
  onShare: share,
});

function friendsChanged(): void {
  markers.sync(panel.friends, phase === 'edit' || phase === 'result');
  panel.setError(null);
  panel.setBusy(phase === 'loading');
}

function setMode(m: Mode): void {
  mode = m;
  panel.setMode(mode, setMode);
  if (run) {
    // Re-rank from the cached travel-time matrix: no Dijkstra re-run needed.
    run.ranked = rankVenues(run.res.venues, mode);
    run.chosen = run.ranked[0];
    applyChoice();
  }
}

// Pin-drop mode: next map click places the selected friend.
function setPicking(id: number | null): void {
  panel.pickingId = id;
  document.body.classList.toggle('picking', id !== null);
  const f = panel.friends.find((x) => x.id === id);
  $('pin-hint').hidden = !f;
  if (f) ($('pin-hint').querySelector('b') as HTMLElement).textContent = f.name;
  if (!isDesktop()) $('panel').classList.toggle('collapsed', id !== null);
  panel.render();
}
$('pin-cancel').onclick = () => setPicking(null);
map.on('click', (e) => {
  if (panel.pickingId === null) return;
  const id = panel.pickingId;
  setPicking(null);
  panel.setLocation(id, e.lngLat.lat, e.lngLat.lng, 'Pinned on map');
  labelPin(id, e.lngLat.lat, e.lngLat.lng);
  friendsChanged();
});

async function labelPin(id: number, lat: number, lon: number): Promise<void> {
  const name = await reverseLabel(lat, lon);
  const f = panel.friends.find((x) => x.id === id);
  if (name && f && f.lat === lat && f.lon === lon) { f.label = `Near ${name}`; panel.render(); }
}

$('panel-grip').onclick = () => $('panel').classList.toggle('collapsed');

function loadDemo(): void {
  panel.clear();
  panel.add({ name: 'Aarav', lat: 23.0216, lon: 72.4712, label: 'South Bopal' });
  panel.add({ name: 'Diya', lat: 22.9990, lon: 72.6030, label: 'Maninagar' });
  panel.add({ name: 'Kabir', lat: 23.1085, lon: 72.5865, label: 'Chandkheda' });
  panel.render();
  friendsChanged();
  void start();
}

// ---------------------------------------------------------------- phases

function setPhase(p: Phase): void {
  phase = p;
  $('panel').classList.toggle('away', p === 'show' || p === 'result');
  $('loading').hidden = p !== 'loading';
  $('controls').hidden = !(p === 'show' || p === 'result');
  $('hud').hidden = p !== 'show';
  if (p !== 'result') card.hide();
  panel.setBusy(p === 'loading');
  markers.sync(panel.friends, p === 'edit' || p === 'result');
}

/** Jump to the end, even if the waves haven't started yet (camera still flying). */
function skipToResult(): void {
  clearTimeout(startTimer);
  if (!show.running && run && phase === 'show') show.start(run.tEnd);
  show.skip();
}

$('btn-edit').onclick = () => {
  skipToResult();
  card.hide();
  setPhase('edit');
  $('panel').classList.remove('collapsed');
};
$('btn-replay').onclick = () => run && play();
$('btn-skip').onclick = skipToResult;
const speedIn = $<HTMLInputElement>('speed');
speedIn.oninput = () => {
  show.speed = +speedIn.value;
  $('speed-out').textContent = `${show.speed}×`;
};

// ---------------------------------------------------------------- worker

const worker = new Worker(new URL('./worker/router.worker.ts', import.meta.url), { type: 'module' });
let reqSeq = 0;
let pending: { id: number; resolve: (m: WorkerMessage) => void } | null = null;
worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;
  if (!pending || msg.id !== pending.id) return; // stale response
  if (msg.type === 'progress') { $('loading-text').textContent = msg.stage; return; }
  pending.resolve(msg);
  pending = null;
};
worker.onerror = (e) => {
  pending?.resolve({ type: 'error', id: pending.id, code: 'internal', message: e.message || 'Worker crashed' });
  pending = null;
};

function compute(req: Omit<ComputeRequest, 'id' | 'type'>): Promise<WorkerMessage> {
  const id = ++reqSeq;
  return new Promise((resolve) => {
    pending = { id, resolve };
    worker.postMessage({ type: 'compute', id, ...req } satisfies ComputeRequest);
  });
}

// ---------------------------------------------------------------- run

const kmBetween = (a: number, b: number, c: number, d: number) => metersBetween(a, b, c, d) / 1000;

async function start(): Promise<void> {
  const people = panel.located() as Located[];
  if (people.length < MIN_FRIENDS) { panel.setError('Add at least two friends with a location.'); return; }
  setPicking(null);

  // Size check: the friends' bounding box must fit in MAX_SPAN_KM.
  const s = Math.min(...people.map((f) => f.lat)), n = Math.max(...people.map((f) => f.lat));
  const w = Math.min(...people.map((f) => f.lon)), e = Math.max(...people.map((f) => f.lon));
  const spanNS = kmBetween(s, w, n, w), spanEW = kmBetween(s, w, s, e);
  if (Math.max(spanNS, spanEW) > MAX_SPAN_KM) {
    panel.setError(`Your group is spread across ${Math.round(Math.max(spanNS, spanEW))} km. This version handles groups within ${MAX_SPAN_KM} km of each other (one city). Move a pin closer.`);
    return;
  }

  // Padded region: a fraction of the span, at least PAD_KM, so detours outside the box are possible.
  const padLat = Math.max(PAD_FRACTION * (n - s), PAD_KM / 111);
  const padLon = Math.max(PAD_FRACTION * (e - w), PAD_KM / (111 * Math.cos((s * Math.PI) / 180)));
  const region: BBox = [s - padLat, w - padLon, n + padLat, e + padLon];

  const key = people.map((f) => `${f.lat.toFixed(5)},${f.lon.toFixed(5)}`).join('|');
  updateHash(people);
  people.forEach((f) => (f.error = undefined));

  // Same locations as last time? Reuse the graph search, just re-rank and replay.
  if (run && run.key === key) {
    run.people = people.map(({ name, color, lat, lon }) => ({ name, color, lat, lon }));
    run.ranked = rankVenues(run.res.venues, mode);
    run.chosen = run.ranked[0];
    applyChoice(false);
    return play();
  }

  setPhase('loading');
  $('loading-text').textContent = 'Preparing…';
  // Show everyone while the roads load.
  map.fitBounds([[w, s], [e, n]], { padding: cameraPadding(true), duration: reducedMotion ? 0 : 700, maxZoom: 14 });
  // Route in the worker while the basemap is still loading.
  const [msg] = await Promise.all([
    compute({
      friends: people.map((f) => ({ lat: f.lat, lon: f.lon })),
      region,
      bakedUrl: new URL(`data/${CITY.id}.bin`, document.baseURI).href,
    }).then((m) => {
      if (!styleLoaded) $('loading-text').textContent = 'Loading the map…';
      return m;
    }),
    mapReady,
  ]);

  if (msg.type === 'error') {
    setPhase('edit');
    const who = msg.friendIndex !== undefined ? people[msg.friendIndex] : undefined;
    if (who) who.error = msg.message;
    panel.render();
    const prefix = who ? `${who.name}: ` : '';
    panel.setError(
      msg.code === 'off-road' ? `${prefix}that spot isn't near a drivable road. Drag their pin onto a street.` : prefix + msg.message,
      msg.code === 'overpass' || msg.code === 'internal' ? () => void start() : undefined,
    );
    return;
  }
  if (msg.type !== 'result') return;
  console.info('[route]', msg.source, `${msg.n} nodes, ${msg.seg.length / 2} segments, ${msg.venues.length} venues`, msg.timings);

  prepare(msg, key, people);
  play();
}

/** Converts a worker result into GPU buffers and the scored, ranked venue list. */
function prepare(res: ComputeResult, key: string, people: Located[]): void {
  const S = res.seg.length / 2;
  const { coords, seg } = res;

  // Segment endpoints in mercator, relative to an origin near the data (float32-safe).
  let mx = 0, my = 0;
  const merc = new Float64Array(res.n * 2);
  for (let i = 0; i < res.n; i++) {
    const [x, y] = toMercator(coords[2 * i], coords[2 * i + 1]);
    merc[2 * i] = x; merc[2 * i + 1] = y; mx += x; my += y;
  }
  const origin: [number, number] = [mx / res.n, my / res.n];
  const segs = new Float32Array(S * SEG_STRIDE);
  for (let k = 0; k < S; k++) {
    const u = seg[2 * k], v = seg[2 * k + 1], o = k * SEG_STRIDE;
    segs[o] = merc[2 * u] - origin[0]; segs[o + 1] = merc[2 * u + 1] - origin[1];
    segs[o + 2] = merc[2 * v] - origin[0]; segs[o + 3] = merc[2 * v + 1] - origin[1];
    segs[o + 4] = res.segWf[k]; segs[o + 5] = res.segWb[k];
    segs[o + 6] = CLASS_WIDTH[res.segCls[k]];
  }

  // Per friend: arrival times at both ends of every segment.
  const times = res.friends.map((f) => {
    const t = new Float32Array(S * 2);
    for (let k = 0; k < S; k++) {
      const du = f.dist[seg[2 * k]], dv = f.dist[seg[2 * k + 1]];
      t[2 * k] = Number.isFinite(du) ? du : 1e7;
      t[2 * k + 1] = Number.isFinite(dv) ? dv : 1e7;
    }
    return t;
  });

  waves.setData({ origin, segs, count: S, times, colors: people.map((p) => hexToRgb(p.color)) });
  venueLights.set(res.venues);

  const ranked = rankVenues(res.venues, mode);
  run = {
    key, res, ranked, chosen: ranked[0], routes: [], tEnd: 1,
    people: people.map(({ name, color, lat, lon }) => ({ name, color, lat, lon })),
  };
  applyChoice(false);
}

/** Recomputes routes + card for the currently chosen venue. */
function applyChoice(refresh = true): void {
  if (!run) return;
  const { res, people } = run;
  const v = res.venues[run.chosen];

  // Route = parent pointers from the venue's node back to each friend's start node.
  run.routes = res.friends.map((f, i) => {
    const path = pathTo(f.parent, v.node);
    const coords: [number, number][] = [[people[i].lon, people[i].lat]];
    const times = [0];
    for (const node of path) { coords.push([res.coords[2 * node], res.coords[2 * node + 1]]); times.push(f.dist[node]); }
    coords.push([v.lon, v.lat]);
    times.push(f.dist[v.node]);
    return { color: people[i].color, coords, times };
  });
  run.tEnd = Math.max(...v.times) * 1.06 + 15;
  waves.setRoutes(run.routes);
  updateHash(people);

  if (!refresh) return;
  if (phase === 'show') { show.retarget(run.tEnd); return; }
  if (phase === 'result') {
    venueLights.update(run.tEnd);
    waves.time = Math.max(waves.time, run.tEnd);
    waves.routeTime = ROUTES_COMPLETE;
    winner.show(v);
    showCard();
    map.triggerRepaint();
  }
}

function showCard(): void {
  if (!run) return;
  const alts = run.ranked.filter((i) => i !== run!.chosen).slice(0, 2).map((i) => ({ index: i, venue: run!.res.venues[i] }));
  card.show({ venue: run.res.venues[run.chosen], friends: run.people, mode, alts });
}

// ---------------------------------------------------------------- animation

/** Keeps the framed area clear of whichever UI is on screen: the friends panel while loading, the result card after. */
function cameraPadding(panelOpen = false) {
  const h = window.innerHeight;
  if (isDesktop()) return panelOpen ? { top: 80, bottom: 80, left: 440, right: 80 } : { top: 110, bottom: 90, left: 80, right: 420 };
  return panelOpen
    ? { top: 60, bottom: Math.min(0.72 * h, 640) + 20, left: 30, right: 30 }
    : { top: 110, bottom: Math.min(0.46 * h, 420) + 30, left: 30, right: 30 };
}

/** Large enough to draw every route in full. */
const ROUTES_COMPLETE = 1e9;
/** How far the camera slowly pushes in during the waves (zoom levels). */
const DRIFT_ZOOM = 0.22;

/** Everyone plus the winner: what the camera frames. */
function showBounds(r: Run): maplibregl.LngLatBounds {
  const v = r.res.venues[r.chosen];
  const b = new maplibregl.LngLatBounds([v.lon, v.lat], [v.lon, v.lat]);
  r.people.forEach((p) => b.extend([p.lon, p.lat]));
  return b;
}

// Slow push-in toward the winner while the waves run. Any user pan/zoom cancels it.
let drift: { z0: number; c0: maplibregl.MercatorCoordinate; at: maplibregl.MercatorCoordinate } | null = null;
let userMovedCamera = false;
map.on('movestart', (e) => { if ((e as { originalEvent?: Event }).originalEvent) { drift = null; userMovedCamera = true; } });

function play(): void {
  if (!run) return;
  const r = run;
  setPhase('show');
  venueLights.reset();
  winner.hide();
  setDim(map, 0);
  waves.intensity = 1;
  waves.fade = Math.max(40, r.tEnd * 0.07);
  waves.time = 0;
  waves.routeTime = 0;
  drift = null;
  userMovedCamera = false;

  const fly = reducedMotion ? 0 : 900;
  const bounds = showBounds(r);
  const padding = cameraPadding();
  map.fitBounds(bounds, { padding, duration: fly, maxZoom: 15 });
  // Drift starts from where the fly *ends*, not wherever the camera is when the timer fires.
  const target = map.cameraForBounds(bounds, { padding, maxZoom: 15 });

  // Let the camera settle before the waves start; a replay cancels a pending start.
  show.stop();
  clearTimeout(startTimer);
  startTimer = window.setTimeout(() => {
    if (run !== r) return;
    const v = r.res.venues[r.chosen];
    if (!reducedMotion && !userMovedCamera && target?.center && target.zoom !== undefined) {
      drift = {
        z0: target.zoom,
        c0: maplibregl.MercatorCoordinate.fromLngLat(target.center),
        at: maplibregl.MercatorCoordinate.fromLngLat([v.lon, v.lat]),
      };
    }
    show.start(r.tEnd);
  }, fly);
}
let startTimer = 0;

/** Zoom by `dz` around the winner, keeping it fixed on screen. */
function applyDrift(dz: number): void {
  if (!drift) return;
  const k = Math.pow(2, -dz);
  const c = new maplibregl.MercatorCoordinate(
    drift.at.x + (drift.c0.x - drift.at.x) * k,
    drift.at.y + (drift.c0.y - drift.at.y) * k,
  );
  map.jumpTo({ center: c.toLngLat(), zoom: drift.z0 + dz });
}

const counter = (orderTime: Float32Array, t: number) => {
  let lo = 0, hi = orderTime.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (orderTime[m] <= t) lo = m + 1; else hi = m; }
  return lo;
};

let winnerShown = false, cardShown = false, finaleCamera = false;
const show = new Show({
  wave(sim, progress) {
    if (!run) return;
    winnerShown = cardShown = finaleCamera = false;
    waves.time = sim;
    applyDrift(DRIFT_ZOOM * easeInOut(progress));
    venueLights.update(sim);
    $('hud-time').textContent = String(Math.floor(sim / 60));
    let settled = 0;
    for (const f of run.res.friends) settled += counter(f.orderTime, sim);
    $('hud-nodes').textContent = settled.toLocaleString('en-IN');
    map.triggerRepaint();
  },
  finale(ms) {
    if (!run) return;
    // 0–900ms: dim everything else.  200ms: winner pops.  250–2100ms: routes trace
    // from each home to the venue.  1100ms: result card.  Camera eases to the final frame.
    if (!finaleCamera) {
      finaleCamera = true;
      drift = null;
      if (!userMovedCamera) {
        map.fitBounds(showBounds(run), {
          padding: cameraPadding(), maxZoom: 15,
          duration: reducedMotion || ms >= FINALE_MS ? 0 : 1800, easing: easeInOut,
        });
      }
    }
    const d = easeOut(ms / 900);
    waves.intensity = 1 - 0.8 * d;
    setDim(map, 0.5 * d);
    if (ms >= 200 && !winnerShown) { winner.show(run.res.venues[run.chosen]); winnerShown = true; }
    const p = easeInOut((ms - 250) / 1850);
    const tMax = Math.max(...run.routes.map((r) => r.times[r.times.length - 1]));
    waves.routeTime = p >= 1 ? ROUTES_COMPLETE : p * tMax;
    if (ms >= 1100 && !cardShown) { setPhase('result'); showCard(); cardShown = true; }
    map.triggerRepaint();
  },
  done() {
    if (phase === 'show') { setPhase('result'); showCard(); }
    map.triggerRepaint();
  },
});

// ---------------------------------------------------------------- sharing

function updateHash(people: { name: string; lat: number; lon: number }[]): void {
  history.replaceState(null, '', encodeState({ mode, friends: people }));
}

async function share(): Promise<void> {
  if (!run) return;
  updateHash(run.people);
  const url = location.href;
  const v = run.res.venues[run.chosen];
  try {
    if (navigator.share && !isDesktop()) {
      await navigator.share({ title: 'Meet in the Middle', text: `Let's meet at ${v.name}`, url });
      return;
    }
    await navigator.clipboard.writeText(url);
    snack('Link copied. Anyone who opens it sees the same result.');
  } catch (err) {
    if ((err as Error).name !== 'AbortError') snack('Could not copy. Copy the address bar instead.');
  }
}

let snackTimer = 0;
function snack(text: string): void {
  const el = $('snack');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(snackTimer);
  snackTimer = window.setTimeout(() => (el.hidden = true), 2800);
}

// ---------------------------------------------------------------- boot

// Pasting a different share link into an open tab only fires `hashchange`
// (our own replaceState() calls don't), so re-boot from the new link.
window.addEventListener('hashchange', () => location.reload());

const shared = decodeState(location.hash);
if (shared) {
  mode = shared.mode;
  shared.friends.forEach((f) => panel.add({ name: f.name, lat: f.lat, lon: f.lon, label: 'From shared link' }));
  while (panel.friends.length < MIN_FRIENDS) panel.add();
} else {
  panel.add({ name: 'You' });
  panel.add();
}
panel.setMode(mode, setMode);
panel.render();
friendsChanged();
if (shared && panel.located().length >= MIN_FRIENDS) void start();

// Dev-only handle for inspecting frames (e.g. when rAF is throttled in a hidden tab).
// Vite strips this block from production builds.
if (import.meta.env.DEV) Object.assign(window, { __mitm: { map, waves, show, setDim } });
