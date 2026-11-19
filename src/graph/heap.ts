/**
 * Binary min-heap of (key, value) pairs stored in parallel typed arrays.
 * No decrease-key: Dijkstra pushes duplicates and skips stale entries on pop
 * ("lazy deletion"), which is simpler and usually faster than tracking positions.
 */
export class MinHeap {
  private keys: Float64Array;
  private vals: Int32Array;
  size = 0;

  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
  }

  push(key: number, val: number): void {
    if (this.size === this.keys.length) this.grow();
    // Sift up: move the hole toward the root until the parent is smaller.
    let i = this.size++;
    const keys = this.keys, vals = this.vals;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }

  /** Key of the minimum element (valid only if size > 0). */
  peekKey(): number { return this.keys[0]; }

  /** Removes the minimum element and returns its value. */
  pop(): number {
    const keys = this.keys, vals = this.vals;
    const top = vals[0];
    const n = --this.size;
    if (n > 0) {
      // Sift down the last element from the root.
      const key = keys[n], val = vals[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = key;
      vals[i] = val;
    }
    return top;
  }

  private grow(): void {
    const k = new Float64Array(this.keys.length * 2); k.set(this.keys); this.keys = k;
    const v = new Int32Array(this.vals.length * 2); v.set(this.vals); this.vals = v;
  }
}
