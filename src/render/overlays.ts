// Everything drawn on the map besides the wave layer: friend pins, candidate
// venues (which light up once every wave has reached them), routes, winner pulse.
import maplibregl, { type ExpressionSpecification, type GeoJSONSource, type Map as MLMap } from 'maplibre-gl';
import type { WaveLayer } from './waveLayer.ts';
import type { VenueResult } from '../worker/protocol.ts';

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export function installLayers(map: MLMap, waves: WaveLayer): void {
  // Insert under the basemap's labels so street names stay readable over the glow.
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;

  map.addSource('dimmer', {
    type: 'geojson',
    data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] } },
  });
  map.addLayer({ id: 'dimmer', type: 'fill', source: 'dimmer', paint: { 'fill-color': '#020205', 'fill-opacity': 0 } }, firstSymbol);
  map.addLayer(waves, firstSymbol);

  map.addSource('venues', { type: 'geojson', data: EMPTY });
  const lit: ExpressionSpecification = ['boolean', ['feature-state', 'lit'], false];
  map.addLayer({
    id: 'venues', type: 'circle', source: 'venues',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, ['case', lit, 2.2, 1.0], 15, ['case', lit, 5, 2.5]],
      'circle-color': ['case', lit, '#fff1c2', '#8a90a6'],
      'circle-opacity': ['case', lit, 0.95, 0.28],
      'circle-blur': ['case', lit, 0.35, 0],
    },
  });

  map.addSource('routes', { type: 'geojson', data: EMPTY });
  const lineLayout = { 'line-cap': 'round', 'line-join': 'round' } as const;
  map.addLayer({ id: 'routes-glow', type: 'line', source: 'routes', layout: lineLayout,
    paint: { 'line-color': ['get', 'color'], 'line-width': 14, 'line-blur': 10, 'line-opacity': 0.55 } });
  map.addLayer({ id: 'routes-casing', type: 'line', source: 'routes', layout: lineLayout,
    paint: { 'line-color': '#05060a', 'line-width': 7, 'line-opacity': 0.75 } });
  map.addLayer({ id: 'routes-core', type: 'line', source: 'routes', layout: lineLayout,
    paint: { 'line-color': ['get', 'color'], 'line-width': 3.5 } });
}

export function setDim(map: MLMap, opacity: number): void {
  map.setPaintProperty('dimmer', 'fill-opacity', opacity);
}

// ---------- Venues ----------

/** Lights venues up in order of "time until every friend has arrived". */
export class VenueLights {
  private order: number[] = [];
  private tmax: number[] = [];
  private cursor = 0;

  constructor(private map: MLMap) {}

  set(venues: VenueResult[]): void {
    this.reset();
    this.tmax = venues.map((v) => Math.max(...v.times));
    this.order = venues.map((_, i) => i).sort((a, b) => this.tmax[a] - this.tmax[b]);
    (this.map.getSource('venues') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: venues.map((v, i) => ({ type: 'Feature', id: i, properties: {}, geometry: { type: 'Point', coordinates: [v.lon, v.lat] } })),
    });
  }

  /** Advance to simulation time t; only venues that newly qualify get a state update. */
  update(t: number): void {
    while (this.cursor < this.order.length && this.tmax[this.order[this.cursor]] <= t) {
      this.map.setFeatureState({ source: 'venues', id: this.order[this.cursor] }, { lit: true });
      this.cursor++;
    }
  }

  reset(): void {
    if (this.map.getSource('venues')) this.map.removeFeatureState({ source: 'venues' });
    this.cursor = 0;
  }
}

// ---------- Routes ----------

export interface Route { color: string; coords: [number, number][]; times: number[] }

/** Draws each route up to simulation time `t` (so routes "re-trace" the waves). */
export function drawRoutes(map: MLMap, routes: Route[], t: number): void {
  const features: GeoJSON.Feature[] = [];
  for (const r of routes) {
    const out: [number, number][] = [];
    for (let i = 0; i < r.coords.length; i++) {
      if (r.times[i] <= t) { out.push(r.coords[i]); continue; }
      if (i > 0) {
        // Interpolate the partial segment at the cut.
        const f = (t - r.times[i - 1]) / Math.max(1e-6, r.times[i] - r.times[i - 1]);
        const a = r.coords[i - 1], b = r.coords[i];
        out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      }
      break;
    }
    if (out.length >= 2) features.push({ type: 'Feature', properties: { color: r.color }, geometry: { type: 'LineString', coordinates: out } });
  }
  (map.getSource('routes') as GeoJSONSource).setData({ type: 'FeatureCollection', features });
}

export function clearRoutes(map: MLMap): void {
  (map.getSource('routes') as GeoJSONSource | undefined)?.setData(EMPTY);
}

// ---------- Markers ----------

export class FriendMarkers {
  private markers = new Map<number, maplibregl.Marker>();

  constructor(private map: MLMap, private onDrag: (id: number, lat: number, lon: number) => void) {}

  sync(friends: { id: number; name: string; color: string; lat?: number; lon?: number }[], draggable: boolean): void {
    const alive = new Set<number>();
    for (const f of friends) {
      if (f.lat === undefined || f.lon === undefined) continue;
      alive.add(f.id);
      let m = this.markers.get(f.id);
      if (!m) {
        const el = document.createElement('div');
        el.className = 'fmarker';
        el.innerHTML = '<span></span>';
        m = new maplibregl.Marker({ element: el, draggable: true });
        m.on('dragend', () => { const p = m!.getLngLat(); this.onDrag(f.id, p.lat, p.lng); });
        m.setLngLat([f.lon, f.lat]).addTo(this.map);
        this.markers.set(f.id, m);
      }
      const el = m.getElement();
      el.style.background = f.color;
      el.style.color = f.color;
      el.title = f.name;
      (el.firstElementChild as HTMLElement).textContent = (f.name.trim()[0] ?? '?').toUpperCase();
      m.setLngLat([f.lon, f.lat]);
      m.setDraggable(draggable);
    }
    for (const [id, m] of this.markers) if (!alive.has(id)) { m.remove(); this.markers.delete(id); }
  }
}

export class WinnerMarker {
  private marker?: maplibregl.Marker;

  constructor(private map: MLMap) {}

  show(v: VenueResult): void {
    this.hide();
    // MapLibre positions the root element with `transform`, so the pop-in
    // animation lives on an inner element to avoid clobbering it.
    const el = document.createElement('div');
    el.innerHTML = '<div class="wmarker pop"><span class="ring"></span><span class="ring"></span><span class="ring"></span><span class="core"></span><span class="label"></span></div>';
    (el.querySelector('.label') as HTMLElement).textContent = v.name;
    this.marker = new maplibregl.Marker({ element: el }).setLngLat([v.lon, v.lat]).addTo(this.map);
  }

  hide(): void { this.marker?.remove(); this.marker = undefined; }
}
