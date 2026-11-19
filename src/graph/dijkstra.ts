import { MinHeap } from './heap.ts';
import type { Graph } from './graph.ts';

export interface DijkstraResult {
  /** Travel time in seconds from the source to each node (Infinity if unreachable). */
  dist: Float32Array;
  /** Previous node on the shortest path (-1 for the source / unreachable nodes). */
  parent: Int32Array;
  /** Nodes in the exact order Dijkstra settled them; this drives the animation. */
  order: Int32Array;
  /** Travel time of order[i]. Non-decreasing, so it can be binary-searched by time. */
  orderTime: Float32Array;
}

/**
 * Single-source Dijkstra over the CSR graph (edge weights = seconds).
 *
 * Invariant: when a node is popped with a key equal to its best-known distance,
 * no shorter path to it can exist (all weights are non-negative), so it is
 * "settled" and recorded in `order`. Entries whose key is larger than the
 * current best are stale duplicates from earlier relaxations and are skipped.
 */
export function dijkstra(g: Graph, source: number): DijkstraResult {
  const n = g.n;
  const dist = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const settled = new Uint8Array(n);
  const order = new Int32Array(n);
  const orderTime = new Float32Array(n);
  let count = 0;

  const heap = new MinHeap(Math.max(1024, n >> 2));
  dist[source] = 0;
  heap.push(0, source);

  const { off, to, w } = g;
  while (heap.size > 0) {
    const d = heap.peekKey();
    const u = heap.pop();
    if (settled[u] || d > dist[u]) continue; // stale entry
    settled[u] = 1;
    order[count] = u;
    orderTime[count] = d;
    count++;

    // Relax every outgoing edge u→v.
    for (let e = off[u], end = off[u + 1]; e < end; e++) {
      const v = to[e];
      const nd = d + w[e];
      if (nd < dist[v]) {
        dist[v] = nd;
        parent[v] = u;
        heap.push(nd, v);
      }
    }
  }

  return {
    dist: Float32Array.from(dist),
    parent,
    order: order.slice(0, count),
    orderTime: orderTime.slice(0, count),
  };
}

/** Walks parent pointers from `target` back to the source. Returns node ids source→target. */
export function pathTo(parent: Int32Array, target: number): number[] {
  const path: number[] = [];
  for (let v = target; v !== -1; v = parent[v]) path.push(v);
  return path.reverse();
}
