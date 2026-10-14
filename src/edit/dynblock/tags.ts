/**
 * 동적 블록 객체의 원본 태그(RawTag) 읽기 도우미.
 *
 * DXF 리더는 동적 블록 객체(매개변수·그립·동작·평가 그래프)를 해석하지 않고 GenericObject.raw에 서브클래스 표지(100)부터
 * 태그를 남긴다. 값은 파일 그대로의 문자열(앞 공백 포함)일 수도, 수일 수도 있다.
 */
import type { RawTag, Vec3, XData, XDataItem } from '../../core/model';

export function tagNum(v: string | number | undefined, def = 0): number {
  if (v === undefined) return def;
  if (typeof v === 'number') return Number.isFinite(v) ? v : def;
  const n = parseFloat(v.trim());
  return Number.isFinite(n) ? n : def;
}

export function tagInt(v: string | number | undefined, def = 0): number {
  if (v === undefined) return def;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : def;
  const n = parseInt(v.trim(), 10);
  return Number.isFinite(n) ? n : def;
}

export function tagStr(v: string | number | undefined, def = ''): string {
  if (v === undefined) return def;
  return typeof v === 'number' ? String(v) : v;
}

/** 핸들 값(앞 0·공백 없는 대문자) */
export function tagHandle(v: string | number | undefined): string {
  const s = tagStr(v).trim().toUpperCase().replace(/^0+(?=.)/, '');
  return s === '0' ? '' : s;
}

/** 서브클래스 표지(100)로 나눈 태그 묶음. 같은 이름이 여러 번이면 첫 것 */
export function subclasses(raw: readonly RawTag[] | undefined): Map<string, RawTag[]> {
  const out = new Map<string, RawTag[]>();
  let cur: RawTag[] | null = null;
  for (const t of raw ?? []) {
    if (t.code === 100) {
      const name = tagStr(t.value).trim();
      if (out.has(name)) cur = [];
      else {
        cur = [];
        out.set(name, cur);
      }
      continue;
    }
    cur?.push(t);
  }
  return out;
}

/**
 * 차례대로 읽는 커서. 기대한 코드가 아니면 기본값을 돌려주고 나아가지 않는다(선택적 태그).
 * 점은 코드 c, c+10, c+20 세 태그(셋째는 없을 수 있다)다.
 */
export class TagCursor {
  i = 0;
  constructor(readonly tags: readonly RawTag[]) {}

  get done(): boolean {
    return this.i >= this.tags.length;
  }

  peek(): number | undefined {
    return this.tags[this.i]?.code;
  }

  has(code: number): boolean {
    return this.peek() === code;
  }

  private take(code: number): string | number | undefined {
    const t = this.tags[this.i];
    if (!t || t.code !== code) return undefined;
    this.i++;
    return t.value;
  }

  int(code: number, def = 0): number {
    return tagInt(this.take(code), def);
  }

  num(code: number, def = 0): number {
    return tagNum(this.take(code), def);
  }

  str(code: number, def = ''): string {
    return tagStr(this.take(code), def);
  }

  handle(code: number): string {
    return tagHandle(this.take(code));
  }

  point(code: number): Vec3 {
    const x = this.take(code);
    if (x === undefined) return { x: 0, y: 0, z: 0 };
    const y = this.take(code + 10);
    const z = this.take(code + 20);
    return { x: tagNum(x), y: tagNum(y), z: tagNum(z) };
  }

  /** 다음 코드가 code가 아니면 건너뛰며 찾는다(stop 코드에서 멈춘다). 찾으면 참 */
  seek(code: number, stop: readonly number[] = []): boolean {
    for (let j = this.i; j < this.tags.length; j++) {
      const c = this.tags[j]!.code;
      if (c === code) {
        this.i = j;
        return true;
      }
      if (stop.includes(c)) return false;
    }
    return false;
  }

  skip(): void {
    this.i++;
  }
}

/** 확장 데이터에서 앱 이름의 항목들 */
export function xdataOf(list: readonly XData[] | undefined, app: string): XDataItem[] | null {
  const a = app.toUpperCase();
  for (const x of list ?? []) if (x.app.toUpperCase() === a) return x.items;
  return null;
}

/** 확장 데이터 앱 하나를 바꾼 사본(items가 null이면 뺀다) */
export function withXData(list: readonly XData[] | undefined, app: string, items: XDataItem[] | null): XData[] | undefined {
  const a = app.toUpperCase();
  const out = (list ?? []).filter((x) => x.app.toUpperCase() !== a).map((x) => ({ app: x.app, items: x.items.map((i) => ({ ...i })) }));
  if (items) {
    // 원래 자리를 지킨다
    const idx = (list ?? []).findIndex((x) => x.app.toUpperCase() === a);
    const entry = { app, items };
    if (idx >= 0 && idx <= out.length) out.splice(idx, 0, entry);
    else out.push(entry);
  }
  return out.length ? out : undefined;
}

export function fmtTag(code: number, value: number): RawTag {
  return { code, value };
}

export function pointTags(code: number, p: Vec3): RawTag[] {
  return [
    { code, value: p.x },
    { code: code + 10, value: p.y },
    { code: code + 20, value: p.z },
  ];
}
