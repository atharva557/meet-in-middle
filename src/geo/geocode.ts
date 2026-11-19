// Nominatim geocoding, restricted to the city. Nominatim's usage policy allows
// at most 1 request/second and forbids autocomplete, so we search on submit
// only and serialize requests through a small throttle.
import { GEOCODE_VIEWBOX } from '../config.ts';

export interface Place { label: string; detail: string; lat: number; lon: number }

const BASE = 'https://nominatim.openstreetmap.org';
let last = 0;
let chain: Promise<unknown> = Promise.resolve();

function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = last + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return fn();
  });
  chain = run.catch(() => undefined);
  return run;
}

function split(display: string): { label: string; detail: string } {
  const parts = display.split(',').map((s) => s.trim());
  return { label: parts[0], detail: parts.slice(1, 3).join(', ') };
}

export class GeocodeError extends Error {}

export function searchPlaces(query: string): Promise<Place[]> {
  const params = new URLSearchParams({
    format: 'jsonv2', q: query, viewbox: GEOCODE_VIEWBOX, bounded: '1',
    countrycodes: 'in', limit: '5', 'accept-language': 'en',
  });
  return throttled(async () => {
    let res: Response;
    try {
      res = await fetch(`${BASE}/search?${params}`, { signal: AbortSignal.timeout(12_000) });
    } catch {
      throw new GeocodeError('Address search is unreachable. Check your connection or drop a pin instead.');
    }
    if (res.status === 429) throw new GeocodeError('Address search is busy. Wait a few seconds or drop a pin.');
    if (!res.ok) throw new GeocodeError(`Address search failed (HTTP ${res.status}). Try dropping a pin.`);
    const rows: { display_name: string; lat: string; lon: string }[] = await res.json();
    return rows.map((r) => ({ ...split(r.display_name), lat: +r.lat, lon: +r.lon }));
  });
}

/** Best-effort neighbourhood name for a dropped pin; never throws. */
export function reverseLabel(lat: number, lon: number): Promise<string | null> {
  const params = new URLSearchParams({ format: 'jsonv2', lat: String(lat), lon: String(lon), zoom: '16', 'accept-language': 'en' });
  return throttled(async () => {
    try {
      const res = await fetch(`${BASE}/reverse?${params}`, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) return null;
      const j = await res.json();
      const a = j.address ?? {};
      return a.neighbourhood || a.suburb || a.quarter || a.road || split(j.display_name ?? '').label || null;
    } catch {
      return null;
    }
  });
}
