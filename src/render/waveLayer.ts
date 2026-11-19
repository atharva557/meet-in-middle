// MapLibre custom WebGL layer that draws every road segment as an instanced quad.
//
// Each segment instance carries, per friend, the Dijkstra arrival time at both of
// its endpoints. The fragment shader works out when the wave reaches each pixel
// along the segment and compares that to `u_time`, so the GPU animates
// the whole network and JS only advances one number per frame.
import type { CustomLayerInterface, Map as MLMap } from 'maplibre-gl';

/** Floats per segment instance in the static buffer: ax, ay, bx, by, wf, wb, widthScale. */
export const SEG_STRIDE = 7;

export interface WaveData {
  /** Mercator origin that segment coordinates are relative to (keeps float32 precise). */
  origin: [number, number];
  segs: Float32Array;
  count: number;
  /** Per friend: [du, dv] per segment, in seconds (unreachable = 1e7). */
  times: Float32Array[];
  colors: [number, number, number][];
}

const VERT = `
precision highp float;
attribute vec2 a_quad;   // x: which end (0 = A, 1 = B), y: side (-1 / +1)
attribute vec4 a_seg;    // A.xy, B.xy in mercator relative to origin
attribute vec3 a_cost;   // travel secs A→B, B→A (-1 = forbidden), width scale
attribute vec2 a_times;  // this friend's arrival time at A and B
uniform mat4 u_matrix;
uniform vec2 u_viewport; // drawing buffer size, px
uniform float u_width;   // base line width, px
varying float v_f;
varying float v_side;
varying float v_hw;
varying vec4 v_t;
void main() {
  vec4 ca = u_matrix * vec4(a_seg.xy, 0.0, 1.0);
  vec4 cb = u_matrix * vec4(a_seg.zw, 0.0, 1.0);
  vec2 half_vp = u_viewport * 0.5;
  vec2 d = (cb.xy / cb.w - ca.xy / ca.w) * half_vp;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float hw = u_width * a_cost.z * 0.5 + 1.0;   // +1px for anti-aliasing
  vec4 c = a_quad.x < 0.5 ? ca : cb;
  c.xy += nrm * a_quad.y * hw / half_vp * c.w;  // extrude in screen space
  gl_Position = c;
  v_f = a_quad.x;
  v_side = a_quad.y * hw;
  v_hw = hw;
  v_t = vec4(a_times, a_cost.xy);
}`;

const FRAG = `
precision highp float;
uniform vec3 u_color;
uniform float u_time;      // simulation clock, seconds of driving
uniform float u_fade;      // how long the bright wave front lingers, seconds
uniform float u_intensity; // global brightness (dimmed in the finale)
uniform float u_glow;      // 1 = soft halo pass, 0 = crisp core pass
varying float v_f;
varying float v_side;
varying float v_hw;
varying vec4 v_t;
void main() {
  float f = v_f;
  // Arrival time at this point = best of entering from A or from B.
  float ta = v_t.z >= 0.0 ? v_t.x + f * v_t.z : 1e9;
  float tb = v_t.w >= 0.0 ? v_t.y + (1.0 - f) * v_t.w : 1e9;
  float t = min(ta, tb);
  if (t > u_time) discard;
  float front = exp(-(u_time - t) / u_fade);
  float x = abs(v_side);
  vec3 c;
  if (u_glow > 0.5) {
    float p = exp(-4.0 * (x / v_hw) * (x / v_hw));
    c = u_color * p * (0.015 + 0.45 * front);
  } else {
    float p = clamp(v_hw - x, 0.0, 1.0);
    c = (u_color * (0.3 + 0.95 * front) + vec3(0.85) * front * front * 0.6) * p;
  }
  // Additive blending: overlapping friends' waves sum toward white.
  gl_FragColor = vec4(c * u_intensity, 0.0);
}`;

type Inst = { divisor(loc: number, d: number): void; draw(mode: number, first: number, count: number, inst: number): void };
type Vao = { create(): unknown; bind(v: unknown): void; del(v: unknown): void };

export class WaveLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  /** Simulation time in seconds of driving. */
  time = 0;
  /** Length of the bright trailing glow behind the wave front, seconds. */
  fade = 90;
  intensity = 1;
  /** Which friends to draw (all by default). */
  visible: boolean[] = [];

  private map?: MLMap;
  private gl?: WebGLRenderingContext | WebGL2RenderingContext;
  private prog?: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private quadBuf?: WebGLBuffer;
  private segBuf?: WebGLBuffer;
  private timeBufs: WebGLBuffer[] = [];
  private vaos: unknown[] = [];
  private inst?: Inst;
  private vao?: Vao;
  private data?: WaveData;

  constructor(id = 'waves') { this.id = id; }

  onAdd(map: MLMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;
    const isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    if (isGL2) {
      const g2 = gl as WebGL2RenderingContext;
      this.inst = { divisor: (l, d) => g2.vertexAttribDivisor(l, d), draw: (m, f, c, i) => g2.drawArraysInstanced(m, f, c, i) };
      this.vao = { create: () => g2.createVertexArray(), bind: (v) => g2.bindVertexArray(v as WebGLVertexArrayObject | null), del: (v) => g2.deleteVertexArray(v as WebGLVertexArrayObject) };
    } else {
      const ext = gl.getExtension('ANGLE_instanced_arrays');
      const vext = gl.getExtension('OES_vertex_array_object');
      if (!ext || !vext) throw new Error('WebGL instancing is not supported on this device.');
      this.inst = { divisor: (l, d) => ext.vertexAttribDivisorANGLE(l, d), draw: (m, f, c, i) => ext.drawArraysInstancedANGLE(m, f, c, i) };
      this.vao = { create: () => vext.createVertexArrayOES(), bind: (v) => vext.bindVertexArrayOES(v as WebGLVertexArrayObjectOES | null), del: (v) => vext.deleteVertexArrayOES(v as WebGLVertexArrayObjectOES) };
    }

    const prog = gl.createProgram()!;
    for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]] as const) {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(sh));
      gl.attachShader(prog, sh);
    }
    // Fixed locations; a_quad on 0 because some drivers require attribute 0 to be a non-instanced array.
    ['a_quad', 'a_seg', 'a_cost', 'a_times'].forEach((name, i) => gl.bindAttribLocation(prog, i, name));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(prog));
    this.prog = prog;
    for (const name of ['u_matrix', 'u_viewport', 'u_width', 'u_color', 'u_time', 'u_fade', 'u_intensity', 'u_glow']) {
      this.u[name] = gl.getUniformLocation(prog, name);
    }
    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    if (this.data) this.upload();
  }

  setData(data: WaveData): void {
    this.data = data;
    this.visible = data.times.map(() => true);
    if (this.gl) this.upload();
    this.map?.triggerRepaint();
  }

  /** Uploads buffers and records one VAO per friend (each binds a different a_times buffer). */
  private upload(): void {
    const gl = this.gl!, d = this.data!;
    this.freeBuffers();
    this.segBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segBuf);
    gl.bufferData(gl.ARRAY_BUFFER, d.segs, gl.STATIC_DRAW);
    for (const t of d.times) {
      const tb = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, tb);
      gl.bufferData(gl.ARRAY_BUFFER, t, gl.STATIC_DRAW);
      this.timeBufs.push(tb);

      const vao = this.vao!.create();
      this.vao!.bind(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf!);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.segBuf);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, SEG_STRIDE * 4, 0);
      this.inst!.divisor(1, 1);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, SEG_STRIDE * 4, 16);
      this.inst!.divisor(2, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, tb);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 8, 0);
      this.inst!.divisor(3, 1);
      this.vao!.bind(null);
      this.vaos.push(vao);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  private freeBuffers(): void {
    const gl = this.gl;
    if (!gl) return;
    if (this.segBuf) gl.deleteBuffer(this.segBuf);
    this.timeBufs.forEach((b) => gl.deleteBuffer(b));
    this.vaos.forEach((v) => this.vao!.del(v));
    this.timeBufs = [];
    this.vaos = [];
    this.segBuf = undefined;
  }

  clear(): void {
    this.data = undefined;
    this.freeBuffers();
    this.map?.triggerRepaint();
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, matrix: ArrayLike<number>): void {
    const d = this.data;
    if (!d || !this.prog || this.vaos.length === 0 || this.time <= 0) return;

    // u_matrix = matrix × translate(origin): the large translation is folded in
    // at double precision here instead of in float32 on the GPU.
    const m = Float32Array.from(matrix as ArrayLike<number>);
    const [ox, oy] = d.origin;
    for (let r = 0; r < 4; r++) m[12 + r] = matrix[r] * ox + matrix[4 + r] * oy + matrix[12 + r];

    const zoom = this.map!.getZoom();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.min(3.4, Math.max(1.0, 0.6 * (zoom - 9.6))) * dpr;

    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.u.u_matrix, false, m);
    gl.uniform2f(this.u.u_viewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(this.u.u_time, this.time);
    gl.uniform1f(this.u.u_fade, this.fade);
    gl.uniform1f(this.u.u_intensity, this.intensity);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE); // additive RGB, keep dest alpha

    // Pass 1: wide soft halo; pass 2: crisp core.
    for (const glow of [1, 0]) {
      gl.uniform1f(this.u.u_glow, glow);
      gl.uniform1f(this.u.u_width, glow ? width * 5 : width);
      for (let i = 0; i < this.vaos.length; i++) {
        if (!this.visible[i]) continue;
        const [r, g, b] = d.colors[i];
        gl.uniform3f(this.u.u_color, r, g, b);
        this.vao!.bind(this.vaos[i]);
        this.inst!.draw(gl.TRIANGLE_STRIP, 0, 4, d.count);
      }
    }
    this.vao!.bind(null);
  }

  onRemove(): void {
    this.freeBuffers();
    if (this.gl && this.prog) this.gl.deleteProgram(this.prog);
  }
}

/** Web Mercator in MapLibre's [0,1] world units. */
export function toMercator(lon: number, lat: number): [number, number] {
  const x = (lon + 180) / 360;
  const s = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return [x, y];
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
