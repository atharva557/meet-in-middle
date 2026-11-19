// Compact binary format for a pre-baked RoadData, so the app can load a whole city
// in one static request instead of hitting Overpass.
//
// Layout (little-endian, every section 4-byte aligned):
//   "MITM" | u32 version | u32 headerBytes | header JSON (padded)
//   i32[N] lat×1e6 | i32[N] lon×1e6 | u32[S] segU | u32[S] segV | u8[S] cls | u8[S] dir | u8[S] speed
import type { RoadData, Venue } from './osm.ts';

const MAGIC = 0x4d54494d; // "MITM"
const VERSION = 1;
const pad4 = (n: number) => (n + 3) & ~3;

interface Header { n: number; s: number; venues: [string, string, number, number][]; meta: Record<string, unknown> }

export function encodeRoadData(rd: RoadData, meta: Record<string, unknown> = {}): Uint8Array {
  const n = rd.lat.length;
  const s = rd.segU.length;
  const header: Header = {
    n, s, meta,
    venues: rd.venues.map((v) => [v.name, v.kind, +v.lat.toFixed(6), +v.lon.toFixed(6)]),
  };
  const hdr = new TextEncoder().encode(JSON.stringify(header));
  const total = 12 + pad4(hdr.length) + 8 * n + 8 * s + pad4(3 * s);
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, VERSION, true);
  dv.setUint32(8, hdr.length, true);
  new Uint8Array(buf, 12, hdr.length).set(hdr);
  let o = 12 + pad4(hdr.length);
  const latI = new Int32Array(buf, o, n); o += 4 * n;
  const lonI = new Int32Array(buf, o, n); o += 4 * n;
  for (let i = 0; i < n; i++) { latI[i] = Math.round(rd.lat[i] * 1e6); lonI[i] = Math.round(rd.lon[i] * 1e6); }
  new Uint32Array(buf, o, s).set(rd.segU); o += 4 * s;
  new Uint32Array(buf, o, s).set(rd.segV); o += 4 * s;
  new Uint8Array(buf, o, s).set(rd.segCls); o += s;
  new Uint8Array(buf, o, s).set(rd.segDir); o += s;
  new Uint8Array(buf, o, s).set(rd.segSpeed);
  return new Uint8Array(buf);
}

export function decodeRoadData(buf: ArrayBuffer): RoadData {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== VERSION) throw new Error('Bad road data file');
  const hlen = dv.getUint32(8, true);
  const header: Header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, hlen)));
  const { n, s } = header;
  let o = 12 + pad4(hlen);
  const latI = new Int32Array(buf, o, n); o += 4 * n;
  const lonI = new Int32Array(buf, o, n); o += 4 * n;
  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  for (let i = 0; i < n; i++) { lat[i] = latI[i] / 1e6; lon[i] = lonI[i] / 1e6; }
  const segU = new Uint32Array(buf, o, s); o += 4 * s;
  const segV = new Uint32Array(buf, o, s); o += 4 * s;
  const segCls = new Uint8Array(buf, o, s); o += s;
  const segDir = new Uint8Array(buf, o, s); o += s;
  const segSpeed = new Uint8Array(buf, o, s);
  const venues: Venue[] = header.venues.map(([name, kind, la, lo]) => ({ name, kind: kind as Venue['kind'], lat: la, lon: lo }));
  return { lat, lon, segU, segV, segCls, segDir, segSpeed, venues };
}
