/**
 * 플롯 스타일 표 파일(CTB·STB) 쓰기와 CTB → STB 변환(CONVERTCTB).
 *
 * 파일 = 48바이트 서명("PIAFILEVERSION_2.0,CTBVER1,compress\r\npmzlibcodec", STB는 STBVER1),
 * 압축 자료의 Adler-32 검사합·풀린 크기·압축 크기(각 4바이트, 리틀 엔디언), zlib 자료.
 * 풀린 본문은 줄마다 `이름=값` 또는 `이름{` … `}` 묶음이고, 묶음 깊이마다 빈칸 하나로 들여 쓴다.
 * 문자열 값은 앞에 따옴표 하나만 둔다(`name="Color_1`).
 */
import type { CtbPen } from '../../render/ctb';

/** 본문 항목: [이름, 값(문자열 그대로) 또는 하위 항목] */
export type PiaEntry = [string, string | PiaEntry[]];

/** 본문 → 항목(순서 유지) */
export function parsePia(text: string): PiaEntry[] {
  const root: PiaEntry[] = [];
  const stack: PiaEntry[][] = [root];
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
      const kids: PiaEntry[] = [];
      cur.push([open[1]!.trim(), kids]);
      stack.push(kids);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) cur.push([line.slice(0, eq).trim(), line.slice(eq + 1)]);
  }
  return root;
}

/** 항목 → 본문(AutoCAD처럼 깊이마다 빈칸 하나, 끝에 줄바꿈) */
export function serializePia(entries: readonly PiaEntry[]): string {
  const out: string[] = [];
  const walk = (list: readonly PiaEntry[], depth: number) => {
    const pad = ' '.repeat(depth);
    for (const [k, v] of list) {
      if (typeof v === 'string') out.push(`${pad}${k}=${v}`);
      else {
        out.push(`${pad}${k}{`);
        walk(v, depth + 1);
        out.push(`${pad}}`);
      }
    }
  };
  walk(entries, 0);
  return out.join('\n') + '\n';
}

const get = (list: readonly PiaEntry[], key: string) => list.find(([k]) => k === key)?.[1];

/** AutoCAD 기본 선가중치 표(custom_lineweight_table, mm) */
export const PIA_LINEWEIGHTS = [0.0, 0.05, 0.09, 0.1, 0.13, 0.15, 0.18, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.53, 0.6, 0.65, 0.7, 0.8, 0.9, 1.0, 1.06, 1.2, 1.4, 1.58, 2.0, 2.11];

const lwTable = (): PiaEntry[] => PIA_LINEWEIGHTS.map((v, i) => [String(i), v.toFixed(Math.max(1, (String(v).split('.')[1] ?? '').length))]);

/** 플롯 스타일 하나의 기본 항목(이름·색·펜 번호·스크린·선종류·선가중치·채우기·끝·결합) */
function styleEntries(name: string, over: Partial<Record<string, string>> = {}): PiaEntry[] {
  const base: PiaEntry[] = [
    ['name', `"${name}`],
    ['localized_name', `"${name}`],
    ['description', '"'],
    ['color', '-1'],
    ['color_policy', '1'],
    ['physical_pen_number', '0'],
    ['virtual_pen_number', '0'],
    ['screen', '100'],
    ['linepattern_size', '0.5'],
    ['linetype', '31'],
    ['adaptive_linetype', 'TRUE'],
    ['lineweight', '0'],
    ['fill_style', '73'],
    ['end_style', '4'],
    ['join_style', '5'],
  ];
  return base.map(([k, v]) => [k, over[k] ?? v] as PiaEntry);
}

/**
 * CTB 본문 → STB 본문. 머리 항목은 그대로 두고 aci_table_available=FALSE, aci_table은 뺀다.
 * plot_style의 0번은 Normal(객체 특성 그대로), 1~255번은 CTB 펜 0~254번을 Color_1 ~ Color_255 이름으로 옮긴다.
 */
export function ctbToStb(text: string): string {
  const src = parsePia(text);
  const ps = get(src, 'plot_style');
  if (!ps || typeof ps === 'string') throw new Error('plot_style 묶음이 없습니다.');
  const styles: PiaEntry[] = [['0', styleEntries('Normal')]];
  for (let i = 0; i < 255; i++) {
    const pen = get(ps, String(i));
    const name = `Color_${i + 1}`;
    const kids: PiaEntry[] = typeof pen === 'string' || !pen ? styleEntries(name) : pen.map(([k, v]) => (k === 'name' || k === 'localized_name' ? [k, `"${name}`] : [k, v]) as PiaEntry);
    if (!kids.some(([k]) => k === 'name')) kids.unshift(['name', `"${name}`]);
    styles.push([String(i + 1), kids]);
  }
  const out: PiaEntry[] = [];
  let placed = false;
  for (const [k, v] of src) {
    if (k === 'aci_table') continue;
    if (k === 'plot_style') {
      out.push(['plot_style', styles]);
      placed = true;
      continue;
    }
    out.push(k === 'aci_table_available' ? [k, 'FALSE'] : [k, v]);
  }
  if (!placed) out.push(['plot_style', styles]);
  if (!out.some(([k]) => k === 'aci_table_available')) out.splice(1, 0, ['aci_table_available', 'FALSE']);
  if (!out.some(([k]) => k === 'custom_lineweight_table')) out.push(['custom_lineweight_table', lwTable()]);
  return serializePia(out);
}

/** 펜 표 → CTB 본문(파일 없이 불러온 표·기본 표를 변환할 때) */
export function ctbTextFromPens(pens: readonly CtbPen[], description = ''): string {
  const aci: PiaEntry[] = [];
  const styles: PiaEntry[] = [];
  for (let i = 0; i < 255; i++) {
    const p = pens[i] ?? { color: null, gray: false, screen: 100, lineweight: null };
    const name = `Color_${i + 1}`;
    aci.push([String(i), `"${name}`]);
    // 색 정책: 1 = 디더, 2 = 회색조, 4 = 지정한 색. 지정한 색은 0xFF000000 | RGB(부호 있는 32비트)
    const policy = 1 | (p.gray ? 2 : 0) | (p.color !== null ? 4 : 0);
    const color = p.color !== null ? String((0xff000000 | (p.color & 0xffffff)) | 0) : '-1';
    styles.push([String(i), styleEntries(name, { color, color_policy: String(policy), screen: String(Math.round(p.screen)), lineweight: String(lineweightIndex(p.lineweight)) })]);
  }
  return serializePia([
    ['description', `"${description}`],
    ['aci_table_available', 'TRUE'],
    ['scale_factor', '1.0'],
    ['apply_factor', 'FALSE'],
    ['custom_lineweight_display_units', '0'],
    ['aci_table', aci],
    ['plot_style', styles],
    ['custom_lineweight_table', lwTable()],
  ]);
}

/** 선가중치(mm) → 표 번호(없으면 0 = 객체 선가중치) */
export function lineweightIndex(mm: number | null): number {
  if (mm === null || !(mm > 0)) return 0;
  let best = 1;
  for (let i = 1; i < PIA_LINEWEIGHTS.length; i++) if (Math.abs(PIA_LINEWEIGHTS[i]! - mm) < Math.abs(PIA_LINEWEIGHTS[best]! - mm)) best = i;
  return best;
}

/** AutoCAD와 함께 오는 색상 종속 표의 펜(파일 없이 변환할 수 있게) */
export function standardCtbPens(name: string): CtbPen[] | null {
  const n = name.toLowerCase().replace(/\.ctb$/, '');
  const all = (p: CtbPen) => Array.from({ length: 255 }, () => ({ ...p }));
  if (n === 'monochrome') return all({ color: 0, gray: false, screen: 100, lineweight: null });
  if (n === 'grayscale') return all({ color: null, gray: true, screen: 100, lineweight: null });
  if (n === 'acad') return all({ color: null, gray: false, screen: 100, lineweight: null });
  const m = /^screening (\d+)%$/.exec(n);
  if (m) return all({ color: null, gray: false, screen: Math.min(100, Number(m[1])), lineweight: null });
  return null;
}

export const STANDARD_CTBS = ['monochrome.ctb', 'Grayscale.ctb', 'acad.ctb', 'Screening 25%.ctb', 'Screening 50%.ctb', 'Screening 75%.ctb', 'Screening 100%.ctb'];

// ---------------------------------------------------------------------------
// 파일 묶기·풀기
// ---------------------------------------------------------------------------

/** Adler-32 */
export function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = 0; i < data.length; ) {
    // 5552바이트마다 나머지를 구하면 32비트를 넘지 않는다
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i++) {
      a += data[i]!;
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

export type PiaKind = 'CTB' | 'STB';

const signature = (kind: PiaKind) => `PIAFILEVERSION_2.0,${kind}VER1,compress\r\npmzlibcodec`;

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const s = new Blob([data as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(s).arrayBuffer());
}

const latin1 = (s: string) => Uint8Array.from(s, (c) => (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 63));

/** 본문 → CTB·STB 파일 바이트 */
export async function packPia(text: string, kind: PiaKind): Promise<Uint8Array<ArrayBuffer>> {
  const raw = latin1(text);
  const z = await pipe(raw, new CompressionStream('deflate'));
  const head = latin1(signature(kind));
  const out = new Uint8Array(60 + z.length);
  out.set(head, 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(48, adler32(z), true);
  dv.setUint32(52, raw.length, true);
  dv.setUint32(56, z.length, true);
  out.set(z, 60);
  return out;
}

/** CTB·STB 파일 바이트 → 종류와 본문. 형식이 아니면 null */
export async function unpackPia(data: Uint8Array): Promise<{ kind: PiaKind; text: string } | null> {
  if (data.length < 62) return null;
  let head = '';
  for (let i = 0; i < 48; i++) head += String.fromCharCode(data[i]!);
  if (!head.startsWith('PIAFILEVERSION_')) return null;
  const kind: PiaKind | null = /STBVER/i.test(head) ? 'STB' : /CTBVER/i.test(head) ? 'CTB' : null;
  if (!kind) return null;
  try {
    const raw = await pipe(data.subarray(60), new DecompressionStream('deflate'));
    let text = '';
    for (let i = 0; i < raw.length; i += 8192) text += String.fromCharCode(...raw.subarray(i, i + 8192));
    return { kind, text };
  } catch {
    return null;
  }
}
