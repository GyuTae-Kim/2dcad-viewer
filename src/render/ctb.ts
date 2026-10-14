/**
 * 색상 종속 플롯 스타일 표(CTB) 읽기.
 * 파일: 48바이트 서명("PIAFILEVERSION_2.0,CTBVER1,compress\r\npmzlibcodec"), 검사합·풀린 크기·압축 크기(각 4바이트), zlib 자료.
 * 풀린 본문은 `이름=값`과 `이름{ … }` 묶음의 문자열이다. plot_style의 0~254번이 ACI 1~255의 펜이다.
 */

export interface CtbPen {
  /** 출력 색(RGB). null이면 객체 색 */
  color: number | null;
  /** 회색조로 바꾸기 */
  gray: boolean;
  /** 스크린(진하기) 0~100 */
  screen: number;
  /** 선가중치(mm). null이면 객체 선가중치 */
  lineweight: number | null;
}

export interface CtbTable {
  name: string;
  pens: CtbPen[];
}

interface Node {
  [k: string]: string | Node;
}

/** `이름=값`·`이름{ … }` 본문 → 중첩 객체 */
function parseBody(text: string): Node {
  const root: Node = {};
  const stack: Node[] = [root];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cur = stack[stack.length - 1]!;
    if (line === '}') {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const open = /^([^=]+)\{$/.exec(line);
    if (open) {
      const n: Node = {};
      cur[open[1]!.trim()] = n;
      stack.push(n);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) {
      let v = line.slice(eq + 1);
      if (v.startsWith('"')) v = v.slice(1);
      cur[line.slice(0, eq).trim()] = v;
    }
  }
  return root;
}

/** 풀린 CTB 본문 → 펜 표 */
export function parseCtbText(text: string, name: string): CtbTable | null {
  const root = parseBody(text);
  const ps = root.plot_style;
  if (!ps || typeof ps === 'string') return null;
  const lwTable = root.custom_lineweight_table;
  const lwOf = (i: number): number | null => {
    if (!i) return null;
    if (lwTable && typeof lwTable !== 'string') {
      const v = lwTable[String(i)];
      if (typeof v === 'string' && Number.isFinite(Number(v))) return Number(v);
    }
    return null;
  };
  const pens: CtbPen[] = [];
  for (let i = 0; i < 255; i++) {
    const p = ps[String(i)];
    if (!p || typeof p === 'string') {
      pens.push({ color: null, gray: false, screen: 100, lineweight: null });
      continue;
    }
    const num = (k: string, d: number) => {
      const v = p[k];
      return typeof v === 'string' && Number.isFinite(Number(v)) ? Number(v) : d;
    };
    const c = num('color', -1) >>> 0;
    const policy = num('color_policy', 1);
    // 색 정책: 비트 4 = 지정한 색(아래 24비트 RGB), 비트 2 = 회색조. 0xFFFFFFFF = 객체 색
    const explicit = (policy & 4) !== 0 && c !== 0xffffffff;
    pens.push({
      color: explicit ? c & 0xffffff : null,
      gray: (policy & 2) !== 0,
      screen: Math.max(0, Math.min(100, num('screen', 100))),
      lineweight: lwOf(num('lineweight', 0)),
    });
  }
  return { name, pens };
}

/** CTB 파일 바이트 → 펜 표(브라우저·Node의 DecompressionStream) */
export async function readCtb(data: Uint8Array, name: string): Promise<CtbTable | null> {
  let head = '';
  for (let i = 0; i < Math.min(48, data.length); i++) head += String.fromCharCode(data[i]!);
  if (!/^PIAFILEVERSION_/.test(head)) return null;
  if (!/CTBVER/i.test(head)) return null;
  const z = data.subarray(60);
  try {
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([z as BlobPart]).stream().pipeThrough(ds);
    const text = new TextDecoder('latin1').decode(await new Response(stream).arrayBuffer());
    return parseCtbText(text, name);
  } catch {
    return null;
  }
}

/** 펜을 적용한 색(스크린은 흰 종이 쪽으로 옅게) */
export function penColor(pen: CtbPen, rgb: number): number {
  let c = pen.color ?? rgb;
  let r = (c >> 16) & 255;
  let g = (c >> 8) & 255;
  let b = c & 255;
  if (pen.gray) {
    const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    r = g = b = y;
  }
  if (pen.screen < 100) {
    const k = pen.screen / 100;
    r = Math.round(255 - (255 - r) * k);
    g = Math.round(255 - (255 - g) * k);
    b = Math.round(255 - (255 - b) * k);
  }
  c = (r << 16) | (g << 8) | b;
  return c;
}
