/**
 * 치수 변수 재지정(DIMOVERRIDE): 변수 이름 ↔ 그룹 코드, 값 검사, 객체의 재지정(overrides)과
 * ACAD 확장 데이터의 DSTYLE 묶음(1000 "DSTYLE", 1002 "{", (1070 코드, 값)…, 1002 "}")을 함께 고친다.
 * DXF 쓰기는 overrides로 DSTYLE을 다시 만들지만 DWG 쓰기는 확장 데이터를 그대로 쓰므로 둘을 늘 맞춘다.
 */
import { DIM_HANDLE_CODES, DIM_VAR_CODES } from '../../core/dimvars';
import type { CadDocument, XData } from '../../core/model';
import { tableKey } from '../../core/model';

export type Overrides = Record<number, string | number>;

/** 변수 이름 → 그룹 코드(같은 이름이 둘이면 핸들 코드 340~347) */
export const DIM_VAR_BY_NAME: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  for (const [codeS, name] of Object.entries(DIM_VAR_CODES)) {
    const code = Number(codeS);
    const prev = m.get(name);
    if (prev === undefined || DIM_HANDLE_CODES.has(code)) m.set(name, code);
  }
  return m;
})();

export type VarKind = 'str' | 'real' | 'angle' | 'int' | 'handle';

export function varKind(code: number): VarKind {
  if (DIM_HANDLE_CODES.has(code)) return 'handle';
  if (code === 50) return 'angle';
  if (code < 10) return 'str';
  if ((code >= 40 && code < 60) || (code >= 140 && code < 150)) return 'real';
  return 'int';
}

/** 정수 변수의 범위 */
const INT_RANGE: Record<number, [number, number]> = {
  69: [0, 2], // DIMTFILL
  70: [0, 256], // DIMTFILLCLR
  77: [0, 4], // DIMTAD
  78: [0, 15], // DIMZIN
  79: [0, 3], // DIMAZIN
  90: [0, 2], // DIMARCSYM
  171: [0, 8], // DIMALTD
  176: [0, 256],
  177: [0, 256],
  178: [0, 256],
  179: [-1, 8], // DIMADEC
  270: [1, 8],
  271: [0, 8],
  272: [0, 8],
  273: [1, 8],
  274: [0, 8],
  275: [0, 4],
  276: [0, 3],
  277: [1, 6],
  279: [0, 2],
  280: [0, 4],
  283: [0, 2],
  284: [0, 15],
  285: [0, 15],
  286: [0, 15],
  287: [0, 5],
  289: [0, 3],
};
/** 켜기/끄기 변수 */
const ON_OFF = new Set([71, 72, 73, 74, 75, 76, 170, 172, 173, 174, 175, 281, 282, 288, 290, 294]);
const LINEWEIGHTS = new Set([-3, -2, -1, 0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211]);

export interface ParsedValue {
  value?: string | number;
  /** 잘못된 값이면 안내 */
  error?: string;
}

/**
 * 입력한 값 → 저장할 값. 핸들 변수는 이름으로 찾은 핸들(블록이 아직 없으면 needBlock에 이름).
 * 각도(DIMJOGANG)는 도 단위로 받아 라디안으로 둔다(5~90°).
 */
export function parseVarValue(doc: CadDocument, code: number, input: string): ParsedValue & { needBlock?: string } {
  const t = input.trim();
  const kind = varKind(code);
  if (kind === 'str') return { value: t === '.' ? '' : t };
  if (kind === 'handle') {
    if (code === 340) {
      const s = doc.textStyles.get(tableKey(t || 'Standard'));
      return s ? { value: s.handle } : { error: `문자 스타일 ${t}을(를) 찾을 수 없습니다.` };
    }
    if (code >= 345) {
      const lt = doc.linetypes.get(tableKey(t || 'ByBlock'));
      return lt ? { value: lt.handle } : { error: `선종류 ${t}을(를) 찾을 수 없습니다. 먼저 로드하십시오.` };
    }
    // 화살촉 블록: "."·빈 값 = 닫고 채움(기본)
    if (!t || t === '.' || /^_?closedfilled$/i.test(t)) return { value: 0 };
    const name = t;
    const r = doc.blockRecords.get(tableKey(name)) ?? doc.blockRecords.get(tableKey(`_${name.replace(/^_/, '')}`));
    if (r) return { value: r.handle };
    return { needBlock: name };
  }
  const n = Number(t);
  if (kind === 'real') {
    if (!t || !Number.isFinite(n)) return { error: '실수 값을 입력하십시오.' };
    if (code === 144 && n === 0) return { error: '0이 아닌 값을 입력하십시오.' };
    if (![145, 47, 48, 141, 144].includes(code) && n < 0) return { error: '양수 또는 0을 입력하십시오.' };
    return { value: n };
  }
  if (kind === 'angle') {
    if (!t || !Number.isFinite(n)) return { error: '각도를 입력하십시오.' };
    if (n < 5 || n > 90) return { error: '값은 5와 90 사이여야 합니다.' };
    return { value: (n * Math.PI) / 180 };
  }
  // 정수
  if (code === 278) {
    // DIMDSEP: 한 글자
    if (t.length === 1) return { value: t.charCodeAt(0) };
    if (/^\d+$/.test(t)) return { value: Number(t) };
    return { error: '한 글자를 입력하십시오.' };
  }
  let v = n;
  if (ON_OFF.has(code)) {
    const u = t.toUpperCase();
    if (u === 'ON' || u === '켜기') v = 1;
    else if (u === 'OFF' || u === '끄기') v = 0;
    if (v !== 0 && v !== 1) return { error: '0(끄기) 또는 1(켜기)을 입력하십시오.' };
    return { value: v };
  }
  if (!t || !Number.isInteger(v)) return { error: '정수 값을 입력하십시오.' };
  if (code === 371 || code === 372) return LINEWEIGHTS.has(v) ? { value: v } : { error: '올바른 선가중치가 아닙니다.' };
  const r = INT_RANGE[code];
  if (r && (v < r[0] || v > r[1])) return { error: `값은 ${r[0]}와 ${r[1]} 사이여야 합니다.` };
  return { value: v };
}

/** 보이기용 값 */
export function formatVarValue(doc: CadDocument, name: string, v: number | string | undefined): string {
  if (v === undefined || v === '') return name === 'DIMBLK' || name === 'DIMBLK1' || name === 'DIMBLK2' || name === 'DIMLDRBLK' ? '.' : '';
  const code = DIM_VAR_BY_NAME.get(name) ?? 0;
  if (code === 50 && typeof v === 'number') return String(Math.round((v * 180) / Math.PI * 1e6) / 1e6);
  if (code === 278 && typeof v === 'number') return String.fromCharCode(v);
  if (typeof v === 'number') return String(Math.round(v * 1e8) / 1e8);
  void doc;
  return v;
}

const isDstyle = (it: { code: number; value: unknown }) => it.code === 1000 && String(it.value).toUpperCase() === 'DSTYLE';

/** ACAD 확장 데이터에서 DSTYLE 묶음을 뺀 나머지 */
function withoutDstyle(xdata: XData[] | undefined): XData[] {
  const out: XData[] = [];
  for (const x of xdata ?? []) {
    if (x.app.toUpperCase() !== 'ACAD') {
      out.push({ app: x.app, items: [...x.items] });
      continue;
    }
    const items = [...x.items];
    const i = items.findIndex(isDstyle);
    if (i >= 0) {
      let j = i + 1;
      let depth = 0;
      for (; j < items.length; j++) {
        const it = items[j]!;
        if (it.code === 1002 && it.value === '{') depth++;
        else if (it.code === 1002 && it.value === '}') {
          depth--;
          if (depth <= 0) {
            j++;
            break;
          }
        }
      }
      items.splice(i, j - i);
    }
    out.push({ app: x.app, items });
  }
  return out;
}

/** 재지정 → DSTYLE 확장 데이터(다른 앱·ACAD의 다른 기록은 그대로) */
export function dstyleXData(xdata: XData[] | undefined, ov: Overrides | undefined): XData[] | undefined {
  const list = withoutDstyle(xdata);
  const keys = ov ? Object.keys(ov).map(Number).filter((k) => Number.isFinite(k)).sort((a, b) => a - b) : [];
  if (keys.length) {
    let acad = list.find((x) => x.app.toUpperCase() === 'ACAD');
    if (!acad) {
      acad = { app: 'ACAD', items: [] };
      list.unshift(acad);
    }
    acad.items.push({ code: 1000, value: 'DSTYLE' }, { code: 1002, value: '{' });
    for (const k of keys) {
      const v = ov![k]!;
      const kind = varKind(k);
      if (kind === 'handle') {
        if (typeof v !== 'string' || !v) continue;
        acad.items.push({ code: 1070, value: k }, { code: 1005, value: v.toUpperCase() });
      } else if (kind === 'real' || kind === 'angle') acad.items.push({ code: 1070, value: k }, { code: 1040, value: Number(v) });
      else if (kind === 'str') acad.items.push({ code: 1070, value: k }, { code: 1000, value: String(v) });
      else acad.items.push({ code: 1070, value: k }, { code: 1070, value: Math.trunc(Number(v)) });
    }
    acad.items.push({ code: 1002, value: '}' });
  }
  const out = list.filter((x) => x.items.length);
  return out.length ? out : undefined;
}

/** 재지정을 더하거나(값) 지운(undefined) 새 overrides·xdata */
export function applyOverrides<T extends { overrides?: Overrides; xdata?: XData[] }>(e: T, changes: Overrides | null): T {
  const c = structuredClone(e);
  let ov: Overrides | undefined;
  if (changes === null) ov = undefined;
  else {
    ov = { ...(e.overrides ?? {}) };
    for (const [k, v] of Object.entries(changes)) ov[Number(k)] = v;
    if (!Object.keys(ov).length) ov = undefined;
  }
  if (ov) c.overrides = ov;
  else delete c.overrides;
  const xd = dstyleXData(e.xdata, ov);
  if (xd) c.xdata = xd;
  else delete c.xdata;
  return c;
}
