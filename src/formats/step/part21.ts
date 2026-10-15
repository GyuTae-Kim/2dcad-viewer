/**
 * ISO 10303-21(STEP 물리 파일) 읽기.
 *
 * 수백 MB 파일도 다룰 수 있게 바이트 단위로 한 번 훑어 인스턴스 위치(시작·끝 바이트)와 개체 이름만 색인하고,
 * 인자는 필요할 때 해석한다(지연 해석, 크기 제한이 있는 캐시).
 *
 * 지원: HEADER(FILE_DESCRIPTION·FILE_NAME·FILE_SCHEMA), 여러 DATA 구역, 단순 인스턴스 `#n=ENTITY(…);`,
 * 복합 인스턴스 `#n=(A(…)B(…));`, 문자열 인코딩(`''`, `\\`, `\S\`, `\P?\`, `\X\hh`, `\X2\…\X0\`, `\X4\…\X0\`,
 * 날 UTF-8), 열거 `.T.`, `$`, `*`, 형식 있는 값 `LENGTH_MEASURE(1.)`, 2진 `"…"`, 목록 중첩, 주석 `/* *\/`.
 */

/** 인스턴스 참조 `#n` */
export class StepRef {
  constructor(readonly id: number) {}
}

/** 열거 값 `.NAME.`(대문자) */
export class StepEnum {
  constructor(readonly value: string) {}
}

/** 형식 있는 값 `TYPE(value)` */
export class StepTyped {
  constructor(
    readonly type: string,
    readonly value: StepValue,
  ) {}
}

/** 2진 값 `"…"`(16진 문자열 그대로) */
export class StepBinary {
  constructor(readonly hex: string) {}
}

/** 파생 값 `*` */
export const DERIVED: unique symbol = Symbol('derived');

/** 해석된 인자 값. `$`(값 없음)은 null */
export type StepValue =
  | number
  | string
  | StepRef
  | StepEnum
  | StepTyped
  | StepBinary
  | StepValue[]
  | null
  | typeof DERIVED;

/** 복합 인스턴스의 한 부분 */
export interface StepPart {
  type: string;
  args: StepValue[];
}

/** 해석된 인스턴스. 복합 인스턴스는 type이 '+'로 이은 부분 이름이고 parts가 있다 */
export interface StepEntity {
  id: number;
  type: string;
  args: StepValue[];
  parts?: StepPart[];
}

export interface StepHeader {
  description: string[];
  implementationLevel: string;
  name: string;
  timeStamp: string;
  author: string[];
  organization: string[];
  preprocessorVersion: string;
  originatingSystem: string;
  authorization: string;
  schemas: string[];
}

const COMPLEX = 0xffffffff;

const C_HASH = 0x23; // #
const C_EQ = 0x3d; // =
const C_SEMI = 0x3b; // ;
const C_LP = 0x28;
const C_RP = 0x29;
const C_COMMA = 0x2c;
const C_QUOTE = 0x27; // '
const C_DQUOTE = 0x22; // "
const C_SLASH = 0x2f;
const C_STAR = 0x2a;
const C_DOLLAR = 0x24;
const C_DOT = 0x2e;
const C_BSL = 0x5c; // \

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x0b;
}
function isKeyChar(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x5f || c === 0x21 || c === 0x2d;
}
function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

const POW10 = [1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22];

let utf8Fatal: TextDecoder | null = null;
function decodeRawBytes(bytes: Uint8Array): string {
  try {
    utf8Fatal ??= new TextDecoder('utf-8', { fatal: true });
    return utf8Fatal.decode(bytes);
  } catch {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
    return s;
  }
}

const isoDecoders = new Map<number, TextDecoder | null>();
/** ISO 8859-n 위쪽 반(0x80~0xFF) 글자 하나 */
function iso8859Char(page: number, code: number): string {
  if (page === 1) return String.fromCharCode(code);
  let dec = isoDecoders.get(page);
  if (dec === undefined) {
    try {
      dec = new TextDecoder(`iso-8859-${page}`);
    } catch {
      dec = null;
    }
    isoDecoders.set(page, dec);
  }
  return dec ? dec.decode(new Uint8Array([code])) : String.fromCharCode(code);
}

function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

/**
 * 문자열 본문(따옴표 안쪽 바이트)을 해독한다.
 * `''`→`'`, `\\`→`\`, `\S\c`(현재 ISO 8859 쪽의 c+128), `\P?\`(쪽 바꾸기), `\X\hh`, `\X2\…\X0\`, `\X4\…\X0\`,
 * 그 밖의 8비트 바이트는 UTF-8로(실패하면 Latin-1로) 읽는다.
 */
export function decodeStepString(b: Uint8Array, s: number, e: number): string {
  let simple = true;
  for (let i = s; i < e; i++) {
    const c = b[i]!;
    if (c === C_BSL || c === C_QUOTE || c >= 0x80 || c === 0x0a || c === 0x0d) {
      simple = false;
      break;
    }
  }
  if (simple) {
    let out = '';
    // 짧은 문자열은 한 번에 만든다
    for (let i = s; i < e; i += 4096) out += String.fromCharCode.apply(null, Array.from(b.subarray(i, Math.min(e, i + 4096))));
    return out;
  }
  let out = '';
  let page = 1;
  let raw: number[] = [];
  const flushRaw = () => {
    if (raw.length) {
      out += decodeRawBytes(Uint8Array.from(raw));
      raw = [];
    }
  };
  let i = s;
  while (i < e) {
    const c = b[i]!;
    if (c === C_QUOTE) {
      // '' → '
      raw.push(C_QUOTE);
      i += b[i + 1] === C_QUOTE ? 2 : 1;
      continue;
    }
    if (c === 0x0a || c === 0x0d) {
      // 줄바꿈은 교환 구조의 일부가 아니다(긴 문자열을 나눠 쓴 파일)
      i++;
      continue;
    }
    if (c !== C_BSL) {
      raw.push(c);
      i++;
      continue;
    }
    const d = b[i + 1];
    if (d === C_BSL) {
      raw.push(C_BSL);
      i += 2;
      continue;
    }
    if (d === 0x53 /* S */ && b[i + 2] === C_BSL && i + 3 < e) {
      flushRaw();
      out += iso8859Char(page, (b[i + 3]! & 0x7f) + 128);
      i += 4;
      continue;
    }
    if (d === 0x50 /* P */ && b[i + 3] === C_BSL) {
      const p = b[i + 2]! - 0x40; // A=1
      if (p >= 1 && p <= 9) page = p;
      i += 4;
      continue;
    }
    if (d === 0x58 /* X */) {
      const k = b[i + 2];
      if (k === C_BSL) {
        // \X\hh
        const h1 = hexVal(b[i + 3] ?? 0);
        const h2 = hexVal(b[i + 4] ?? 0);
        if (h1 >= 0 && h2 >= 0) {
          flushRaw();
          out += String.fromCharCode(h1 * 16 + h2);
          i += 5;
          continue;
        }
      } else if ((k === 0x32 || k === 0x34) && b[i + 3] === C_BSL) {
        // \X2\ 또는 \X4\ … \X0\
        flushRaw();
        const w = k === 0x32 ? 4 : 8;
        let j = i + 4;
        while (j + w <= e) {
          if (b[j] === C_BSL) break;
          let v = 0;
          let ok = true;
          for (let q = 0; q < w; q++) {
            const h = hexVal(b[j + q]!);
            if (h < 0) ok = false;
            v = v * 16 + h;
          }
          if (!ok) break;
          out += w === 4 ? String.fromCharCode(v) : String.fromCodePoint(Math.min(v, 0x10ffff));
          j += w;
        }
        // \X0\ 닫기
        if (b[j] === C_BSL && b[j + 1] === 0x58 && b[j + 2] === 0x30 && b[j + 3] === C_BSL) j += 4;
        i = j;
        continue;
      }
    }
    if (d === 0x4e /* N */ && b[i + 2] === C_BSL) {
      // 일부 내보내기가 쓰는 줄바꿈 표시
      raw.push(0x0a);
      i += 3;
      continue;
    }
    // 알 수 없는 지시는 글자 그대로
    raw.push(c);
    i++;
  }
  flushRaw();
  return out;
}

/** 지연 해석 캐시 상한(개체 수). 넘으면 비운다 */
const CACHE_LIMIT = 400_000;

export class StepParseError extends Error {}

/**
 * STEP 파일 색인. 생성 시 DATA 구역을 한 번 훑어 인스턴스 위치를 기록한다.
 */
export class StepFile {
  readonly bytes: Uint8Array;
  readonly header: StepHeader;
  /** 색인된 인스턴스 수 */
  readonly count: number;
  /** 문법 오류로 건너뛴 문장 수 */
  readonly skipped: number;
  /** 형식 이름 표(번호 → 이름) */
  readonly typeNames: string[] = [];

  private ids: Uint32Array;
  private starts: Uint32Array;
  private ends: Uint32Array;
  private types: Uint32Array;
  private dense: Int32Array | null = null;
  private sparse: Map<number, number> | null = null;
  private typeLookup = new Map<string, number>();
  private byType: Map<number, number[]> | null = null;
  private complexParts: Map<number, string[]> | null = null;
  private cache = new Map<number, StepEntity>();
  private pos = 0;
  private end = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    let cap = Math.max(1024, Math.ceil(bytes.length / 48));
    let ids = new Uint32Array(cap);
    let starts = new Uint32Array(cap);
    let ends = new Uint32Array(cap);
    let types = new Uint32Array(cap);
    let n = 0;
    let skipped = 0;
    let maxId = 0;
    const header: StepHeader = {
      description: [],
      implementationLevel: '',
      name: '',
      timeStamp: '',
      author: [],
      organization: [],
      preprocessorVersion: '',
      originatingSystem: '',
      authorization: '',
      schemas: [],
    };
    const b = bytes;
    const len = b.length;
    let i = 0;
    let section: 'none' | 'header' | 'data' = 'none';
    while (i < len) {
      // 공백·주석 건너뛰기
      const c = b[i]!;
      if (isSpace(c)) {
        i++;
        continue;
      }
      if (c === C_SLASH && b[i + 1] === C_STAR) {
        i = this.skipComment(i);
        continue;
      }
      if (section === 'data' && c === C_HASH) {
        // #n = …;
        let j = i + 1;
        let id = 0;
        while (j < len && isDigit(b[j]!)) id = id * 10 + (b[j++]! - 0x30);
        while (j < len && (isSpace(b[j]!) || (b[j] === C_SLASH && b[j + 1] === C_STAR))) j = isSpace(b[j]!) ? j + 1 : this.skipComment(j);
        const stmtEnd = this.scanToSemicolon(j);
        if (b[j] !== C_EQ || j === i + 1) {
          skipped++;
          i = stmtEnd + 1;
          continue;
        }
        j++;
        while (j < len && (isSpace(b[j]!) || (b[j] === C_SLASH && b[j + 1] === C_STAR))) j = isSpace(b[j]!) ? j + 1 : this.skipComment(j);
        let t: number;
        if (b[j] === C_LP) t = COMPLEX;
        else {
          let k = j;
          while (k < len && isKeyChar(b[k]!)) k++;
          if (k === j) {
            skipped++;
            i = stmtEnd + 1;
            continue;
          }
          t = this.internBytes(j, k);
        }
        if (n === cap) {
          cap *= 2;
          const grow = (a: Uint32Array) => {
            const r = new Uint32Array(cap);
            r.set(a);
            return r;
          };
          ids = grow(ids);
          starts = grow(starts);
          ends = grow(ends);
          types = grow(types);
        }
        ids[n] = id;
        starts[n] = j;
        ends[n] = stmtEnd;
        types[n] = t;
        n++;
        if (id > maxId) maxId = id;
        i = stmtEnd + 1;
        continue;
      }
      // 키워드 문장
      let k = i;
      while (k < len && isKeyChar(b[k]!)) k++;
      if (k === i) {
        // 알 수 없는 바이트: 다음 ;까지 건너뛴다
        skipped++;
        i = this.scanToSemicolon(i) + 1;
        continue;
      }
      const kw = latin1(b, i, k).toUpperCase();
      const stmtEnd = this.scanToSemicolon(k);
      if (kw === 'HEADER') section = 'header';
      else if (kw === 'DATA') section = 'data';
      else if (kw === 'ENDSEC') section = 'none';
      else if (kw === 'END-ISO-10303-21') break;
      else if (section === 'header') {
        try {
          this.pos = k;
          this.end = stmtEnd;
          this.skipWs();
          if (b[this.pos] === C_LP) {
            const args = this.parseList();
            readHeaderEntity(header, kw, args);
          }
        } catch {
          skipped++;
        }
      }
      i = stmtEnd + 1;
    }
    this.ids = ids.subarray(0, n);
    this.starts = starts.subarray(0, n);
    this.ends = ends.subarray(0, n);
    this.types = types.subarray(0, n);
    this.count = n;
    this.skipped = skipped;
    this.header = header;
    if (maxId <= n * 4 + 1_000_000) {
      const d = new Int32Array(maxId + 1).fill(-1);
      for (let q = 0; q < n; q++) d[ids[q]!] = q;
      this.dense = d;
    } else {
      const m = new Map<number, number>();
      for (let q = 0; q < n; q++) m.set(ids[q]!, q);
      this.sparse = m;
    }
  }

  private skipComment(i: number): number {
    const b = this.bytes;
    let j = i + 2;
    while (j < b.length && !(b[j] === C_STAR && b[j + 1] === C_SLASH)) j++;
    return Math.min(b.length, j + 2);
  }

  /** i부터 문자열·주석 밖의 ;를 찾는다(없으면 파일 끝) */
  private scanToSemicolon(i: number): number {
    const b = this.bytes;
    const len = b.length;
    while (i < len) {
      const c = b[i]!;
      if (c === C_SEMI) return i;
      if (c === C_QUOTE) {
        i++;
        while (i < len) {
          if (b[i] === C_QUOTE) {
            if (b[i + 1] === C_QUOTE) i += 2;
            else break;
          } else i++;
        }
        i++;
        continue;
      }
      if (c === C_SLASH && b[i + 1] === C_STAR) {
        i = this.skipComment(i);
        continue;
      }
      i++;
    }
    return len;
  }

  private internBytes(s: number, e: number): number {
    const b = this.bytes;
    let lower = false;
    for (let i = s; i < e; i++) if (b[i]! >= 0x61 && b[i]! <= 0x7a) lower = true;
    let name = latin1(b, s, e);
    if (lower) name = name.toUpperCase();
    return this.intern(name);
  }

  private intern(name: string): number {
    let t = this.typeLookup.get(name);
    if (t === undefined) {
      t = this.typeNames.length;
      this.typeNames.push(name);
      this.typeLookup.set(name, t);
    }
    return t;
  }

  private indexOf(id: number): number {
    if (this.dense) return id < this.dense.length ? this.dense[id]! : -1;
    return this.sparse!.get(id) ?? -1;
  }

  /** 인스턴스가 있는지 */
  has(id: number): boolean {
    return this.indexOf(id) >= 0;
  }

  /** 단순 인스턴스의 개체 이름(복합이면 'COMPLEX', 없으면 '') */
  typeOf(id: number): string {
    const q = this.indexOf(id);
    if (q < 0) return '';
    const t = this.types[q]!;
    return t === COMPLEX ? 'COMPLEX' : this.typeNames[t]!;
  }

  /** 개체 이름별 인스턴스 수(복합 인스턴스는 부분마다 센다) */
  typeCounts(): Map<string, number> {
    const m = new Map<string, number>();
    for (const [t, list] of this.typeIndex()) m.set(this.typeNames[t]!, list.length);
    return m;
  }

  private typeIndex(): Map<number, number[]> {
    if (this.byType) return this.byType;
    const m = new Map<number, number[]>();
    const cp = new Map<number, string[]>();
    for (let q = 0; q < this.count; q++) {
      let t = this.types[q]!;
      if (t === COMPLEX) {
        const names = this.complexNames(q);
        cp.set(this.ids[q]!, names);
        for (const nm of names) {
          t = this.intern(nm);
          let l = m.get(t);
          if (!l) m.set(t, (l = []));
          l.push(this.ids[q]!);
        }
        continue;
      }
      let l = m.get(t);
      if (!l) m.set(t, (l = []));
      l.push(this.ids[q]!);
    }
    this.byType = m;
    this.complexParts = cp;
    return m;
  }

  /** 복합 인스턴스의 부분 이름들(인자는 해석하지 않는다) */
  private complexNames(q: number): string[] {
    const b = this.bytes;
    const names: string[] = [];
    let i = this.starts[q]! + 1;
    const e = this.ends[q]!;
    let depth = 0;
    while (i < e) {
      const c = b[i]!;
      if (c === C_QUOTE) {
        i++;
        while (i < e) {
          if (b[i] === C_QUOTE) {
            if (b[i + 1] === C_QUOTE) i += 2;
            else break;
          } else i++;
        }
        i++;
        continue;
      }
      if (c === C_LP) depth++;
      else if (c === C_RP) depth--;
      else if (depth === 0 && isKeyChar(c) && !isDigit(c)) {
        let k = i;
        while (k < e && isKeyChar(b[k]!)) k++;
        names.push(latin1(b, i, k).toUpperCase());
        i = k;
        continue;
      }
      i++;
    }
    return names;
  }

  /** 개체 이름(복합 인스턴스의 부분 이름 포함)으로 인스턴스 번호 목록 */
  idsOfType(name: string): number[] {
    const idx = this.typeIndex();
    const t = this.typeLookup.get(name.toUpperCase());
    if (t === undefined) return [];
    return idx.get(t) ?? [];
  }

  /** 복합 인스턴스의 부분 이름(복합이 아니면 undefined) */
  partNames(id: number): string[] | undefined {
    const q = this.indexOf(id);
    if (q < 0 || this.types[q] !== COMPLEX) return undefined;
    this.typeIndex();
    return this.complexParts!.get(id);
  }

  /** 모든 인스턴스 번호(파일 순서) */
  allIds(): Uint32Array {
    return this.ids;
  }

  /** 인스턴스를 해석해 돌려준다(없거나 문법 오류면 undefined) */
  get(id: number): StepEntity | undefined {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const q = this.indexOf(id);
    if (q < 0) return undefined;
    let ent: StepEntity;
    try {
      ent = this.parseAt(q);
    } catch {
      return undefined;
    }
    if (this.cache.size >= CACHE_LIMIT) this.cache.clear();
    this.cache.set(id, ent);
    return ent;
  }

  /** 캐시를 비운다(큰 파일에서 단계 사이에) */
  clearCache(): void {
    this.cache.clear();
  }

  private parseAt(q: number): StepEntity {
    const id = this.ids[q]!;
    this.pos = this.starts[q]!;
    this.end = this.ends[q]!;
    const t = this.types[q]!;
    const b = this.bytes;
    if (t !== COMPLEX) {
      while (this.pos < this.end && isKeyChar(b[this.pos]!)) this.pos++;
      this.skipWs();
      const args = this.parseList();
      return { id, type: this.typeNames[t]!, args };
    }
    // 복합: ( A(…) B(…) … )
    this.pos++;
    const parts: StepPart[] = [];
    for (;;) {
      this.skipWs();
      if (this.pos >= this.end || b[this.pos] === C_RP) break;
      const s = this.pos;
      while (this.pos < this.end && isKeyChar(b[this.pos]!)) this.pos++;
      if (this.pos === s) throw new StepParseError(`#${id}: 복합 인스턴스 문법`);
      const name = latin1(b, s, this.pos).toUpperCase();
      this.skipWs();
      const args = b[this.pos] === C_LP ? this.parseList() : [];
      parts.push({ type: name, args });
    }
    return { id, type: parts.map((p) => p.type).join('+'), args: [], parts };
  }

  private skipWs(): void {
    const b = this.bytes;
    while (this.pos < this.end) {
      const c = b[this.pos]!;
      if (isSpace(c)) this.pos++;
      else if (c === C_SLASH && b[this.pos + 1] === C_STAR) this.pos = this.skipComment(this.pos);
      else break;
    }
  }

  /** '(' 값, 값 … ')' */
  private parseList(): StepValue[] {
    const b = this.bytes;
    if (b[this.pos] !== C_LP) throw new StepParseError('( 가 필요하다');
    this.pos++;
    const out: StepValue[] = [];
    this.skipWs();
    if (b[this.pos] === C_RP) {
      this.pos++;
      return out;
    }
    for (;;) {
      out.push(this.parseValue());
      this.skipWs();
      const c = b[this.pos];
      if (c === C_COMMA) {
        this.pos++;
        continue;
      }
      if (c === C_RP) {
        this.pos++;
        return out;
      }
      throw new StepParseError(`예상하지 못한 바이트 ${c} @${this.pos}`);
    }
  }

  private parseValue(): StepValue {
    this.skipWs();
    const b = this.bytes;
    const c = b[this.pos]!;
    if (c === C_HASH || c === 0x40 /* @ */) {
      let j = this.pos + 1;
      let id = 0;
      while (j < this.end && isDigit(b[j]!)) id = id * 10 + (b[j++]! - 0x30);
      this.pos = j;
      return new StepRef(id);
    }
    if (c === C_QUOTE) {
      const s = this.pos + 1;
      let j = s;
      while (j < this.end) {
        if (b[j] === C_QUOTE) {
          if (b[j + 1] === C_QUOTE) j += 2;
          else break;
        } else j++;
      }
      this.pos = j + 1;
      return decodeStepString(b, s, j);
    }
    if (c === C_LP) return this.parseList();
    if (c === C_DOLLAR) {
      this.pos++;
      return null;
    }
    if (c === C_STAR) {
      this.pos++;
      return DERIVED;
    }
    if (c === C_DOT) {
      const s = this.pos + 1;
      let j = s;
      while (j < this.end && b[j] !== C_DOT) j++;
      this.pos = j + 1;
      return new StepEnum(latin1(b, s, j).toUpperCase());
    }
    if (c === C_DQUOTE) {
      const s = this.pos + 1;
      let j = s;
      while (j < this.end && b[j] !== C_DQUOTE) j++;
      this.pos = j + 1;
      return new StepBinary(latin1(b, s, j));
    }
    if (isDigit(c) || c === 0x2d || c === 0x2b) return this.parseNumber();
    if (isKeyChar(c)) {
      const s = this.pos;
      while (this.pos < this.end && isKeyChar(b[this.pos]!)) this.pos++;
      const name = latin1(b, s, this.pos).toUpperCase();
      this.skipWs();
      if (b[this.pos] === C_LP) {
        const inner = this.parseList();
        return new StepTyped(name, inner.length === 1 ? inner[0]! : inner);
      }
      return new StepTyped(name, null);
    }
    throw new StepParseError(`알 수 없는 값 바이트 ${c} @${this.pos}`);
  }

  private parseNumber(): number {
    const b = this.bytes;
    const s = this.pos;
    let i = s;
    let neg = false;
    if (b[i] === 0x2d) {
      neg = true;
      i++;
    } else if (b[i] === 0x2b) i++;
    let mant = 0;
    let digits = 0;
    let exp10 = 0;
    while (i < this.end && isDigit(b[i]!)) {
      if (digits < 18) {
        mant = mant * 10 + (b[i]! - 0x30);
        if (mant !== 0) digits++;
      } else exp10++;
      i++;
    }
    if (b[i] === C_DOT) {
      i++;
      while (i < this.end && isDigit(b[i]!)) {
        if (digits < 18) {
          mant = mant * 10 + (b[i]! - 0x30);
          if (mant !== 0) digits++;
          exp10--;
        }
        i++;
      }
    }
    if (b[i] === 0x45 || b[i] === 0x65) {
      i++;
      let eneg = false;
      if (b[i] === 0x2d) {
        eneg = true;
        i++;
      } else if (b[i] === 0x2b) i++;
      let ev = 0;
      while (i < this.end && isDigit(b[i]!)) ev = ev * 10 + (b[i++]! - 0x30);
      exp10 += eneg ? -ev : ev;
    }
    this.pos = i;
    if (digits <= 15 && exp10 >= -22 && exp10 <= 22) {
      const v = exp10 < 0 ? mant / POW10[-exp10]! : mant * POW10[exp10]!;
      return neg ? -v : v;
    }
    // 유효 숫자가 많으면 정확히 반올림되게 표준 해석(부호 포함)
    return parseFloat(latin1(b, s, i));
  }
}

function latin1(b: Uint8Array, s: number, e: number): string {
  if (e - s < 64) {
    let r = '';
    for (let i = s; i < e; i++) r += String.fromCharCode(b[i]!);
    return r;
  }
  return String.fromCharCode.apply(null, Array.from(b.subarray(s, e)));
}

function strList(v: StepValue | undefined): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : [];
}
function str(v: StepValue | undefined): string {
  return typeof v === 'string' ? v : '';
}

function readHeaderEntity(h: StepHeader, kw: string, a: StepValue[]): void {
  if (kw === 'FILE_DESCRIPTION') {
    h.description = strList(a[0]);
    h.implementationLevel = str(a[1]);
  } else if (kw === 'FILE_NAME') {
    h.name = str(a[0]);
    h.timeStamp = str(a[1]);
    h.author = strList(a[2]);
    h.organization = strList(a[3]);
    h.preprocessorVersion = str(a[4]);
    h.originatingSystem = str(a[5]);
    h.authorization = str(a[6]);
  } else if (kw === 'FILE_SCHEMA') {
    h.schemas = strList(a[0]);
  }
}

// ── 값 꺼내기 도우미 ──

/** 인자에서 참조 번호(아니면 0) */
export function refId(v: StepValue | undefined): number {
  return v instanceof StepRef ? v.id : 0;
}
/** 숫자(형식 있는 값이면 안의 숫자) */
export function num(v: StepValue | undefined, dflt = NaN): number {
  if (typeof v === 'number') return v;
  if (v instanceof StepTyped) return num(v.value, dflt);
  return dflt;
}
/** 목록(아니면 빈 목록) */
export function list(v: StepValue | undefined): StepValue[] {
  return Array.isArray(v) ? v : [];
}
/** 참조 목록 */
export function refList(v: StepValue | undefined): number[] {
  const out: number[] = [];
  for (const x of list(v)) if (x instanceof StepRef) out.push(x.id);
  return out;
}
/** 숫자 목록 */
export function numList(v: StepValue | undefined): number[] {
  return list(v).map((x) => num(x));
}
/** 문자열 */
export function text(v: StepValue | undefined): string {
  return typeof v === 'string' ? v : '';
}
/** 열거 값 이름(아니면 '') */
export function enumOf(v: StepValue | undefined): string {
  return v instanceof StepEnum ? v.value : '';
}
/** .T./.F. 논리값(.U. 또는 없음이면 dflt) */
export function bool(v: StepValue | undefined, dflt = true): boolean {
  if (v instanceof StepEnum) {
    if (v.value === 'T' || v.value === 'TRUE') return true;
    if (v.value === 'F' || v.value === 'FALSE') return false;
  }
  return dflt;
}

/** 복합 인스턴스에서 부분 하나 */
export function partOf(e: StepEntity, type: string): StepPart | undefined {
  return e.parts?.find((p) => p.type === type);
}
/** 인스턴스가 그 형식이거나 그 부분을 가지는지 */
export function isA(e: StepEntity, type: string): boolean {
  return e.type === type || (e.parts?.some((p) => p.type === type) ?? false);
}
