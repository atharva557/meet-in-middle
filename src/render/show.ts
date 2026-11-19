// The animation timeline: a simulation clock (seconds of driving) for the waves,
// then a finale (dim → winner → routes → result card), driven by requestAnimationFrame.

export interface ShowHooks {
  /** Called every frame during the wave phase: simulation time (s) and progress 0→1. */
  wave(sim: number, progress: number): void;
  /** Called every frame of the finale with elapsed ms since it started (clamped to FINALE_MS). */
  finale(ms: number): void;
  done(): void;
}

/** Real-time length of the wave phase at 1× speed. */
const WAVE_MS = 10000;
export const FINALE_MS = 2400;

export class Show {
  speed = 1;
  private sim = 0;
  /** Wave-phase progress 0→1 in real time; `sim` is an eased function of it. */
  private p = 0;
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
    this.p = 0;
    this.finaleMs = -1;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  /** Change where the waves stop (e.g. a different winner) without restarting. */
  retarget(tEnd: number): void { this.tEnd = Math.max(tEnd, this.sim); }

  skip(): void {
    if (!this.running) return;
    this.p = 1;
    this.sim = this.tEnd;
    this.hooks.wave(this.sim, 1);
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
      // One global clock drives every wave, so at any instant each road fills in
      // proportion to its real travel time (slow roads visibly lag). The clock
      // itself eases in and out so the show starts and lands gently.
      this.p = Math.min(1, this.p + (dt * this.speed) / WAVE_MS);
      this.sim = this.tEnd * clockEase(this.p);
      this.hooks.wave(this.sim, this.p);
      if (this.p >= 1) this.finaleMs = 0;
    } else {
      this.finaleMs = Math.min(FINALE_MS, this.finaleMs + dt * Math.max(1, this.speed));
      this.hooks.finale(this.finaleMs);
      if (this.finaleMs >= FINALE_MS) return this.finish();
    }
    this.raf = requestAnimationFrame(this.tick);
  };
}

/** Mostly smoothstep with a linear share, so it never fully stalls at either end. */
export const clockEase = (p: number) => 0.3 * p + 0.7 * p * p * (3 - 2 * p);

export const easeOut = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
export const easeInOut = (x: number) => {
  x = Math.min(1, Math.max(0, x));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
