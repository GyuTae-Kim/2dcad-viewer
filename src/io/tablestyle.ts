/**
 * 테이블 스타일(TABLESTYLE) 값 — DXF 태그 ↔ 형식 중립 값. DXF 쓰기(버전에 맞는 태그), DWG 읽기(원본 태그 만들기),
 * DWG 쓰기(옛 배치·R2010+ 배치)가 같이 쓴다.
 *
 * DXF(AutoCAD 표본): 100 AcDbTableStyle, (R2010+) 280 0, 3 설명, 70 흐름, 71 플래그, 40·41 여백, 280·281 제목·머리글 숨김,
 * 행 스타일 셋(데이터·제목·머리글 순)마다 7 문자 스타일, 140 높이, 170 정렬, 62 문자 색, 63 채우기 색, 283 채우기 사용,
 * (R2007+) 90 자료 종류, 91 단위, 1 형식, 테두리 여섯(위·가로 안쪽·아래·왼쪽·세로 안쪽·오른쪽)마다 274+i 선가중치,
 * 284+i 보임, 64+i 색.
 */
import type { CadColor, RawTag } from '../core/model';

export interface IoBorder {
  lineweight: number;
  visible: boolean;
  color: CadColor;
}

export interface IoRowStyle {
  textStyle: string;
  height: number;
  align: number;
  color: CadColor;
  fill: CadColor;
  fillOn: boolean;
  dataType: number;
  unitType: number;
  format: string;
  /** 위·가로 안쪽·아래·왼쪽·세로 안쪽·오른쪽 */
  borders: IoBorder[];
}

export interface IoTableStyle {
  description: string;
  flow: number;
  flags: number;
  hMargin: number;
  vMargin: number;
  titleSuppressed: boolean;
  headerSuppressed: boolean;
  /** 데이터·제목·머리글 순 */
  rows: IoRowStyle[];
}

const num = (v: string | number | undefined, d = 0): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
};

export function defaultRowStyle(height: number, align: number): IoRowStyle {
  return {
    textStyle: 'Standard',
    height,
    align,
    color: { aci: 0 },
    fill: { aci: 7 },
    fillOn: false,
    dataType: 512,
    unitType: 0,
    format: '',
    borders: Array.from({ length: 6 }, () => ({ lineweight: -2, visible: true, color: { aci: 0 } })),
  };
}

export function defaultIoTableStyle(metric: boolean, name = 'Standard'): IoTableStyle {
  const h = metric ? 4.5 : 0.18;
  const th = metric ? 6 : 0.25;
  const m = metric ? 1.5 : 0.06;
  return { description: name, flow: 0, flags: 0, hMargin: m, vMargin: m, titleSuppressed: false, headerSuppressed: false, rows: [defaultRowStyle(h, 2), defaultRowStyle(th, 5), defaultRowStyle(h, 5)] };
}

/** DXF 태그(100 AcDbTableStyle부터) → 값. 표지가 없으면 null */
export function parseTableStyleTags(raw: readonly RawTag[] | undefined): IoTableStyle | null {
  if (!raw) return null;
  let i = raw.findIndex((t) => t.code === 100 && String(t.value).trim() === 'AcDbTableStyle');
  if (i < 0) return null;
  i++;
  // R2010+: 표지 바로 뒤 280(판)
  if (raw[i]?.code === 280 && raw[i + 1]?.code === 3) i++;
  const s = defaultIoTableStyle(false, '');
  s.rows = [];
  let row: IoRowStyle | null = null;
  for (; i < raw.length; i++) {
    const t = raw[i]!;
    if (t.code === 100) break;
    if (t.code === 7) {
      row = defaultRowStyle(0.18, 1);
      row.textStyle = String(t.value) || 'Standard';
      s.rows.push(row);
      continue;
    }
    if (!row) {
      switch (t.code) {
        case 3:
          s.description = String(t.value);
          break;
        case 70:
          s.flow = num(t.value);
          break;
        case 71:
          s.flags = num(t.value);
          break;
        case 40:
          s.hMargin = num(t.value, s.hMargin);
          break;
        case 41:
          s.vMargin = num(t.value, s.vMargin);
          break;
        case 280:
          s.titleSuppressed = num(t.value) !== 0;
          break;
        case 281:
          s.headerSuppressed = num(t.value) !== 0;
          break;
      }
      continue;
    }
    const c = t.code;
    if (c === 140) row.height = num(t.value, row.height);
    else if (c === 170) row.align = num(t.value, row.align);
    else if (c === 62) row.color = { aci: num(t.value) };
    else if (c === 63) row.fill = { aci: num(t.value, 7) };
    else if (c === 283) row.fillOn = num(t.value) !== 0;
    else if (c === 90) row.dataType = num(t.value);
    else if (c === 91) row.unitType = num(t.value);
    else if (c === 1) row.format = String(t.value);
    else if (c >= 274 && c <= 279) row.borders[c - 274]!.lineweight = num(t.value, -2);
    else if (c >= 284 && c <= 289) row.borders[c - 284]!.visible = num(t.value, 1) !== 0;
    else if (c >= 64 && c <= 69) row.borders[c - 64]!.color = { aci: num(t.value) };
  }
  while (s.rows.length < 3) s.rows.push(defaultRowStyle(s.rows.length === 1 ? 0.25 : 0.18, s.rows.length ? 5 : 2));
  s.rows.length = 3;
  return s;
}

const aci = (c: CadColor): number => (c.aci >= 0 && c.aci <= 257 ? c.aci : 7);

/** 값 → 대상 DXF 버전(1018 …)의 태그 */
export function tableStyleTags(s: IoTableStyle, ver: number): RawTag[] {
  const out: RawTag[] = [{ code: 100, value: 'AcDbTableStyle' }];
  const t = (code: number, value: string | number) => out.push({ code, value });
  if (ver >= 1024) t(280, 0);
  t(3, s.description);
  t(70, s.flow);
  t(71, s.flags);
  t(40, s.hMargin);
  t(41, s.vMargin);
  t(280, s.titleSuppressed ? 1 : 0);
  t(281, s.headerSuppressed ? 1 : 0);
  for (const r of s.rows) {
    t(7, r.textStyle || 'Standard');
    t(140, r.height);
    t(170, r.align);
    t(62, aci(r.color));
    t(63, aci(r.fill));
    t(283, r.fillOn ? 1 : 0);
    if (ver >= 1021) {
      t(90, r.dataType);
      t(91, r.unitType);
      t(1, r.format);
    }
    r.borders.forEach((b, i) => {
      t(274 + i, b.lineweight);
      t(284 + i, b.visible ? 1 : 0);
      t(64 + i, aci(b.color));
    });
  }
  return out;
}

/** 태그가 대상 버전의 배치인지(R2004 / R2007 / R2010+) */
export function tableStyleTagsFit(raw: readonly RawTag[], ver: number): boolean {
  const i = raw.findIndex((t) => t.code === 100 && String(t.value).trim() === 'AcDbTableStyle');
  if (i < 0) return true;
  const lead280 = raw[i + 1]?.code === 280 && raw[i + 2]?.code === 3;
  const has90 = raw.some((t, k) => k > i && t.code === 90);
  const fam = lead280 ? 3 : has90 ? 2 : 1;
  const want = ver >= 1024 ? 3 : ver >= 1021 ? 2 : 1;
  return fam === want;
}
