/**
 * R2004 계열 압축(사양 4.7의 명령 형식, decompressR18의 짝).
 * 3바이트 해시로 직전 위치를 찾는 단순한 탐욕 방식이다.
 */

const MAX_NEAR = 0x3fff; // 2바이트 거리
// 먼 거리 명령(0x10~0x1F)은 쓰지 않는다: 사양이 거리 기준(+1 여부)을 분명히 하지 않고
// AutoCAD 파일에서도 보지 못해 다른 리더와 어긋날 수 있다.
const MAX_FAR = MAX_NEAR;

class Out {
  buf = new Uint8Array(1024);
  n = 0;
  push(b: number): void {
    if (this.n >= this.buf.length) {
      const nb = new Uint8Array(this.buf.length * 2);
      nb.set(this.buf);
      this.buf = nb;
    }
    this.buf[this.n++] = b & 0xff;
  }
  bytes(src: Uint8Array, from: number, to: number): void {
    for (let i = from; i < to; i++) this.push(src[i]);
  }
}

/** 글자 길이(4 이상): 0x01~0x0F 또는 0x00 + 확장 */
function literalLength(o: Out, n: number): void {
  if (n <= 18) {
    o.push(n - 3);
    return;
  }
  o.push(0);
  let rem = n - 3 - 0x0f;
  while (rem > 0xff) {
    o.push(0);
    rem -= 0xff;
  }
  o.push(rem);
}

/** 긴 압축 길이(1 이상) */
function longValue(o: Out, v: number): void {
  if (v <= 0xff) {
    o.push(v);
    return;
  }
  o.push(0);
  let rem = v - 0xff;
  while (rem > 0xff) {
    o.push(0);
    rem -= 0xff;
  }
  o.push(rem);
}

/** 되돌아 복사 명령. 다음 글자 수(lit)가 1~3이면 명령에 넣고 true */
function match(o: Out, len: number, dist: number, lit: number): boolean {
  const d = dist - 1;
  const small = lit >= 1 && lit <= 3 ? lit : 0;
  if (d <= 0x3ff && len <= 14) {
    o.push(((len + 1) << 4) | ((d & 3) << 2) | small);
    o.push(d >> 2);
  } else if (d <= MAX_NEAR) {
    if (len <= 33) o.push(0x1e + len);
    else {
      o.push(0x20);
      longValue(o, len - 0x21);
    }
    o.push(((d & 0x3f) << 2) | small);
    o.push(d >> 6);
  } else {
    const dd = d - 0x3fff;
    if (len <= 17) o.push(0x10 + len - 2);
    else {
      o.push(0x10);
      longValue(o, len - 9);
    }
    o.push(((dd & 0x3f) << 2) | small);
    o.push(dd >> 6);
  }
  return small !== 0;
}

export function compressR18(input: Uint8Array): Uint8Array {
  // 첫 글자 묶음은 0이거나 4바이트 이상이어야 하므로 아주 짧은 입력은 0으로 채운다(풀 때 크기로 자른다)
  let src = input;
  if (src.length > 0 && src.length < 4) {
    src = new Uint8Array(4);
    src.set(input);
  }
  const n = src.length;
  const o = new Out();
  const HASH = 1 << 15;
  const head = new Int32Array(HASH).fill(-1);
  const hash = (i: number) => Math.imul((src[i] << 16) ^ (src[i + 1] << 8) ^ src[i + 2], 0x9e3779b1) >>> 17;

  // (길이, 거리) 목록을 먼저 만든다
  const ops: { lit: number; len: number; dist: number }[] = [];
  let litStart = 0;
  let i = 0;
  while (i + 3 <= n) {
    const h = hash(i) & (HASH - 1);
    const cand = head[h];
    head[h] = i;
    let len = 0;
    let dist = 0;
    if (cand >= 0 && i - cand <= MAX_FAR) {
      let l = 0;
      const max = Math.min(n - i, 0xffff);
      while (l < max && src[cand + l] === src[i + l]) l++;
      dist = i - cand;
      len = l;
      // 먼 거리에서는 3바이트 일치를 쓸 수 없다
      if (dist - 1 > MAX_NEAR && len < 4) len = 0;
    }
    // 첫 글자 묶음은 0이거나 4바이트 이상이어야 한다
    if (len >= 3 && !(ops.length === 0 && i - litStart > 0 && i - litStart < 4)) {
      ops.push({ lit: i - litStart, len, dist });
      for (let k = 1; k < len && i + k + 3 <= n; k++) head[hash(i + k) & (HASH - 1)] = i + k;
      i += len;
      litStart = i;
    } else i++;
  }
  const tail = n - litStart;

  // 출력: 첫 글자, (명령 + 글자)…, 끝 0x11
  let pos = 0;
  const first = ops.length ? ops[0].lit : tail;
  if (first > 0) literalLength(o, first);
  o.bytes(src, 0, first);
  pos = first;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    pos += op.len;
    const nextLit = k + 1 < ops.length ? ops[k + 1].lit : tail;
    const inOp = match(o, op.len, op.dist, nextLit);
    if (!inOp && nextLit > 0) literalLength(o, nextLit);
    o.bytes(src, pos, pos + nextLit);
    pos += nextLit;
  }
  o.push(0x11);
  o.push(0);
  o.push(0);
  return o.buf.slice(0, o.n);
}
