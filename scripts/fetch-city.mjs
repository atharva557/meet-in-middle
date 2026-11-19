// Downloads the raw OSM road network + candidate venues for the configured city
// from Overpass, as a grid of small tiles (big single queries time out on busy
// public servers). Each tile is cached on disk, so re-running resumes.
// Output: data/raw/<city>.json  (then run `npm run bake-city`)
//
//   npm run fetch-city
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { CITY, OVERPASS_ENDPOINTS, roadQuery, venueQuery } from '../src/config.ts';

const ENDPOINTS = [...OVERPASS_ENDPOINTS, 'https://overpass.kumi.systems/api/interpreter'];
const GRID = Number(process.env.GRID ?? 4); // GRID × GRID tiles
const TILE_DIR = `data/raw/tiles-${CITY.id}`;
// ONLY=1_2,2_2 fetches just those tiles (and merges whatever is on disk), handy for testing.
const ONLY = process.env.ONLY?.split(',');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => access(p).then(() => true, () => false);

async function attempt(url, query, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': 'meet-in-the-middle-build/0.1', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(query),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok || text[0] !== '{') throw new Error(`HTTP ${res.status}: ${text.slice(0, 80).replace(/\s+/g, ' ')}`);
  const json = JSON.parse(text);
  if (json.remark && /timed out|runtime error|out of memory/i.test(json.remark)) throw new Error(json.remark.slice(0, 80));
  return text;
}

/**
 * Fetch one query. The main server answers "at capacity" instantly when busy, so
 * it's retried often with backoff; mirrors (which tend to hang) get one try every third round.
 */
async function fetchWithRetry(query, label) {
  let delay = 15_000;
  for (let round = 0; round < 30; round++) {
    const urls = round % 3 === 2 ? ENDPOINTS.slice(1) : ENDPOINTS.slice(0, 1);
    for (const url of urls) {
      const t0 = Date.now();
      try {
        const text = await attempt(url, query, url === ENDPOINTS[0] ? 200_000 : 60_000);
        console.log(`  ${label} ok via ${new URL(url).host} in ${((Date.now() - t0) / 1000).toFixed(0)}s (${(text.length / 1e6).toFixed(1)} MB)`);
        return text;
      } catch (err) {
        console.log(`  ${label} ${new URL(url).host}: ${err.message}`);
      }
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, 90_000);
  }
  throw new Error(`gave up on ${label}`);
}

await mkdir(TILE_DIR, { recursive: true });
const [S, W, N, E] = CITY.bbox;
const dLat = (N - S) / GRID, dLon = (E - W) / GRID;

for (let r = 0; r < GRID; r++) {
  for (let c = 0; c < GRID; c++) {
    const file = `${TILE_DIR}/${r}_${c}.json`;
    if (await exists(file) || (ONLY && !ONLY.includes(`${r}_${c}`))) continue;
    const bb = [S + r * dLat, W + c * dLon, S + (r + 1) * dLat, W + (c + 1) * dLon].map((v) => v.toFixed(5)).join(',');
    await writeFile(file, await fetchWithRetry(roadQuery(bb, 180, false), `tile ${r},${c}`));
    await sleep(1500); // be polite between tiles
  }
}

// Venues are sparse, so one city-wide query is cheap.
const venueFile = `${TILE_DIR}/venues.json`;
if (!(await exists(venueFile))) {
  await writeFile(venueFile, await fetchWithRetry(venueQuery(`${S},${W},${N},${E}`, 120), 'venues'));
}

// Merge tiles, de-duplicating ways/nodes that straddle tile borders.
const seen = new Set();
const elements = [];
let stamp;
const parts = [venueFile];
for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) parts.push(`${TILE_DIR}/${r}_${c}.json`);
for (const part of parts) {
  if (!(await exists(part))) { console.log(`  (missing ${part}, skipped)`); continue; }
  const j = JSON.parse(await readFile(part, 'utf8'));
  stamp ??= j.osm3s?.timestamp_osm_base;
  for (const el of j.elements) {
    // A way can be both a road (with nodes) and appear again in a neighbouring tile.
    const k = `${el.type}/${el.id}/${el.tags ? 't' : ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    elements.push(el);
  }
}
await writeFile(`data/raw/${CITY.id}.json`, JSON.stringify({ osm3s: { timestamp_osm_base: stamp }, elements }));
console.log(`wrote data/raw/${CITY.id}.json with ${elements.length} elements`);
