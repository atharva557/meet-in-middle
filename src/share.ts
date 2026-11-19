// Encodes friends + mode in the URL hash so a result can be shared and replayed:
//   #m=max&f=Asha@23.0225,72.5714&f=Ravi@23.0710,72.5180
// Coordinates are rounded to 4 decimals (~11 m), which is plenty for routing and
// avoids broadcasting exact doorsteps.
import { MAX_FRIENDS } from './config.ts';
import { MODE_ORDER, type Mode } from './scoring.ts';

export interface SharedFriend { name: string; lat: number; lon: number }
export interface SharedState { mode: Mode; friends: SharedFriend[] }

export function encodeState(s: SharedState): string {
  const parts = [`m=${s.mode}`];
  for (const f of s.friends) parts.push(`f=${encodeURIComponent(f.name)}@${f.lat.toFixed(4)},${f.lon.toFixed(4)}`);
  return '#' + parts.join('&');
}

export function decodeState(hash: string): SharedState | null {
  const h = hash.replace(/^#/, '');
  if (!h) return null;
  let mode: Mode = 'max';
  const friends: SharedFriend[] = [];
  for (const part of h.split('&')) {
    const [k, v = ''] = part.split('=');
    if (k === 'm' && (MODE_ORDER as string[]).includes(v)) mode = v as Mode;
    if (k === 'f') {
      const m = /^(.*)@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(v);
      if (!m) continue;
      const lat = +m[2], lon = +m[3];
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      let name: string;
      try { name = decodeURIComponent(m[1]); } catch { name = m[1]; }
      friends.push({ name: name.slice(0, 24) || `Friend ${friends.length + 1}`, lat, lon });
    }
  }
  return friends.length ? { mode, friends: friends.slice(0, MAX_FRIENDS) } : null;
}
