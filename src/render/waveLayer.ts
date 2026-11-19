// MapLibre custom WebGL layer that draws the Dijkstra waves and the final routes.
//
// Every road segment is an instanced quad carrying, per friend, the arrival time
// at both ends. The fragment shader works out when the wave reaches each pixel
// and compares it to `u_time`, so the GPU animates the whole network and JS only
// advances one number per frame.
//
// For a clean look, each friend is rendered in two steps:
//   1. into an offscreen texture with MAX blending, so overlapping segment ends
//      (every OSM node is a joint) never double up into bright beads;
//   2. composited onto the map with SCREEN blending plus a mipmap-based glow,
//      so different friends mix toward white without blowing out.
// Routes are drawn by the same segment shader straight onto the map, revealed
// per pixel by `routeTime`, so they trace smoothly without touching GeoJSON.
import type { CustomLayerInterface, Map as MLMap } from 'maplibre-gl';

/** Floats per segment instance: ax, ay, bx, by, costAB, costBA, widthScale. */
export const SEG_STRIDE = 7;

export interface WaveData {
  /** Mercator origin that segment coordinates are relative to (keeps float32 precise). */
  origin: [number, number];
  segs: Float32Array;
  count: number;
  /** Per friend: [tA, tB] per segment, in seconds (unreachable = 1e7). */
  times: Float32Array[];
  colors: [number, number, number][];
}

/** A friend's route: lon/lat points and the driving time (s) at each point. */
export interface Route { color: string; coords: [number, number][]; times: number[] }

// ---------------------------------------------------------------- shaders

const SEG_VERT = `
precision highp float;
attribute vec2 a_quad;   // x: 0 = A end, 1 = B end; y: side -1 / +1
attribute vec4 a_seg;    // A.xy, B.xy in mercator relative to origin
attribute vec3 a_cost;   // travel secs A→B, B→A (-1 = forbidden), width scale
attribute vec2 a_times;  // arrival time at A and at B
uniform mat4 u_matrix;
uniform vec2 u_viewport;  // target size, px
uniform float u_width;    // base line width, px
uniform float u_minWidth; // thinner lines are drawn this wide but fainter (no shimmer)
varying vec2 v_pos;       // px: x along the segment from A, y across
varying float v_len;
varying float v_hw;
varying float v_cov;
varying vec4 v_t;
void main() {
  vec4 ca = u_matrix * vec4(a_seg.xy, 0.0, 1.0);
  vec4 cb = u_matrix * vec4(a_seg.zw, 0.0, 1.0);
  vec2 hv = u_viewport * 0.5;
  vec2 sa = ca.xy / ca.w * hv;
  vec2 sb = cb.xy / cb.w * hv;
  vec2 d = sb - sa;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float w = u_width * a_cost.z;
  float dw = max(w, u_minWidth);
  float hw = dw * 0.5 + 0.75;                       // + anti-aliasing margin
  float along = a_quad.x < 0.5 ? -hw : len + hw;    // extend past both ends for round caps
  vec2 s = sa + dir * along + nrm * (a_quad.y * hw);
  gl_Position = vec4(s / hv, 0.0, 1.0);
  v_pos = vec2(along, a_quad.y * hw);
  v_len = len;
  v_hw = hw;
  v_cov = w / dw;
  v_t = vec4(a_times, a_cost.xy);
}`;

const SEG_FRAG = `
precision highp float;
uniform vec3 u_color;
uniform float u_time;  // simulation clock, seconds of driving
uniform float u_fade;  // how long the bright head lingers, seconds
uniform float u_soft;  // fade-in ramp at the very front, seconds
uniform float u_mode;  // 0 wave, 1 route glow, 2 route casing, 3 route core
varying vec2 v_pos;
varying float v_len;
varying float v_hw;
varying float v_cov;
varying vec4 v_t;
void main() {
  // Distance from this pixel to the segment line: round caps give clean joins.
  float dx = max(max(-v_pos.x, v_pos.x - v_len), 0.0);
  float dist = length(vec2(dx, v_pos.y));
  if (dist > v_hw) discard;

  // When does the wave reach this point? Best of entering from A or from B.
  float f = v_len > 1e-4 ? clamp(v_pos.x / v_len, 0.0, 1.0) : 0.0;
  float ta = v_t.z >= 0.0 ? v_t.x + f * v_t.z : 1e9;
  float tb = v_t.w >= 0.0 ? v_t.y + (1.0 - f) * v_t.w : 1e9;
  float age = u_time - min(ta, tb);
  if (age < 0.0) discard;

  float lead = smoothstep(0.0, u_soft, age);   // soft leading edge
  float head = exp(-age / u_fade);             // bright, white-hot wave front
  float edge = clamp(v_hw - dist, 0.0, 1.0);   // 1px anti-aliased edge

  if (u_mode < 0.5) {
    vec3 c = u_color * (0.42 + 0.8 * head) + vec3(0.55) * head * head;
    gl_FragColor = vec4(min(c, vec3(1.0)) * edge * v_cov * lead, 1.0);
  } else if (u_mode < 1.5) {
    // Soft halo; MAX-blended so halos of neighbouring segments never stack up.
    float r = dist / v_hw;
    gl_FragColor = vec4(u_color * exp(-3.0 * r * r) * 0.5 * lead, 0.0);
  } else if (u_mode < 2.5) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 0.85 * edge * lead);
  } else {
    // Slightly luminous core so it reads as the brightest part; white-hot at the tip.
    vec3 c = mix(u_color, vec3(1.0), 0.22 + 0.7 * head);
    gl_FragColor = vec4(c * edge * lead, edge * lead);
  }
}`;

const COMP_VERT = `
precision highp float;
attribute vec2 a_pos;
varying vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

// Glow = a few taps from blurry mip levels (cheap bloom); composited with SCREEN.
const COMP_FRAG = `
precision mediump float;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform float u_opacity;
uniform float u_glow;
varying vec2 v_uv;
void main() {
  vec3 c = texture2D(u_tex, v_uv).rgb;
  if (u_glow > 0.0) {
    vec2 o = u_texel * 5.0;
    vec3 g = texture2D(u_tex, v_uv, 2.0).rgb * 0.45
      + (texture2D(u_tex, v_uv + vec2(o.x, o.y), 3.5).rgb
       + texture2D(u_tex, v_uv + vec2(-o.x, o.y), 3.5).rgb
       + texture2D(u_tex, v_uv + vec2(o.x, -o.y), 3.5).rgb
       + texture2D(u_tex, v_uv + vec2(-o.x, -o.y), 3.5).rgb) * 0.16;
    c += g * u_glow;
  }
  gl_FragColor = vec4(min(c * u_opacity, vec3(1.0)), 0.0);
}`;

// ---------------------------------------------------------------- GL helpers

type GL = WebGLRenderingContext | WebGL2RenderingContext;
interface Api {
  divisor(loc: number, d: number): void;
  drawInst(mode: number, first: number, count: number, inst: number): void;
  vaoCreate(): unknown;
  vaoBind(v: unknown): void;
  vaoDelete(v: unknown): void;
  /** MAX blend equation, or null if unsupported. */
  max: number | null;
  /** Mipmaps on non-power-of-two textures (needed for the glow). */
  npotMips: boolean;
}

function makeApi(gl: GL): Api {
  if (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext) {
    return {
      divisor: (l, d) => gl.vertexAttribDivisor(l, d),
      drawInst: (m, f, c, i) => gl.drawArraysInstanced(m, f, c, i),
      vaoCreate: () => gl.createVertexArray(),
      vaoBind: (v) => gl.bindVertexArray(v as WebGLVertexArrayObject | null),
      vaoDelete: (v) => gl.deleteVertexArray(v as WebGLVertexArrayObject),
      max: gl.MAX,
      npotMips: true,
    };
  }
  const inst = gl.getExtension('ANGLE_instanced_arrays');
  const vao = gl.getExtension('OES_vertex_array_object');
  const minmax = gl.getExtension('EXT_blend_minmax');
  if (!inst || !vao) throw new Error('WebGL instancing is not supported on this device.');
  return {
    divisor: (l, d) => inst.vertexAttribDivisorANGLE(l, d),
    drawInst: (m, f, c, i) => inst.drawArraysInstancedANGLE(m, f, c, i),
    vaoCreate: () => vao.createVertexArrayOES(),
    vaoBind: (v) => vao.bindVertexArrayOES(v as WebGLVertexArrayObjectOES | null),
    vaoDelete: (v) => vao.deleteVertexArrayOES(v as WebGLVertexArrayObjectOES),
    max: minmax ? minmax.MAX_EXT : null,
    npotMips: false,
  };
}

function program(gl: GL, vs: string, fs: string, attribs: string[]): WebGLProgram {
  const prog = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(sh));
    gl.attachShader(prog, sh);
  }
  // Fixed locations; attribute 0 is always a non-instanced array (some drivers require it).
  attribs.forEach((name, i) => gl.bindAttribLocation(prog, i, name));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(prog));
  return prog;
}

function uniforms(gl: GL, prog: WebGLProgram, names: string[]) {
  const u: Record<string, WebGLUniformLocation | null> = {};
  for (const n of names) u[n] = gl.getUniformLocation(prog, n);
  return u;
}

interface Batch { vao: unknown; bufs: WebGLBuffer[]; count: number; color: [number, number, number] }

// ---------------------------------------------------------------- layer

export class WaveLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  /** Wave clock, seconds of driving. */
  time = 0;
  /** How long the bright head trails the wave front, seconds. */
  fade = 90;
  /** Wave brightness (lowered in the finale so routes stand out). */
  intensity = 1;
  /** Route clock: each route is drawn up to this driving time. */
  routeTime = 0;

  private map?: MLMap;
  private gl?: GL;
  private api?: Api;
  private segProg?: WebGLProgram;
  private compProg?: WebGLProgram;
  private su: Record<string, WebGLUniformLocation | null> = {};
  private cu: Record<string, WebGLUniformLocation | null> = {};
  private quadBuf?: WebGLBuffer;
  private triBuf?: WebGLBuffer;
  private compVao?: unknown;
  private fbo?: WebGLFramebuffer;
  private tex?: WebGLTexture;
  private fboSize = [0, 0];

  private data?: WaveData;
  private segBuf?: WebGLBuffer;
  private waves: Batch[] = [];
  private routeSrc: Route[] = [];
  private routes: Batch[] = [];

  constructor(id = 'waves') { this.id = id; }

  onAdd(map: MLMap, gl: GL): void {
    this.map = map;
    this.gl = gl;
    this.api = makeApi(gl);
    this.segProg = program(gl, SEG_VERT, SEG_FRAG, ['a_quad', 'a_seg', 'a_cost', 'a_times']);
    this.su = uniforms(gl, this.segProg, ['u_matrix', 'u_viewport', 'u_width', 'u_minWidth', 'u_color', 'u_time', 'u_fade', 'u_soft', 'u_mode']);
    this.compProg = program(gl, COMP_VERT, COMP_FRAG, ['a_pos']);
    this.cu = uniforms(gl, this.compProg, ['u_tex', 'u_texel', 'u_opacity', 'u_glow']);

    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

    // One oversized triangle covers the screen for compositing.
    this.triBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.triBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.compVao = this.api.vaoCreate();
    this.api.vaoBind(this.compVao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    this.api.vaoBind(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    if (this.data) this.uploadWaves();
    if (this.routeSrc.length) this.uploadRoutes();
  }

  setData(data: WaveData): void {
    this.data = data;
    this.routeSrc = [];
    if (this.gl) { this.uploadWaves(); this.freeBatches(this.routes); this.routes = []; }
    this.map?.triggerRepaint();
  }

  setRoutes(routes: Route[]): void {
    this.routeSrc = routes;
    if (this.gl && this.data) this.uploadRoutes();
    this.map?.triggerRepaint();
  }

  /** VAO for one instanced draw: shared quad + a segment buffer + a times buffer. */
  private makeBatch(segBuf: WebGLBuffer, times: Float32Array, count: number, color: [number, number, number], own: WebGLBuffer[]): Batch {
    const gl = this.gl!, api = this.api!;
    const tb = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, tb);
    gl.bufferData(gl.ARRAY_BUFFER, times, gl.STATIC_DRAW);
    const vao = api.vaoCreate();
    api.vaoBind(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf!);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, segBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, SEG_STRIDE * 4, 0);
    api.divisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, SEG_STRIDE * 4, 16);
    api.divisor(2, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, tb);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 8, 0);
    api.divisor(3, 1);
    api.vaoBind(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return { vao, bufs: [tb, ...own], count, color };
  }

  private freeBatches(list: Batch[]): void {
    for (const b of list) { this.api!.vaoDelete(b.vao); b.bufs.forEach((x) => this.gl!.deleteBuffer(x)); }
  }

  private uploadWaves(): void {
    const gl = this.gl!, d = this.data!;
    this.freeBatches(this.waves);
    if (this.segBuf) gl.deleteBuffer(this.segBuf);
    this.segBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segBuf);
    gl.bufferData(gl.ARRAY_BUFFER, d.segs, gl.STATIC_DRAW);
    this.waves = d.times.map((t, i) => this.makeBatch(this.segBuf!, t, d.count, d.colors[i], []));
  }

  /** Each route becomes its own little segment set, timed by driving time along it. */
  private uploadRoutes(): void {
    const gl = this.gl!, [ox, oy] = this.data!.origin;
    this.freeBatches(this.routes);
    this.routes = this.routeSrc.map((r) => {
      const n = Math.max(0, r.coords.length - 1);
      const segs = new Float32Array(n * SEG_STRIDE);
      const times = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        const [ax, ay] = toMercator(r.coords[i][0], r.coords[i][1]);
        const [bx, by] = toMercator(r.coords[i + 1][0], r.coords[i + 1][1]);
        const o = i * SEG_STRIDE;
        segs[o] = ax - ox; segs[o + 1] = ay - oy; segs[o + 2] = bx - ox; segs[o + 3] = by - oy;
        segs[o + 4] = Math.max(0, r.times[i + 1] - r.times[i]); // forward only
        segs[o + 5] = -1;
        segs[o + 6] = 1;
        times[2 * i] = r.times[i];
        times[2 * i + 1] = r.times[i + 1];
      }
      const sb = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, sb);
      gl.bufferData(gl.ARRAY_BUFFER, segs, gl.STATIC_DRAW);
      return this.makeBatch(sb, times, n, hexToRgb(r.color), [sb]);
    });
  }

  clear(): void {
    this.data = undefined;
    this.routeSrc = [];
    if (this.gl) { this.freeBatches(this.waves); this.freeBatches(this.routes); }
    this.waves = [];
    this.routes = [];
    this.map?.triggerRepaint();
  }

  /** (Re)creates the offscreen target when the canvas size changes. */
  private ensureTarget(w: number, h: number): void {
    const gl = this.gl!;
    if (this.fbo && this.fboSize[0] === w && this.fboSize[1] === h) return;
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.tex) gl.deleteTexture(this.tex);
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.api!.npotMips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.api!.npotMips) gl.generateMipmap(gl.TEXTURE_2D);
    this.fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    this.fboSize = [w, h];
  }

  render(gl: GL, matrix: ArrayLike<number>): void {
    const d = this.data, api = this.api;
    if (!d || !api || !this.segProg || this.waves.length === 0 || this.time <= 0) return;

    // u_matrix = matrix × translate(origin), folded in at double precision.
    const m = Float32Array.from(matrix as ArrayLike<number>);
    const [ox, oy] = d.origin;
    for (let r = 0; r < 4; r++) m[12 + r] = matrix[r] * ox + matrix[4 + r] * oy + matrix[12 + r];

    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const vp = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const dpr = window.devicePixelRatio || 1;
    // On very dense screens render the waves at ≤2× and let the composite upscale.
    const scale = dpr > 2 ? 2 / dpr : 1;
    const fw = Math.max(1, Math.round(W * scale)), fh = Math.max(1, Math.round(H * scale));
    this.ensureTarget(fw, fh);

    const zoom = this.map!.getZoom();
    const baseW = Math.min(3.2, Math.max(1.0, 0.6 * (zoom - 9.6))) * dpr;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);

    const segUniforms = (vw: number, vh: number, width: number, minW: number, time: number, fade: number, mode: number) => {
      gl.useProgram(this.segProg!);
      gl.uniformMatrix4fv(this.su.u_matrix, false, m);
      gl.uniform2f(this.su.u_viewport, vw, vh);
      gl.uniform1f(this.su.u_width, width);
      gl.uniform1f(this.su.u_minWidth, minW);
      gl.uniform1f(this.su.u_time, time);
      gl.uniform1f(this.su.u_fade, fade);
      gl.uniform1f(this.su.u_soft, Math.max(1, fade * 0.12));
      gl.uniform1f(this.su.u_mode, mode);
    };

    // ---- waves: per friend, offscreen with MAX, then SCREEN-composite with glow
    const glow = api.npotMips ? 1 : 0;
    for (const b of this.waves) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo!);
      gl.viewport(0, 0, fw, fh);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      segUniforms(fw, fh, baseW * scale, 1.0 * scale * dpr, this.time, this.fade, 0);
      if (api.max !== null) gl.blendEquation(api.max);
      else { gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE); }
      gl.uniform3f(this.su.u_color, b.color[0], b.color[1], b.color[2]);
      api.vaoBind(b.vao);
      api.drawInst(gl.TRIANGLE_STRIP, 0, 4, b.count);
      api.vaoBind(null);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex!);
      if (glow) gl.generateMipmap(gl.TEXTURE_2D);

      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
      gl.viewport(vp[0], vp[1], vp[2], vp[3]);
      gl.useProgram(this.compProg!);
      gl.uniform1i(this.cu.u_tex, 0);
      gl.uniform2f(this.cu.u_texel, 1 / fw, 1 / fh);
      gl.uniform1f(this.cu.u_opacity, this.intensity);
      gl.uniform1f(this.cu.u_glow, glow * 0.9);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ZERO, gl.ONE); // screen
      api.vaoBind(this.compVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      api.vaoBind(null);
    }

    // ---- routes: drawn directly on the map, revealed per pixel by routeTime
    if (this.routes.length && this.routeTime > 0) {
      const rw = Math.min(5, Math.max(3.2, 0.8 * (zoom - 7))) * dpr;
      // glow (MAX) → dark casing → core, each over all routes so cores stay on top
      const passes: [number, number][] = [[1, rw * 4.5], [2, rw + 4 * dpr], [3, rw]];
      for (const [mode, width] of passes) {
        segUniforms(W, H, width, width, this.routeTime, 40, mode);
        if (mode === 1 && api.max !== null) {
          gl.blendEquation(api.max);
        } else if (mode === 1) {
          gl.blendEquation(gl.FUNC_ADD);
          gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
        } else {
          gl.blendEquation(gl.FUNC_ADD);
          gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
        }
        for (const b of this.routes) {
          gl.uniform3f(this.su.u_color, b.color[0], b.color[1], b.color[2]);
          api.vaoBind(b.vao);
          api.drawInst(gl.TRIANGLE_STRIP, 0, 4, b.count);
        }
      }
      api.vaoBind(null);
    }
  }

  onRemove(): void {
    const gl = this.gl;
    if (!gl) return;
    this.freeBatches(this.waves);
    this.freeBatches(this.routes);
    if (this.segBuf) gl.deleteBuffer(this.segBuf);
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.tex) gl.deleteTexture(this.tex);
    if (this.segProg) gl.deleteProgram(this.segProg);
    if (this.compProg) gl.deleteProgram(this.compProg);
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
