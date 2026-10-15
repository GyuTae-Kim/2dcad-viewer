/**
 * 워커 → 메인 문서 전송용 값 부호화(구조화 복제를 대신한다).
 *
 * 수백만 객체의 문서를 postMessage로 그냥 보내면 메인 스레드의 역직렬화가 수 초~수십 초 걸린다
 * (V8은 객체마다 속성 이름 문자열을 다시 읽고 속성을 하나씩 붙인다).
 * 여기서는 값 나무를 형식 배열 몇 개와 문자열 표로 바꾼다.
 * - 같은 속성 이름 순서(모양)는 한 번만 적고, 메인은 모양마다 만든 객체 리터럴 함수로 객체를 만든다(숨은 클래스가 한 번에 정해진다).
 *   워커도 모양마다 속성을 이름으로 바로 읽는 쓰기 함수를 만들어 쓴다(속성 읽기가 한 모양만 보고, 수 값을 상자에 담지 않는다).
 * - 수는 Float64Array, 짧은 문자열은 표 하나(같은 값은 한 번), 바이트 배열은 버퍼 하나에 모은다(모두 transfer로 옮긴다).
 * - 수만 든 배열(폴리선 평탄 좌표·매듭 등)은 값마다 태그를 쓰지 않고 수 배열에 이어 적는다(되살리면 상자 없는 실수 배열).
 * - 얼린 객체(공유 ByLayer 색 등)는 같은 객체로 다시 만든다(구조화 복제처럼 한 번 보낸 안에서 공유를 지킨다).
 * - 순환 참조·함수·BigInt·희소 배열처럼 다루지 않는 값이 있으면 encode가 null을 돌려준다(그때는 구조화 복제로 보낸다).
 * 구조화 복제와 같게: 객체는 자기 열거 문자열 속성만(프로토타입은 버린다), undefined 값 속성도 남긴다, NaN·-0도 그대로.
 */

const T_UNDEF = 0;
const T_NULL = 1;
const T_FALSE = 2;
const T_TRUE = 3;
const T_NUM = 4;
const T_STR = 5;
const T_OBJ = 6;
const T_ARR = 7;
const T_MAP = 8;
const T_SET = 9;
const T_BIN = 10;
/** 앞서 만든 얼린 객체 다시 쓰기 */
const T_REF = 11;
/** 얼린 객체(처음): 모양 + 값, 다시 쓰도록 번호를 매긴다 */
const T_FROZEN = 12;
/** 작은 정수(0~255): 수 배열 대신 tags 다음 바이트에 */
const T_U8 = 13;
/** 수만 든 배열(정점 평탄 좌표·매듭 등): 길이 + 수 배열에 이어서(값마다 태그를 쓰지 않는다) */
const T_NUMS = 14;

/** 형식 배열 종류(bins 안에서) */
const BIN_KINDS = ['Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array', 'Uint8ClampedArray'] as const;
type BinKind = (typeof BIN_KINDS)[number];
const BIN_CTORS: Record<BinKind, { new (b: ArrayBuffer, o: number, n: number): ArrayBufferView; BYTES_PER_ELEMENT: number }> = {
  Uint8Array,
  Int8Array,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
  Uint8ClampedArray,
};

/** 부호화한 값(전송할 버퍼는 transfer 목록에) */
export interface Encoded {
  tags: Uint8Array;
  nums: Float64Array;
  ints: Int32Array;
  strs: string[];
  /** 모양마다 속성 이름 */
  shapes: string[][];
  /** 바이트 배열을 이어 붙인 것(8바이트 정렬) */
  bins: Uint8Array;
}

export function encodedTransfer(e: Encoded): ArrayBuffer[] {
  return [e.tags.buffer as ArrayBuffer, e.nums.buffer as ArrayBuffer, e.ints.buffer as ArrayBuffer, e.bins.buffer as ArrayBuffer];
}

class Unsupported extends Error {}

/**
 * 부호화 작업 버퍼(묶음마다 새로 만들지 않고 다시 쓴다). 큰 문서에서 묶음마다 형식 배열을 두 배씩 키우면
 * 바깥 메모리 때문에 V8이 큰 GC를 자주 하고, 살아 있는 문서가 클수록 GC 한 번이 비싸다.
 */
export interface EncoderScratch {
  tags: Uint8Array;
  nums: Float64Array;
  ints: Int32Array;
  bins: Uint8Array;
}

export function encoderScratch(): EncoderScratch {
  return { tags: new Uint8Array(1 << 16), nums: new Float64Array(1 << 14), ints: new Int32Array(1 << 14), bins: new Uint8Array(0) };
}

/** 값 여러 개를 이어서 부호화한다(모양·문자열 표를 함께 쓴다). finish로 끝낸다 */
export class Encoder {
  private tags: Uint8Array;
  private nt = 0;
  private nums: Float64Array;
  private nn = 0;
  private ints: Int32Array;
  private ni = 0;
  private readonly strs: string[] = [];
  private readonly strIds = new Map<string, number>();
  private readonly shapes: string[][] = [];
  /**
   * 모양마다 속성 자리별 문자열 같은 값 찾기 점수: 같은 값이 자주 나오면(도면층 이름 등) 표에서 찾고,
   * 거의 늘 새 값이면(핸들·문자 내용) 찾지 않고 바로 표에 넣는다 — 큰 찾기 표를 줄인다.
   */
  private readonly dedupe: Int32Array[] = [];
  /** 모양마다 만든 값 쓰기 함수(없으면 일반 반복) */
  private readonly writers: (ShapeWriter | null)[] = [];
  /** 첫 속성 이름 → 속성 수별 → 그 모양들(대개 한둘이라 이름을 차례로 맞춰 본다, 최근에 맞은 것이 앞) */
  private readonly byFirst = new Map<string, number[][]>();
  private readonly emptyShape: number[] = [];
  private bins: Uint8Array;
  private nb = 0;
  private readonly frozen = new Map<object, number>();
  private readonly keyBuf: string[] = [];

  /** scratch를 주면 그 버퍼를 쓰고 finish 때 (커졌으면 커진 버퍼를) 돌려놓는다 — 한 번에 Encoder 하나만 쓸 것 */
  constructor(private readonly scratch?: EncoderScratch) {
    const s = scratch ?? encoderScratch();
    this.tags = s.tags;
    this.nums = s.nums;
    this.ints = s.ints;
    this.bins = s.bins;
  }

  /** 값 하나를 덧붙인다. 다루지 않는 값이면 false(그때는 이 Encoder를 버린다) */
  add(v: unknown): boolean {
    try {
      this.value(v);
      return true;
    } catch (e) {
      // 순환 참조는 호출 깊이 초과로 끝난다
      if (e instanceof Unsupported || e instanceof RangeError) return false;
      throw e;
    }
  }

  finish(): Encoded {
    const sc = this.scratch;
    if (sc) {
      sc.tags = this.tags;
      sc.nums = this.nums;
      sc.ints = this.ints;
      sc.bins = this.bins;
    }
    return {
      tags: this.tags.slice(0, this.nt),
      nums: this.nums.slice(0, this.nn),
      ints: this.ints.slice(0, this.ni),
      strs: this.strs,
      shapes: this.shapes,
      bins: this.bins.slice(0, this.nb),
    };
  }

  private tag(t: number): void {
    if (this.nt >= this.tags.length) {
      const n = new Uint8Array(this.tags.length * 2);
      n.set(this.tags);
      this.tags = n;
    }
    this.tags[this.nt++] = t;
  }

  private int(v: number): void {
    if (this.ni >= this.ints.length) {
      const n = new Int32Array(this.ints.length * 2);
      n.set(this.ints);
      this.ints = n;
    }
    this.ints[this.ni++] = v;
  }

  /** 수 하나(모양별 쓰기 함수가 부르므로 private이 아니다) */
  num(v: number): void {
    // 0~255 정수는 태그 다음 바이트 하나로(-0은 수로)
    if (v >= 0 && v <= 255 && (v | 0) === v && !(v === 0 && 1 / v < 0)) {
      this.tag(T_U8);
      this.tag(v);
      return;
    }
    this.tag(T_NUM);
    if (this.nn >= this.nums.length) {
      const n = new Float64Array(this.nums.length * 2);
      n.set(this.nums);
      this.nums = n;
    }
    this.nums[this.nn++] = v;
  }

  /** 문자열(같은 값을 표에서 찾는다) */
  private str(s: string): void {
    this.tag(T_STR);
    if (s.length <= 40) {
      let id = this.strIds.get(s);
      if (id === undefined) {
        id = this.strs.length;
        this.strs.push(s);
        this.strIds.set(s, id);
      }
      this.int(id);
    } else {
      this.int(this.strs.length);
      this.strs.push(s);
    }
  }

  /** 객체 속성 자리의 문자열: 그 자리 점수가 낮으면(늘 새 값) 찾지 않는다. 모양별 쓰기 함수가 부르므로 private이 아니다 */
  slotStr(s: string, score: Int32Array, i: number): void {
    const sc = score[i]!;
    if (sc < -32 || s.length > 40) {
      this.tag(T_STR);
      this.int(this.strs.length);
      this.strs.push(s);
      return;
    }
    this.tag(T_STR);
    let id = this.strIds.get(s);
    if (id === undefined) {
      id = this.strs.length;
      this.strs.push(s);
      this.strIds.set(s, id);
      score[i] = sc - 1;
    } else if (sc < 1024) score[i] = sc + 4;
    this.int(id);
  }

  /** 값 하나(모양별 쓰기 함수가 부르므로 private이 아니다) */
  value(v: unknown): void {
    switch (typeof v) {
      case 'number':
        this.num(v);
        return;
      case 'string':
        this.str(v);
        return;
      case 'boolean':
        this.tag(v ? T_TRUE : T_FALSE);
        return;
      case 'undefined':
        this.tag(T_UNDEF);
        return;
      case 'object':
        if (v === null) this.tag(T_NULL);
        else this.object(v);
        return;
      default:
        throw new Unsupported();
    }
  }

  private object(o: object): void {
    const proto = Object.getPrototypeOf(o);
    if (proto === Object.prototype || proto === null) {
      this.record(o as Record<string, unknown>, true);
      return;
    }
    if (Array.isArray(o)) {
      const n = o.length;
      if (n > 1 && allNumbers(o, n)) {
        this.numbers(o, n);
        return;
      }
      this.tag(T_ARR);
      this.int(n);
      for (let i = 0; i < n; i++) {
        if (!(i in o)) throw new Unsupported();
        this.value(o[i]);
      }
      return;
    }
    if (ArrayBuffer.isView(o)) {
      this.bin(o);
      return;
    }
    if (o instanceof Map) {
      this.tag(T_MAP);
      this.int(o.size);
      for (const [k, val] of o) {
        this.value(k);
        this.value(val);
      }
      return;
    }
    if (o instanceof Set) {
      this.tag(T_SET);
      this.int(o.size);
      for (const k of o) this.value(k);
      return;
    }
    // 구조화 복제가 다루지 않거나 다르게 다루는 것(Date, RegExp, ArrayBuffer, Error, Promise …)
    if (o instanceof Date || o instanceof RegExp || o instanceof ArrayBuffer || o instanceof Error || typeof (o as { then?: unknown }).then === 'function') throw new Unsupported();
    this.record(o as Record<string, unknown>, false);
  }

  /** 객체: 얼렸으면 같은 객체 다시 쓰기, 아니면 모양 번호 + 값들 */
  private record(o: Record<string, unknown>, simple: boolean): void {
    if (Object.isFrozen(o)) {
      const id = this.frozen.get(o);
      if (id !== undefined) {
        this.tag(T_REF);
        this.int(id);
        return;
      }
      this.frozen.set(o, this.frozen.size);
      this.tag(T_FROZEN);
    } else this.tag(T_OBJ);
    const keys = this.keyBuf;
    let nk = 0;
    // 일반 객체는 for-in이 자기 속성만 돈다(V8 열거 캐시를 써서 빠르다)
    if (simple) for (const k in o) keys[nk++] = k;
    else for (const k of Object.keys(o)) keys[nk++] = k;
    const id = this.shapeOf(keys, nk);
    this.int(id);
    const score = this.dedupe[id]!;
    const wr = this.writers[id];
    if (wr) {
      wr(o, this, score);
      return;
    }
    // keyBuf는 하위 객체가 다시 쓰므로 모양에서 이름을 읽는다
    const names = this.shapes[id]!;
    for (let i = 0; i < nk; i++) {
      const v = o[names[i]!];
      if (typeof v === 'string') this.slotStr(v, score, i);
      else this.value(v);
    }
  }

  private shapeOf(keys: string[], nk: number): number {
    let cands: number[] = this.emptyShape;
    if (nk) {
      let byLen = this.byFirst.get(keys[0]!);
      if (!byLen) this.byFirst.set(keys[0]!, (byLen = []));
      cands = byLen[nk] ??= [];
    }
    for (let c = 0; c < cands.length; c++) {
      const id = cands[c]!;
      const s = this.shapes[id]!;
      let i = 1;
      while (i < nk && s[i] === keys[i]) i++;
      if (i < nk) continue;
      if (c > 0) {
        // 최근에 맞은 모양을 앞으로
        cands[c] = cands[0]!;
        cands[0] = id;
      }
      return id;
    }
    const id = this.shapes.length;
    this.shapes.push(keys.slice(0, nk));
    this.dedupe.push(new Int32Array(nk));
    this.writers.push(makeWriter(this.shapes[id]!));
    cands.push(id);
    return id;
  }

  /** 수만 든 배열 */
  private numbers(a: readonly number[], n: number): void {
    this.tag(T_NUMS);
    this.int(n);
    let nn = this.nn;
    if (nn + n > this.nums.length) {
      let cap = this.nums.length * 2;
      while (cap < nn + n) cap *= 2;
      const g = new Float64Array(cap);
      g.set(this.nums.subarray(0, nn));
      this.nums = g;
    }
    const nums = this.nums;
    for (let i = 0; i < n; i++) nums[nn++] = a[i]!;
    this.nn = nn;
  }

  private bin(v: ArrayBufferView): void {
    const kind = BIN_KINDS.indexOf(v.constructor.name as BinKind);
    if (kind < 0) throw new Unsupported();
    const bytes = v.byteLength;
    const at = (this.nb + 7) & ~7;
    if (at + bytes > this.bins.length) {
      let cap = Math.max(1 << 16, this.bins.length * 2);
      while (cap < at + bytes) cap *= 2;
      const n = new Uint8Array(cap);
      n.set(this.bins.subarray(0, this.nb));
      this.bins = n;
    }
    this.bins.set(new Uint8Array(v.buffer, v.byteOffset, bytes), at);
    this.nb = at + bytes;
    this.tag(T_BIN);
    this.int(kind);
    this.int(at);
    this.int(bytes);
  }
}

/**
 * 모양 → 값 쓰기 함수: 속성을 이름으로 바로 읽는다. 모양마다 함수가 따로라 속성 읽기가 한 모양의 객체만 보게 되어
 * 일반 반복(o[이름])보다 빠르다. eval을 막은 환경이면 null(일반 반복).
 */
type ShapeWriter = (o: Record<string, unknown>, w: Encoder, score: Int32Array) => void;

function makeWriter(keys: string[]): ShapeWriter | null {
  if (keys.some((k) => k === '__proto__')) return null;
  try {
    // 수는 바로 num으로(일반 value를 거치면 실수 속성 값을 상자에 담느라 수마다 할당한다)
    const body = keys.map((k, i) => `v = o[${JSON.stringify(k)}];\nif (typeof v === 'number') w.num(v);\nelse if (typeof v === 'string') w.slotStr(v, s, ${i});\nelse w.value(v);`).join('\n');
    return new Function('o', 'w', 's', `let v;\n${body}`) as ShapeWriter;
  } catch {
    return null;
  }
}

/** 배열 값이 모두 수인지(빈칸이 있으면 아니다) */
function allNumbers(a: readonly unknown[], n: number): boolean {
  for (let i = 0; i < n; i++) if (typeof a[i] !== 'number') return false;
  return true;
}

/** 모양 → 객체 리터럴 함수(속성 순서대로 r()을 부른다) */
type Factory = (r: () => unknown) => Record<string, unknown>;

function makeFactory(keys: string[]): Factory {
  const safe = keys.every((k) => k !== '__proto__');
  if (safe) {
    try {
      const body = `return {${keys.map((k) => `${JSON.stringify(k)}: r()`).join(',')}};`;
      return new Function('r', body) as Factory;
    } catch {
      /* eval을 막은 환경: 아래 일반 함수 */
    }
  }
  return (r) => {
    const o: Record<string, unknown> = {};
    for (const k of keys) Object.defineProperty(o, k, { value: r(), writable: true, enumerable: true, configurable: true });
    return o;
  };
}

/** Encoder가 만든 값들을 차례로 되살린다(같은 Encoded에서 add한 순서대로 next를 부른다) */
export class Decoder {
  private ti = 0;
  private ni = 0;
  private ii = 0;
  private readonly factories: (Factory | undefined)[];
  private readonly frozen: unknown[] = [];
  private readonly r: () => unknown;

  constructor(private readonly e: Encoded) {
    this.factories = new Array(e.shapes.length);
    this.r = () => this.read();
  }

  next(): unknown {
    return this.read();
  }

  /** 읽을 값이 남았는지 */
  more(): boolean {
    return this.ti < this.e.tags.length;
  }

  private factory(id: number): Factory {
    let f = this.factories[id];
    if (!f) this.factories[id] = f = makeFactory(this.e.shapes[id]!);
    return f;
  }

  private read(): unknown {
    const e = this.e;
    const t = e.tags[this.ti++]!;
    switch (t) {
      case T_U8:
        return e.tags[this.ti++]!;
      case T_NUM:
        return e.nums[this.ni++]!;
      case T_STR:
        return e.strs[e.ints[this.ii++]!]!;
      case T_OBJ:
        return this.factory(e.ints[this.ii++]!)(this.r);
      case T_UNDEF:
        return undefined;
      case T_NULL:
        return null;
      case T_FALSE:
        return false;
      case T_TRUE:
        return true;
      case T_ARR: {
        const n = e.ints[this.ii++]!;
        const a = new Array(n);
        for (let i = 0; i < n; i++) a[i] = this.read();
        return a;
      }
      case T_NUMS: {
        // new Array(n)에 차례로 넣으면 꼭 맞는 크기의 실수 배열(상자 없음)이 된다
        const n = e.ints[this.ii++]!;
        const a = new Array<number>(n);
        const nums = e.nums;
        let ni = this.ni;
        for (let i = 0; i < n; i++) a[i] = nums[ni++]!;
        this.ni = ni;
        return a;
      }
      case T_MAP: {
        const n = e.ints[this.ii++]!;
        const m = new Map();
        for (let i = 0; i < n; i++) {
          const k = this.read();
          m.set(k, this.read());
        }
        return m;
      }
      case T_SET: {
        const n = e.ints[this.ii++]!;
        const s = new Set();
        for (let i = 0; i < n; i++) s.add(this.read());
        return s;
      }
      case T_BIN: {
        const kind = BIN_KINDS[e.ints[this.ii++]!]!;
        const at = e.ints[this.ii++]!;
        const bytes = e.ints[this.ii++]!;
        const C = BIN_CTORS[kind];
        // 객체마다 제 버퍼(구조화 복제와 같게 — 뷰가 큰 버퍼를 붙잡거나 다시 보낼 때 통째로 가지 않게)
        const buf = e.bins.buffer.slice(e.bins.byteOffset + at, e.bins.byteOffset + at + bytes) as ArrayBuffer;
        return new C(buf, 0, bytes / C.BYTES_PER_ELEMENT);
      }
      case T_FROZEN: {
        // 구조화 복제처럼 얼리지 않은 사본(한 번 보낸 안에서 함께 쓴다)
        const slot = this.frozen.length;
        this.frozen.push(undefined);
        const o = this.factory(e.ints[this.ii++]!)(this.r);
        this.frozen[slot] = o;
        return o;
      }
      case T_REF:
        return this.frozen[e.ints[this.ii++]!];
    }
    throw new Error(`부호화 자료가 올바르지 않습니다(태그 ${t})`);
  }
}
