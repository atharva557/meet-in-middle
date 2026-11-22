// App-wide constants. Imported by both the browser app and the Node build scripts,
// so keep this file free of DOM / Vite-only APIs.

export type BBox = [south: number, west: number, north: number, east: number];

export const CITY = {
  id: 'ahmedabad',
  name: 'Ahmedabad',
  /** Area covered by the pre-baked road graph (AMC + outskirts). */
  bbox: [22.9, 72.45, 23.14, 72.7] as BBox,
  center: [72.5714, 23.0225] as [number, number],
  zoom: 11.2,
};

/** Nominatim search is restricted to this box (lon/lat: left,top,right,bottom). */
export const GEOCODE_VIEWBOX = '72.38,23.24,72.78,22.84';

/** Drivable OSM highway classes. Service roads are excluded (parking aisles, driveways). */
export const HIGHWAY_REGEX =
  '^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street)$';

/**
 * Overpass QL for candidate venues inside a "s,w,n,e" bbox string.
 * OSM has only ~160 named cafés/restaurants/malls in Ahmedabad, so quick-bite places
 * (fast food, food courts, ice cream) and department stores are included too.
 */
export const VENUE_QUERY = (bb: string) => `(
  nwr["amenity"~"^(cafe|restaurant|fast_food|food_court|ice_cream)$"]["name"](${bb});
  nwr["shop"~"^(mall|department_store)$"]["name"](${bb});
);
out center tags qt;`;

export const roadQuery = (bb: string, timeout = 90, withVenues = true) => `[out:json][timeout:${timeout}];
way["highway"~"${HIGHWAY_REGEX}"](${bb})->.roads;
.roads out body qt;
.roads >;
out skel qt;
${withVenues ? VENUE_QUERY(bb) : ''}`;

export const venueQuery = (bb: string, timeout = 90) => `[out:json][timeout:${timeout}];
${VENUE_QUERY(bb)}`;

/** Road classes, index = class id stored per segment. Links map to their parent class. */
export const ROAD_CLASSES = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
] as const;

/**
 * Typical *average* driving speed (km/h) per class in Ahmedabad city traffic.
 * Used when a road has no usable `maxspeed` tag.
 */
export const DEFAULT_SPEED_KMH = [70, 45, 35, 30, 25, 20, 16, 10];
/** `*_link` ramps are slower than the road they belong to. */
export const LINK_SPEED_FACTOR = 0.75;
/** A posted `maxspeed` is a legal limit, not an average; scale it down for urban traffic. */
export const MAXSPEED_FACTOR = 0.75;

/** Relative line width per road class in the wave animation. */
export const CLASS_WIDTH = [2.1, 1.9, 1.7, 1.45, 1.2, 0.95, 0.85, 0.75];

export const FRIEND_COLORS = ['#22d3ee', '#f472b6', '#facc15', '#a3e635', '#a78bfa'];
export const MIN_FRIENDS = 2;
export const MAX_FRIENDS = 5;

/** Friends must fit inside a box this many km on each side. */
export const MAX_SPAN_KM = 25;
/** Padding added around the friends' bbox before loading roads. */
export const PAD_FRACTION = 0.25;
export const PAD_KM = 2.5;
/** How far a home / venue may be from the nearest drivable road. */
export const SNAP_FRIEND_M = 600;
export const SNAP_VENUE_M = 200;
/**
 * Speed (km/h, straight line) for the stretch between a home or venue and the road
 * node it snapped to: lanes, driveways and parking that the road graph leaves out.
 * Without it, someone 600 m from a road would get those 600 m for free.
 */
export const ACCESS_SPEED_KMH = 10;

export const BASEMAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
