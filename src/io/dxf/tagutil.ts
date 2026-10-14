/** DXF 레코드 해석 도우미 */
import type { TagValue } from './records';
import type { CadColor, RawTag, Vec2, Vec3, XData, XDataItem } from '../../core/model';
import { normalizeHandle } from '../../core/model';
import { decodeCadEscapes } from '../../core/codepage';

export const num = (v: TagValue | undefined): number => {
  if (typeof v === 'number') return v;
  if (v === undefined) return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

export const int = (v: TagValue | undefined): number => {
  if (typeof v === 'number') return Math.trunc(v);
  if (v === undefined) return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
};

export const str = (v: TagValue | undefined): string => (v === undefined ? '' : typeof v === 'string' ? v : String(v));

/** 이름(도면층·블록·스타일)은 \U+ 이스케이프를 풀어 둔다. */
export const name = (v: TagValue | undefined): string => decodeCadEscapes(str(v).trim());

export const handle = (v: TagValue | undefined): string => normalizeHandle(str(v));

export const DEG = Math.PI / 180;

/**
 * 객체 고유 태그 묶음. 하위 클래스 표지(100)와 함께 위치를 기억한다.
 * 순서가 중요한 객체(LWPOLYLINE 정점, HATCH 경계, SPLINE 매듭 등)는 i를 앞으로 옮기며 읽는다.
 */
export class Tags {
  constructor(
    readonly codes: number[],
    readonly values: TagValue[],
    readonly subs: string[],
  ) {}

  get length(): number {
    return this.codes.length;
  }

  /** 첫 번째 code의 위치(없으면 -1). sub를 주면 그 하위 클래스 안에서만 찾는다. */
  find(code: number, sub?: string): number {
    const c = this.codes;
    for (let i = 0; i < c.length; i++) if (c[i] === code && (sub === undefined || this.subs[i] === sub)) return i;
    return -1;
  }

  has(code: number): boolean {
    return this.find(code) >= 0;
  }

  num(code: number, def = 0, sub?: string): number {
    const i = this.find(code, sub);
    return i < 0 ? def : num(this.values[i]);
  }

  int(code: number, def = 0, sub?: string): number {
    const i = this.find(code, sub);
    return i < 0 ? def : int(this.values[i]);
  }

  str(code: number, def = '', sub?: string): string {
    const i = this.find(code, sub);
    return i < 0 ? def : str(this.values[i]);
  }

  /** 점: code, code+10, code+20 */
  point(code: number, def?: Vec3, sub?: string): Vec3 {
    const i = this.find(code, sub);
    if (i < 0) return def ? { ...def } : { x: 0, y: 0, z: 0 };
    return this.pointAt(i);
  }

  hasPoint(code: number, sub?: string): boolean {
    return this.find(code, sub) >= 0;
  }

  /** i 위치의 code에서 시작하는 점(바로 뒤 태그가 Y·Z면 함께 읽는다) */
  pointAt(i: number): Vec3 {
    const c = this.codes[i]!;
    const x = num(this.values[i]);
    let y = 0;
    let z = 0;
    if (this.codes[i + 1] === c + 10) {
      y = num(this.values[i + 1]);
      if (this.codes[i + 2] === c + 20) z = num(this.values[i + 2]);
    }
    return { x, y, z };
  }

  point2At(i: number): Vec2 {
    const p = this.pointAt(i);
    return { x: p.x, y: p.y };
  }

  /** code의 모든 값 */
  all(code: number): TagValue[] {
    const out: TagValue[] = [];
    for (let i = 0; i < this.codes.length; i++) if (this.codes[i] === code) out.push(this.values[i]!);
    return out;
  }

  raw(): RawTag[] {
    return this.codes.map((code, i) => ({ code, value: this.values[i]! }));
  }
}

export function parseColor(aci: number | undefined, rgb: number | undefined, name: string | undefined): CadColor {
  const c: CadColor = { aci: aci === undefined ? 256 : aci };
  if (rgb !== undefined) c.rgb = rgb & 0xffffff;
  if (name) c.name = name;
  return c;
}

/** 확장 데이터 태그 해석(1001부터 끝까지) */
export function parseXData(codes: number[], values: TagValue[], start: number): XData[] {
  const out: XData[] = [];
  let cur: XData | null = null;
  for (let i = start; i < codes.length; i++) {
    const code = codes[i]!;
    const v = values[i]!;
    if (code === 1001) {
      cur = { app: str(v), items: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    let item: XDataItem;
    if (code >= 1010 && code <= 1013) {
      const x = num(v);
      let y = 0;
      let z = 0;
      if (codes[i + 1] === code + 10) {
        y = num(values[i + 1]);
        i++;
        if (codes[i + 1] === code + 20) {
          z = num(values[i + 1]);
          i++;
        }
      }
      item = { code, value: { x, y, z } };
    } else if (code === 1004) {
      item = { code, value: hexToBytes(str(v)) };
    } else if ((code >= 1040 && code <= 1042) || (code >= 1060 && code <= 1071)) {
      item = { code, value: num(v) };
    } else {
      item = { code, value: str(v) };
    }
    cur.items.push(item);
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.trim();
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

/** 확장 데이터에서 앱 이름(대소문자 무시)으로 찾기 */
export function findXData(xdata: XData[] | undefined, app: string): XData | undefined {
  if (!xdata) return undefined;
  const a = app.toUpperCase();
  return xdata.find((x) => x.app.toUpperCase() === a);
}

/**
 * ACAD DSTYLE 재지정: 1000 "DSTYLE", 1002 "{", (1070 코드, 값)… 1002 "}"
 * 반환: 그룹 코드 → 값
 */
export function parseDimOverrides(xdata: XData[] | undefined): Record<number, string | number> | undefined {
  const x = findXData(xdata, 'ACAD');
  if (!x) return undefined;
  const items = x.items;
  let i = items.findIndex((it) => it.code === 1000 && String(it.value).toUpperCase() === 'DSTYLE');
  if (i < 0) return undefined;
  i++;
  if (items[i]?.code === 1002) i++;
  const out: Record<number, string | number> = {};
  for (; i + 1 < items.length; i += 2) {
    const k = items[i]!;
    if (k.code === 1002) break;
    if (k.code !== 1070) break;
    const v = items[i + 1]!.value;
    out[Number(k.value)] = typeof v === 'number' || typeof v === 'string' ? v : String(v);
  }
  return out;
}
