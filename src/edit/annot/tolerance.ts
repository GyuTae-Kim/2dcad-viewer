/**
 * 기하 공차(TOLERANCE): 대화상자 값 ↔ AutoCAD 공차 문자열, 그리고 프레임 배치(선·기호 외곽선·문자 자리).
 *
 * 문자열: 줄마다 `기호%%v공차1%%v공차2%%v데이텀1%%v데이텀2%%v데이텀3`(끝의 빈 칸은 뺀다), 줄 사이 `^J`.
 * 기호·지름·재료 조건은 GDT 글꼴 문자 `{\Fgdt;x}`로 적는다(a 경사도, b 직각도, c 평면도, d 면의 윤곽도, e 진원도,
 * f 평행도, g 원통도, h 원주 흔들림, i 대칭도, j 위치도, k 선의 윤곽도, l Ⓛ, m Ⓜ, n ⌀, p Ⓟ, r 동심도, s Ⓢ,
 * t 온 흔들림, u 진직도). 높이(투영 공차 영역)와 데이텀 식별자는 %%v가 없는 줄로 뒤에 붙인다.
 *
 * 기호 외곽선은 ISO 1101 도형을 이 프로젝트에서 직접 그린 것이다(gdt.shx를 쓰지 않는다).
 */

export interface P {
  x: number;
  y: number;
}

export type MaterialCond = '' | 'M' | 'L' | 'S';

export interface TolCell {
  dia: boolean;
  value: string;
  mc: MaterialCond;
}

export interface TolDatum {
  value: string;
  mc: MaterialCond;
}

export interface TolRow {
  /** GDT 글꼴 문자(a~u) 또는 '' */
  sym: string;
  tol1: TolCell;
  tol2: TolCell;
  datum: [TolDatum, TolDatum, TolDatum];
}

export interface TolSpec {
  rows: [TolRow, TolRow];
  height: string;
  projected: boolean;
  datumId: string;
}

/** 기하 특성 기호(대화상자 순서) */
export const GDT_SYMBOLS: { key: string; label: string }[] = [
  { key: 'j', label: '위치도' },
  { key: 'r', label: '동심도' },
  { key: 'i', label: '대칭도' },
  { key: 'f', label: '평행도' },
  { key: 'b', label: '직각도' },
  { key: 'a', label: '경사도' },
  { key: 'g', label: '원통도' },
  { key: 'c', label: '평면도' },
  { key: 'e', label: '진원도' },
  { key: 'u', label: '진직도' },
  { key: 'd', label: '면의 윤곽도' },
  { key: 'k', label: '선의 윤곽도' },
  { key: 'h', label: '원주 흔들림' },
  { key: 't', label: '온 흔들림' },
];

const MC_CHAR: Record<Exclude<MaterialCond, ''>, string> = { M: 'm', L: 'l', S: 's' };

export const emptyCell = (): TolCell => ({ dia: false, value: '', mc: '' });
export const emptyDatum = (): TolDatum => ({ value: '', mc: '' });
export const emptyRow = (): TolRow => ({ sym: '', tol1: emptyCell(), tol2: emptyCell(), datum: [emptyDatum(), emptyDatum(), emptyDatum()] });
export const emptySpec = (): TolSpec => ({ rows: [emptyRow(), emptyRow()], height: '', projected: false, datumId: '' });

const gdt = (c: string) => `{\\Fgdt;${c}}`;

function cellText(c: TolCell): string {
  if (!c.value && !c.dia && !c.mc) return '';
  return (c.dia ? gdt('n') : '') + c.value + (c.mc ? gdt(MC_CHAR[c.mc]) : '');
}

function datumText(d: TolDatum): string {
  if (!d.value && !d.mc) return '';
  return d.value + (d.mc ? gdt(MC_CHAR[d.mc]) : '');
}

function rowText(r: TolRow): string {
  const parts = [r.sym ? gdt(r.sym) : '', cellText(r.tol1), cellText(r.tol2), ...r.datum.map(datumText)];
  let n = parts.length;
  while (n > 0 && !parts[n - 1]) n--;
  if (n === 0) return '';
  return parts.slice(0, Math.max(n, 2)).join('%%v');
}

/** 대화상자 값 → 공차 문자열(아무것도 없으면 '') */
export function buildToleranceText(s: TolSpec): string {
  const lines: string[] = [];
  const r1 = rowText(s.rows[0]);
  const r2 = rowText(s.rows[1]);
  if (r1) lines.push(r1);
  if (r2) {
    if (!r1) lines.push('');
    lines.push(r2);
  }
  if (!lines.length) return '';
  const h = s.height.trim();
  if (h || s.projected) lines.push(h + (s.projected ? gdt('p') : ''));
  if (s.datumId.trim()) {
    if (!(h || s.projected)) lines.push('');
    lines.push(s.datumId.trim());
  }
  return lines.join('^J');
}

/** 칸 문자 하나를 조각으로: 일반 문자와 GDT 문자 */
export type Token = { gdt: string } | { text: string };

export function tokens(s: string): Token[] {
  const out: Token[] = [];
  const re = /\{\\F(?:gdt|GDT)[^;]*;([^}]*)\}/g;
  let at = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > at) out.push({ text: s.slice(at, m.index) });
    for (const ch of m[1]!) out.push({ gdt: ch.toLowerCase() });
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push({ text: s.slice(at) });
  return out;
}

const MC_OF: Record<string, MaterialCond> = { m: 'M', l: 'L', s: 'S' };

function parseCell(s: string): TolCell {
  const c = emptyCell();
  for (const t of tokens(s)) {
    if ('text' in t) c.value += t.text;
    else if (t.gdt === 'n') c.dia = true;
    else if (MC_OF[t.gdt]) c.mc = MC_OF[t.gdt]!;
  }
  return c;
}

/** 공차 문자열 → 대화상자 값(담을 수 없는 줄은 extra로) */
export function parseToleranceText(text: string): TolSpec & { extra: string[] } {
  const s = emptySpec();
  const extra: string[] = [];
  const lines = text.split(/\^J|\\P|\n/);
  let row = 0;
  let after = 0;
  for (const line of lines) {
    if (line.includes('%%v') || line.includes('%%V')) {
      if (row > 1) {
        extra.push(line);
        continue;
      }
      const parts = line.split(/%%v/i);
      const r = s.rows[row]!;
      const symTok = tokens(parts[0] ?? '').find((t) => 'gdt' in t) as { gdt: string } | undefined;
      r.sym = symTok?.gdt ?? '';
      r.tol1 = parseCell(parts[1] ?? '');
      r.tol2 = parseCell(parts[2] ?? '');
      for (let i = 0; i < 3; i++) {
        const c = parseCell(parts[3 + i] ?? '');
        r.datum[i] = { value: c.value, mc: c.mc };
      }
      row++;
    } else if (!line && after === 0 && row === 0) {
      row++;
    } else {
      if (after === 0) {
        const toks = tokens(line);
        s.projected = toks.some((t) => 'gdt' in t && t.gdt === 'p');
        s.height = toks
          .filter((t): t is { text: string } => 'text' in t)
          .map((t) => t.text)
          .join('');
      } else if (after === 1) s.datumId = line;
      else extra.push(line);
      after++;
    }
  }
  return { ...s, extra };
}

// ---------------------------------------------------------------------------
// 기호 외곽선(크기 1 상자, 가운데 0,0)
// ---------------------------------------------------------------------------

export interface Stroke {
  pts: P[];
  closed?: boolean;
}

function circle(cx: number, cy: number, r: number, n = 24): Stroke {
  const pts: P[] = [];
  for (let i = 0; i < n; i++) pts.push({ x: cx + r * Math.cos((i / n) * 2 * Math.PI), y: cy + r * Math.sin((i / n) * 2 * Math.PI) });
  return { pts, closed: true };
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number, n = 16): P[] {
  const pts: P[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

const L = (...xy: number[]): Stroke => {
  const pts: P[] = [];
  for (let i = 0; i + 1 < xy.length; i += 2) pts.push({ x: xy[i]!, y: xy[i + 1]! });
  return { pts };
};

/** 화살표(꼬리 a → 끝 b, 머리 두 획) */
function arrow(ax: number, ay: number, bx: number, by: number, head = 0.22): Stroke[] {
  const a = Math.atan2(by - ay, bx - ax);
  const h1 = a + Math.PI - 0.4;
  const h2 = a + Math.PI + 0.4;
  return [L(ax, ay, bx, by), L(bx + head * Math.cos(h1), by + head * Math.sin(h1), bx, by, bx + head * Math.cos(h2), by + head * Math.sin(h2))];
}

/** 원 안 글자 하나(재료 조건·투영) */
function circled(letter: Stroke[]): Stroke[] {
  return [circle(0, 0, 0.45), ...letter];
}

/** GDT 글꼴 문자 하나의 외곽선(없는 문자는 null) */
export function gdtGlyph(c: string): Stroke[] | null {
  const t60 = Math.PI / 3;
  const dx = Math.cos(t60);
  const dy = Math.sin(t60);
  switch (c) {
    case 'a':
      return [L(0.45, -0.35, -0.45, -0.35, 0.35, 0.4)];
    case 'b':
      return [L(-0.45, -0.38, 0.45, -0.38), L(0, -0.38, 0, 0.45)];
    case 'c':
      return [{ pts: [{ x: -0.48, y: -0.25 }, { x: 0.25, y: -0.25 }, { x: 0.48, y: 0.25 }, { x: -0.25, y: 0.25 }], closed: true }];
    case 'd':
      return [{ pts: arc(0, -0.22, 0.45, 0, Math.PI), closed: true }];
    case 'e':
      return [circle(0, 0, 0.42)];
    case 'f':
      return [L(-0.4, -0.42, -0.05, 0.42), L(0.05, -0.42, 0.4, 0.42)];
    case 'g': {
      const r = 0.28;
      const nx = -dy;
      const ny = dx;
      return [circle(0, 0, r), L(r * nx - 0.5 * dx, r * ny - 0.5 * dy, r * nx + 0.5 * dx, r * ny + 0.5 * dy), L(-r * nx - 0.5 * dx, -r * ny - 0.5 * dy, -r * nx + 0.5 * dx, -r * ny + 0.5 * dy)];
    }
    case 'h':
      return arrow(-0.3, -0.4, 0.3, 0.4);
    case 't':
      return [...arrow(-0.42, -0.4, 0.02, 0.4), ...arrow(-0.02, -0.4, 0.42, 0.4), L(-0.42, -0.4, -0.02, -0.4)];
    case 'i':
      return [L(-0.48, 0, 0.48, 0), L(-0.28, 0.24, 0.28, 0.24), L(-0.28, -0.24, 0.28, -0.24)];
    case 'j':
      return [circle(0, 0, 0.28), L(-0.48, 0, 0.48, 0), L(0, -0.48, 0, 0.48)];
    case 'k':
      return [{ pts: arc(0, -0.22, 0.45, 0, Math.PI) }];
    case 'r':
      return [circle(0, 0, 0.45), circle(0, 0, 0.24)];
    case 'u':
      return [L(-0.48, 0, 0.48, 0)];
    case 'n':
      return [circle(0, 0, 0.32), L(-0.42, -0.42, 0.42, 0.42)];
    case 'm':
      return circled([L(-0.22, -0.22, -0.22, 0.22, 0, 0, 0.22, 0.22, 0.22, -0.22)]);
    case 'l':
      return circled([L(-0.15, 0.24, -0.15, -0.22, 0.18, -0.22)]);
    case 's':
      return circled([L(0.18, 0.16, 0.08, 0.24, -0.1, 0.24, -0.2, 0.14, -0.18, 0.04, 0.18, -0.04, 0.2, -0.15, 0.1, -0.24, -0.1, -0.24, -0.2, -0.16)]);
    case 'p':
      return circled([L(-0.15, -0.25, -0.15, 0.25, 0.08, 0.25, 0.18, 0.17, 0.18, 0.06, 0.08, -0.01, -0.15, -0.01)]);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 프레임 배치
// ---------------------------------------------------------------------------

export interface TolLayout {
  /** 프레임·칸막이·기호(로컬 좌표: 삽입점 = 첫 줄 왼쪽 가운데) */
  strokes: Stroke[];
  /** 문자 자리: 왼쪽 가운데 기준점 */
  texts: { text: string; x: number; y: number }[];
  width: number;
  height: number;
}

/** 문자 폭 재기(문자 높이 h) */
export type MeasureWidth = (text: string, h: number) => number;

/** 대략의 폭(시험·미리보기용): 글자당 0.7h */
export const roughWidth: MeasureWidth = (t, h) => t.length * 0.7 * h;

function place(g: Stroke[], cx: number, cy: number, s: number): Stroke[] {
  return g.map((st) => ({ closed: st.closed, pts: st.pts.map((q) => ({ x: cx + q.x * s, y: cy + q.y * s })) }));
}

/**
 * 공차 문자열의 프레임 배치. h = 문자 높이(DIMTXT × DIMSCALE), gap = 칸 안쪽 여백(DIMGAP × DIMSCALE).
 * 줄 높이 = 2h, 기호 칸 = 정사각형. 두 줄의 기호가 같으면 기호 칸을 함께 쓴다(복합 프레임).
 */
export function toleranceLayout(text: string, h: number, gap: number, measure: MeasureWidth = roughWidth): TolLayout {
  const rowH = 2 * h;
  const pad = Math.max(gap, h * 0.25);
  const strokes: Stroke[] = [];
  const texts: TolLayout['texts'] = [];
  const box = (x0: number, y0: number, x1: number, y1: number) => strokes.push({ pts: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], closed: true });
  const lines = text.split(/\^J|\\P|\n/);
  const rows = lines.filter((l) => /%%v/i.test(l));
  const rest = lines.filter((l) => !/%%v/i.test(l));
  // 칸 내용 너비와 그리기
  const content = (s: string): { w: number; draw: (x: number, y: number) => void } => {
    const toks = tokens(s);
    let w = 0;
    const items: ({ g: Stroke[]; x: number } | { t: string; x: number })[] = [];
    for (const t of toks) {
      if ('gdt' in t) {
        const g = gdtGlyph(t.gdt);
        if (g) {
          items.push({ g, x: w + h / 2 });
          w += h * 1.1;
        } else {
          items.push({ t: t.gdt, x: w });
          w += measure(t.gdt, h);
        }
      } else if (t.text) {
        items.push({ t: t.text, x: w });
        w += measure(t.text, h);
      }
    }
    return {
      w,
      draw: (x, y) => {
        for (const it of items) {
          if ('g' in it) strokes.push(...place(it.g, x + it.x, y, h));
          else texts.push({ text: it.t, x: x + it.x, y });
        }
      },
    };
  };
  let width = 0;
  let y = 0;
  const parsed = rows.map((l) => l.split(/%%v/i));
  const symOf = (parts: string[]) => {
    const t = tokens(parts[0] ?? '').find((q) => 'gdt' in q) as { gdt: string } | undefined;
    return t?.gdt ?? '';
  };
  const shared = parsed.length === 2 && symOf(parsed[0]!) !== '' && symOf(parsed[0]!) === symOf(parsed[1]!);
  parsed.forEach((parts, ri) => {
    const top = y + rowH / 2;
    const bot = y - rowH / 2;
    let x = 0;
    const sym = symOf(parts);
    if (sym || parts[0]) {
      if (!(shared && ri === 1)) {
        const yTop = top;
        const yBot = shared ? bot - rowH : bot;
        box(0, yBot, rowH, yTop);
        const g = gdtGlyph(sym);
        if (g) strokes.push(...place(g, rowH / 2, (yTop + yBot) / 2, h));
      }
      x = rowH;
    }
    for (let i = 1; i < parts.length; i++) {
      const s = parts[i] ?? '';
      if (!s) continue;
      const c = content(s);
      const w = Math.max(rowH, c.w + 2 * pad);
      box(x, bot, x + w, top);
      c.draw(x + (w - c.w) / 2, y);
      x += w;
    }
    width = Math.max(width, x);
    y -= rowH;
  });
  // 높이(투영 공차 영역)와 데이텀 식별자
  rest.forEach((l, i) => {
    if (!l) return;
    const top = y + rowH / 2;
    const bot = y - rowH / 2;
    const c = content(l);
    const x0 = i === 0 && rows.length ? rowH : 0;
    const w = Math.max(rowH, c.w + 2 * pad);
    box(x0, bot, x0 + w, top);
    c.draw(x0 + (w - c.w) / 2, y);
    width = Math.max(width, x0 + w);
    y -= rowH;
  });
  return { strokes, texts, width, height: -y };
}
