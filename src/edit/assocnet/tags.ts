/**
 * 연관 망 객체의 원본 태그(GenericObject.raw)를 차례로 읽고 쓰는 작은 도우미.
 * DXF 리더는 값을 글로 두기도 하고(앞뒤 빈칸 포함) DWG 코덱은 수로 두므로 읽을 때 늘 정규화한다.
 */
import type { RawTag, Vec3 } from '../../core/model';
import { normalizeHandle } from '../../core/model';

/** 배치가 표본에서 본 것과 다를 때(부르는 쪽은 그 객체를 해석하지 않고 원본 그대로 둔다) */
export class AssocFormatError extends Error {}

export const fail = (what: string): never => {
  throw new AssocFormatError(what);
};

export const num = (v: string | number | undefined, d = 0): number => {
  if (v === undefined) return d;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : d;
};
export const int = (v: string | number | undefined, d = 0): number => Math.trunc(num(v, d));
/** 글 값(앞뒤 빈칸은 DXF 줄 맞춤이 아니면 그대로 둔다 — 이름·식은 빈칸이 뜻을 가질 수 있다) */
export const str = (v: string | number | undefined): string => (v === undefined ? '' : String(v));
/** 핸들(0·빈 값은 '') */
export const hnd = (v: string | number | undefined): string => {
  const s = str(v).trim();
  return s && s !== '0' ? normalizeHandle(s) : '';
};

/** 태그 읽기 커서 */
export class TagReader {
  i: number;
  constructor(
    readonly t: readonly RawTag[],
    start = 0,
  ) {
    this.i = start;
  }
  get done(): boolean {
    return this.i >= this.t.length;
  }
  peek(off = 0): RawTag | undefined {
    return this.t[this.i + off];
  }
  is(code: number, off = 0): boolean {
    return this.t[this.i + off]?.code === code;
  }
  /** 이 코드면 값을 꺼낸다(아니면 undefined, 자리는 그대로) */
  opt(code: number): string | number | undefined {
    const x = this.t[this.i];
    if (!x || x.code !== code) return undefined;
    this.i++;
    return x.value;
  }
  need(code: number): string | number {
    const x = this.t[this.i];
    if (!x || x.code !== code) fail(`태그 ${code} 자리(${this.i})에 ${x ? x.code : '끝'}`);
    this.i++;
    return x!.value;
  }
  int(code = 90): number {
    return int(this.need(code));
  }
  num(code = 40): number {
    return num(this.need(code));
  }
  bool(code = 290): boolean {
    return int(this.need(code)) !== 0;
  }
  str(code = 1): string {
    return str(this.need(code));
  }
  hnd(code: number): string {
    return hnd(this.need(code));
  }
  /** 점(code, code+10, code+20) */
  pt(code = 10): Vec3 {
    const x = num(this.need(code));
    const y = num(this.need(code + 10));
    const z = num(this.need(code + 20));
    return { x, y, z };
  }
  /** 서브클래스 표지(100 name) */
  sub(name: string): void {
    const v = str(this.need(100)).trim();
    if (v !== name) fail(`서브클래스 ${name} 자리에 ${v}`);
  }
  isSub(name: string): boolean {
    const x = this.t[this.i];
    return !!x && x.code === 100 && str(x.value).trim() === name;
  }
  /** 다음 서브클래스 표지(100) 앞까지 남은 태그 */
  rest(): RawTag[] {
    const out: RawTag[] = [];
    while (this.i < this.t.length && this.t[this.i]!.code !== 100) out.push(this.t[this.i++]!);
    return out;
  }
}

/** 태그 쓰기 */
export class TagWriter {
  readonly out: RawTag[] = [];
  t(code: number, value: string | number): this {
    this.out.push({ code, value });
    return this;
  }
  int(code: number, v: number): this {
    return this.t(code, Math.trunc(v));
  }
  num(code: number, v: number): this {
    return this.t(code, Number.isFinite(v) ? v : 0);
  }
  bool(code: number, v: boolean): this {
    return this.t(code, v ? 1 : 0);
  }
  str(code: number, v: string): this {
    return this.t(code, v);
  }
  hnd(code: number, h: string): this {
    return this.t(code, h ? normalizeHandle(h) : '0');
  }
  pt(code: number, p: Vec3): this {
    return this.num(code, p.x).num(code + 10, p.y).num(code + 20, p.z);
  }
  sub(name: string): this {
    return this.t(100, name);
  }
  tags(list: readonly RawTag[]): this {
    for (const x of list) this.out.push({ ...x });
    return this;
  }
}

/** 두 태그 목록이 같은 값인지(수는 수로, 핸들은 정규화해 비교) */
export function sameTags(a: readonly RawTag[], b: readonly RawTag[], eps = 0): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameTag(a[i]!, b[i]!, eps)) return false;
  return true;
}

const HANDLE_CODES = (c: number) => (c >= 320 && c <= 369) || (c >= 390 && c <= 399) || (c >= 480 && c <= 481) || c === 5 || c === 105;

export function sameTag(a: RawTag, b: RawTag, eps = 0): boolean {
  if (a.code !== b.code) return false;
  const c = a.code;
  if (HANDLE_CODES(c)) return hnd(a.value) === hnd(b.value);
  const isNum = (c >= 10 && c <= 59) || (c >= 60 && c <= 99) || (c >= 140 && c <= 149) || (c >= 170 && c <= 179) || (c >= 270 && c <= 299) || (c >= 1010 && c <= 1071);
  if (isNum) {
    const x = num(a.value, NaN);
    const y = num(b.value, NaN);
    if (Number.isNaN(x) || Number.isNaN(y)) return str(a.value).trim() === str(b.value).trim();
    return x === y || Math.abs(x - y) <= eps * Math.max(1, Math.abs(x), Math.abs(y));
  }
  return str(a.value) === str(b.value);
}
