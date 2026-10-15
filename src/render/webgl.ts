/**
 * WebGL2 렌더러.
 * - 묶음(chunk)마다 "묶음 좌표 → 화면 픽셀" 행렬을 CPU에서 double로 계산해 넘긴다(큰 좌표 떨림 방지).
 * - 선분은 사각형 인스턴스로 펼쳐 선가중치(픽셀 폭)를 그린다.
 * - 글리프는 모양을 한 번만 올리고 인스턴스(변환)로 그린다.
 * - 깊이 = 그리기 순서.
 */
import type { ChunkData, DisplayList, EntityBox } from './displaylist';
import { GLYPH_STRIDE, SEG_STRIDE, TRI_STRIDE } from './displaylist';
import { type ChunkGroup, type ChunkKind, drawWhole, elementBytes, mergeGroup, planChunkGroups, rebaseInto } from './chunkgroups';

/** 화면 변환: px = A · (p − ref) + t  (A는 도면 단위 → 픽셀, y 아래로) */
export interface ViewXf {
  /** 2×2 [a, b, c, d]: px.x = a·dx + c·dy, px.y = b·dx + d·dy */
  A: [number, number, number, number];
  refX: number;
  refY: number;
  tx: number;
  ty: number;
}

const SEG_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_seg;
layout(location=2) in float a_depth;
layout(location=3) in uint a_style;
uniform vec2 u_m0; uniform vec2 u_m1; uniform vec2 u_m2; // 묶음 좌표 → 픽셀
uniform vec2 u_size;
uniform sampler2D u_styles;
uniform float u_lwScale;
uniform vec4 u_override; // a > 0이면 색 덮어쓰기
out vec4 v_color;
vec4 styleTexel(uint s, int k) {
  int i = int(s) * 2 + k;
  return texelFetch(u_styles, ivec2(i % 2048, i / 2048), 0);
}
void main() {
  vec4 c = styleTexel(a_style, 0);
  vec4 x = styleTexel(a_style, 1);
  vec2 p0 = u_m0 * a_seg.x + u_m1 * a_seg.y + u_m2;
  vec2 p1 = u_m0 * a_seg.z + u_m1 * a_seg.w + u_m2;
  float w = max(1.0, x.x * u_lwScale);
  vec2 d = p1 - p0;
  float len = length(d);
  vec2 dir = len > 1e-6 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  float ext = w > 1.5 ? w * 0.5 : 0.5;
  vec2 p = mix(p0, p1, a_corner.x) + n * a_corner.y * w * 0.5 + dir * (a_corner.x * 2.0 - 1.0) * ext;
  vec2 clip = vec2(p.x / u_size.x * 2.0 - 1.0, 1.0 - p.y / u_size.y * 2.0);
  gl_Position = x.y > 0.5 ? vec4(clip, a_depth * 2.0 - 1.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
  v_color = u_override.a > 0.0 ? u_override : c;
}`;

const TRI_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec2 a_pos;
layout(location=1) in float a_depth;
layout(location=2) in uint a_style;
uniform vec2 u_m0; uniform vec2 u_m1; uniform vec2 u_m2;
uniform vec2 u_size;
uniform sampler2D u_styles;
uniform vec4 u_override;
out vec4 v_color;
vec4 styleTexel(uint s, int k) {
  int i = int(s) * 2 + k;
  return texelFetch(u_styles, ivec2(i % 2048, i / 2048), 0);
}
void main() {
  vec4 c = styleTexel(a_style, 0);
  vec4 x = styleTexel(a_style, 1);
  vec2 p = u_m0 * a_pos.x + u_m1 * a_pos.y + u_m2;
  vec2 clip = vec2(p.x / u_size.x * 2.0 - 1.0, 1.0 - p.y / u_size.y * 2.0);
  gl_Position = x.y > 0.5 ? vec4(clip, a_depth * 2.0 - 1.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
  v_color = u_override.a > 0.0 ? u_override : c;
}`;

// 글리프(윤곽): 정점 = 글리프 좌표, 인스턴스 = 변환
const GLYPH_FILL_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec2 a_pos;
layout(location=1) in vec4 i_m;      // a b c d
layout(location=2) in vec4 i_ef;     // eHi eLo fHi fLo
layout(location=3) in vec2 i_ds;     // depth style
uniform vec4 u_A; uniform vec2 u_refHi; uniform vec2 u_refLo; uniform vec2 u_t;
uniform vec2 u_size;
uniform sampler2D u_styles;
uniform vec4 u_override;
uniform float u_minPx;
out vec4 v_color;
vec4 styleTexel(uint s, int k) {
  int i = int(s) * 2 + k;
  return texelFetch(u_styles, ivec2(i % 2048, i / 2048), 0);
}
void main() {
  uint st = uint(i_ds.y + 0.5);
  vec4 c = styleTexel(st, 0);
  vec4 x = styleTexel(st, 1);
  vec2 d = vec2(i_m.x * a_pos.x + i_m.z * a_pos.y, i_m.y * a_pos.x + i_m.w * a_pos.y);
  d += vec2((i_ef.x - u_refHi.x) + (i_ef.y - u_refLo.x), (i_ef.z - u_refHi.y) + (i_ef.w - u_refLo.y));
  vec2 p = vec2(u_A.x * d.x + u_A.z * d.y, u_A.y * d.x + u_A.w * d.y) + u_t;
  // 화면에서 너무 작은 글자는 그리지 않는다
  float hpx = length(vec2(u_A.x * i_m.z + u_A.z * i_m.w, u_A.y * i_m.z + u_A.w * i_m.w));
  vec2 clip = vec2(p.x / u_size.x * 2.0 - 1.0, 1.0 - p.y / u_size.y * 2.0);
  gl_Position = (x.y > 0.5 && hpx >= u_minPx) ? vec4(clip, i_ds.x * 2.0 - 1.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
  v_color = u_override.a > 0.0 ? u_override : c;
}`;

// 글리프(단선): 정점 = [x0, y0, x1, y1, 모서리 t, 모서리 s]
const GLYPH_STROKE_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec4 a_seg;
layout(location=4) in vec2 a_corner;
layout(location=1) in vec4 i_m;
layout(location=2) in vec4 i_ef;
layout(location=3) in vec2 i_ds;
uniform vec4 u_A; uniform vec2 u_refHi; uniform vec2 u_refLo; uniform vec2 u_t;
uniform vec2 u_size;
uniform sampler2D u_styles;
uniform float u_lwScale;
uniform vec4 u_override;
uniform float u_minPx;
out vec4 v_color;
vec4 styleTexel(uint s, int k) {
  int i = int(s) * 2 + k;
  return texelFetch(u_styles, ivec2(i % 2048, i / 2048), 0);
}
vec2 toPx(vec2 g) {
  vec2 d = vec2(i_m.x * g.x + i_m.z * g.y, i_m.y * g.x + i_m.w * g.y);
  d += vec2((i_ef.x - u_refHi.x) + (i_ef.y - u_refLo.x), (i_ef.z - u_refHi.y) + (i_ef.w - u_refLo.y));
  return vec2(u_A.x * d.x + u_A.z * d.y, u_A.y * d.x + u_A.w * d.y) + u_t;
}
void main() {
  uint st = uint(i_ds.y + 0.5);
  vec4 c = styleTexel(st, 0);
  vec4 x = styleTexel(st, 1);
  vec2 p0 = toPx(a_seg.xy);
  vec2 p1 = toPx(a_seg.zw);
  float w = max(1.0, x.x * u_lwScale);
  vec2 dd = p1 - p0;
  float len = length(dd);
  vec2 dir = len > 1e-6 ? dd / len : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  float ext = w > 1.5 ? w * 0.5 : 0.5;
  vec2 p = mix(p0, p1, a_corner.x) + n * a_corner.y * w * 0.5 + dir * (a_corner.x * 2.0 - 1.0) * ext;
  float hpx = length(vec2(u_A.x * i_m.z + u_A.z * i_m.w, u_A.y * i_m.z + u_A.w * i_m.w));
  vec2 clip = vec2(p.x / u_size.x * 2.0 - 1.0, 1.0 - p.y / u_size.y * 2.0);
  gl_Position = (x.y > 0.5 && hpx >= u_minPx) ? vec4(clip, i_ds.x * 2.0 - 1.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
  v_color = u_override.a > 0.0 ? u_override : c;
}`;

const FS = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 o;
void main() { o = v_color; }`;

// 화면 좌표 단색 삼각형(용지·그림자)
const SCREEN_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_px;
uniform vec2 u_size;
uniform float u_depth;
void main() { gl_Position = vec4(a_px.x / u_size.x * 2.0 - 1.0, 1.0 - a_px.y / u_size.y * 2.0, u_depth, 1.0); }`;
const SCREEN_FS = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 o;
void main() { o = u_color; }`;

// 래스터 이미지: 정점 = 묶음 기준 위치 + UV
const IMG_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec2 a_pos;
layout(location=1) in vec2 a_uv;
uniform vec2 u_m0; uniform vec2 u_m1; uniform vec2 u_m2;
uniform vec2 u_size;
uniform float u_depth;
uniform uint u_style;
uniform sampler2D u_styles;
out vec2 v_uv;
void main() {
  int i = int(u_style) * 2 + 1;
  vec4 x = texelFetch(u_styles, ivec2(i % 2048, i / 2048), 0);
  vec2 p = u_m0 * a_pos.x + u_m1 * a_pos.y + u_m2;
  vec2 clip = vec2(p.x / u_size.x * 2.0 - 1.0, 1.0 - p.y / u_size.y * 2.0);
  gl_Position = x.y > 0.5 ? vec4(clip, u_depth * 2.0 - 1.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
  v_uv = a_uv;
}`;
const IMG_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_img;
uniform vec3 u_bcf;   // 밝기·대비·흐리기(0~100, 기본 50·50·0)
uniform vec3 u_bg;
uniform float u_alpha;
uniform float u_mono;
uniform float u_adjust;
out vec4 o;
void main() {
  vec4 c = texture(u_img, v_uv);
  vec3 rgb = (c.rgb - 0.5) * (u_bcf.y / 50.0) + 0.5 + (u_bcf.x - 50.0) / 100.0;
  if (u_mono > 0.5) rgb = vec3(dot(rgb, vec3(0.299, 0.587, 0.114)));
  if (u_adjust > 0.5 && dot(u_bg, vec3(0.299, 0.587, 0.114)) < 0.5 && max(rgb.r, max(rgb.g, rgb.b)) - min(rgb.r, min(rgb.g, rgb.b)) < 0.15) rgb = vec3(1.0) - rgb;
  rgb = mix(rgb, u_bg, u_bcf.z / 100.0);
  o = vec4(clamp(rgb, 0.0, 1.0), u_alpha > 0.5 ? c.a : 1.0);
}`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('셰이더 오류: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('셰이더 연결 오류: ' + gl.getProgramInfoLog(p));
  return p;
}

/** 그릴 단위 하나(묶음 또는 묶음 무리): 원점 + 종류별 VAO·버퍼 */
interface GpuDraw {
  ox: number;
  oy: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  seg: WebGLVertexArrayObject | null;
  segCount: number;
  tri: WebGLVertexArrayObject | null;
  triCount: number;
  tseg: WebGLVertexArrayObject | null;
  tsegCount: number;
  ttri: WebGLVertexArrayObject | null;
  ttriCount: number;
  segBuf: WebGLBuffer | null;
  triBuf: WebGLBuffer | null;
  tsegBuf: WebGLBuffer | null;
  ttriBuf: WebGLBuffer | null;
}

interface GpuChunk extends GpuDraw {
  /** 무리 번호(-1: 무리 없음 — 처음부터 올린다) */
  group: number;
  /** 무리에 든 묶음은 필요할 때(크게 확대해 무리 일부만 보일 때) 올리고, 오래 안 쓰면 내린다 */
  lazy: { bufs: WebGLBuffer[]; vaos: WebGLVertexArrayObject[]; bytes: number; used: number } | null;
}

/** 묶음 무리(chunkgroups): 여러 작은 묶음을 무리 원점 기준으로 이어 붙인 버퍼 */
interface GpuGroup extends GpuDraw {
  info: ChunkGroup;
  /** 종류별로 members[k] 묶음이 시작하는 요소 번호(편집 숨기기 패치용) */
  at: Record<ChunkKind, Int32Array | null>;
}

export interface GpuScene {
  chunks: GpuChunk[];
  /** 묶음 무리(묶음이 적으면 비어 있다) */
  groups: GpuGroup[];
  /** 무리 격자 칸 크기(도면 단위) */
  groupSize: number;
  /** 원본 묶음 자료(무리에 든 묶음을 나중에 올릴 때) */
  src: ChunkData[];
  /** 나중에 올린 묶음 바이트 합 */
  lazyBytes: number;
  glyphFillVao: WebGLVertexArrayObject | null;
  glyphStrokeVao: WebGLVertexArrayObject | null;
  instBuf: WebGLBuffer | null;
  glyphs: DisplayList['glyphs'];
  buffers: WebGLBuffer[];
  vaos: WebGLVertexArrayObject[];
  xlines: number[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  images: GpuImage[];
}

interface GpuImage {
  key: string;
  handle: string;
  vao: WebGLVertexArrayObject;
  count: number;
  ox: number;
  oy: number;
  depth: number;
  style: number;
  bcf: [number, number, number];
  transparent: boolean;
  mono: boolean;
  adjust: boolean;
  hidden: boolean;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

/** 장면마다 따로 올려 둘 무리 속 묶음 바이트 상한(넘으면 오래 안 쓴 것부터 내린다) */
const LAZY_BUDGET = 160 << 20;

export class GLRenderer {
  readonly gl: WebGL2RenderingContext;
  private segProg!: WebGLProgram;
  private triProg!: WebGLProgram;
  private gFillProg!: WebGLProgram;
  private gStrokeProg!: WebGLProgram;
  private screenProg!: WebGLProgram;
  private imgProg!: WebGLProgram;
  /** 래스터 이미지 텍스처(열쇠 = 파일 이름) */
  private readonly textures = new Map<string, WebGLTexture>();
  private readonly u: Map<WebGLProgram, Uniforms> = new Map();
  private cornerBuf!: WebGLBuffer;
  private styleTex!: WebGLTexture;
  private screenBuf!: WebGLBuffer;
  private screenVao!: WebGLVertexArrayObject;
  private xlineBuf!: WebGLBuffer;
  private xlineVao!: WebGLVertexArrayObject;
  width = 1;
  height = 1;
  dpr = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true, stencil: true });
    if (!gl) throw new Error('이 브라우저는 WebGL2를 지원하지 않습니다.');
    this.gl = gl;
    this.init();
  }

  /** 셰이더·공용 버퍼 만들기(문맥을 잃었다가 되찾을 때 다시 부른다) */
  init(): void {
    const gl = this.gl;
    this.u.clear();
    this.segProg = compile(gl, SEG_VS, FS);
    this.triProg = compile(gl, TRI_VS, FS);
    this.gFillProg = compile(gl, GLYPH_FILL_VS, FS);
    this.gStrokeProg = compile(gl, GLYPH_STROKE_VS, FS);
    this.screenProg = compile(gl, SCREEN_VS, SCREEN_FS);
    this.imgProg = compile(gl, IMG_VS, IMG_FS);
    this.textures.clear();
    for (const p of [this.segProg, this.triProg, this.gFillProg, this.gStrokeProg, this.screenProg, this.imgProg]) {
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
      const map: Uniforms = {};
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(p, i)!;
        map[info.name] = gl.getUniformLocation(p, info.name);
      }
      this.u.set(p, map);
    }
    // 사각형 모서리(삼각형 2개)
    this.cornerBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 0, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    this.styleTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.styleTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 2, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(8));
    this.screenBuf = gl.createBuffer()!;
    this.screenVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.screenVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.screenBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.xlineBuf = gl.createBuffer()!;
    this.xlineVao = this.segVao(this.xlineBuf, 0);
  }

  /** 래스터 이미지 텍스처 올리기·지우기 */
  setImage(key: string, src: TexImageSource | null): void {
    const gl = this.gl;
    const old = this.textures.get(key);
    if (old) gl.deleteTexture(old);
    this.textures.delete(key);
    if (!src) return;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures.set(key, t);
  }

  hasImage(key: string): boolean {
    return this.textures.has(key);
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.dpr = dpr;
    this.width = Math.max(1, Math.round(cssW * dpr));
    this.height = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== this.width || this.canvas.height !== this.height) {
      this.canvas.width = this.width;
      this.canvas.height = this.height;
    }
  }

  /** 스타일 표 [r,g,b,a, lw, visible, 0, 0]×n */
  setStyles(data: Float32Array): void {
    const gl = this.gl;
    const texels = Math.max(2, data.length / 4);
    const w = Math.min(2048, texels);
    const h = Math.ceil(texels / 2048);
    const padded = new Float32Array(w * h * 4);
    padded.set(data);
    gl.bindTexture(gl.TEXTURE_2D, this.styleTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, padded);
  }

  private segVao(buf: WebGLBuffer, byteOffset: number): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const stride = SEG_STRIDE * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, byteOffset);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, byteOffset + 16);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, stride, byteOffset + 20);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
    return vao;
  }

  private triVao(buf: WebGLBuffer): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const stride = TRI_STRIDE * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, stride, 12);
    gl.bindVertexArray(null);
    return vao;
  }

  upload(dl: DisplayList): GpuScene {
    const gl = this.gl;
    const scene: GpuScene = {
      chunks: [],
      groups: [],
      groupSize: 0,
      src: dl.chunks,
      lazyBytes: 0,
      glyphFillVao: null,
      glyphStrokeVao: null,
      instBuf: null,
      glyphs: dl.glyphs,
      buffers: [],
      vaos: [],
      xlines: dl.xlines,
      minX: dl.minX,
      minY: dl.minY,
      maxX: dl.maxX,
      maxY: dl.maxY,
      images: [],
    };
    const mkBuf = (data: ArrayBuffer | ArrayBufferView) => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      scene.buffers.push(b);
      return b;
    };
    const plan = planChunkGroups(dl.chunks);
    dl.chunks.forEach((c, i) => {
      const g: GpuChunk = {
        ox: c.ox,
        oy: c.oy,
        minX: c.minX,
        minY: c.minY,
        maxX: c.maxX,
        maxY: c.maxY,
        seg: null,
        segCount: c.segCount,
        tri: null,
        triCount: c.triCount,
        tseg: null,
        tsegCount: c.tsegCount,
        ttri: null,
        ttriCount: c.ttriCount,
        segBuf: null,
        triBuf: null,
        tsegBuf: null,
        ttriBuf: null,
        group: plan ? plan.groupOf[i]! : -1,
        lazy: null,
      };
      if (g.group < 0) {
        if (c.segCount) g.seg = this.segVao((g.segBuf = mkBuf(c.segs)), 0);
        if (c.triCount) g.tri = this.triVao((g.triBuf = mkBuf(c.tris)));
        if (c.tsegCount) g.tseg = this.segVao((g.tsegBuf = mkBuf(c.tsegs)), 0);
        if (c.ttriCount) g.ttri = this.triVao((g.ttriBuf = mkBuf(c.ttris)));
        for (const v of [g.seg, g.tri, g.tseg, g.ttri]) if (v) scene.vaos.push(v);
      }
      scene.chunks.push(g);
    });
    if (plan) {
      scene.groupSize = plan.size;
      for (const info of plan.groups) {
        const gg: GpuGroup = {
          info,
          ox: info.ox,
          oy: info.oy,
          minX: info.minX,
          minY: info.minY,
          maxX: info.maxX,
          maxY: info.maxY,
          seg: null,
          segCount: 0,
          tri: null,
          triCount: 0,
          tseg: null,
          tsegCount: 0,
          ttri: null,
          ttriCount: 0,
          segBuf: null,
          triBuf: null,
          tsegBuf: null,
          ttriBuf: null,
          at: { segs: null, tris: null, tsegs: null, ttris: null },
        };
        const put = (kind: ChunkKind) => {
          const m = mergeGroup(dl.chunks, info, kind);
          gg.at[kind] = m.at;
          if (!m.count) return;
          const buf = mkBuf(m.data);
          if (kind === 'segs') [gg.segBuf, gg.seg, gg.segCount] = [buf, this.segVao(buf, 0), m.count];
          else if (kind === 'tsegs') [gg.tsegBuf, gg.tseg, gg.tsegCount] = [buf, this.segVao(buf, 0), m.count];
          else if (kind === 'tris') [gg.triBuf, gg.tri, gg.triCount] = [buf, this.triVao(buf), m.count];
          else [gg.ttriBuf, gg.ttri, gg.ttriCount] = [buf, this.triVao(buf), m.count];
        };
        put('segs');
        put('tris');
        put('tsegs');
        put('ttris');
        for (const v of [gg.seg, gg.tri, gg.tseg, gg.ttri]) if (v) scene.vaos.push(v);
        scene.groups.push(gg);
      }
    }
    const gs = dl.glyphs;
    if (gs.instanceCount) {
      scene.instBuf = mkBuf(gs.instances);
      if (gs.fillVerts.length) {
        const vb = mkBuf(gs.fillVerts);
        const vao = gl.createVertexArray()!;
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, vb);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        this.bindInstance(scene.instBuf, 0);
        gl.bindVertexArray(null);
        scene.glyphFillVao = vao;
        scene.vaos.push(vao);
      }
      if (gs.strokeSegs.length) {
        // 선분마다 6정점(사각형) [x0,y0,x1,y1,t,s]
        const n = gs.strokeSegs.length / 4;
        const exp = new Float32Array(n * 6 * 6);
        const corners = [0, -1, 1, -1, 0, 1, 0, 1, 1, -1, 1, 1];
        for (let i = 0; i < n; i++) {
          for (let k = 0; k < 6; k++) {
            const o = (i * 6 + k) * 6;
            exp[o] = gs.strokeSegs[i * 4]!;
            exp[o + 1] = gs.strokeSegs[i * 4 + 1]!;
            exp[o + 2] = gs.strokeSegs[i * 4 + 2]!;
            exp[o + 3] = gs.strokeSegs[i * 4 + 3]!;
            exp[o + 4] = corners[k * 2]!;
            exp[o + 5] = corners[k * 2 + 1]!;
          }
        }
        const vb = mkBuf(exp);
        const vao = gl.createVertexArray()!;
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, vb);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 24, 0);
        gl.enableVertexAttribArray(4);
        gl.vertexAttribPointer(4, 2, gl.FLOAT, false, 24, 16);
        this.bindInstance(scene.instBuf, 0);
        gl.bindVertexArray(null);
        scene.glyphStrokeVao = vao;
        scene.vaos.push(vao);
      }
    }
    // 래스터 이미지
    for (const im of dl.images ?? []) {
      const buf = mkBuf(im.verts);
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
      gl.bindVertexArray(null);
      scene.vaos.push(vao);
      scene.images.push({
        key: im.key,
        handle: im.handle,
        vao,
        count: im.verts.length / 4,
        ox: im.ox,
        oy: im.oy,
        depth: im.depth,
        style: im.style,
        bcf: [im.brightness || 50, im.contrast || 50, im.fade || 0],
        transparent: im.transparent,
        mono: !!im.mono,
        adjust: !!im.adjust,
        hidden: false,
      });
    }
    return scene;
  }

  /** 래스터 이미지 그리기(불투명 또는 투명 이미지만) */
  private drawImages(scene: GpuScene, view: ViewXf, transparent: boolean, bg: [number, number, number]): void {
    if (!scene.images.length) return;
    const gl = this.gl;
    gl.useProgram(this.imgProg);
    const u = this.u.get(this.imgProg)!;
    gl.uniform2f(u.u_size!, this.width, this.height);
    gl.uniform1i(u.u_styles!, 0);
    gl.uniform1i(u.u_img!, 1);
    gl.uniform3f(u.u_bg!, bg[0], bg[1], bg[2]);
    gl.uniform1f(u.u_alpha!, transparent ? 1 : 0);
    const A = view.A;
    for (const im of scene.images) {
      if (im.hidden || im.transparent !== transparent) continue;
      const t = this.textures.get(im.key);
      if (!t) continue;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.activeTexture(gl.TEXTURE0);
      const dx = im.ox - view.refX;
      const dy = im.oy - view.refY;
      gl.uniform2f(u.u_m0!, A[0], A[1]);
      gl.uniform2f(u.u_m1!, A[2], A[3]);
      gl.uniform2f(u.u_m2!, A[0] * dx + A[2] * dy + view.tx, A[1] * dx + A[3] * dy + view.ty);
      gl.uniform1f(u.u_depth!, im.depth);
      gl.uniform1ui(u.u_style!, im.style);
      gl.uniform3f(u.u_bcf!, im.bcf[0], im.bcf[1], im.bcf[2]);
      gl.uniform1f(u.u_mono!, im.mono ? 1 : 0);
      gl.uniform1f(u.u_adjust!, im.adjust ? 1 : 0);
      gl.bindVertexArray(im.vao);
      gl.drawArrays(gl.TRIANGLES, 0, im.count);
    }
  }

  private bindInstance(buf: WebGLBuffer, startInstance: number): void {
    const gl = this.gl;
    const stride = GLYPH_STRIDE * 4;
    const base = startInstance * stride;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, base);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, base + 16);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, stride, base + 32);
    gl.vertexAttribDivisor(3, 1);
  }

  /**
   * 객체 하나의 그림을 숨긴다(원본 표시 목록과 GPU 버퍼의 스타일을 숨김 스타일로 바꾼다).
   */
  hideEntity(scene: GpuScene, src: DisplayList, box: EntityBox, hidden: number): void {
    const gl = this.gl;
    for (const im of scene.images) if (im.handle === box.handle) im.hidden = true;
    for (let i = 0; i < src.xlineHandles.length; i++) if (src.xlineHandles[i] === box.handle) scene.xlines[i * 7 + 6] = hidden;
    if (box.chunk !== undefined) {
      const c = src.chunks[box.chunk];
      const g = scene.chunks[box.chunk];
      if (c && g) {
        const gr = g.group >= 0 ? scene.groups[g.group] : undefined;
        const k = gr ? gr.info.members.indexOf(box.chunk) : -1;
        const patch = (kind: ChunkKind, gbuf: WebGLBuffer | null, groupBuf: WebGLBuffer | null | undefined, range: [number, number] | undefined, stride: number, styleOffset: number, verts: number) => {
          if (!range || !range[1]) return;
          const buf = c[kind];
          const u = new Uint32Array(buf);
          const [start, n] = range;
          for (let i = start * verts; i < (start + n) * verts; i++) u[i * stride + styleOffset] = hidden;
          if (gbuf) {
            gl.bindBuffer(gl.ARRAY_BUFFER, gbuf);
            gl.bufferSubData(gl.ARRAY_BUFFER, start * verts * stride * 4, new Uint8Array(buf, start * verts * stride * 4, n * verts * stride * 4));
          }
          // 무리 버퍼: 같은 요소를 무리 원점 기준으로 다시 만들어 그 자리에 쓴다
          const at = gr?.at[kind];
          if (gr && groupBuf && at && k >= 0) {
            const part = new ArrayBuffer(n * elementBytes(kind));
            rebaseInto(part, 0, c, kind, start, n, gr);
            gl.bindBuffer(gl.ARRAY_BUFFER, groupBuf);
            gl.bufferSubData(gl.ARRAY_BUFFER, (at[k]! + start) * elementBytes(kind), part);
          }
        };
        patch('segs', g.segBuf, gr?.segBuf, box.seg, SEG_STRIDE, 5, 1);
        patch('tsegs', g.tsegBuf, gr?.tsegBuf, box.tseg, SEG_STRIDE, 5, 1);
        patch('tris', g.triBuf, gr?.triBuf, box.tri, TRI_STRIDE, 3, 3);
        patch('ttris', g.ttriBuf, gr?.ttriBuf, box.ttri, TRI_STRIDE, 3, 3);
      }
    }
    if (box.glyphs?.length && scene.instBuf) {
      const f = new Float32Array(src.glyphs.instances);
      gl.bindBuffer(gl.ARRAY_BUFFER, scene.instBuf);
      for (const k of box.glyphs) {
        f[k * GLYPH_STRIDE + 9] = hidden;
        gl.bufferSubData(gl.ARRAY_BUFFER, (k * GLYPH_STRIDE + 9) * 4, f.subarray(k * GLYPH_STRIDE + 9, k * GLYPH_STRIDE + 10));
      }
    }
  }

  dispose(scene: GpuScene | null): void {
    if (!scene) return;
    const gl = this.gl;
    for (const b of scene.buffers) gl.deleteBuffer(b);
    for (const v of scene.vaos) gl.deleteVertexArray(v);
    scene.buffers.length = 0;
    scene.vaos.length = 0;
    for (const c of scene.chunks) if (c.lazy) this.dropChunk(scene, c);
  }

  /** 무리에 든 묶음을 따로 올린다(크게 확대해 무리 일부만 보일 때) */
  private ensureChunk(scene: GpuScene, i: number): void {
    const g = scene.chunks[i]!;
    if (g.lazy) {
      g.lazy.used = this.frame;
      return;
    }
    const c = scene.src[i]!;
    const gl = this.gl;
    const lazy: NonNullable<GpuChunk['lazy']> = { bufs: [], vaos: [], bytes: 0, used: this.frame };
    const mk = (data: ArrayBuffer) => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      lazy.bufs.push(b);
      lazy.bytes += data.byteLength;
      return b;
    };
    if (c.segCount) g.seg = this.segVao((g.segBuf = mk(c.segs)), 0);
    if (c.triCount) g.tri = this.triVao((g.triBuf = mk(c.tris)));
    if (c.tsegCount) g.tseg = this.segVao((g.tsegBuf = mk(c.tsegs)), 0);
    if (c.ttriCount) g.ttri = this.triVao((g.ttriBuf = mk(c.ttris)));
    for (const v of [g.seg, g.tri, g.tseg, g.ttri]) if (v) lazy.vaos.push(v);
    g.lazy = lazy;
    scene.lazyBytes += lazy.bytes;
  }

  private dropChunk(scene: GpuScene, g: GpuChunk): void {
    if (!g.lazy) return;
    const gl = this.gl;
    for (const b of g.lazy.bufs) gl.deleteBuffer(b);
    for (const v of g.lazy.vaos) gl.deleteVertexArray(v);
    scene.lazyBytes -= g.lazy.bytes;
    g.lazy = null;
    g.seg = g.tri = g.tseg = g.ttri = null;
    g.segBuf = g.triBuf = g.tsegBuf = g.ttriBuf = null;
  }

  /** 따로 올린 묶음이 너무 많으면 이번 그림에 안 쓴 것부터(오래된 순) 내린다 */
  private trimChunks(scene: GpuScene): void {
    if (scene.lazyBytes <= LAZY_BUDGET) return;
    const old = scene.chunks.filter((c) => c.lazy && c.lazy.used !== this.frame).sort((a, b) => a.lazy!.used - b.lazy!.used);
    for (const c of old) {
      if (scene.lazyBytes <= LAZY_BUDGET * 0.75) break;
      this.dropChunk(scene, c);
    }
  }

  /** 그림 번호(따로 올린 묶음을 언제 썼는지) */
  private frame = 0;
  /** 마지막 draw의 그리기 호출 수(선·채우기 묶음, 측정용) */
  lastDraws = 0;
  /** 묶음 무리를 통째로 그려도 되면 그렇게(false면 늘 원래 묶음 — 견주기용) */
  mergeGroups = true;

  clear(rgb: [number, number, number]): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(rgb[0], rgb[1], rgb[2], 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  /** 화면 픽셀 좌표의 단색 다각형(삼각형 목록) */
  screenFill(tris: number[], rgba: [number, number, number, number], depth = 0.999): void {
    const gl = this.gl;
    gl.useProgram(this.screenProg);
    const u = this.u.get(this.screenProg)!;
    gl.uniform2f(u.u_size!, this.width, this.height);
    gl.uniform4f(u.u_color!, rgba[0], rgba[1], rgba[2], rgba[3]);
    gl.uniform1f(u.u_depth!, depth);
    gl.bindVertexArray(this.screenVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.screenBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(tris), gl.DYNAMIC_DRAW);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, tris.length / 2);
    gl.bindVertexArray(null);
  }

  /**
   * 다각형 자르기(스텐실): 화면 픽셀 삼각형 안에만 그린다. null이면 해제.
   * 가위 영역이 켜져 있으면 그 안의 스텐실만 지운다.
   */
  stencilClip(tris: number[] | null): void {
    const gl = this.gl;
    if (!tris) {
      gl.disable(gl.STENCIL_TEST);
      return;
    }
    gl.enable(gl.STENCIL_TEST);
    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.colorMask(false, false, false, false);
    gl.stencilFunc(gl.ALWAYS, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    this.screenFill(tris, [0, 0, 0, 1]);
    gl.colorMask(true, true, true, true);
    gl.stencilFunc(gl.EQUAL, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
  }

  /** 가위(scissor) 영역(화면 픽셀, 위쪽 원점) 설정·해제 */
  scissor(rect: [number, number, number, number] | null): void {
    const gl = this.gl;
    if (!rect) {
      gl.disable(gl.SCISSOR_TEST);
      return;
    }
    const [x, y, w, h] = rect;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(Math.floor(x), Math.floor(this.height - y - h), Math.ceil(w), Math.ceil(h));
  }

  clearDepth(): void {
    const gl = this.gl;
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
  }

  /**
   * 장면 그리기. view: 도면 → 픽셀(장치 픽셀). lwScale: 선가중치 mm → 픽셀
   * visibleRect: 화면에 보이는 도면 범위(묶음 걸러 내기), override: 색 덮어쓰기
   */
  draw(scene: GpuScene, view: ViewXf, opt: { lwScale: number; visible?: [number, number, number, number]; override?: [number, number, number, number]; minTextPx?: number; bg?: [number, number, number] }): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.width, this.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.styleTex);
    const ov = opt.override ?? [0, 0, 0, 0];
    const vis = opt.visible;
    const A = view.A;
    const seen = (c: GpuDraw) => !vis || !(c.maxX < vis[0] || c.minX > vis[2] || c.maxY < vis[1] || c.minY > vis[3]);
    // 이번에 그릴 단위: 무리를 통째로 그리거나(전체 보기 등), 무리의 보이는 묶음만(크게 확대)
    this.frame++;
    const units: GpuDraw[] = [];
    const pxPerUnit = Math.sqrt(Math.abs(A[0] * A[3] - A[1] * A[2]));
    for (const g of scene.groups) {
      if (!seen(g)) continue;
      if (this.mergeGroups && drawWhole(g.info, scene.groupSize, pxPerUnit, vis)) units.push(g);
      else
        for (const m of g.info.members) {
          const c = scene.chunks[m]!;
          if (!seen(c)) continue;
          this.ensureChunk(scene, m);
          units.push(c);
        }
    }
    for (const c of scene.chunks) if (c.group < 0 && seen(c)) units.push(c);
    this.trimChunks(scene);
    let draws = 0;
    const setM = (u: Uniforms, c: GpuDraw) => {
      const dx = c.ox - view.refX;
      const dy = c.oy - view.refY;
      gl.uniform2f(u.u_m0!, A[0], A[1]);
      gl.uniform2f(u.u_m1!, A[2], A[3]);
      gl.uniform2f(u.u_m2!, A[0] * dx + A[2] * dy + view.tx, A[1] * dx + A[3] * dy + view.ty);
    };
    const pass = (transparent: boolean) => {
      // 채우기
      gl.useProgram(this.triProg);
      let u = this.u.get(this.triProg)!;
      gl.uniform2f(u.u_size!, this.width, this.height);
      gl.uniform1i(u.u_styles!, 0);
      gl.uniform4f(u.u_override!, ov[0], ov[1], ov[2], ov[3]);
      for (const c of units) {
        const vao = transparent ? c.ttri : c.tri;
        const n = transparent ? c.ttriCount : c.triCount;
        if (!vao || !n) continue;
        setM(u, c);
        gl.bindVertexArray(vao);
        gl.drawArrays(gl.TRIANGLES, 0, n * 3);
        draws++;
      }
      // 래스터 이미지(그리기 순서 깊이)
      if (!opt.override || opt.override[3] === 0) this.drawImages(scene, view, transparent, opt.bg ?? [1, 1, 1]);
      // 선
      gl.useProgram(this.segProg);
      u = this.u.get(this.segProg)!;
      gl.uniform2f(u.u_size!, this.width, this.height);
      gl.uniform1i(u.u_styles!, 0);
      gl.uniform1f(u.u_lwScale!, opt.lwScale);
      gl.uniform4f(u.u_override!, ov[0], ov[1], ov[2], ov[3]);
      for (const c of units) {
        const vao = transparent ? c.tseg : c.seg;
        const n = transparent ? c.tsegCount : c.segCount;
        if (!vao || !n) continue;
        setM(u, c);
        gl.bindVertexArray(vao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
        draws++;
      }
      // 글리프
      this.drawGlyphs(scene, view, opt.lwScale, ov, transparent, opt.minTextPx ?? 0.6);
    };
    pass(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    pass(true);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    this.lastDraws = draws;
    this.drawXlines(scene, view, opt.lwScale, ov);
  }

  private drawGlyphs(scene: GpuScene, view: ViewXf, lwScale: number, ov: number[], transparent: boolean, minPx: number): void {
    const gl = this.gl;
    const gs = scene.glyphs;
    if (!gs.instanceCount || !scene.instBuf) return;
    const refHiX = Math.fround(view.refX);
    const refHiY = Math.fround(view.refY);
    const setCommon = (u: Uniforms) => {
      gl.uniform4f(u.u_A!, view.A[0], view.A[1], view.A[2], view.A[3]);
      gl.uniform2f(u.u_refHi!, refHiX, refHiY);
      gl.uniform2f(u.u_refLo!, view.refX - refHiX, view.refY - refHiY);
      gl.uniform2f(u.u_t!, view.tx, view.ty);
      gl.uniform2f(u.u_size!, this.width, this.height);
      gl.uniform1i(u.u_styles!, 0);
      gl.uniform4f(u.u_override!, ov[0]!, ov[1]!, ov[2]!, ov[3]!);
      gl.uniform1f(u.u_minPx!, minPx);
    };
    if (scene.glyphFillVao) {
      gl.useProgram(this.gFillProg);
      const u = this.u.get(this.gFillProg)!;
      setCommon(u);
      gl.bindVertexArray(scene.glyphFillVao);
      for (const r of gs.runs) {
        if (r.transparent !== transparent) continue;
        const g = gs.glyphs[r.glyph]!;
        if (g.kind !== 0) continue;
        this.bindInstance(scene.instBuf, r.start);
        gl.drawArraysInstanced(gl.TRIANGLES, g.first, g.count, r.count);
      }
    }
    if (scene.glyphStrokeVao) {
      gl.useProgram(this.gStrokeProg);
      const u = this.u.get(this.gStrokeProg)!;
      setCommon(u);
      gl.uniform1f(u.u_lwScale!, lwScale);
      gl.bindVertexArray(scene.glyphStrokeVao);
      for (const r of gs.runs) {
        if (r.transparent !== transparent) continue;
        const g = gs.glyphs[r.glyph]!;
        if (g.kind !== 1) continue;
        this.bindInstance(scene.instBuf, r.start);
        gl.drawArraysInstanced(gl.TRIANGLES, g.first * 6, g.count * 6, r.count);
      }
    }
    gl.bindVertexArray(null);
  }

  /** 무한선: 화면 범위로 잘라 그린다 */
  private drawXlines(scene: GpuScene, view: ViewXf, lwScale: number, ov: number[]): void {
    const xl = scene.xlines;
    if (!xl.length) return;
    const gl = this.gl;
    // 화면 대각선보다 넉넉한 길이(도면 단위)
    const det = Math.abs(view.A[0] * view.A[3] - view.A[1] * view.A[2]);
    const pxPerUnit = Math.sqrt(det) || 1;
    // 화면 중심의 도면 좌표
    const inv = 1 / (view.A[0] * view.A[3] - view.A[1] * view.A[2]);
    const sx = this.width / 2 - view.tx;
    const sy = this.height / 2 - view.ty;
    const cx = view.refX + (view.A[3] * sx - view.A[2] * sy) * inv;
    const cy = view.refY + (-view.A[1] * sx + view.A[0] * sy) * inv;
    const R = (Math.hypot(this.width, this.height) / pxPerUnit) * 2;
    const n = xl.length / 7;
    const data = new ArrayBuffer(n * SEG_STRIDE * 4);
    const f = new Float32Array(data);
    const u32 = new Uint32Array(data);
    for (let i = 0; i < n; i++) {
      const [x, y, dx, dy, ray, depth, style] = xl.slice(i * 7, i * 7 + 7) as [number, number, number, number, number, number, number];
      // 화면 중심에 가장 가까운 선 위의 점
      const t = (cx - x) * dx + (cy - y) * dy;
      let t0 = t - R;
      const t1 = t + R;
      if (ray) t0 = Math.max(0, t0);
      const o = i * SEG_STRIDE;
      f[o] = x + dx * t0 - view.refX;
      f[o + 1] = y + dy * t0 - view.refY;
      f[o + 2] = x + dx * Math.max(t0, t1) - view.refX;
      f[o + 3] = y + dy * Math.max(t0, t1) - view.refY;
      f[o + 4] = depth;
      u32[o + 5] = style;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.xlineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.useProgram(this.segProg);
    const u = this.u.get(this.segProg)!;
    gl.uniform2f(u.u_size!, this.width, this.height);
    gl.uniform1i(u.u_styles!, 0);
    gl.uniform1f(u.u_lwScale!, lwScale);
    gl.uniform4f(u.u_override!, ov[0]!, ov[1]!, ov[2]!, ov[3]!);
    gl.uniform2f(u.u_m0!, view.A[0], view.A[1]);
    gl.uniform2f(u.u_m1!, view.A[2], view.A[3]);
    gl.uniform2f(u.u_m2!, view.tx, view.ty);
    gl.enable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.xlineVao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
    gl.bindVertexArray(null);
  }
}
