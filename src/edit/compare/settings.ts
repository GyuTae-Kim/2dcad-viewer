/**
 * 도면 비교(COMPARE) 시스템 변수: 이름·형·초기값·범위와 값 읽기(DOM 없음).
 * 저장은 앱이 한다(이 브라우저의 localStorage). 여기서는 값의 뜻만 정한다.
 */

/** 정수 변수 */
export interface IntVar {
  kind: 'int';
  name: string;
  def: number;
  min: number;
  max: number;
  /** 명령행 설명 */
  title: string;
}

/** 색상 변수(ACI 1–255, `RGB:r,g,b` 또는 #rrggbb) */
export interface ColorVar {
  kind: 'color';
  name: string;
  def: string;
  title: string;
}

export type CompareVar = IntVar | ColorVar;

export const COMPARE_VARS: readonly CompareVar[] = [
  { kind: 'color', name: 'COMPARECOLOR1', def: '82', title: '현재 도면에서만 있는 객체의 색상' },
  { kind: 'color', name: 'COMPARECOLOR2', def: '1', title: '비교 도면에서만 있는 객체의 색상' },
  { kind: 'color', name: 'COMPARECOLORCOMMON', def: '253', title: '차이 없는 객체의 색상' },
  { kind: 'int', name: 'COMPAREFRONT', def: 1, min: 1, max: 2, title: '앞에 그릴 도면(1 현재, 2 비교)' },
  { kind: 'int', name: 'COMPAREHATCH', def: 0, min: 0, max: 1, title: '해치 비교' },
  { kind: 'int', name: 'COMPARETEXT', def: 1, min: 0, max: 1, title: '문자 비교' },
  { kind: 'int', name: 'COMPAREPROPS', def: 0, min: 0, max: 127, title: '비교할 특성(1 색상, 2 도면층, 4 선종류, 8 선종류 축척, 16 선가중치, 32 두께, 64 투명도)' },
  { kind: 'int', name: 'COMPARETOLERANCE', def: 6, min: 0, max: 14, title: '비교 허용 오차(소수점 자릿수)' },
  { kind: 'int', name: 'COMPARERCSHAPE', def: 0, min: 0, max: 1, title: '구름형 리비전 쉐이프(0 직사각형, 1 폴리곤)' },
  { kind: 'int', name: 'COMPARERCMARGIN', def: 5, min: 1, max: 25, title: '구름형 리비전 여백' },
  { kind: 'int', name: 'COMPARESHOW1', def: 1, min: 0, max: 1, title: '현재 도면에서만 있는 객체 표시' },
  { kind: 'int', name: 'COMPARESHOW2', def: 1, min: 0, max: 1, title: '비교 도면에서만 있는 객체 표시' },
  { kind: 'int', name: 'COMPARESHOWCOMMON', def: 1, min: 0, max: 1, title: '차이 없는 객체 표시' },
  { kind: 'int', name: 'COMPARESHOWRC', def: 1, min: 0, max: 1, title: '구름형 리비전 표시' },
];

export function compareVar(name: string): CompareVar | undefined {
  const n = name.trim().toUpperCase();
  return COMPARE_VARS.find((v) => v.name === n);
}

/** 색상 값 → ACI 또는 RGB. 올바르지 않으면 null */
export function parseCompareColor(text: string): { aci: number } | { rgb: number } | null {
  const t = text.trim();
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return n >= 1 && n <= 255 ? { aci: n } : null;
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(t);
  if (hex) return { rgb: parseInt(hex[1]!, 16) };
  const rgb = /^(?:RGB\s*:)?\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/i.exec(t);
  if (rgb) {
    const c = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    if (c.some((v) => v > 255)) return null;
    return { rgb: (c[0]! << 16) | (c[1]! << 8) | c[2]! };
  }
  return null;
}

/** 색상 값의 표준 글(ACI는 번호, 트루컬러는 `RGB:r,g,b`) */
export function formatCompareColor(c: { aci: number } | { rgb: number }): string {
  if ('aci' in c) return String(c.aci);
  return `RGB:${(c.rgb >> 16) & 255},${(c.rgb >> 8) & 255},${c.rgb & 255}`;
}

/**
 * 저장된 값을 읽는다: 정수 변수는 범위를 벗어나면 가장 가까운 허용 값, 숫자가 아니면 초기값.
 * 색상 변수는 올바르지 않으면 초기값.
 */
export function normalizeStored(v: CompareVar, raw: string | null | undefined): string | number {
  if (v.kind === 'color') {
    const c = raw == null ? null : parseCompareColor(raw);
    return c ? formatCompareColor(c) : v.def;
  }
  const n = raw == null || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(n)) return v.def;
  return Math.max(v.min, Math.min(v.max, Math.round(n)));
}

/** 명령행 입력을 검사한다: 받아들이면 { value }, 아니면 { error } */
export function parseInput(v: CompareVar, text: string): { value: string | number } | { error: string } {
  if (v.kind === 'color') {
    const c = parseCompareColor(text);
    return c ? { value: formatCompareColor(c) } : { error: '1과 255 사이의 색상 번호나 RGB:r,g,b 또는 #rrggbb를 입력하십시오.' };
  }
  const t = text.trim();
  if (!/^-?\d+$/.test(t)) return { error: `${v.min}과 ${v.max} 사이의 정수를 입력하십시오.` };
  const n = Number(t);
  if (n < v.min || n > v.max) return { error: `${v.min}과 ${v.max} 사이의 정수를 입력하십시오.` };
  return { value: n };
}

/** 비교 설정(변수 값을 모은 것) */
export interface CompareSettings {
  color1: string;
  color2: string;
  colorCommon: string;
  front: number;
  hatch: boolean;
  text: boolean;
  props: number;
  tolerance: number;
  rcShape: number;
  rcMargin: number;
  show1: boolean;
  show2: boolean;
  showCommon: boolean;
  showRc: boolean;
}

/** 변수 값 읽기 함수 → 설정 */
export function settingsFrom(get: (name: string) => string | number): CompareSettings {
  const n = (k: string) => Number(get(k));
  return {
    color1: String(get('COMPARECOLOR1')),
    color2: String(get('COMPARECOLOR2')),
    colorCommon: String(get('COMPARECOLORCOMMON')),
    front: n('COMPAREFRONT'),
    hatch: n('COMPAREHATCH') === 1,
    text: n('COMPARETEXT') === 1,
    props: n('COMPAREPROPS'),
    tolerance: n('COMPARETOLERANCE'),
    rcShape: n('COMPARERCSHAPE'),
    rcMargin: n('COMPARERCMARGIN'),
    show1: n('COMPARESHOW1') === 1,
    show2: n('COMPARESHOW2') === 1,
    showCommon: n('COMPARESHOWCOMMON') === 1,
    showRc: n('COMPARESHOWRC') === 1,
  };
}

/** 초기값만으로 만든 설정 */
export function defaultSettings(): CompareSettings {
  return settingsFrom((name) => compareVar(name)!.def);
}
