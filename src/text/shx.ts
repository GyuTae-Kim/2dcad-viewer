/**
 * SHX 글꼴(컴파일된 도형 파일) 읽기와 단선 글리프 만들기.
 * 형식: "AutoCAD-86 shapes 1.0/1.1"(일반·도형), "AutoCAD-86 bigfont 1.0"(큰 글꼴, 2바이트 코드),
 * "AutoCAD-86 unifont 1.0"(유니코드). 도형 정의는 AutoCAD 문서의 벡터 길이·방향 바이트와 특수 코드 0~14다.
 * 글리프 좌표는 다른 글꼴처럼 "문자 높이 = 1"(글꼴의 기준선 위 높이 above)로 맞춘다.
 */
import type { FontFace, GlyphGeom } from './fonts';

export type ShxKind = 'shapes' | 'bigfont' | 'unifont';

export interface ShxFont {
  /** 파일 이름(소문자, 확장자 포함) */
  name: string;
  kind: ShxKind;
  /** 기준선 위 높이(벡터 단위). 문자 높이가 이 값에 맞춰진다 */
  above: number;
  below: number;
  /** 0 가로, 2 가로·세로 */
  modes: number;
  /** 큰 글꼴: 2바이트 문자의 첫 바이트 범위 */
  ranges: [number, number][];
  /** 도형 번호 → 명세 바이트(이름 뒤) */
  defs: Map<number, Uint8Array>;
  /** 도형 번호 → 이름 */
  names: Map<number, string>;
}

const u16 = (d: Uint8Array, p: number) => d[p]! | (d[p + 1]! << 8);
const u32 = (d: Uint8Array, p: number) => (d[p]! | (d[p + 1]! << 8) | (d[p + 2]! << 16) | (d[p + 3]! << 24)) >>> 0;

/** 정의 = 이름\0 + 명세 바이트 */
function splitDef(def: Uint8Array): { name: string; spec: Uint8Array } {
  let z = def.indexOf(0);
  if (z < 0) z = 0;
  let name = '';
  for (let i = 0; i < z; i++) name += String.fromCharCode(def[i]!);
  return { name, spec: def.subarray(z + 1) };
}

/** 글꼴 정보 도형(0번)에서 위·아래 높이와 모드 */
function fontInfo(f: ShxFont, spec: Uint8Array | undefined): void {
  if (!spec || spec.length < 2) return;
  if (f.kind === 'bigfont') {
    // 문자 높이, 0, 모드, 문자 폭, 0
    f.above = spec[0]! || f.above;
    f.below = 0;
    f.modes = spec[2] ?? 0;
  } else {
    f.above = spec[0]! || f.above;
    f.below = spec[1] ?? 0;
    f.modes = spec[2] ?? 0;
  }
}

export function parseShx(data: Uint8Array, fileName: string): ShxFont | null {
  const lim = Math.min(64, data.length);
  let eof = -1;
  for (let i = 0; i < lim; i++)
    if (data[i] === 0x1a) {
      eof = i;
      break;
    }
  if (eof < 0) return null;
  let head = '';
  for (let i = 0; i < eof; i++) head += String.fromCharCode(data[i]!);
  if (!/^AutoCAD-86/i.test(head)) return null;
  const kind: ShxKind | null = /unifont/i.test(head) ? 'unifont' : /bigfont/i.test(head) ? 'bigfont' : /shapes/i.test(head) ? 'shapes' : null;
  if (!kind) return null;
  const f: ShxFont = { name: fileName.toLowerCase(), kind, above: 1, below: 0, modes: 0, ranges: [], defs: new Map(), names: new Map() };
  let p = eof + 1;
  const put = (code: number, def: Uint8Array) => {
    const { name, spec } = splitDef(def);
    f.defs.set(code, spec);
    if (name) f.names.set(code, name);
  };
  try {
    if (kind === 'shapes') {
      const n = u16(data, p + 4);
      p += 6;
      const idx: [number, number][] = [];
      for (let i = 0; i < n && p + 4 <= data.length; i++, p += 4) idx.push([u16(data, p), u16(data, p + 2)]);
      for (const [code, len] of idx) {
        if (p + len > data.length) break;
        put(code, data.subarray(p, p + len));
        p += len;
      }
    } else if (kind === 'unifont') {
      p += 4; // 도형 수
      const infoLen = u16(data, p);
      p += 2;
      const info = splitDef(data.subarray(p, p + infoLen));
      f.names.set(0, info.name);
      fontInfo(f, info.spec);
      p += infoLen;
      while (p + 4 <= data.length) {
        const code = u16(data, p);
        const len = u16(data, p + 2);
        p += 4;
        if (!len || p + len > data.length) break;
        put(code, data.subarray(p, p + len));
        p += len;
      }
    } else {
      // 큰 글꼴: 색인 수, 글자 수, 범위 수, 범위들, 색인(코드·길이·위치 8바이트)
      const nIdx = u16(data, p);
      const nRanges = u16(data, p + 4);
      p += 6;
      for (let i = 0; i < nRanges; i++, p += 4) f.ranges.push([u16(data, p), u16(data, p + 2)]);
      for (let i = 0; i < nIdx && p + 8 <= data.length; i++, p += 8) {
        const code = u16(data, p);
        const len = u16(data, p + 2);
        const off = u32(data, p + 4);
        if (!len || off + len > data.length) continue;
        put(code, data.subarray(off, off + len));
      }
    }
  } catch {
    return null;
  }
  if (!f.defs.size) return null;
  if (kind !== 'unifont') fontInfo(f, f.defs.get(0));
  if (!(f.above > 0)) f.above = 1;
  return f;
}

// ---------------------------------------------------------------------------
// 도형 실행
// ---------------------------------------------------------------------------

const DIRS: [number, number][] = [
  [1, 0],
  [1, 0.5],
  [1, 1],
  [0.5, 1],
  [0, 1],
  [-0.5, 1],
  [-1, 1],
  [-1, 0.5],
  [-1, 0],
  [-1, -0.5],
  [-1, -1],
  [-0.5, -1],
  [0, -1],
  [0.5, -1],
  [1, -1],
  [1, -0.5],
];

const s8 = (b: number) => (b > 127 ? b - 256 : b);

interface Pen {
  x: number;
  y: number;
  strokes: number[][];
  cur: number[] | null;
}

function lineTo(pen: Pen, x: number, y: number, draw: boolean): void {
  if (draw) {
    if (!pen.cur) {
      pen.cur = [pen.x, pen.y];
      pen.strokes.push(pen.cur);
    }
    pen.cur.push(x, y);
  } else pen.cur = null;
  pen.x = x;
  pen.y = y;
}

/** 중심·반지름·시작각·사이각으로 호 */
function arcTo(pen: Pen, cx: number, cy: number, r: number, a0: number, sweep: number, draw: boolean): void {
  const n = Math.max(2, Math.ceil((Math.abs(sweep) / (Math.PI / 4)) * 4));
  for (let k = 1; k <= n; k++) {
    const a = a0 + (sweep * k) / n;
    lineTo(pen, cx + r * Math.cos(a), cy + r * Math.sin(a), draw);
  }
}

/** 볼록 값(-127~127)으로 지정한 호 */
function bulgeTo(pen: Pen, dx: number, dy: number, b: number, draw: boolean): void {
  const x1 = pen.x + dx;
  const y1 = pen.y + dy;
  if (!b) {
    lineTo(pen, x1, y1, draw);
    return;
  }
  const bulge = b / 127;
  const c = Math.hypot(dx, dy);
  if (c < 1e-12) return;
  const th = 4 * Math.atan(bulge);
  const r = Math.abs(c / (2 * Math.sin(th / 2)));
  // 중심 = 현의 중점 + 왼쪽 법선 × (c/2)·(1 - b²)/(2b)
  const k = ((c / 2) * (1 - bulge * bulge)) / (2 * bulge);
  const cx = (pen.x + x1) / 2 + (-dy / c) * k;
  const cy = (pen.y + y1) / 2 + (dx / c) * k;
  const a0 = Math.atan2(pen.y - cy, pen.x - cx);
  arcTo(pen, cx, cy, r, a0, th, draw);
  pen.x = x1;
  pen.y = y1;
}

export class ShxRunner {
  constructor(
    readonly font: ShxFont,
    /** 하위 도형을 찾을 다른 글꼴(큰 글꼴의 기본 글꼴 등) */
    readonly fallback: ShxFont | null = null,
  ) {}

  /** 도형 하나를 실행해 선과 끝 위치를 얻는다(벡터 단위) */
  run(code: number, vertical = false): { strokes: number[][]; x: number; y: number } | null {
    const spec = this.font.defs.get(code);
    if (!spec) return null;
    const pen: Pen = { x: 0, y: 0, strokes: [], cur: null };
    this.exec(this.font, spec, pen, 1, vertical, 0);
    return { strokes: pen.strokes, x: pen.x, y: pen.y };
  }

  private exec(font: ShxFont, b: Uint8Array, pen: Pen, scale0: number, vertical: boolean, depth: number): void {
    if (depth > 8) return;
    let draw = true;
    let scale = scale0;
    const stack: [number, number][] = [];
    let i = 0;
    let onlyVertical = false;
    while (i < b.length) {
      const c = b[i++]!;
      const skip = onlyVertical && !vertical;
      onlyVertical = false;
      if (c >= 0x10) {
        if (skip) continue;
        const len = (c >> 4) * scale;
        const d = DIRS[c & 15]!;
        lineTo(pen, pen.x + d[0] * len, pen.y + d[1] * len, draw);
        continue;
      }
      switch (c) {
        case 0:
          return;
        case 1:
          if (!skip) draw = true;
          break;
        case 2:
          if (!skip) {
            draw = false;
            pen.cur = null;
          }
          break;
        case 3: {
          const k = b[i++] ?? 1;
          if (!skip && k) scale /= k;
          break;
        }
        case 4: {
          const k = b[i++] ?? 1;
          if (!skip) scale *= k;
          break;
        }
        case 5:
          if (!skip && stack.length < 8) stack.push([pen.x, pen.y]);
          break;
        case 6:
          if (!skip) {
            const t = stack.pop();
            if (t) {
              pen.cur = null;
              pen.x = t[0];
              pen.y = t[1];
            }
          }
          break;
        case 7: {
          // 하위 도형
          let sub: number;
          let place: { x: number; y: number; w: number; h: number } | null = null;
          if (font.kind === 'unifont') {
            sub = ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
            i += 2;
          } else if (font.kind === 'bigfont') {
            const hi = b[i++] ?? 0;
            if (hi === 0) {
              // 확장 큰 글꼴: 0, 도형 번호(2), 원점 x·y, 폭·높이
              sub = ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
              place = { x: b[i + 2] ?? 0, y: b[i + 3] ?? 0, w: b[i + 4] ?? 0, h: b[i + 5] ?? 0 };
              i += 6;
            } else {
              sub = (hi << 8) | (b[i++] ?? 0);
            }
          } else sub = b[i++] ?? 0;
          if (skip) break;
          let src = font;
          let spec = font.defs.get(sub);
          if (!spec && this.fallback) {
            spec = this.fallback.defs.get(sub);
            src = this.fallback;
          }
          if (!spec) break;
          if (place) {
            // 원점으로 옮기고 폭·높이 비율로 줄여 그린다
            const H = font.above || 1;
            const sx = (place.w || H) / H;
            const sy = (place.h || H) / H;
            const sp: Pen = { x: 0, y: 0, strokes: [], cur: null };
            this.exec(src, spec, sp, scale, vertical, depth + 1);
            const ox = pen.x + place.x * scale;
            const oy = pen.y + place.y * scale;
            for (const st of sp.strokes) {
              for (let k = 0; k < st.length; k += 2) {
                st[k] = ox + st[k]! * sx;
                st[k + 1] = oy + st[k + 1]! * sy;
              }
              pen.strokes.push(st);
            }
            pen.cur = null;
          } else {
            pen.cur = null;
            this.exec(src, spec, pen, scale, vertical, depth + 1);
            pen.cur = null;
          }
          break;
        }
        case 8: {
          const dx = s8(b[i++] ?? 0);
          const dy = s8(b[i++] ?? 0);
          if (!skip) lineTo(pen, pen.x + dx * scale, pen.y + dy * scale, draw);
          break;
        }
        case 9:
          for (;;) {
            const dx = s8(b[i++] ?? 0);
            const dy = s8(b[i++] ?? 0);
            if ((!dx && !dy) || i > b.length) break;
            if (!skip) lineTo(pen, pen.x + dx * scale, pen.y + dy * scale, draw);
          }
          break;
        case 10: {
          const r = (b[i++] ?? 0) * scale;
          const sc = b[i++] ?? 0;
          if (skip || !r) break;
          const cw = (sc & 0x80) !== 0;
          const s = (sc >> 4) & 7;
          const n = sc & 15 || 8;
          const a0 = (s * Math.PI) / 4;
          const sweep = ((n * Math.PI) / 4) * (cw ? -1 : 1);
          const cx = pen.x - r * Math.cos(a0);
          const cy = pen.y - r * Math.sin(a0);
          arcTo(pen, cx, cy, r, a0, sweep, draw);
          break;
        }
        case 11: {
          const so = b[i++] ?? 0;
          const eo = b[i++] ?? 0;
          const r = (((b[i] ?? 0) << 8) | (b[i + 1] ?? 0)) * scale;
          i += 2;
          const sc = b[i++] ?? 0;
          if (skip || !r) break;
          const cw = (sc & 0x80) !== 0;
          const s = (sc >> 4) & 7;
          const n = sc & 15 || 8;
          const oct = Math.PI / 4;
          const sgn = cw ? -1 : 1;
          const a0 = s * oct + sgn * ((so * oct) / 256);
          const a1 = eo ? (s + sgn * (n - 1)) * oct + sgn * ((eo * oct) / 256) : (s + sgn * n) * oct;
          const cx = pen.x - r * Math.cos(a0);
          const cy = pen.y - r * Math.sin(a0);
          arcTo(pen, cx, cy, r, a0, a1 - a0, draw);
          break;
        }
        case 12: {
          const dx = s8(b[i++] ?? 0) * scale;
          const dy = s8(b[i++] ?? 0) * scale;
          const bu = s8(b[i++] ?? 0);
          if (!skip) bulgeTo(pen, dx, dy, bu, draw);
          break;
        }
        case 13:
          for (;;) {
            const dx = s8(b[i++] ?? 0);
            const dy = s8(b[i++] ?? 0);
            if ((!dx && !dy) || i > b.length) break;
            const bu = s8(b[i++] ?? 0);
            if (!skip) bulgeTo(pen, dx * scale, dy * scale, bu, draw);
          }
          break;
        case 14:
          onlyVertical = true;
          break;
        default:
          break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 글꼴 면
// ---------------------------------------------------------------------------

/** 큰 글꼴의 2바이트 코드 → 유니코드 변환에 쓸 코드 페이지 */
function bigfontEncoding(f: ShxFont): string {
  const n = f.name.replace(/\.shx$/, '');
  if (/^(whg|wht|hg|hn|kor|ks)/.test(n)) return 'euc-kr';
  if (/^(ext|jis|bigfont|@?extfont)/.test(n)) return 'shift_jis';
  if (/^(chineset|big5|tw)/.test(n)) return 'big5';
  if (/^(gb|hz|china)/.test(n)) return 'gbk';
  // 첫 바이트 범위로 짐작: 일본어(0x81~0x9F + 0xE0~)
  if (f.ranges.some(([a, b]) => a <= 0x81 && b >= 0x9f) && f.ranges.some(([a]) => a >= 0xe0)) return 'shift_jis';
  return 'euc-kr';
}

const reverseMaps = new Map<string, Map<number, number>>();

/** 유니코드 → 2바이트 코드(첫 바이트 << 8 | 둘째 바이트) */
function reverseMap(enc: string): Map<number, number> {
  let m = reverseMaps.get(enc);
  if (m) return m;
  m = new Map();
  let dec: TextDecoder;
  try {
    dec = new TextDecoder(enc, { fatal: true });
  } catch {
    reverseMaps.set(enc, m);
    return m;
  }
  const buf = new Uint8Array(2);
  for (let a = 0x81; a <= 0xfe; a++)
    for (let b = 0x40; b <= 0xfe; b++) {
      buf[0] = a;
      buf[1] = b;
      try {
        const s = dec.decode(buf);
        if (s.length === 1) {
          const cp = s.codePointAt(0)!;
          if (cp >= 0x80 && !m.has(cp)) m.set(cp, (a << 8) | b);
        }
      } catch {
        /* 없는 코드 */
      }
    }
  reverseMaps.set(enc, m);
  return m;
}

/** SHX 글꼴(과 큰 글꼴)로 글리프를 만드는 글꼴 면 */
export class ShxFace implements FontFace {
  readonly kind = 'stroke' as const;
  readonly descent: number;
  private readonly cache = new Map<number, GlyphGeom | null>();
  private readonly main: ShxRunner | null;
  private readonly big: ShxRunner | null;
  private readonly bigMap: Map<number, number> | null;

  constructor(
    readonly font: ShxFont | null,
    readonly bigFont: ShxFont | null,
  ) {
    this.main = font ? new ShxRunner(font) : null;
    this.big = bigFont ? new ShxRunner(bigFont, font) : null;
    this.bigMap = bigFont ? reverseMap(bigfontEncoding(bigFont)) : null;
    this.descent = font ? font.below / (font.above || 1) : 0.33;
  }

  /** 유니코드 → 이 글꼴의 도형 번호와 실행기 */
  private locate(code: number): { r: ShxRunner; n: number; above: number } | null {
    const f = this.font;
    if (f && this.main) {
      const cands = [code];
      // %%d·%%p·%%c(도·플러스마이너스·지름): 일반 SHX 글꼴의 127·128·129
      if (code === 0xb0) cands.push(127);
      if (code === 0xb1) cands.push(128);
      if (code === 0x2205 || code === 0x2300 || code === 0xd8) cands.push(0x2205, 0x2300, 129);
      for (const c of cands) if ((f.kind === 'unifont' || c < 256) && c !== 0 && f.defs.has(c)) return { r: this.main, n: c, above: f.above };
    }
    if (this.big && this.bigFont && code >= 0x80) {
      const dbcs = this.bigMap?.get(code);
      if (dbcs !== undefined && this.bigFont.defs.has(dbcs)) return { r: this.big, n: dbcs, above: f?.above ?? this.bigFont.above };
    }
    return null;
  }

  has(code: number): boolean {
    return this.locate(code) !== null;
  }

  glyph(code: number): GlyphGeom | null {
    if (this.cache.has(code)) return this.cache.get(code)!;
    const loc = this.locate(code);
    let g: GlyphGeom | null = null;
    if (loc) {
      const res = loc.r.run(loc.n);
      if (res) {
        // 큰 글꼴 글자는 그 글꼴의 문자 높이를 기본 글꼴의 위 높이에 맞춘다
        const k = 1 / (loc.r === this.big && this.bigFont ? this.bigFont.above || loc.above : loc.above);
        const strokes: Float32Array[] = [];
        const segs: number[] = [];
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const st of res.strokes) {
          const f32 = new Float32Array(st.length);
          for (let i = 0; i < st.length; i += 2) {
            const x = st[i]! * k;
            const y = st[i + 1]! * k;
            f32[i] = x;
            f32[i + 1] = y;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            if (i >= 2) segs.push(f32[i - 2]!, f32[i - 1]!, x, y);
          }
          if (st.length === 2) segs.push(f32[0]!, f32[1]!, f32[0]!, f32[1]!);
          strokes.push(f32);
        }
        const advance = res.x * k;
        if (!strokes.length) {
          minX = 0;
          minY = 0;
          maxX = advance;
          maxY = 0;
        }
        g = { advance, strokes, segs: new Float32Array(segs), minX, minY, maxX, maxY };
      }
    }
    this.cache.set(code, g);
    return g;
  }
}

// ---------------------------------------------------------------------------
// 불러온 SHX 글꼴 모음
// ---------------------------------------------------------------------------

export class ShxLibrary {
  private readonly fonts = new Map<string, ShxFont>();
  private readonly faces = new Map<string, ShxFace>();

  /** 이름(대소문자·확장자 무시)으로 */
  static key(name: string): string {
    return name.trim().toLowerCase().replace(/^.*[\\/]/, '').replace(/\.shx$/, '');
  }

  add(name: string, data: Uint8Array): ShxFont | null {
    const f = parseShx(data, name);
    if (f) {
      this.fonts.set(ShxLibrary.key(name), f);
      this.faces.clear();
    }
    return f;
  }

  get size(): number {
    return this.fonts.size;
  }

  clear(): void {
    this.fonts.clear();
    this.faces.clear();
  }

  names(): string[] {
    return [...this.fonts.values()].map((f) => f.name);
  }

  has(name: string): boolean {
    return this.fonts.has(ShxLibrary.key(name));
  }

  get(name: string): ShxFont | undefined {
    return this.fonts.get(ShxLibrary.key(name));
  }

  /** 문자 스타일의 글꼴·큰 글꼴 이름으로 글꼴 면(둘 다 없으면 null) */
  face(font: string, bigFont = ''): ShxFace | null {
    const k = `${ShxLibrary.key(font)}|${ShxLibrary.key(bigFont)}`;
    let f = this.faces.get(k);
    if (f) return f;
    const main = this.fonts.get(ShxLibrary.key(font || 'txt')) ?? null;
    const big = bigFont ? (this.fonts.get(ShxLibrary.key(bigFont)) ?? null) : null;
    if (!main && !big) return null;
    f = new ShxFace(main && main.kind !== 'bigfont' ? main : null, big && big.kind === 'bigfont' ? big : null);
    this.faces.set(k, f);
    return f;
  }
}
