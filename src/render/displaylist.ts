/**
 * 표시 목록: 화면에 그릴 선분과 삼각형을 공간 격자 묶음(chunk)으로 모은다.
 *
 * - 좌표는 묶음 원점 기준 float32다. 묶음은 객체 크기에 맞춘 격자 칸이라 원점이 가깝고,
 *   큰 좌표(예: 500000, 300000)에서도 확대했을 때 떨리지 않는다.
 * - depth = 그리기 순서(나중 객체일수록 작다). 채우기와 선을 따로 그려도 겹침 순서가 맞는다.
 * - 선분 1개 = [x0, y0, x1, y1, depth, style] 24바이트, 삼각형 정점 = [x, y, depth, style] 16바이트.
 */

export const SEG_STRIDE = 6; // 4바이트 단위
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
    const nb = new ArrayBuffer(cap * 4);
    new Float32Array(nb).set(this.f32.subarray(0, this.length));
    this.buf = nb;
    this.f32 = new Float32Array(nb);
    this.u32 = new Uint32Array(nb);
  }

  /** 잘라 낸 복사본(전송용) */
  take(): ArrayBuffer {
    return this.buf.slice(0, this.length * 4);
  }
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
  /** 이 객체의 그림이 든 묶음 번호와 범위([시작, 개수]) — 편집할 때 숨기는 데 쓴다 */
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
}

class ChunkBuilder {
  static serial = 0;
  readonly id = ChunkBuilder.serial++;
  readonly segs = new GrowBuffer(4096);
  readonly tris = new GrowBuffer(4096);
  readonly tsegs = new GrowBuffer(64);
  readonly ttris = new GrowBuffer(64);
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;

  constructor(
    readonly key: string,
    readonly ox: number,
    readonly oy: number,
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

/**
 * 객체 하나의 그림을 임시로 모았다가(월드 좌표, double) 범위가 정해지면 알맞은 묶음에 넣는다.
 */
export class DisplayListBuilder {
  private readonly chunks = new Map<string, ChunkBuilder>();
  private readonly done: ChunkBuilder[] = [];
  readonly entities: EntityBox[] = [];
  readonly xlines: number[] = [];
  readonly xlineHandles: string[] = [];
  // 객체 하나의 임시 그림
  private segX: number[] = [];
  private segS: number[] = [];
  private triX: number[] = [];
  private triS: number[] = [];
  private depth = 0;
  // 글리프
  private readonly glyphIds = new Map<object, number>();
  private readonly glyphDefs: { kind: 0 | 1; data: Float32Array }[] = [];
  /** 글리프 번호별 인스턴스 [a,b,c,d,e,f,depth,style] (double) */
  private readonly inst = new Map<number, { o: number[]; t: number[] }>();
  private pendingInst: { g: number; v: number[]; transparent: boolean }[] = [];
  /** 객체 일련번호(글리프 인스턴스가 어느 객체 것인지) */
  private serial = 0;
  private readonly boxBySerial = new Map<number, EntityBox>();
  private readonly chunkOfBox = new Map<EntityBox, ChunkBuilder>();
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
    this.segX.push(x0, y0, x1, y1, this.depth);
    this.segS.push(style);
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
    const d = this.depth;
    this.triX.push(x0, y0, d, x1, y1, d, x2, y2, d);
    this.triS.push(style);
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
    const [a, b, c, d, e, f] = m as [number, number, number, number, number, number];
    if (!Number.isFinite(a + b + c + d + e + f)) return;
    if (this.clips.length) {
      // 글자는 가운데가 경계 안에 있을 때만
      const mx = (bbox[0] + bbox[2]) / 2;
      const my = (bbox[1] + bbox[3]) / 2;
      if (!this.inside(a * mx + c * my + e, b * mx + d * my + f)) return;
    }
    this.pendingInst.push({ g, v: [a, b, c, d, e, f, this.depth, style, this.serial], transparent: this.transparent(style) });
    const [x0, y0, x1, y1] = bbox;
    for (const [x, y] of [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ] as const)
      this.grow(a * x + c * y + e, b * x + d * y + f);
  }

  private images: ImageDraw[] = [];

  /** 래스터 이미지(월드 좌표 [x, y, u, v, …] 삼각형) */
  image(key: string, tris: number[], style: number, opt: { brightness: number; contrast: number; fade: number; transparent: boolean }): void {
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

  /** 지금까지 모은 그림을 한 객체로 마감한다. */
  endEntity(handle: string): void {
    for (const im of this.pendingImages) im.handle = handle;
    this.pendingImages = [];
    while (this.xlineHandles.length < this.xlines.length / 7) this.xlineHandles.push(handle);
    for (const p of this.pendingInst) {
      let r = this.inst.get(p.g);
      if (!r) {
        r = { o: [], t: [] };
        this.inst.set(p.g, r);
      }
      (p.transparent ? r.t : r.o).push(...p.v);
    }
    const hadGlyphs = this.pendingInst.length > 0;
    this.pendingInst = [];
    if (this.segS.length === 0 && this.triS.length === 0) {
      if (hadGlyphs) this.recordEntity(handle);
      this.resetEntity();
      this.serial++;
      return;
    }
    const w = this.maxX - this.minX;
    const h = this.maxY - this.minY;
    const size = Math.max(w, h, 1e-9);
    const level = Math.ceil(Math.log2(size));
    const cell = Math.pow(2, level + 8);
    const cx = (this.minX + this.maxX) / 2;
    const cy = (this.minY + this.maxY) / 2;
    const ix = Math.floor(cx / cell);
    const iy = Math.floor(cy / cell);
    const key = `${level}:${ix}:${iy}`;
    let ch = this.chunks.get(key);
    if (!ch || ch.size > MAX_CHUNK) {
      if (ch) this.done.push(ch);
      ch = new ChunkBuilder(key, (ix + 0.5) * cell, (iy + 0.5) * cell);
      this.chunks.set(key, ch);
    }
    const ox = ch.ox;
    const oy = ch.oy;
    const seg0 = ch.segs.length / SEG_STRIDE;
    const tseg0 = ch.tsegs.length / SEG_STRIDE;
    const tri0 = ch.tris.length / TRI_STRIDE / 3;
    const ttri0 = ch.ttris.length / TRI_STRIDE / 3;
    // 선분
    const sx = this.segX;
    const ss = this.segS;
    for (let i = 0; i < ss.length; i++) {
      const style = ss[i]!;
      const b = this.transparent(style) ? ch.tsegs : ch.segs;
      b.reserve(SEG_STRIDE);
      const o = b.length;
      const k = i * 5;
      b.f32[o] = sx[k]! - ox;
      b.f32[o + 1] = sx[k + 1]! - oy;
      b.f32[o + 2] = sx[k + 2]! - ox;
      b.f32[o + 3] = sx[k + 3]! - oy;
      b.f32[o + 4] = sx[k + 4]!;
      b.u32[o + 5] = style;
      b.length += SEG_STRIDE;
    }
    const tx = this.triX;
    const ts = this.triS;
    for (let i = 0; i < ts.length; i++) {
      const style = ts[i]!;
      const b = this.transparent(style) ? ch.ttris : ch.tris;
      b.reserve(TRI_STRIDE * 3);
      for (let v = 0; v < 3; v++) {
        const o = b.length;
        const k = i * 9 + v * 3;
        b.f32[o] = tx[k]! - ox;
        b.f32[o + 1] = tx[k + 1]! - oy;
        b.f32[o + 2] = tx[k + 2]!;
        b.u32[o + 3] = style;
        b.length += TRI_STRIDE;
      }
    }
    if (this.minX < ch.minX) ch.minX = this.minX;
    if (this.minY < ch.minY) ch.minY = this.minY;
    if (this.maxX > ch.maxX) ch.maxX = this.maxX;
    if (this.maxY > ch.maxY) ch.maxY = this.maxY;
    const box = this.recordEntity(handle);
    if (box) {
      box.seg = [seg0, ch.segs.length / SEG_STRIDE - seg0];
      box.tseg = [tseg0, ch.tsegs.length / SEG_STRIDE - tseg0];
      box.tri = [tri0, ch.tris.length / TRI_STRIDE / 3 - tri0];
      box.ttri = [ttri0, ch.ttris.length / TRI_STRIDE / 3 - ttri0];
      this.chunkOfBox.set(box, ch);
    }
    this.resetEntity();
    this.serial++;
  }

  private recordEntity(handle: string): EntityBox | null {
    if (!(this.minX <= this.maxX)) return null;
    if (this.minX < this.totalMinX) this.totalMinX = this.minX;
    if (this.minY < this.totalMinY) this.totalMinY = this.minY;
    if (this.maxX > this.totalMaxX) this.totalMaxX = this.maxX;
    if (this.maxY > this.totalMaxY) this.totalMaxY = this.maxY;
    if (!handle) return null;
    const box: EntityBox = { handle, minX: this.minX, minY: this.minY, maxX: this.maxX, maxY: this.maxY };
    this.entities.push(box);
    this.boxBySerial.set(this.serial, box);
    return box;
  }

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
    let total = 0;
    for (const r of this.inst.values()) total += (r.o.length + r.t.length) / 9;
    const buf = new ArrayBuffer(total * GLYPH_STRIDE * 4);
    const f = new Float32Array(buf);
    const runs: GlyphSet['runs'] = [];
    let k = 0;
    const put = (g: number, list: number[], transparent: boolean) => {
      if (!list.length) return;
      const start = k;
        for (let i = 0; i < list.length; i += 9) {
        const o = k * GLYPH_STRIDE;
        f[o] = list[i]!;
        f[o + 1] = list[i + 1]!;
        f[o + 2] = list[i + 2]!;
        f[o + 3] = list[i + 3]!;
        const e = list[i + 4]!;
        const ff = list[i + 5]!;
        const eh = Math.fround(e);
        const fh = Math.fround(ff);
        f[o + 4] = eh;
        f[o + 5] = e - eh;
        f[o + 6] = fh;
        f[o + 7] = ff - fh;
        f[o + 8] = list[i + 6]!;
        f[o + 9] = list[i + 7]!;
        const box = this.boxBySerial.get(list[i + 8]!);
        if (box) (box.glyphs ??= []).push(k);
        k++;
      }
      runs.push({ glyph: g, start, count: k - start, transparent });
    };
    for (const [g, r] of this.inst) put(g, r.o, false);
    for (const [g, r] of this.inst) put(g, r.t, true);
    return { fillVerts, strokeSegs, glyphs, instances: buf, runs, instanceCount: k };
  }

  private resetEntity(): void {
    this.segX.length = 0;
    this.segS.length = 0;
    this.triX.length = 0;
    this.triS.length = 0;
    this.minX = Infinity;
    this.minY = Infinity;
    this.maxX = -Infinity;
    this.maxY = -Infinity;
  }

  finish(): DisplayList {
    const all = [...this.done, ...this.chunks.values()];
    const idx = new Map(all.map((c, i) => [c, i]));
    for (const [box, ch] of this.chunkOfBox) box.chunk = idx.get(ch);
    return {
      chunks: all.map((c) => c.data()),
      glyphs: this.finishGlyphs(),
      entities: this.entities,
      minX: this.totalMinX,
      minY: this.totalMinY,
      maxX: this.totalMaxX,
      maxY: this.totalMaxY,
      xlines: this.xlines,
      xlineHandles: this.xlineHandles,
      images: this.images.length ? this.images : undefined,
    };
  }
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
function clipConvex(subject: number[], clip: number[]): number[] {
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
