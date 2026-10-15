/**
 * SketchUp 2021 이후 model.dat의 꼬리표-길이-값(TLV) 읽기.
 * 바이트에서 확인한 꼴: [u16 꼬리표][u32 길이][길이만큼 내용], 모두 리틀 엔디언. 내용은 자식 TLV들이거나 값이다.
 * 어느 꼬리표가 묶음인지는 자료에 적혀 있지 않아 해석기가 아는 경로로만 내려간다(모르는 꼬리표는 길이로 건너뛴다).
 * 값 꼴(관찰): 식별 번호는 길이 1~n바이트의 부호 없는 리틀 엔디언 정수, 좌표·평면·변환은 f64 배열, 이름은 UTF-8.
 */

/** 내용 범위 [start, end)와 꼬리표 */
export interface TlvNode {
  tag: number;
  start: number;
  end: number;
}

const utf8 = new TextDecoder('utf-8');

export class TlvReader {
  readonly b: Uint8Array;
  readonly dv: DataView;
  constructor(b: Uint8Array) {
    this.b = b;
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }

  /** [start, end) 안의 자식 TLV를 차례로 돈다. 길이가 범위를 넘으면 Error */
  each(start: number, end: number, fn: (tag: number, s: number, e: number) => void): void {
    let p = start;
    while (p < end) {
      if (p + 6 > end) throw new Error(`TLV 머리가 잘렸습니다(@${p})`);
      const tag = this.dv.getUint16(p, true);
      const len = this.dv.getUint32(p + 2, true);
      const s = p + 6;
      const e = s + len;
      if (e > end) throw new Error(`TLV 길이가 범위를 넘습니다(꼬리표 0x${tag.toString(16)} @${p})`);
      fn(tag, s, e);
      p = e;
    }
  }

  children(n: TlvNode): TlvNode[] {
    const out: TlvNode[] = [];
    this.each(n.start, n.end, (tag, start, end) => out.push({ tag, start, end }));
    return out;
  }

  /** 첫 자식 중 꼬리표가 같은 것 */
  first(n: TlvNode, tag: number): TlvNode | undefined {
    let p = n.start;
    while (p + 6 <= n.end) {
      const t = this.dv.getUint16(p, true);
      const len = this.dv.getUint32(p + 2, true);
      const e = p + 6 + len;
      if (e > n.end) throw new Error(`TLV 길이가 범위를 넘습니다(꼬리표 0x${t.toString(16)} @${p})`);
      if (t === tag) return { tag: t, start: p + 6, end: e };
      p = e;
    }
    return undefined;
  }

  /** 경로를 따라 첫 자식으로 내려간다 */
  path(n: TlvNode, ...tags: number[]): TlvNode | undefined {
    let cur: TlvNode | undefined = n;
    for (const t of tags) {
      if (!cur) return undefined;
      cur = this.first(cur, t);
    }
    return cur;
  }

  /** 길이만큼의 부호 없는 리틀 엔디언 정수(최대 6바이트까지 정확) */
  uint(n: TlvNode | undefined): number | undefined {
    if (!n || n.end <= n.start) return undefined;
    let v = 0;
    let mul = 1;
    for (let p = n.start; p < n.end && p < n.start + 7; p++) {
      v += this.b[p]! * mul;
      mul *= 256;
    }
    return v;
  }

  u8(n: TlvNode | undefined): number | undefined {
    return n && n.end > n.start ? this.b[n.start] : undefined;
  }

  i32(n: TlvNode | undefined): number | undefined {
    return n && n.end - n.start >= 4 ? this.dv.getInt32(n.start, true) : undefined;
  }

  f64(n: TlvNode, i: number): number {
    return this.dv.getFloat64(n.start + 8 * i, true);
  }

  /** f64 배열(내용 길이가 8의 배수가 아니면 남는 바이트는 버린다) */
  f64s(n: TlvNode | undefined): number[] | undefined {
    if (!n) return undefined;
    const k = Math.floor((n.end - n.start) / 8);
    const out = new Array<number>(k);
    for (let i = 0; i < k; i++) out[i] = this.dv.getFloat64(n.start + 8 * i, true);
    return out;
  }

  str(n: TlvNode | undefined): string | undefined {
    return n ? utf8.decode(this.b.subarray(n.start, n.end)) : undefined;
  }
}
