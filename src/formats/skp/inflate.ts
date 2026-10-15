/**
 * 동기 DEFLATE 풀기(RFC 1951 원시 스트림). SketchUp 2021 이후 파일은 ZIP 꾸러미라 model.dat·material.xml을
 * 풀어야 하는데, 해석기는 동기 함수(skpToScene)이고 워커에서도 돌아야 해서 DecompressionStream(비동기) 대신 직접 푼다.
 * RFC 1951의 설명(블록 종류 0·1·2, 정규 허프만 부호, 길이·거리 기준표)만 보고 썼다.
 */

/** 길이 부호 257~285의 기준 길이와 덧붙는 비트 수 */
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
/** 거리 부호 0~29의 기준 거리와 덧붙는 비트 수 */
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193,
  12289, 16385, 24577,
];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
/** 동적 블록에서 부호 길이 부호의 길이가 오는 차례 */
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** 허프만 찾기표: 낮은 비트부터 읽은 maxBits 비트 → (기호 << 4) | 부호 길이. 0이면 없는 부호 */
interface Huffman {
  table: Uint32Array;
  maxBits: number;
}

function buildHuffman(lengths: ArrayLike<number>, n: number): Huffman {
  let maxBits = 0;
  const count = new Uint16Array(16);
  for (let i = 0; i < n; i++) {
    const l = lengths[i]!;
    if (l > 0) {
      count[l]!++;
      if (l > maxBits) maxBits = l;
    }
  }
  if (maxBits === 0) return { table: new Uint32Array(1), maxBits: 1 };
  const next = new Uint16Array(16);
  let code = 0;
  for (let bits = 1; bits <= 15; bits++) {
    code = (code + count[bits - 1]!) << 1;
    next[bits] = code;
  }
  next[0] = 0;
  const size = 1 << maxBits;
  const table = new Uint32Array(size);
  for (let sym = 0; sym < n; sym++) {
    const len = lengths[sym]!;
    if (len === 0) continue;
    const c = next[len]!++;
    // 비트 흐름은 부호를 높은 비트부터 싣는다 → 낮은 비트부터 읽는 찾기표에 맞게 뒤집는다
    let rev = 0;
    for (let i = 0; i < len; i++) rev |= ((c >> i) & 1) << (len - 1 - i);
    const entry = (sym << 4) | len;
    for (let j = rev; j < size; j += 1 << len) table[j] = entry;
  }
  return { table, maxBits };
}

let fixedLit: Huffman | null = null;
let fixedDist: Huffman | null = null;

function fixedTables(): [Huffman, Huffman] {
  if (!fixedLit || !fixedDist) {
    const l = new Uint8Array(288);
    for (let i = 0; i < 144; i++) l[i] = 8;
    for (let i = 144; i < 256; i++) l[i] = 9;
    for (let i = 256; i < 280; i++) l[i] = 7;
    for (let i = 280; i < 288; i++) l[i] = 8;
    fixedLit = buildHuffman(l, 288);
    const d = new Uint8Array(30).fill(5);
    fixedDist = buildHuffman(d, 30);
  }
  return [fixedLit, fixedDist];
}

/**
 * 원시 DEFLATE 스트림을 푼다. expected(ZIP 중앙 목록의 원래 크기)를 알면 그만큼 미리 잡는다.
 * 깨진 스트림이면 Error를 던진다.
 */
export function inflateRaw(src: Uint8Array, expected = 0): Uint8Array {
  // DEFLATE는 1바이트로 많아야 258바이트(약 1032배)까지 늘어난다 → 그보다 큰 원래 크기는 깨진 값으로 보고 늘려 가며 푼다
  const plausible = src.length * 1032 + 1024;
  let out = new Uint8Array(expected > 0 && expected <= plausible ? expected : Math.min(plausible, Math.max(1024, src.length * 4)));
  let op = 0;
  let ip = 0;
  let bitBuf = 0;
  let bitCnt = 0;

  const ensure = (need: number): void => {
    if (op + need <= out.length) return;
    let size = out.length * 2;
    while (size < op + need) size *= 2;
    const n = new Uint8Array(size);
    n.set(out.subarray(0, op));
    out = n;
  };
  /** 비트를 n개(≤24) 채운다. 입력 끝을 넘으면 0을 채우고, 실제로 넘겨 읽었는지는 끝에서 본다 */
  const fill = (n: number): void => {
    while (bitCnt < n) {
      const byte = ip < src.length ? src[ip]! : 0;
      ip++;
      bitBuf |= byte << bitCnt;
      bitCnt += 8;
    }
  };
  const bits = (n: number): number => {
    if (n === 0) return 0;
    fill(n);
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  };
  const decode = (h: Huffman): number => {
    fill(h.maxBits);
    const e = h.table[bitBuf & ((1 << h.maxBits) - 1)]!;
    const len = e & 15;
    if (len === 0) throw new Error('DEFLATE: 잘못된 허프만 부호');
    bitBuf >>>= len;
    bitCnt -= len;
    return e >>> 4;
  };

  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      // 저장 블록: 바이트 경계로 맞추고 LEN·NLEN(미리 채워 둔 온전한 바이트는 입력으로 되돌린다)
      ip -= bitCnt >> 3;
      bitBuf = 0;
      bitCnt = 0;
      if (ip + 4 > src.length) throw new Error('DEFLATE: 저장 블록 머리가 잘렸습니다');
      const len = src[ip]! | (src[ip + 1]! << 8);
      const nlen = src[ip + 2]! | (src[ip + 3]! << 8);
      ip += 4;
      if ((len ^ 0xffff) !== nlen) throw new Error('DEFLATE: 저장 블록 길이 검사 실패');
      if (ip + len > src.length) throw new Error('DEFLATE: 저장 블록이 잘렸습니다');
      ensure(len);
      out.set(src.subarray(ip, ip + len), op);
      op += len;
      ip += len;
      continue;
    }
    let lit: Huffman;
    let dist: Huffman;
    if (type === 1) {
      [lit, dist] = fixedTables();
    } else if (type === 2) {
      const hlit = bits(5) + 257;
      const hdist = bits(5) + 1;
      const hclen = bits(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]!] = bits(3);
      const clh = buildHuffman(cl, 19);
      const lens = new Uint8Array(hlit + hdist);
      let i = 0;
      while (i < hlit + hdist) {
        const sym = decode(clh);
        if (sym < 16) lens[i++] = sym;
        else {
          let rep: number;
          let val = 0;
          if (sym === 16) {
            if (i === 0) throw new Error('DEFLATE: 앞 길이 없이 반복');
            val = lens[i - 1]!;
            rep = 3 + bits(2);
          } else if (sym === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          if (i + rep > hlit + hdist) throw new Error('DEFLATE: 부호 길이 반복이 넘칩니다');
          lens.fill(val, i, i + rep);
          i += rep;
        }
      }
      lit = buildHuffman(lens.subarray(0, hlit), hlit);
      dist = buildHuffman(lens.subarray(hlit), hdist);
    } else throw new Error('DEFLATE: 알 수 없는 블록 종류 3');

    for (;;) {
      const sym = decode(lit);
      if (sym < 256) {
        ensure(1);
        out[op++] = sym;
      } else if (sym === 256) break;
      else {
        const li = sym - 257;
        if (li >= 29) throw new Error('DEFLATE: 잘못된 길이 부호');
        const len = LEN_BASE[li]! + bits(LEN_EXTRA[li]!);
        const di = decode(dist);
        if (di >= 30) throw new Error('DEFLATE: 잘못된 거리 부호');
        const d = DIST_BASE[di]! + bits(DIST_EXTRA[di]!);
        if (d > op) throw new Error('DEFLATE: 거리가 출력 앞을 넘습니다');
        ensure(len);
        let from = op - d;
        for (let k = 0; k < len; k++) out[op++] = out[from++]!;
      }
    }
    if (ip > src.length + 4) throw new Error('DEFLATE: 입력이 잘렸습니다');
  }
  return op === out.length ? out : out.slice(0, op);
}
