/**
 * 표시 목록: 화면에 그릴 선분과 삼각형을 공간 격자 묶음(chunk)으로 모은다.
 *
 * - 좌표는 묶음 원점 기준 float32다. 묶음은 객체 크기에 맞춘 격자 칸이라 원점이 가깝고,
 *   큰 좌표(예: 500000, 300000)에서도 확대했을 때 떨리지 않는다.
 * - depth = 그리기 순서(나중 객체일수록 작다). 채우기와 선을 따로 그려도 겹침 순서가 맞는다.
 * - 선분 1개 = [x0, y0, x1, y1, depth, style] 24바이트, 삼각형 정점 = [x, y, depth, style] 16바이트.
 */

export const SEG_STRIDE = 6; // 4바이트 단위
/** 묶은 상자 하나의 색인 수(PackedBoxes.ranges) */
const PACK = 11;
export const TRI_STRIDE = 4;

export class GrowBuffer {
  buf: ArrayBuffer;
  f32: Float32Array;
  u32: Uint32Array;
  /** 4바이트 단위 길이 */
  length = 0;

  constructor(initial = 1024) {
    this.buf = new ArrayBuffer(initial * 4);
    this.f32 = new Float32Array(this.buf);
    this.u32 = new Uint32Array(this.buf);
  }

  reserve(n: number): void {
    if (this.length + n <= this.f32.length) return;
    let cap = this.f32.length * 2;
    while (cap < this.length + n) cap *= 2;
    const nb = resized(this.buf, cap * 4, this.length * 4);
    this.buf = nb;
    this.f32 = new Float32Array(nb);
    this.u32 = new Uint32Array(nb);
  }

  /** 쓴 만큼으로 줄인 버퍼(전송용). 이 GrowBuffer는 더 쓰지 않는다 */
  take(): ArrayBuffer {
    const n = this.length * 4;
    return resized(this.buf, n, n);
  }
}

/**
 * 버퍼 크기 바꾸기(앞 used 바이트를 옮긴다). ArrayBuffer.transfer(ES2024)가 있으면 그것으로 — 옛 버퍼를 기다리지 않고 바로 놓아 주어,
 * 수백 MB의 표시 목록을 만드는 동안 쓰레기 버퍼가 쌓여 V8이 바깥 메모리 때문에 큰 GC를 자주 하는 일을 줄인다.
 */
function resized(buf: ArrayBuffer, bytes: number, used: number): ArrayBuffer {
  const tr = (buf as ArrayBuffer & { transfer?: (len: number) => ArrayBuffer }).transfer;
  if (typeof tr === 'function') return tr.call(buf, bytes);
  if (bytes <= buf.byteLength) return buf.slice(0, bytes);
  const nb = new ArrayBuffer(bytes);
  new Uint8Array(nb).set(new Uint8Array(buf, 0, used));
  return nb;
}

export interface ChunkData {
  key: string;
  ox: number;
  oy: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** 선분 [x0, y0, x1, y1, depth, style]×n */
  segs: ArrayBuffer;
  segCount: number;
  /** 삼각형 정점 [x, y, depth, style]×(3n) */
  tris: ArrayBuffer;
  triCount: number;
  /** 투명 스타일 */
  tsegs: ArrayBuffer;
  tsegCount: number;
  ttris: ArrayBuffer;
  ttriCount: number;
}

export interface EntityBox {
  handle: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** 이 객체의 그림이 든 묶음 번호와 범위([시작, 개수]) — 편집할 때 숨기는 데 쓴다. 그림이 없는 범위(개수 0)는 두지 않는다 */
  chunk?: number;
  seg?: [number, number];
  tseg?: [number, number];
  tri?: [number, number];
  ttri?: [number, number];
  /** 글리프 인스턴스 번호 */
  glyphs?: number[];
}

/**
 * 글리프 인스턴스: 같은 글자 모양은 한 번만 저장하고 글자마다 변환만 둔다.
 * 인스턴스 = [a, b, c, d, eHi, eLo, fHi, fLo, depth, style, 0, 0] (float32 12개)
 * e·f(이동)는 큰 좌표에서도 정밀하도록 hi + lo 두 float로 나눈다.
 */
export const GLYPH_STRIDE = 12;

export interface GlyphSet {
  /** 윤곽 글리프 삼각형 정점 [x, y, …](글리프 단위) */
  fillVerts: Float32Array;
  /** 단선 글리프 선분 [x0, y0, x1, y1, …] */
  strokeSegs: Float32Array;
  /** 글리프마다 범위: kind 0 = 윤곽(fillVerts 정점 범위), 1 = 단선(strokeSegs 선분 범위) */
  glyphs: { kind: 0 | 1; first: number; count: number }[];
  /** 글리프 번호 순으로 모은 인스턴스(불투명, 투명) */
  instances: ArrayBuffer;
  /** 글리프마다 [시작, 개수](instances 안) */
  runs: { glyph: number; start: number; count: number; transparent: boolean }[];
  instanceCount: number;
}

export interface DisplayList {
  chunks: ChunkData[];
  glyphs: GlyphSet;
  /** 최상위 객체마다 범위(선택·확대에 쓴다) */
  entities: EntityBox[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** 무한선(XLINE·RAY): 화면마다 잘라 그린다 [x, y, dx, dy, ray(0|1), depth, style] */
  xlines: number[];
  /** 무한선마다 객체 핸들 */
  xlineHandles: string[];
  /** 래스터 이미지(파일이 연결됐을 때만 그린다) */
  images?: ImageDraw[];
  /** 외부 참조 인스턴스(참조 파일을 연결했을 때 그 모형 장면을 이 변환으로 그린다) */
  xrefs?: XrefDraw[];
  /** 선종류 무늬(점선 등)를 입힌 객체가 있으면 참(PSLTSCALE용 뷰포트 장면이 필요한지) */
  dashed?: boolean;
  /** 형식 배열로 묶은 객체 상자(finish(true)일 때만, entities는 비어 있다 — 워커가 그대로 옮긴다) */
  packed?: PackedBoxes;
}

/** 외부 참조 하나: 참조 모형 좌표 → 이 공간 좌표 2D 아핀 [a, b, c, d, e, f] */
export interface XrefDraw {
  /** 외부 참조 블록 이름(대문자) */
  key: string;
  handle: string;
  m: [number, number, number, number, number, number];
  /** XCLIP 경계(이 공간 좌표) */
  clip?: number[];
  clipInverted?: boolean;
  /** 블록 참조의 스타일(도면층 끄기·동결로 숨길 때) */
  style: number;
}

/** 래스터 이미지 하나: 자르기 경계를 삼각형으로 나눈 정점 [x - ox, y - oy, u, v, …] */
export interface ImageDraw {
  /** 이미지 파일 열쇠(IMAGEDEF 파일 이름, 소문자) */
  key: string;
  handle: string;
  ox: number;
  oy: number;
  verts: Float32Array;
  depth: number;
  style: number;
  /** 0~100 */
  brightness: number;
  contrast: number;
  fade: number;
  transparent: boolean;
  /** 회색조로(PDF 언더레이 단색) */
  mono?: boolean;
  /** 어두운 배경이면 무채색을 뒤집는다(PDF 언더레이 배경에 맞춤) */
  adjust?: boolean;
}

class ChunkBuilder {
  readonly segs = new GrowBuffer(4096);
  // 삼각형(채우기)은 드물어 작게 시작한다(묶음이 수만 개일 때 빈 자리가 수백 MB가 되지 않게)
  readonly tris = new GrowBuffer(256);
  readonly tsegs = new GrowBuffer(64);
  readonly ttris = new GrowBuffer(64);
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;
  /** 미리 보기 조각으로 이미 보낸 길이(4바이트 단위): segs, tris, tsegs, ttris */
  readonly sent = new Int32Array(4);

  constructor(
    readonly key: string,
    readonly ox: number,
    readonly oy: number,
    /** 이 표시 목록에서 만든 순서 */
    readonly index: number,
    /** 객체 크기 단계(객체 크기 ≤ 2^level) */
    readonly level = 0,
  ) {}

  get size(): number {
    return this.segs.length / SEG_STRIDE + this.tris.length / TRI_STRIDE;
  }

  data(): ChunkData {
    return {
      key: this.key,
      ox: this.ox,
      oy: this.oy,
      minX: this.minX,
      minY: this.minY,
      maxX: this.maxX,
      maxY: this.maxY,
      segs: this.segs.take(),
      segCount: this.segs.length / SEG_STRIDE,
      tris: this.tris.take(),
      triCount: this.tris.length / TRI_STRIDE / 3,
      tsegs: this.tsegs.take(),
      tsegCount: this.tsegs.length / SEG_STRIDE,
      ttris: this.ttris.take(),
      ttriCount: this.ttris.length / TRI_STRIDE / 3,
    };
  }
}

const MAX_CHUNK = 1 << 20;

/** 미리 보기 화면(점진 빌드 조각에서 보이지 않을 것을 빼는 데 쓴다) */
export interface SnapshotView {
  /** 화면에 보일 수 있는 범위(도면 좌표) */
  rect?: readonly [number, number, number, number];
  /** 화면 픽셀 / 도면 단위 */
  pxPerUnit?: number;
  /** 이보다 작은 글자(픽셀)는 그리지 않는다(렌더러 기본 0.6) */
  minTextPx?: number;
}

/**
 * 객체(같은 깊이가 이어진 요소)마다 첫 요소만: 반 픽셀보다 작은 객체는 선분 하나로도 같은 한 점으로 보인다.
 * out이 없으면 개수(4바이트 단위)만 센다. depthAt: 요소 안 깊이 칸, stride: 요소 하나의 4바이트 칸 수.
 */
function firstPerEntity(g: GrowBuffer, from: number, stride: number, depthAt: number, out: ArrayBuffer | null, at: number, dx: number, dy: number): number {
  const f = g.f32;
  const u = g.u32;
  const end = g.length;
  let last = NaN;
  let w = 0;
  const dst = out ? new Float32Array(out) : null;
  const dstU = out ? new Uint32Array(out) : null;
  for (let e = from; e < end; e += stride) {
    const d = f[e + depthAt]!;
    if (d === last) continue;
    last = d;
    if (dst && dstU) {
      const o = at + w;
      for (let q = 0; q < stride; q++) dstU[o + q] = u[e + q]!;
      if (stride === SEG_STRIDE) {
        dst[o] = f[e]! + dx;
        dst[o + 1] = f[e + 1]! + dy;
        dst[o + 2] = f[e + 2]! + dx;
        dst[o + 3] = f[e + 3]! + dy;
      } else
        for (let v = 0; v < stride; v += TRI_STRIDE) {
          dst[o + v] = f[e + v]! + dx;
          dst[o + v + 1] = f[e + v + 1]! + dy;
        }
    }
    w += stride;
  }
  return w;
}

/**
 * 객체 하나의 그림을 임시로 모았다가(월드 좌표, double) 범위가 정해지면 알맞은 묶음에 넣는다.
 * 수백만 객체에서도 객체마다 작은 JS 배열·객체를 만들지 않게 임시 그림과 글리프 인스턴스는 형식 배열에 둔다.
 */
export class DisplayListBuilder {
  /** 묶음 열쇠 → live 자리(level마다 ix·iy 수 열쇠, 아주 큰 칸 번호는 문자열 열쇠) */
  private readonly levelSlots = new Map<number, Map<number, number>>();
  private readonly strSlots = new Map<string, number>();
  /** 열쇠마다 지금 채우는 묶음(열쇠를 처음 만든 순서) */
  private readonly live: ChunkBuilder[] = [];
  private readonly done: ChunkBuilder[] = [];
  private chunkCount = 0;
  /**
   * 객체 상자(형식 배열에 모은다 — 수백만 객체에도 상자 객체를 만들지 않는다): 핸들, [minX, minY, maxX, maxY],
   * [묶음(-1 없음), seg 시작, 개수, tseg 시작, 개수, tri 시작, 개수, ttri 시작, 개수, 글리프 시작, 개수](PackedBoxes와 같은 꼴)
   */
  private readonly boxHandles: string[] = [];
  private boxB = new Float64Array(4 * 1024);
  private boxR = new Int32Array(PACK * 1024);
  private boxN = 0;
  readonly xlines: number[] = [];
  readonly xlineHandles: string[] = [];
  // 객체 하나의 임시 그림(월드 좌표, double): 선분 [x0, y0, x1, y1, depth], 삼각형 [x, y, depth]×3
  private segX = new Float64Array(5 * 256);
  private segS = new Uint32Array(256);
  private segN = 0;
  private triX = new Float64Array(9 * 64);
  private triS = new Uint32Array(64);
  private triN = 0;
  /** 스타일별 투명 여부(0 모름, 1 불투명, 2 투명) — 한 번 만드는 동안 바뀌지 않는다 */
  private transp = new Uint8Array(256);
  private depth = 0;
  // 글리프
  private readonly glyphIds = new Map<object, number>();
  private readonly glyphDefs: { kind: 0 | 1; data: Float32Array }[] = [];
  /** 글리프 인스턴스(들어온 순서): [a, b, c, d, e, f, depth, style](double), 글리프 번호, 투명, 주인 상자 번호 */
  private instF = new Float64Array(8 * 1024);
  private instG = new Int32Array(1024);
  private instT = new Uint8Array(1024);
  private instO = new Int32Array(1024);
  private instN = 0;
  /** 객체가 끝나 주인이 정해진 인스턴스 수 */
  private instDone = 0;
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;
  totalMinX = Infinity;
  totalMinY = Infinity;
  totalMaxX = -Infinity;
  totalMaxY = -Infinity;

  constructor(private readonly transparent: (style: number) => boolean) {}

  setDepth(d: number): void {
    this.depth = d;
  }

  private grow(x: number, y: number): void {
    if (x < this.minX) this.minX = x;
    if (x > this.maxX) this.maxX = x;
    if (y < this.minY) this.minY = y;
    if (y > this.maxY) this.maxY = y;
  }

  private isTransparent(style: number): boolean {
    let t = this.transp;
    if (style >= t.length) {
      let n = t.length * 2;
      while (n <= style) n *= 2;
      const nt = new Uint8Array(n);
      nt.set(t);
      this.transp = t = nt;
    }
    let v = t[style]!;
    if (v === 0) t[style] = v = this.transparent(style) ? 2 : 1;
    return v === 2;
  }

  // -------------------------------------------------------------------------
  // 자르기(XCLIP): 블록 참조를 펼치는 동안 경계 다각형 안(반전이면 밖)만 남긴다
  // -------------------------------------------------------------------------

  private clips: Clip[] = [];

  /** 월드 좌표 다각형 [x, y, …]으로 자르기 시작 */
  pushClip(poly: number[], inverted = false): void {
    if (poly.length < 6) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < poly.length; i += 2) {
      minX = Math.min(minX, poly[i]!);
      maxX = Math.max(maxX, poly[i]!);
      minY = Math.min(minY, poly[i + 1]!);
      maxY = Math.max(maxY, poly[i + 1]!);
    }
    this.clips.push({ poly: ccw(poly), inverted, convex: isConvex(poly), bbox: [minX, minY, maxX, maxY] });
  }

  popClip(): void {
    this.clips.pop();
  }

  private inside(x: number, y: number): boolean {
    for (const c of this.clips) if (pointInPolygon(x, y, c.poly) === c.inverted) return false;
    return true;
  }

  segment(x0: number, y0: number, x1: number, y1: number, style: number): void {
    if (!Number.isFinite(x0 + y0 + x1 + y1)) return;
    if (this.clips.length) {
      // 모든 경계와의 교점으로 나눠 가운데가 안에 있는 조각만
      const ts = [0, 1];
      for (const c of this.clips) segmentPolygonParams(x0, y0, x1, y1, c.poly, ts);
      ts.sort((a, b) => a - b);
      const dx = x1 - x0;
      const dy = y1 - y0;
      let open = -1;
      for (let i = 0; i + 1 < ts.length; i++) {
        const ta = ts[i]!;
        const tb = ts[i + 1]!;
        if (tb - ta < 1e-12) continue;
        const tm = (ta + tb) / 2;
        const ins = this.inside(x0 + dx * tm, y0 + dy * tm);
        if (ins && open < 0) open = ta;
        if (!ins && open >= 0) {
          this.rawSegment(x0 + dx * open, y0 + dy * open, x0 + dx * ta, y0 + dy * ta, style);
          open = -1;
        }
      }
      if (open >= 0) this.rawSegment(x0 + dx * open, y0 + dy * open, x1, y1, style);
      // 점(길이 0)
      if (dx === 0 && dy === 0 && this.inside(x0, y0)) this.rawSegment(x0, y0, x1, y1, style);
      return;
    }
    this.rawSegment(x0, y0, x1, y1, style);
  }

  private rawSegment(x0: number, y0: number, x1: number, y1: number, style: number): void {
    const n = this.segN;
    if (n === this.segS.length) {
      const x = new Float64Array(this.segX.length * 2);
      x.set(this.segX);
      this.segX = x;
      const s = new Uint32Array(this.segS.length * 2);
      s.set(this.segS);
      this.segS = s;
    }
    const sx = this.segX;
    const k = n * 5;
    sx[k] = x0;
    sx[k + 1] = y0;
    sx[k + 2] = x1;
    sx[k + 3] = y1;
    sx[k + 4] = this.depth;
    this.segS[n] = style;
    this.segN = n + 1;
    this.grow(x0, y0);
    this.grow(x1, y1);
  }

  /** 꺾은선 [x, y, …] */
  polyline(pts: ArrayLike<number>, closed: boolean, style: number): void {
    const n = pts.length >> 1;
    for (let i = 0; i + 1 < n; i++) this.segment(pts[i * 2]!, pts[i * 2 + 1]!, pts[i * 2 + 2]!, pts[i * 2 + 3]!, style);
    if (closed && n > 2) this.segment(pts[(n - 1) * 2]!, pts[(n - 1) * 2 + 1]!, pts[0]!, pts[1]!, style);
  }

  triangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, style: number): void {
    if (!Number.isFinite(x0 + y0 + x1 + y1 + x2 + y2)) return;
    if (this.clips.length) {
      let polys: number[][] = [[x0, y0, x1, y1, x2, y2]];
      for (const c of this.clips) {
        if (c.convex && !c.inverted) polys = polys.map((pg) => clipConvex(pg, c.poly)).filter((pg) => pg.length >= 6);
        else
          polys = polys.filter((pg) => {
            let cx = 0;
            let cy = 0;
            const n = pg.length / 2;
            for (let i = 0; i < pg.length; i += 2) {
              cx += pg[i]!;
              cy += pg[i + 1]!;
            }
            return pointInPolygon(cx / n, cy / n, c.poly) !== c.inverted;
          });
      }
      // 부채꼴로 다시 나눈다: (0, i, i+1)
      for (const pg of polys) for (let i = 1; i + 1 < pg.length / 2; i++) this.rawTriangle(pg[0]!, pg[1]!, pg[i * 2]!, pg[i * 2 + 1]!, pg[i * 2 + 2]!, pg[i * 2 + 3]!, style);
      return;
    }
    this.rawTriangle(x0, y0, x1, y1, x2, y2, style);
  }

  private rawTriangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, style: number): void {
    const n = this.triN;
    if (n === this.triS.length) {
      const x = new Float64Array(this.triX.length * 2);
      x.set(this.triX);
      this.triX = x;
      const s = new Uint32Array(this.triS.length * 2);
      s.set(this.triS);
      this.triS = s;
    }
    const d = this.depth;
    const tx = this.triX;
    const k = n * 9;
    tx[k] = x0;
    tx[k + 1] = y0;
    tx[k + 2] = d;
    tx[k + 3] = x1;
    tx[k + 4] = y1;
    tx[k + 5] = d;
    tx[k + 6] = x2;
    tx[k + 7] = y2;
    tx[k + 8] = d;
    this.triS[n] = style;
    this.triN = n + 1;
    this.grow(x0, y0);
    this.grow(x1, y1);
    this.grow(x2, y2);
  }

  /** 삼각형 목록 [x0,y0,x1,y1,x2,y2,…] */
  triangles(xy: ArrayLike<number>, style: number): void {
    for (let i = 0; i + 5 < xy.length; i += 6) this.triangle(xy[i]!, xy[i + 1]!, xy[i + 2]!, xy[i + 3]!, xy[i + 4]!, xy[i + 5]!, style);
  }

  /**
   * 글리프 하나. key = 글리프 모양 객체(같은 모양이면 같은 객체), data = 삼각형 정점 또는 선분,
   * m = 글리프 → 월드 2D 아핀, bbox = 글리프 범위.
   */
  glyph(key: object, kind: 0 | 1, data: Float32Array, m: readonly number[], bbox: readonly [number, number, number, number], style: number): void {
    let g = this.glyphIds.get(key);
    if (g === undefined) {
      g = this.glyphDefs.length;
      this.glyphDefs.push({ kind, data });
      this.glyphIds.set(key, g);
    }
    const a = m[0]!;
    const b = m[1]!;
    const c = m[2]!;
    const d = m[3]!;
    const e = m[4]!;
    const f = m[5]!;
    if (!Number.isFinite(a + b + c + d + e + f)) return;
    if (this.clips.length) {
      // 글자는 가운데가 경계 안에 있을 때만
      const mx = (bbox[0] + bbox[2]) / 2;
      const my = (bbox[1] + bbox[3]) / 2;
      if (!this.inside(a * mx + c * my + e, b * mx + d * my + f)) return;
    }
    const n = this.instN;
    if (n === this.instG.length) {
      // 두 배로(옛 버퍼는 resized가 바로 놓아 준다)
      const cap = n * 2;
      this.instF = new Float64Array(resized(this.instF.buffer as ArrayBuffer, cap * 64, n * 64));
      this.instG = new Int32Array(resized(this.instG.buffer as ArrayBuffer, cap * 4, n * 4));
      this.instT = new Uint8Array(resized(this.instT.buffer as ArrayBuffer, cap, n));
      this.instO = new Int32Array(resized(this.instO.buffer as ArrayBuffer, cap * 4, n * 4));
    }
    const F = this.instF;
    const o = n * 8;
    F[o] = a;
    F[o + 1] = b;
    F[o + 2] = c;
    F[o + 3] = d;
    F[o + 4] = e;
    F[o + 5] = f;
    F[o + 6] = this.depth;
    F[o + 7] = style;
    this.instG[n] = g;
    this.instT[n] = this.isTransparent(style) ? 1 : 0;
    this.instN = n + 1;
    const x0 = bbox[0];
    const y0 = bbox[1];
    const x1 = bbox[2];
    const y1 = bbox[3];
    this.grow(a * x0 + c * y0 + e, b * x0 + d * y0 + f);
    this.grow(a * x1 + c * y0 + e, b * x1 + d * y0 + f);
    this.grow(a * x1 + c * y1 + e, b * x1 + d * y1 + f);
    this.grow(a * x0 + c * y1 + e, b * x0 + d * y1 + f);
  }

  private images: ImageDraw[] = [];
  /** 선종류 무늬를 입혔는지 */
  dashed = false;

  /** 래스터 이미지(월드 좌표 [x, y, u, v, …] 삼각형) */
  image(key: string, tris: number[], style: number, opt: { brightness: number; contrast: number; fade: number; transparent: boolean; mono?: boolean; adjust?: boolean }): void {
    if (tris.length < 12) return;
    const ox = tris[0]!;
    const oy = tris[1]!;
    const v = new Float32Array(tris.length);
    for (let i = 0; i + 3 < tris.length; i += 4) {
      v[i] = tris[i]! - ox;
      v[i + 1] = tris[i + 1]! - oy;
      v[i + 2] = tris[i + 2]!;
      v[i + 3] = tris[i + 3]!;
      this.grow(tris[i]!, tris[i + 1]!);
    }
    this.images.push({ key, handle: '', ox, oy, verts: v, depth: this.depth, style, ...opt });
    this.pendingImages.push(this.images[this.images.length - 1]!);
  }

  private pendingImages: ImageDraw[] = [];
  private xrefs: XrefDraw[] = [];
  private pendingXrefs: XrefDraw[] = [];

  /** 외부 참조 인스턴스. 범위는 참조 쪽 범위를 모르므로 삽입점만 넣는다 */
  xref(key: string, m: XrefDraw['m'], style: number, clip?: { poly: number[]; inverted: boolean }): void {
    const d: XrefDraw = { key, handle: '', m, style, clip: clip?.poly, clipInverted: clip?.inverted };
    this.xrefs.push(d);
    this.pendingXrefs.push(d);
    this.grow(m[4], m[5]);
  }

  xline(x: number, y: number, dx: number, dy: number, ray: boolean, style: number): void {
    if (this.clips.length) {
      // 자르기 안의 구성선·광선: 경계 범위를 넉넉히 덮는 선분으로 바꿔 자른다
      const bb = this.clips[0]!.bbox;
      const L = Math.hypot(bb[2] - bb[0], bb[3] - bb[1]) + Math.hypot(x - bb[0], y - bb[1]) + 1;
      const n = Math.hypot(dx, dy) || 1;
      const ux = dx / n;
      const uy = dy / n;
      this.segment(ray ? x : x - ux * L, ray ? y : y - uy * L, x + ux * L, y + uy * L, style);
      return;
    }
    this.xlines.push(x, y, dx, dy, ray ? 1 : 0, this.depth, style);
  }

  /** 지금 객체의 글리프 인스턴스에 주인 상자(번호, 없으면 -1)를 정한다 */
  private ownInstances(box: number): void {
    for (let i = this.instDone; i < this.instN; i++) this.instO[i] = box;
    this.instDone = this.instN;
  }

  /** 객체 크기 단계와 칸에 맞는 묶음(가득 찼으면 새 묶음) */
  private chunkFor(level: number, ix: number, iy: number, cell: number): ChunkBuilder {
    const LIM = 33554432; // 2^25: ix·2^26 + iy가 double로 정확하다
    let slot: number | undefined;
    let lm: Map<number, number> | undefined;
    let nk = 0;
    let sk = '';
    if (ix > -LIM && ix < LIM && iy > -LIM && iy < LIM) {
      lm = this.levelSlots.get(level);
      if (!lm) this.levelSlots.set(level, (lm = new Map()));
      nk = ix * 67108864 + iy;
      slot = lm.get(nk);
    } else {
      sk = `${level}:${ix}:${iy}`;
      slot = this.strSlots.get(sk);
    }
    let ch = slot === undefined ? undefined : this.live[slot];
    if (!ch || ch.size > MAX_CHUNK) {
      if (ch) this.done.push(ch);
      ch = new ChunkBuilder(`${level}:${ix}:${iy}`, (ix + 0.5) * cell, (iy + 0.5) * cell, this.chunkCount++, level);
      if (slot === undefined) {
        slot = this.live.length;
        this.live.push(ch);
        if (lm) lm.set(nk, slot);
        else this.strSlots.set(sk, slot);
      } else this.live[slot] = ch;
    }
    return ch;
  }

  /** 지금까지 모은 그림을 한 객체로 마감한다. */
  endEntity(handle: string): void {
    // 이미지·외부 참조만 있는 객체도 범위를 남긴다
    const hadOther = this.pendingImages.length > 0 || this.pendingXrefs.length > 0;
    if (this.pendingImages.length) {
      for (const im of this.pendingImages) im.handle = handle;
      this.pendingImages = [];
    }
    if (this.pendingXrefs.length) {
      for (const x of this.pendingXrefs) x.handle = handle;
      this.pendingXrefs = [];
    }
    while (this.xlineHandles.length < this.xlines.length / 7) this.xlineHandles.push(handle);
    const hadGlyphs = this.instN > this.instDone;
    const ns = this.segN;
    const nt = this.triN;
    if (ns === 0 && nt === 0) {
      this.ownInstances(hadGlyphs || hadOther ? this.recordEntity(handle) : -1);
      this.resetEntity();
      return;
    }
    const w = this.maxX - this.minX;
    const h = this.maxY - this.minY;
    const size = Math.max(w, h, 1e-9);
    const level = Math.ceil(Math.log2(size));
    const cell = Math.pow(2, level + 8);
    const cx = (this.minX + this.maxX) / 2;
    const cy = (this.minY + this.maxY) / 2;
    const ch = this.chunkFor(level, Math.floor(cx / cell), Math.floor(cy / cell), cell);
    const ox = ch.ox;
    const oy = ch.oy;
    const seg0 = ch.segs.length / SEG_STRIDE;
    const tseg0 = ch.tsegs.length / SEG_STRIDE;
    const tri0 = ch.tris.length / TRI_STRIDE / 3;
    const ttri0 = ch.ttris.length / TRI_STRIDE / 3;
    // 선분: 버퍼를 한 번에 늘린 뒤 옮긴다
    if (ns) {
      const sx = this.segX;
      const ss = this.segS;
      let nTr = 0;
      for (let i = 0; i < ns; i++) if (this.isTransparent(ss[i]!)) nTr++;
      if (ns > nTr) ch.segs.reserve((ns - nTr) * SEG_STRIDE);
      if (nTr) ch.tsegs.reserve(nTr * SEG_STRIDE);
      for (let i = 0; i < ns; i++) {
        const style = ss[i]!;
        const b = nTr && this.isTransparent(style) ? ch.tsegs : ch.segs;
        const f32 = b.f32;
        const o = b.length;
        const k = i * 5;
        f32[o] = sx[k]! - ox;
        f32[o + 1] = sx[k + 1]! - oy;
        f32[o + 2] = sx[k + 2]! - ox;
        f32[o + 3] = sx[k + 3]! - oy;
        f32[o + 4] = sx[k + 4]!;
        b.u32[o + 5] = style;
        b.length = o + SEG_STRIDE;
      }
    }
    if (nt) {
      const tx = this.triX;
      const ts = this.triS;
      let nTr = 0;
      for (let i = 0; i < nt; i++) if (this.isTransparent(ts[i]!)) nTr++;
      if (nt > nTr) ch.tris.reserve((nt - nTr) * TRI_STRIDE * 3);
      if (nTr) ch.ttris.reserve(nTr * TRI_STRIDE * 3);
      for (let i = 0; i < nt; i++) {
        const style = ts[i]!;
        const b = nTr && this.isTransparent(style) ? ch.ttris : ch.tris;
        const f32 = b.f32;
        const u32 = b.u32;
        for (let v = 0; v < 3; v++) {
          const o = b.length;
          const k = i * 9 + v * 3;
          f32[o] = tx[k]! - ox;
          f32[o + 1] = tx[k + 1]! - oy;
          f32[o + 2] = tx[k + 2]!;
          u32[o + 3] = style;
          b.length = o + TRI_STRIDE;
        }
      }
    }
    if (this.minX < ch.minX) ch.minX = this.minX;
    if (this.minY < ch.minY) ch.minY = this.minY;
    if (this.maxX > ch.maxX) ch.maxX = this.maxX;
    if (this.maxY > ch.maxY) ch.maxY = this.maxY;
    const box = this.recordEntity(handle);
    if (box >= 0) {
      // 개수 0인 범위는 상자를 풀 때 두지 않는다
      const R = this.boxR;
      const r = box * PACK;
      // 마칠 때 묶음 번호(만든 순서 → 목록 순서)로 바꾼다
      R[r] = ch.index;
      R[r + 1] = seg0;
      R[r + 2] = ch.segs.length / SEG_STRIDE - seg0;
      R[r + 3] = tseg0;
      R[r + 4] = ch.tsegs.length / SEG_STRIDE - tseg0;
      R[r + 5] = tri0;
      R[r + 6] = ch.tris.length / TRI_STRIDE / 3 - tri0;
      R[r + 7] = ttri0;
      R[r + 8] = ch.ttris.length / TRI_STRIDE / 3 - ttri0;
    }
    this.ownInstances(box);
    this.resetEntity();
  }

  /** 지금 객체의 상자를 남기고 번호를 돌려준다(범위가 없거나 핸들이 없으면 -1) */
  private recordEntity(handle: string): number {
    if (!(this.minX <= this.maxX)) return -1;
    if (this.minX < this.totalMinX) this.totalMinX = this.minX;
    if (this.minY < this.totalMinY) this.totalMinY = this.minY;
    if (this.maxX > this.totalMaxX) this.totalMaxX = this.maxX;
    if (this.maxY > this.totalMaxY) this.totalMaxY = this.maxY;
    if (!handle) return -1;
    const i = this.boxN;
    if ((i + 1) * 4 > this.boxB.length) {
      // 두 배로(늘린 자리는 0)
      this.boxB = new Float64Array(resized(this.boxB.buffer as ArrayBuffer, this.boxB.byteLength * 2, i * 32));
      this.boxR = new Int32Array(resized(this.boxR.buffer as ArrayBuffer, this.boxR.byteLength * 2, i * PACK * 4));
    }
    const B = this.boxB;
    const o = i * 4;
    B[o] = this.minX;
    B[o + 1] = this.minY;
    B[o + 2] = this.maxX;
    B[o + 3] = this.maxY;
    this.boxR[i * PACK] = -1;
    this.boxHandles.push(handle);
    this.boxN = i + 1;
    return i;
  }

  /**
   * 글리프 인스턴스를 글리프별로 모은다(처음 나온 글리프 순서로 불투명 묶음들, 그다음 같은 순서로 투명 묶음들).
   * 들어온 순서를 지키는 셈 정렬이라 수백만 개도 JS 배열 없이 한 번에 옮긴다.
   */
  private finishGlyphs(): GlyphSet {
    let nFill = 0;
    let nStroke = 0;
    for (const g of this.glyphDefs) {
      if (g.kind === 0) nFill += g.data.length;
      else nStroke += g.data.length;
    }
    const fillVerts = new Float32Array(nFill);
    const strokeSegs = new Float32Array(nStroke);
    const glyphs: GlyphSet['glyphs'] = [];
    let fo = 0;
    let so = 0;
    for (const g of this.glyphDefs) {
      if (g.kind === 0) {
        fillVerts.set(g.data, fo);
        glyphs.push({ kind: 0, first: fo / 2, count: g.data.length / 2 });
        fo += g.data.length;
      } else {
        strokeSegs.set(g.data, so);
        glyphs.push({ kind: 1, first: so / 4, count: g.data.length / 4 });
        so += g.data.length;
      }
    }
    const n = this.instDone;
    const nG = this.glyphDefs.length;
    const cO = new Int32Array(nG);
    const cT = new Int32Array(nG);
    const seen = new Uint8Array(nG);
    const order: number[] = [];
    const G = this.instG;
    const T = this.instT;
    for (let i = 0; i < n; i++) {
      const g = G[i]!;
      if (!seen[g]) {
        seen[g] = 1;
        order.push(g);
      }
      if (T[i]) cT[g] = cT[g]! + 1;
      else cO[g] = cO[g]! + 1;
    }
    const runs: GlyphSet['runs'] = [];
    let k = 0;
    // 묶음마다 다음에 쓸 자리
    const atO = new Int32Array(nG);
    const atT = new Int32Array(nG);
    for (const g of order)
      if (cO[g]) {
        atO[g] = k;
        runs.push({ glyph: g, start: k, count: cO[g]!, transparent: false });
        k += cO[g]!;
      }
    for (const g of order)
      if (cT[g]) {
        atT[g] = k;
        runs.push({ glyph: g, start: k, count: cT[g]!, transparent: true });
        k += cT[g]!;
      }
    const buf = new ArrayBuffer(k * GLYPH_STRIDE * 4);
    const f = new Float32Array(buf);
    const ownerAt = new Int32Array(k);
    const F = this.instF;
    const O = this.instO;
    for (let i = 0; i < n; i++) {
      const g = G[i]!;
      let pos: number;
      if (T[i]) {
        pos = atT[g]!;
        atT[g] = pos + 1;
      } else {
        pos = atO[g]!;
        atO[g] = pos + 1;
      }
      const o = pos * GLYPH_STRIDE;
      const s = i * 8;
      f[o] = F[s]!;
      f[o + 1] = F[s + 1]!;
      f[o + 2] = F[s + 2]!;
      f[o + 3] = F[s + 3]!;
      const e = F[s + 4]!;
      const ff = F[s + 5]!;
      const eh = Math.fround(e);
      const fh = Math.fround(ff);
      f[o + 4] = eh;
      f[o + 5] = e - eh;
      f[o + 6] = fh;
      f[o + 7] = ff - fh;
      f[o + 8] = F[s + 6]!;
      f[o + 9] = F[s + 7]!;
      ownerAt[pos] = O[i]!;
    }
    // 상자마다 인스턴스 번호(작은 번호부터): 상자별 개수 → 시작 → 채우기
    const R = this.boxR;
    const nb = this.boxN;
    let total = 0;
    for (let p = 0; p < k; p++) {
      const ow = ownerAt[p]!;
      if (ow >= 0) {
        R[ow * PACK + 10] = R[ow * PACK + 10]! + 1;
        total++;
      }
    }
    let at = 0;
    for (let b = 0; b < nb; b++) {
      const r = b * PACK;
      R[r + 9] = at;
      at += R[r + 10]!;
    }
    const glyphOf = new Int32Array(total);
    const fill = new Int32Array(nb);
    for (let p = 0; p < k; p++) {
      const ow = ownerAt[p]!;
      if (ow >= 0) {
        glyphOf[R[ow * PACK + 9]! + fill[ow]!] = p;
        fill[ow] = fill[ow]! + 1;
      }
    }
    this.boxGlyphs = glyphOf;
    // 임시 저장소를 놓아 준다
    this.instF = new Float64Array(0);
    this.instG = new Int32Array(0);
    this.instT = new Uint8Array(0);
    this.instO = new Int32Array(0);
    this.instN = this.instDone = 0;
    return { fillVerts, strokeSegs, glyphs, instances: buf, runs, instanceCount: k };
  }

  private resetEntity(): void {
    this.segN = 0;
    this.triN = 0;
    this.minX = Infinity;
    this.minY = Infinity;
    this.maxX = -Infinity;
    this.maxY = -Infinity;
  }

  /** 미리 보기 조각으로 이미 보낸 글리프 인스턴스 수 */
  private instSent = 0;

  /**
   * 점진 빌드용 미리 보기 조각: 지난 조각 뒤로 마감한 객체들의 그림을 묶음 하나로(좌표는 (ox, oy) 기준 float32) 모은다.
   * 만드는 중인 표시 목록은 바꾸지 않는다(보낸 위치만 적는다). 객체 상자·무한선·이미지·외부 참조는 넣지 않는다.
   * view(미리 보기 화면 — 움직이지 않는다)를 주면 화면에서 보이지 않는 것을 뺀다:
   * 범위 밖 묶음, 반 픽셀보다 작은 객체는 선분·삼각형 하나만(한 픽셀 점으로 보인다), 너무 작아 그리지 않을 글자.
   */
  snapshot(ox: number, oy: number, view?: SnapshotView): DisplayList {
    const all = [...this.done, ...this.live];
    const kinds = ['segs', 'tris', 'tsegs', 'ttris'] as const;
    const rect = view?.rect;
    const px = view?.pxPerUnit ?? 0;
    // 묶음마다: 0 건너뜀(범위 밖), 1 모두, 2 객체마다 하나
    const mode = new Uint8Array(all.length);
    const total = [0, 0, 0, 0];
    for (let ci = 0; ci < all.length; ci++) {
      const c = all[ci]!;
      if (rect && (c.maxX < rect[0] || c.minX > rect[2] || c.maxY < rect[1] || c.minY > rect[3])) continue;
      const m = px > 0 && Math.pow(2, c.level) * px < 0.5 ? 2 : 1;
      mode[ci] = m;
      for (let k = 0; k < 4; k++) total[k]! += m === 1 ? c[kinds[k]!].length - c.sent[k]! : firstPerEntity(c[kinds[k]!], c.sent[k]!, k === 0 || k === 2 ? SEG_STRIDE : TRI_STRIDE * 3, k === 0 || k === 2 ? 4 : 2, null, 0, 0, 0);
    }
    const bufs = total.map((n) => new ArrayBuffer(n * 4));
    const at = [0, 0, 0, 0];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let ci = 0; ci < all.length; ci++) {
      const c = all[ci]!;
      const m = mode[ci]!;
      let any = false;
      for (let k = 0; k < 4; k++) {
        const g = c[kinds[k]!];
        const from = c.sent[k]!;
        const n = g.length - from;
        c.sent[k] = g.length;
        if (!n || !m) continue;
        const stride = k === 0 || k === 2 ? SEG_STRIDE : TRI_STRIDE;
        const dx = c.ox - ox;
        const dy = c.oy - oy;
        const o = at[k]!;
        if (m === 2) {
          const w = firstPerEntity(g, from, k === 0 || k === 2 ? SEG_STRIDE : TRI_STRIDE * 3, k === 0 || k === 2 ? 4 : 2, bufs[k]!, o, dx, dy);
          at[k] = o + w;
          any ||= w > 0;
          continue;
        }
        any = true;
        new Uint32Array(bufs[k]!, o * 4, n).set(g.u32.subarray(from, from + n));
        const dst = new Float32Array(bufs[k]!, o * 4, n);
        const src = g.f32;
        for (let e = 0; e < n; e += stride) {
          dst[e] = src[from + e]! + dx;
          dst[e + 1] = src[from + e + 1]! + dy;
          if (stride === SEG_STRIDE) {
            dst[e + 2] = src[from + e + 2]! + dx;
            dst[e + 3] = src[from + e + 3]! + dy;
          }
        }
        at[k] = o + n;
      }
      if (any) {
        if (c.minX < minX) minX = c.minX;
        if (c.minY < minY) minY = c.minY;
        if (c.maxX > maxX) maxX = c.maxX;
        if (c.maxY > maxY) maxY = c.maxY;
      }
    }
    const chunk: ChunkData = {
      key: 'preview',
      ox,
      oy,
      minX,
      minY,
      maxX,
      maxY,
      segs: bufs[0]!,
      segCount: total[0]! / SEG_STRIDE,
      tris: bufs[1]!,
      triCount: total[1]! / TRI_STRIDE / 3,
      tsegs: bufs[2]!,
      tsegCount: total[2]! / SEG_STRIDE,
      ttris: bufs[3]!,
      ttriCount: total[3]! / TRI_STRIDE / 3,
    };
    const glyphs = this.snapshotGlyphs(view);
    return {
      chunks: minX <= maxX ? [chunk] : [],
      glyphs,
      entities: [],
      minX,
      minY,
      maxX,
      maxY,
      xlines: [],
      xlineHandles: [],
    };
  }

  /** 지난 조각 뒤로 마감한 객체의 글리프 인스턴스(쓰는 글리프만 이 조각 번호로). view: 범위 밖·너무 작은 글자는 뺀다 */
  private snapshotGlyphs(view?: SnapshotView): GlyphSet {
    const from = this.instSent;
    const to = this.instDone;
    this.instSent = to;
    const G = this.instG;
    const T = this.instT;
    const F = this.instF;
    // 넣을 인스턴스(글리프 높이 = |(c, d)|, 위치 = (e, f))
    const keep = new Uint8Array(Math.max(0, to - from));
    const rect = view?.rect;
    const minH = view?.pxPerUnit ? (view.minTextPx ?? 0.6) / view.pxPerUnit : 0;
    for (let i = from; i < to; i++) {
      const s = i * 8;
      if (minH && Math.hypot(F[s + 2]!, F[s + 3]!) < minH) continue;
      if (rect && (F[s + 4]! < rect[0] || F[s + 4]! > rect[2] || F[s + 5]! < rect[1] || F[s + 5]! > rect[3])) continue;
      keep[i - from] = 1;
    }
    // 전체 글리프 번호 → 조각 글리프 번호(-1 안 씀)
    const local = new Int32Array(this.glyphDefs.length).fill(-1);
    const used: number[] = [];
    for (let i = from; i < to; i++) {
      if (!keep[i - from]) continue;
      const g = G[i]!;
      if (local[g]! < 0) {
        local[g] = used.length;
        used.push(g);
      }
    }
    let nFill = 0;
    let nStroke = 0;
    for (const g of used) {
      const d = this.glyphDefs[g]!;
      if (d.kind === 0) nFill += d.data.length;
      else nStroke += d.data.length;
    }
    const fillVerts = new Float32Array(nFill);
    const strokeSegs = new Float32Array(nStroke);
    const glyphs: GlyphSet['glyphs'] = [];
    let fo = 0;
    let so = 0;
    for (const g of used) {
      const d = this.glyphDefs[g]!;
      if (d.kind === 0) {
        fillVerts.set(d.data, fo);
        glyphs.push({ kind: 0, first: fo / 2, count: d.data.length / 2 });
        fo += d.data.length;
      } else {
        strokeSegs.set(d.data, so);
        glyphs.push({ kind: 1, first: so / 4, count: d.data.length / 4 });
        so += d.data.length;
      }
    }
    // (투명, 글리프) 순서로 셈 정렬
    const nG = used.length;
    const cnt = new Int32Array(nG * 2);
    for (let i = from; i < to; i++) if (keep[i - from]) cnt[local[G[i]!]! * 2 + (T[i] ? 1 : 0)]!++;
    const pos = new Int32Array(nG * 2);
    const runs: GlyphSet['runs'] = [];
    let k = 0;
    for (const t of [0, 1])
      for (let g = 0; g < nG; g++) {
        const n = cnt[g * 2 + t]!;
        if (!n) continue;
        pos[g * 2 + t] = k;
        runs.push({ glyph: g, start: k, count: n, transparent: t === 1 });
        k += n;
      }
    const buf = new ArrayBuffer(k * GLYPH_STRIDE * 4);
    const f = new Float32Array(buf);
    for (let i = from; i < to; i++) {
      if (!keep[i - from]) continue;
      const slot = local[G[i]!]! * 2 + (T[i] ? 1 : 0);
      const p = pos[slot]!;
      pos[slot] = p + 1;
      const o = p * GLYPH_STRIDE;
      const s = i * 8;
      f[o] = F[s]!;
      f[o + 1] = F[s + 1]!;
      f[o + 2] = F[s + 2]!;
      f[o + 3] = F[s + 3]!;
      const e = F[s + 4]!;
      const ff = F[s + 5]!;
      const eh = Math.fround(e);
      const fh = Math.fround(ff);
      f[o + 4] = eh;
      f[o + 5] = e - eh;
      f[o + 6] = fh;
      f[o + 7] = ff - fh;
      f[o + 8] = F[s + 6]!;
      f[o + 9] = F[s + 7]!;
    }
    return { fillVerts, strokeSegs, glyphs, instances: buf, runs, instanceCount: k };
  }

  /** finishGlyphs가 만든 상자별 글리프 인스턴스 번호 */
  private boxGlyphs = new Int32Array(0);

  /**
   * 표시 목록으로 마감한다. packed면 객체 상자를 형식 배열(list.packed)로만 두고 entities는 비운다
   * (워커가 그대로 옮기고 메인이 unpackBoxes로 푼다). 아니면 entities에 상자 객체를 만든다.
   */
  finish(packed = false): DisplayList {
    const all = [...this.done, ...this.live];
    // 묶음 번호: 만든 순서 → 목록 순서
    const pos = new Int32Array(this.chunkCount);
    for (let i = 0; i < all.length; i++) pos[all[i]!.index] = i;
    const R = this.boxR;
    for (let b = 0; b < this.boxN; b++) {
      const c = R[b * PACK]!;
      if (c >= 0) R[b * PACK] = pos[c]!;
    }
    // 묶음 버퍼는 take()가 옮기며(transfer) 바로 놓아 준다
    const chunks = all.map((c) => c.data());
    this.live.length = 0;
    this.done.length = 0;
    const glyphs = this.finishGlyphs();
    const n = this.boxN;
    const hs = this.boxHandles;
    let newline = false;
    for (const h of hs) if (h.includes('\n')) newline = true;
    const boxes: PackedBoxes = {
      count: n,
      handles: newline ? '' : hs.join('\n'),
      handleList: newline ? hs.slice() : undefined,
      bounds: new Float64Array(resized(this.boxB.buffer as ArrayBuffer, n * 32, n * 32)),
      ranges: new Int32Array(resized(this.boxR.buffer as ArrayBuffer, n * PACK * 4, n * PACK * 4)),
      glyphs: this.boxGlyphs,
    };
    this.boxB = new Float64Array(0);
    this.boxR = new Int32Array(0);
    return {
      chunks,
      glyphs,
      entities: packed ? [] : unpackBoxes(boxes),
      packed: packed ? boxes : undefined,
      minX: this.totalMinX,
      minY: this.totalMinY,
      maxX: this.totalMaxX,
      maxY: this.totalMaxY,
      xlines: this.xlines,
      xlineHandles: this.xlineHandles,
      images: this.images.length ? this.images : undefined,
      xrefs: this.xrefs.length ? this.xrefs : undefined,
      dashed: this.dashed || undefined,
    };
  }
}

/**
 * 전송용으로 묶은 객체 상자. 수백만 개의 작은 객체·배열을 구조화 복제하지 않고 형식 배열을 옮긴다(postMessage transfer).
 * 핸들은 '\n'으로 이은 문자열 하나(핸들에는 줄바꿈이 없다; 있으면 handleList를 쓴다).
 */
export interface PackedBoxes {
  count: number;
  handles: string;
  handleList?: string[];
  /** [minX, minY, maxX, maxY]×n */
  bounds: Float64Array;
  /** [묶음(-1 없음), seg 시작, 개수, tseg 시작, 개수, tri 시작, 개수, ttri 시작, 개수, 글리프 시작, 개수]×n */
  ranges: Int32Array;
  /** 상자들의 글리프 인스턴스 번호를 이어 붙인 것 */
  glyphs: Int32Array;
}


export function packBoxes(boxes: readonly EntityBox[]): PackedBoxes {
  const n = boxes.length;
  const bounds = new Float64Array(n * 4);
  const ranges = new Int32Array(n * PACK);
  let ng = 0;
  let newline = false;
  for (const b of boxes) {
    if (b.glyphs) ng += b.glyphs.length;
    if (b.handle.includes('\n')) newline = true;
  }
  const glyphs = new Int32Array(ng);
  let gi = 0;
  for (let i = 0; i < n; i++) {
    const b = boxes[i]!;
    const o = i * 4;
    bounds[o] = b.minX;
    bounds[o + 1] = b.minY;
    bounds[o + 2] = b.maxX;
    bounds[o + 3] = b.maxY;
    const r = i * PACK;
    ranges[r] = b.chunk ?? -1;
    const put = (k: number, v: [number, number] | undefined) => {
      if (!v) return;
      ranges[r + k] = v[0];
      ranges[r + k + 1] = v[1];
    };
    put(1, b.seg);
    put(3, b.tseg);
    put(5, b.tri);
    put(7, b.ttri);
    if (b.glyphs) {
      ranges[r + 9] = gi;
      ranges[r + 10] = b.glyphs.length;
      glyphs.set(b.glyphs, gi);
      gi += b.glyphs.length;
    }
  }
  const handles = newline ? '' : boxes.map((b) => b.handle).join('\n');
  return { count: n, handles, handleList: newline ? boxes.map((b) => b.handle) : undefined, bounds, ranges, glyphs };
}

/** packBoxes를 되돌린다(빈 범위·없는 묶음·글리프는 두지 않는다) */
export function unpackBoxes(p: PackedBoxes): EntityBox[] {
  const n = p.count;
  const handles = p.handleList ?? (n ? p.handles.split('\n') : []);
  const { bounds, ranges, glyphs } = p;
  const out = new Array<EntityBox>(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const b: EntityBox = { handle: handles[i]!, minX: bounds[o]!, minY: bounds[o + 1]!, maxX: bounds[o + 2]!, maxY: bounds[o + 3]! };
    const r = i * PACK;
    if (ranges[r + 2]) b.seg = [ranges[r + 1]!, ranges[r + 2]!];
    if (ranges[r + 4]) b.tseg = [ranges[r + 3]!, ranges[r + 4]!];
    if (ranges[r + 6]) b.tri = [ranges[r + 5]!, ranges[r + 6]!];
    if (ranges[r + 8]) b.ttri = [ranges[r + 7]!, ranges[r + 8]!];
    if (ranges[r]! >= 0) b.chunk = ranges[r]!;
    const gc = ranges[r + 10]!;
    if (gc) b.glyphs = Array.from(glyphs.subarray(ranges[r + 9]!, ranges[r + 9]! + gc));
    out[i] = b;
  }
  return out;
}

/** 전송할 때 넘길 버퍼 목록 */
export function transferables(dl: DisplayList): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const c of dl.chunks) out.push(c.segs, c.tris, c.tsegs, c.ttris);
  out.push(dl.glyphs.instances, dl.glyphs.fillVerts.buffer as ArrayBuffer, dl.glyphs.strokeSegs.buffer as ArrayBuffer);
  for (const im of dl.images ?? []) out.push(im.verts.buffer as ArrayBuffer);
  return out;
}

// ---------------------------------------------------------------------------
// 자르기 도우미
// ---------------------------------------------------------------------------

interface Clip {
  poly: number[];
  inverted: boolean;
  convex: boolean;
  bbox: [number, number, number, number];
}

/** 반시계 방향 다각형으로 */
function ccw(poly: number[]): number[] {
  let a = 0;
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += poly[i * 2]! * poly[j * 2 + 1]! - poly[j * 2]! * poly[i * 2 + 1]!;
  }
  if (a >= 0) return poly.slice();
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(poly[i * 2]!, poly[i * 2 + 1]!);
  return out;
}

function isConvex(poly: number[]): boolean {
  const n = poly.length / 2;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const ax = poly[i * 2]!;
    const ay = poly[i * 2 + 1]!;
    const bx = poly[((i + 1) % n) * 2]!;
    const by = poly[((i + 1) % n) * 2 + 1]!;
    const cx = poly[((i + 2) % n) * 2]!;
    const cy = poly[((i + 2) % n) * 2 + 1]!;
    const z = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(z) < 1e-15) continue;
    if (!sign) sign = Math.sign(z);
    else if (Math.sign(z) !== sign) return false;
  }
  return true;
}

/** 홀짝 규칙 점 포함 */
export function pointInPolygon(x: number, y: number, poly: number[]): boolean {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2]!;
    const yi = poly[i * 2 + 1]!;
    const xj = poly[j * 2]!;
    const yj = poly[j * 2 + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 선분과 다각형 변의 교점 매개변수(0~1)를 ts에 더한다 */
function segmentPolygonParams(x0: number, y0: number, x1: number, y1: number, poly: number[], ts: number[]): void {
  const n = poly.length / 2;
  const rx = x1 - x0;
  const ry = y1 - y0;
  for (let i = 0; i < n; i++) {
    const ax = poly[i * 2]!;
    const ay = poly[i * 2 + 1]!;
    const bx = poly[((i + 1) % n) * 2]!;
    const by = poly[((i + 1) % n) * 2 + 1]!;
    const sx = bx - ax;
    const sy = by - ay;
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-18) continue;
    const t = ((ax - x0) * sy - (ay - y0) * sx) / den;
    const u = ((ax - x0) * ry - (ay - y0) * rx) / den;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
  }
}

/** 볼록(반시계) 다각형으로 다각형 자르기(Sutherland–Hodgman) */
export function clipConvex(subject: number[], clip: number[]): number[] {
  let out = subject;
  const n = clip.length / 2;
  for (let i = 0; i < n && out.length >= 6; i++) {
    const ax = clip[i * 2]!;
    const ay = clip[i * 2 + 1]!;
    const bx = clip[((i + 1) % n) * 2]!;
    const by = clip[((i + 1) % n) * 2 + 1]!;
    const side = (x: number, y: number) => (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    const input = out;
    out = [];
    const m = input.length / 2;
    for (let k = 0; k < m; k++) {
      const px = input[k * 2]!;
      const py = input[k * 2 + 1]!;
      const qx = input[((k + 1) % m) * 2]!;
      const qy = input[((k + 1) % m) * 2 + 1]!;
      const sp = side(px, py);
      const sq = side(qx, qy);
      if (sp >= 0) out.push(px, py);
      if (sp >= 0 !== sq >= 0) {
        const t = sp / (sp - sq);
        out.push(px + (qx - px) * t, py + (qy - py) * t);
      }
    }
  }
  return out;
}
