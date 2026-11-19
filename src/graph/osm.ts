// Converts raw Overpass JSON into a compact, renumbered road dataset.
// Shared by the browser (live Overpass fallback) and scripts/bake-city.mjs.
import {
  DEFAULT_SPEED_KMH, LINK_SPEED_FACTOR, MAXSPEED_FACTOR, ROAD_CLASSES,
} from '../config.ts';

export type VenueKind = 'cafe' | 'restaurant' | 'food' | 'mall';
export interface Venue { name: string; kind: VenueKind; lat: number; lon: number }

/** Road network as flat typed arrays. Segments are undirected pieces between two consecutive OSM nodes. */
export interface RoadData {
  lat: Float64Array;
  lon: Float64Array;
  segU: Uint32Array;
  segV: Uint32Array;
  /** Index into ROAD_CLASSES. */
  segCls: Uint8Array;
  /** 0 = two-way, 1 = only U→V, 2 = only V→U. */
  segDir: Uint8Array;
  /** Resolved average speed, km/h. */
  segSpeed: Uint8Array;
  venues: Venue[];
}

interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  tags?: Record<string, string>;
  center?: { lat: number; lon: number };
}

/** Parses `maxspeed` values like "50", "50 km/h", "30 mph". Returns km/h or null. */
function parseMaxspeed(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?\s*$/i.exec(raw.split(';')[0]);
  if (!m) return null;
  let v = parseFloat(m[1]);
  if (m[2] && m[2].toLowerCase() === 'mph') v *= 1.609;
  return v >= 5 && v <= 140 ? v : null;
}

function classify(highway: string): { cls: number; link: boolean } | null {
  const link = highway.endsWith('_link');
  const base = link ? highway.slice(0, -5) : highway;
  const cls = (ROAD_CLASSES as readonly string[]).indexOf(base);
  return cls < 0 ? null : { cls, link };
}

/** 0 = both ways, 1 = forward only, 2 = backward only. */
function direction(tags: Record<string, string>): number {
  const ow = tags.oneway;
  if (ow === 'yes' || ow === '1' || ow === 'true') return 1;
  if (ow === '-1' || ow === 'reverse') return 2;
  if (ow === 'no') return 0;
  // Implied oneway per OSM conventions.
  if (tags.highway === 'motorway' || tags.junction === 'roundabout' || tags.junction === 'circular') return 1;
  return 0;
}

export function osmToRoadData(elements: OsmElement[]): RoadData {
  // Pass 1: coordinates of plain (untagged) nodes; these are the road geometry nodes.
  const coords = new Map<number, [number, number]>();
  const venues: Venue[] = [];
  for (const el of elements) {
    if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined && !el.tags) {
      coords.set(el.id, [el.lat, el.lon]);
    }
  }

  // Pass 2: road ways → segments; tagged nodes/ways with a center → venues.
  const index = new Map<number, number>();
  const lat: number[] = [];
  const lon: number[] = [];
  const segU: number[] = [];
  const segV: number[] = [];
  const segCls: number[] = [];
  const segDir: number[] = [];
  const segSpeed: number[] = [];
  const idOf = (osmId: number): number => {
    let i = index.get(osmId);
    if (i === undefined) {
      const c = coords.get(osmId)!;
      i = lat.length;
      index.set(osmId, i);
      lat.push(c[0]);
      lon.push(c[1]);
    }
    return i;
  };

  for (const el of elements) {
    const tags = el.tags;
    if (!tags) continue;
    if (el.type === 'way' && tags.highway && el.nodes) {
      const c = classify(tags.highway);
      if (!c) continue;
      if (tags.access === 'no' || tags.access === 'private' || tags.motor_vehicle === 'no') continue;
      const posted = parseMaxspeed(tags.maxspeed);
      let speed = posted !== null ? posted * MAXSPEED_FACTOR : DEFAULT_SPEED_KMH[c.cls];
      if (c.link) speed *= LINK_SPEED_FACTOR;
      speed = Math.max(5, Math.min(120, Math.round(speed)));
      const dir = direction(tags);
      for (let k = 1; k < el.nodes.length; k++) {
        const a = el.nodes[k - 1];
        const b = el.nodes[k];
        if (a === b || !coords.has(a) || !coords.has(b)) continue;
        segU.push(idOf(a));
        segV.push(idOf(b));
        segCls.push(c.cls);
        segDir.push(dir);
        segSpeed.push(speed);
      }
    } else if (tags.name) {
      const p = el.type === 'node' ? (el.lat !== undefined ? { lat: el.lat, lon: el.lon! } : null) : el.center;
      if (!p) continue;
      const kind: VenueKind | null =
        tags.shop === 'mall' || tags.shop === 'department_store' ? 'mall'
          : tags.amenity === 'cafe' ? 'cafe'
          : tags.amenity === 'restaurant' ? 'restaurant'
          : tags.amenity === 'fast_food' || tags.amenity === 'food_court' || tags.amenity === 'ice_cream' ? 'food'
          : null;
      if (kind) venues.push({ name: tags['name:en'] || tags.name, kind, lat: p.lat, lon: p.lon });
    }
  }

  return {
    lat: Float64Array.from(lat),
    lon: Float64Array.from(lon),
    segU: Uint32Array.from(segU),
    segV: Uint32Array.from(segV),
    segCls: Uint8Array.from(segCls),
    segDir: Uint8Array.from(segDir),
    segSpeed: Uint8Array.from(segSpeed),
    venues,
  };
}
