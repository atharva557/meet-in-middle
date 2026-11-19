// The animation timeline: a simulation clock (seconds of driving) for the waves,
// then a finale (dim → winner → routes → result card), driven by requestAnimationFrame.

export interface ShowHooks {
  /** Called every frame during the wave phase with the simulation time in seconds. */
  wave(sim: number): void;
  /** Called every frame of the finale with elapsed ms since it started (clamped to FINALE_MS). */
  finale(ms: number): void;
  done(): void;
}

/** Real-time length of the wave phase at 1× speed. */
const WAVE_MS = 9000;
export const FINALE_MS = 2400;

export class Show {
  speed = 1;
  private sim = 0;
  private tEnd = 1;
  private finaleMs = -1;
  private last = 0;
  private raf = 0;
  running = false;

  constructor(private hooks: ShowHooks) {}

  /** Start (or restart) a show whose waves stop at simulation time `tEnd`. */
  start(tEnd: number): void {
    this.stop();
    this.tEnd = tEnd;
    this.sim = 0;
    this.finaleMs = -1;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  /** Change where the waves stop (e.g. a different winner) without restarting. */
  retarget(tEnd: number): void { this.tEnd = Math.max(tEnd, this.sim); }

  skip(): void {
    if (!this.running) return;
    this.sim = this.tEnd;
    this.hooks.wave(this.sim);
    this.finaleMs = FINALE_MS;
    this.hooks.finale(FINALE_MS);
    this.finish();
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.running = false;
  }

  private finish(): void {
    this.stop();
    this.hooks.done();
  }

  private tick = (now: number): void => {
    // Clamp dt so a backgrounded tab doesn't jump straight to the end.
    const dt = Math.min(64, now - this.last);
    this.last = now;
    if (this.finaleMs < 0) {
      // Simulation time advances linearly, so slow roads visibly fill in slower.
      this.sim = Math.min(this.tEnd, this.sim + (dt * this.speed * this.tEnd) / WAVE_MS);
      this.hooks.wave(this.sim);
      if (this.sim >= this.tEnd) this.finaleMs = 0;
    } else {
      this.finaleMs = Math.min(FINALE_MS, this.finaleMs + dt * Math.max(1, this.speed));
      this.hooks.finale(this.finaleMs);
      if (this.finaleMs >= FINALE_MS) return this.finish();
    }
    this.raf = requestAnimationFrame(this.tick);
  };
}

export const easeOut = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
export const easeInOut = (x: number) => {
  x = Math.min(1, Math.max(0, x));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
