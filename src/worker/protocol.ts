// Messages exchanged between the main thread and the routing worker.
import type { BBox } from '../config.ts';
import type { VenueKind } from '../graph/osm.ts';

export interface ComputeRequest {
  type: 'compute';
  id: number;
  friends: { lat: number; lon: number }[];
  /** Region to load roads for (already padded and size-checked by the main thread). */
  region: BBox;
  bakedUrl: string;
}

export interface FriendRoute {
  snapNode: number;
  snapMeters: number;
  /** Seconds from home to `snapNode`; already included in every venue time. */
  accessSecs: number;
  /** Road-only travel time from `snapNode` (excludes `accessSecs`). */
  dist: Float32Array;
  parent: Int32Array;
  /** Settle order + times, straight from Dijkstra. */
  order: Int32Array;
  orderTime: Float32Array;
}

export interface VenueResult {
  name: string;
  kind: VenueKind;
  lat: number;
  lon: number;
  node: number;
  /** Door-to-door seconds for each friend (home access + roads + venue access). */
  times: number[];
}

export interface ComputeResult {
  type: 'result';
  id: number;
  source: 'baked' | 'overpass';
  n: number;
  /** Node coordinates, interleaved [lon0, lat0, lon1, lat1, ...]. */
  coords: Float64Array;
  /** Display segments: node ids interleaved [u0, v0, u1, v1, ...]. */
  seg: Uint32Array;
  segWf: Float32Array;
  segWb: Float32Array;
  segCls: Uint8Array;
  friends: FriendRoute[];
  venues: VenueResult[];
  timings: Record<string, number>;
}

export type ErrorCode = 'overpass' | 'off-road' | 'no-venues' | 'unreachable' | 'internal';

export interface ComputeError {
  type: 'error';
  id: number;
  code: ErrorCode;
  message: string;
  friendIndex?: number;
}

export interface Progress { type: 'progress'; id: number; stage: string }

export type WorkerMessage = ComputeResult | ComputeError | Progress;
