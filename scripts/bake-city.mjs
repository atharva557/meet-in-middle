// Converts data/raw/<city>.json (from fetch-city) into public/data/<city>.bin,
// the compact road graph the app loads at runtime.
//
//   npm run bake-city
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { CITY } from '../src/config.ts';
import { osmToRoadData } from '../src/graph/osm.ts';
import { encodeRoadData } from '../src/graph/codec.ts';

const raw = JSON.parse(await readFile(`data/raw/${CITY.id}.json`, 'utf8'));
const rd = osmToRoadData(raw.elements);

// Drop duplicate venues (same name mapped as both a node and a building).
const seen = new Set();
rd.venues = rd.venues.filter((v) => {
  const k = `${v.name.toLowerCase()}|${v.lat.toFixed(3)}|${v.lon.toFixed(3)}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

const bin = encodeRoadData(rd, {
  city: CITY.id,
  bbox: CITY.bbox,
  generated: raw.osm3s?.timestamp_osm_base ?? new Date().toISOString(),
  attribution: '© OpenStreetMap contributors (ODbL)',
});
await mkdir('public/data', { recursive: true });
await writeFile(`public/data/${CITY.id}.bin`, bin);

const kinds = rd.venues.reduce((m, v) => ((m[v.kind] = (m[v.kind] || 0) + 1), m), {});
console.log({
  nodes: rd.lat.length,
  segments: rd.segU.length,
  venues: kinds,
  mb: +(bin.byteLength / 1e6).toFixed(2),
});
