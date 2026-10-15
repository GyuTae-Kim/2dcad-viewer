/**
 * Windows 메타파일(WMF) 쓰기. Microsoft 공개 명세 [MS-WMF]를 따른다.
 *
 * 파일 = 배치 가능 머리(META_PLACEABLE, 22바이트) + META_HEADER(18바이트) + 레코드 + META_EOF.
 * 레코드 = RecordSize(32비트, 16비트 낱말 수) + RecordFunction(16비트) + 매개변수(16비트 낱말들).
 * 좌표는 부호 있는 16비트 논리 단위다. MM_ANISOTROPIC 창 원점 (0, 0), 창 크기 = 그림 크기, y는 아래로.
 */

/** 레코드 함수 번호([MS-WMF] 2.1.1.1 RecordType) */
export const WMF_FN = {
  EOF: 0x0000,
  SAVEDC: 0x001e,
  SETBKMODE: 0x0102,
  SETMAPMODE: 0x0103,
  SETPOLYFILLMODE: 0x0106,
  RESTOREDC: 0x0127,
  SELECTOBJECT: 0x012d,
  DELETEOBJECT: 0x01f0,
  SETWINDOWORG: 0x020b,
  SETWINDOWEXT: 0x020c,
  CREATEPENINDIRECT: 0x02fa,
  CREATEBRUSHINDIRECT: 0x02fc,
  POLYGON: 0x0324,
  POLYLINE: 0x0325,
  INTERSECTCLIPRECT: 0x0416,
  POLYPOLYGON: 0x0538,
} as const;

/** 배치 가능 머리 열쇠 */
export const WMF_PLACEABLE_KEY = 0x9ac6cdd7;
const MM_ANISOTROPIC = 8;
const TRANSPARENT = 1;
const WINDING = 2;
const PS_SOLID = 0;
const BS_SOLID = 0;
/** 레코드 하나에 넣는 점 수 상한(읽는 프로그램이 큰 레코드를 싫어한다) */
const MAX_POINTS = 4000;

const clamp16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)));

/** 만든 펜·붓: 같은 모양인지 가리는 열쇠와 객체 표 자리 */
interface GdiObject {
  key: string;
  index: number;
}

/** 16비트 낱말 단위로 레코드를 모아 WMF 바이트를 만든다 */
export class WmfWriter {
  private words = new Uint16Array(4096);
  private n = 0;
  private maxRecord = 3;
  /** 객체 표(만든 객체가 차지한 자리) */
  private readonly slots: boolean[] = [];
  private maxObjects = 0;
  private pen: GdiObject | null = null;
  private brush: GdiObject | null = null;
  /** saveDC 때 고른 펜·붓(그 상태로 돌아갈 때 다시 쓰이므로 그 사이에는 지우지 않는다) */
  private saved: { pen: GdiObject | null; brush: GdiObject | null } | null = null;

  /**
   * @param width 그림 폭(논리 단위)
   * @param height 그림 높이(논리 단위)
   * @param unitsPerInch 1인치의 논리 단위 수(배치 가능 머리 Inch)
   */
  constructor(
    readonly width: number,
    readonly height: number,
    readonly unitsPerInch: number,
  ) {
    this.record(WMF_FN.SETMAPMODE, [MM_ANISOTROPIC]);
    this.record(WMF_FN.SETWINDOWORG, [0, 0]);
    // 매개변수는 GDI 함수 인수의 역순(y 먼저)
    this.record(WMF_FN.SETWINDOWEXT, [clamp16(height), clamp16(width)]);
    this.record(WMF_FN.SETBKMODE, [TRANSPARENT]);
    this.record(WMF_FN.SETPOLYFILLMODE, [WINDING]);
  }

  private reserve(k: number): void {
    if (this.n + k <= this.words.length) return;
    let len = this.words.length * 2;
    while (len < this.n + k) len *= 2;
    const w = new Uint16Array(len);
    w.set(this.words.subarray(0, this.n));
    this.words = w;
  }

  /** 레코드 하나(매개변수는 16비트 값들, 음수는 2의 보수) */
  record(fn: number, params: ArrayLike<number>): void {
    const size = 3 + params.length;
    this.reserve(size);
    const w = this.words;
    w[this.n++] = size & 0xffff;
    w[this.n++] = (size >>> 16) & 0xffff;
    w[this.n++] = fn;
    for (let i = 0; i < params.length; i++) w[this.n++] = params[i]! & 0xffff;
    if (size > this.maxRecord) this.maxRecord = size;
  }

  /** 객체를 만든다: 표에서 가장 앞의 빈 자리를 차지한다 */
  private create(fn: number, params: number[]): number {
    this.record(fn, params);
    let i = this.slots.indexOf(false);
    if (i < 0) {
      i = this.slots.length;
      this.slots.push(true);
    } else this.slots[i] = true;
    const used = this.slots.filter(Boolean).length;
    if (used > this.maxObjects) this.maxObjects = used;
    return i;
  }

  private remove(index: number): void {
    this.record(WMF_FN.DELETEOBJECT, [index]);
    this.slots[index] = false;
  }

  /** 펜(실선, 폭은 논리 단위, 0이면 1픽셀) */
  setPen(rgb: number, width: number): void {
    const w = Math.max(0, clamp16(width));
    const key = `${rgb}|${w}`;
    if (this.pen?.key === key) return;
    const index = this.create(WMF_FN.CREATEPENINDIRECT, [PS_SOLID, w, 0, ...colorRef(rgb)]);
    this.record(WMF_FN.SELECTOBJECT, [index]);
    if (this.pen && this.pen !== this.saved?.pen) this.remove(this.pen.index);
    this.pen = { key, index };
  }

  /** 단색 붓 */
  setBrush(rgb: number): void {
    const key = String(rgb);
    if (this.brush?.key === key) return;
    const index = this.create(WMF_FN.CREATEBRUSHINDIRECT, [BS_SOLID, ...colorRef(rgb), 0]);
    this.record(WMF_FN.SELECTOBJECT, [index]);
    if (this.brush && this.brush !== this.saved?.brush) this.remove(this.brush.index);
    this.brush = { key, index };
  }

  /** 꺾은선 [x, y, …](논리 단위). 길면 나눈다 */
  polyline(pts: ArrayLike<number>): void {
    const count = pts.length >> 1;
    if (count < 2) return;
    for (let s = 0; s < count - 1; s += MAX_POINTS - 1) {
      const e = Math.min(count, s + MAX_POINTS);
      const p: number[] = [e - s];
      for (let i = s; i < e; i++) p.push(clamp16(pts[i * 2]!), clamp16(pts[i * 2 + 1]!));
      this.record(WMF_FN.POLYLINE, p);
    }
  }

  /** 다각형 하나 */
  polygon(pts: ArrayLike<number>): void {
    const count = pts.length >> 1;
    if (count < 3) return;
    const p: number[] = [count];
    for (let i = 0; i < count; i++) p.push(clamp16(pts[i * 2]!), clamp16(pts[i * 2 + 1]!));
    this.record(WMF_FN.POLYGON, p);
  }

  /** 다각형 여러 개를 한 레코드로(겹치는 곳은 WINDING으로 채운다) */
  polyPolygon(polys: readonly ArrayLike<number>[]): void {
    let i = 0;
    while (i < polys.length) {
      const counts: number[] = [];
      const pts: number[] = [];
      while (i < polys.length && (counts.length === 0 || pts.length / 2 + polys[i]!.length / 2 <= MAX_POINTS)) {
        const p = polys[i++]!;
        const c = p.length >> 1;
        if (c < 3) continue;
        counts.push(c);
        for (let k = 0; k < c * 2; k++) pts.push(clamp16(p[k]!));
      }
      if (counts.length) this.record(WMF_FN.POLYPOLYGON, [counts.length, ...counts, ...pts]);
    }
  }

  /** 장치 문맥 상태를 저장한다(자르기 전). 겹쳐 부르지 않는다 */
  saveDC(): void {
    this.record(WMF_FN.SAVEDC, []);
    this.saved = { pen: this.pen, brush: this.brush };
  }

  /** 앞의 saveDC 상태로(자르기 해제). 펜·붓도 그때 것으로 돌아가므로, 그 사이에 만든 것은 고르기가 풀린 뒤 지운다 */
  restoreDC(): void {
    this.record(WMF_FN.RESTOREDC, [0xffff]);
    const s = this.saved ?? { pen: null, brush: null };
    for (const o of [this.pen, this.brush]) if (o && o !== s.pen && o !== s.brush) this.remove(o.index);
    this.pen = s.pen;
    this.brush = s.brush;
    this.saved = null;
  }

  /** 자르기 사각형(논리 단위) */
  clipRect(left: number, top: number, right: number, bottom: number): void {
    // 매개변수 순서: Bottom, Right, Top, Left
    this.record(WMF_FN.INTERSECTCLIPRECT, [clamp16(bottom), clamp16(right), clamp16(top), clamp16(left)]);
  }

  /** META_EOF로 닫아 파일 바이트를 만든다(고른 채인 펜·붓은 재생이 끝날 때 함께 풀린다) */
  finish(): Uint8Array<ArrayBuffer> {
    if (this.saved) this.restoreDC();
    this.record(WMF_FN.EOF, []);
    const body = this.n;
    const out = new Uint8Array(22 + 18 + body * 2);
    const dv = new DataView(out.buffer);
    // 배치 가능 머리(META_PLACEABLE)
    dv.setUint32(0, WMF_PLACEABLE_KEY, true);
    dv.setUint16(4, 0, true);
    dv.setInt16(6, 0, true);
    dv.setInt16(8, 0, true);
    dv.setInt16(10, clamp16(this.width), true);
    dv.setInt16(12, clamp16(this.height), true);
    dv.setUint16(14, Math.max(1, Math.min(65535, Math.round(this.unitsPerInch))), true);
    dv.setUint32(16, 0, true);
    let sum = 0;
    for (let i = 0; i < 10; i++) sum ^= dv.getUint16(i * 2, true);
    dv.setUint16(20, sum, true);
    // META_HEADER
    const h = 22;
    dv.setUint16(h, 1, true); // MEMORYMETAFILE
    dv.setUint16(h + 2, 9, true); // 머리 크기(낱말)
    dv.setUint16(h + 4, 0x0300, true);
    const total = 9 + body;
    dv.setUint16(h + 6, total & 0xffff, true);
    dv.setUint16(h + 8, (total >>> 16) & 0xffff, true);
    dv.setUint16(h + 10, Math.max(1, this.maxObjects), true);
    dv.setUint32(h + 12, this.maxRecord, true);
    dv.setUint16(h + 16, 0, true);
    for (let i = 0; i < body; i++) dv.setUint16(40 + i * 2, this.words[i]!, true);
    return out;
  }
}

/** COLORREF(빨강, 초록, 파랑, 0)를 16비트 낱말 둘로 */
function colorRef(rgb: number): [number, number] {
  const r = (rgb >> 16) & 255;
  const g = (rgb >> 8) & 255;
  const b = rgb & 255;
  return [r | (g << 8), b];
}

/** WMF 레코드 하나(읽어 확인할 때) */
export interface WmfRecord {
  fn: number;
  /** 매개변수 낱말(부호 없는 16비트) */
  params: Uint16Array;
}

/** 쓴 WMF를 다시 읽는다(시험·확인용): 배치 가능 머리, 머리, 레코드 */
export function readWmf(data: Uint8Array): { placeable: { bbox: [number, number, number, number]; inch: number; checksumOk: boolean }; header: { size: number; objects: number; maxRecord: number }; records: WmfRecord[] } {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint32(0, true) !== WMF_PLACEABLE_KEY) throw new Error('배치 가능 머리가 없습니다.');
  let sum = 0;
  for (let i = 0; i < 10; i++) sum ^= dv.getUint16(i * 2, true);
  const placeable = { bbox: [dv.getInt16(6, true), dv.getInt16(8, true), dv.getInt16(10, true), dv.getInt16(12, true)] as [number, number, number, number], inch: dv.getUint16(14, true), checksumOk: sum === dv.getUint16(20, true) };
  const h = 22;
  const header = { size: dv.getUint16(h + 6, true) | (dv.getUint16(h + 8, true) << 16), objects: dv.getUint16(h + 10, true), maxRecord: dv.getUint32(h + 12, true) };
  const records: WmfRecord[] = [];
  let o = 40;
  while (o + 6 <= data.length) {
    const size = dv.getUint32(o, true);
    const fn = dv.getUint16(o + 4, true);
    if (size < 3) throw new Error('레코드 크기가 잘못됐습니다.');
    const params = new Uint16Array(size - 3);
    for (let i = 0; i < params.length; i++) params[i] = dv.getUint16(o + 6 + i * 2, true);
    records.push({ fn, params });
    o += size * 2;
    if (fn === WMF_FN.EOF) break;
  }
  return { placeable, header, records };
}

// ---------------------------------------------------------------------------
// 표시 목록 → WMF: 선분·삼각형을 받아 같은 스타일끼리 꺾은선·다각형 묶음으로 쓴다
// ---------------------------------------------------------------------------

export interface WmfStyle {
  rgb: number;
  /** 선 폭(논리 단위, 0이면 1픽셀) */
  width: number;
}

/** 출력 좌표(그림 단위)의 선분·삼각형을 받아 WMF로 옮기는 받개. k = 논리 단위 / 그림 단위 */
export class WmfSink {
  private run: number[] = [];
  private runStyle = -1;
  private tris: number[][] = [];
  private triStyle = -1;

  constructor(
    readonly out: WmfWriter,
    readonly k: number,
    readonly styleOf: (s: number) => WmfStyle,
  ) {}

  seg(x0: number, y0: number, x1: number, y1: number, s: number): void {
    this.flushTris();
    const k = this.k;
    const ax = Math.round(x0 * k);
    const ay = Math.round(y0 * k);
    const bx = Math.round(x1 * k);
    const by = Math.round(y1 * k);
    const r = this.run;
    if (s === this.runStyle && r.length >= 2 && r.length < MAX_POINTS * 2 && r[r.length - 2] === ax && r[r.length - 1] === ay) {
      if (bx !== ax || by !== ay) r.push(bx, by);
      return;
    }
    this.flushRun();
    this.runStyle = s;
    this.run = [ax, ay, bx, by];
  }

  tri(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, s: number): void {
    this.flushRun();
    const k = this.k;
    let p = [Math.round(x0 * k), Math.round(y0 * k), Math.round(x1 * k), Math.round(y1 * k), Math.round(x2 * k), Math.round(y2 * k)];
    const area = (p[2]! - p[0]!) * (p[5]! - p[1]!) - (p[4]! - p[0]!) * (p[3]! - p[1]!);
    if (area === 0) return;
    // WINDING으로 채우므로 방향을 하나로 맞춘다(겹친 삼각형이 구멍이 되지 않게)
    if (area < 0) p = [p[0]!, p[1]!, p[4]!, p[5]!, p[2]!, p[3]!];
    if (s !== this.triStyle || this.tris.length >= 1000) this.flushTris();
    this.triStyle = s;
    this.tris.push(p);
  }

  private flushRun(): void {
    if (this.run.length >= 4) {
      const st = this.styleOf(this.runStyle);
      this.out.setPen(st.rgb, st.width);
      this.out.polyline(this.run);
    }
    this.run = [];
    this.runStyle = -1;
  }

  private flushTris(): void {
    if (this.tris.length) {
      const st = this.styleOf(this.triStyle);
      // 이웃 삼각형 사이 틈이 보이지 않게 같은 색 1픽셀 펜으로 테두리도 그린다
      this.out.setPen(st.rgb, 0);
      this.out.setBrush(st.rgb);
      this.out.polyPolygon(this.tris);
    }
    this.tris = [];
    this.triStyle = -1;
  }

  /** 모아 둔 것을 쓴다(자르기 영역을 바꾸기 전과 끝에) */
  flush(): void {
    this.flushRun();
    this.flushTris();
  }
}

/** 그림 크기(그림 단위)와 1인치의 그림 단위 수 → 논리 단위 배율(16비트에 들어가고 1인치가 1440 이하) */
export function wmfScale(width: number, height: number, unitsPerInch: number): { k: number; inch: number; w: number; h: number } {
  const big = Math.max(width, height, 1e-9);
  const k = Math.min(1440 / unitsPerInch, 32000 / big);
  return { k, inch: Math.max(1, Math.round(unitsPerInch * k)), w: Math.max(1, Math.round(width * k)), h: Math.max(1, Math.round(height * k)) };
}
