/**
 * 명령행 버전 명령의 순수 계산(화면 없음): 단위 이름·변환, 클래식 배열 위치, 이름 목록 나열 등.
 */

/** INSUNITS 번호 → 한국어 이름(AutoCAD 2026 한국어판 "단위" 목록) */
export const UNIT_NAMES: Record<number, string> = {
  0: '단위 없음',
  1: '인치',
  2: '피트',
  3: '마일',
  4: '밀리미터',
  5: '센티미터',
  6: '미터',
  7: '킬로미터',
  8: '마이크로인치',
  9: '밀',
  10: '야드',
  11: '옹스트롬',
  12: '나노미터',
  13: '미크론',
  14: '데시미터',
  15: '데카미터',
  16: '헥토미터',
  17: '기가미터',
  18: '천문 단위',
  19: '광년',
  20: '파섹',
};

/** 단위 1의 길이(mm). 모르는 단위는 null */
export function unitInMm(u: number): number | null {
  const t: Record<number, number> = {
    1: 25.4,
    2: 304.8,
    3: 1609344,
    4: 1,
    5: 10,
    6: 1000,
    7: 1e6,
    8: 0.0000254,
    9: 0.0254,
    10: 914.4,
    11: 1e-7,
    12: 1e-6,
    13: 1e-3,
    14: 100,
    15: 10000,
    16: 100000,
    17: 1e12,
    18: 1.495978707e14,
    19: 9.4607304725808e18,
    20: 3.0856775814913673e19,
  };
  return t[u] ?? null;
}

/** 블록 단위 → 도면 단위 변환 비율(둘 중 하나라도 단위 없음이면 1) */
export function insertUnitFactor(blockUnits: number, drawingUnits: number): number {
  if (!blockUnits || !drawingUnits || blockUnits === drawingUnits) return 1;
  const a = unitInMm(blockUnits);
  const b = unitInMm(drawingUnits);
  return a && b ? a / b : 1;
}

/** 클래식 직사각형 배열의 항목 이동량(첫 항목 0,0 빼고). 행은 dy, 열은 dx, 각도는 행 축(SNAPANG) */
export function rectArrayOffsets(rows: number, cols: number, dy: number, dx: number, angle = 0): { x: number; y: number }[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const out: { x: number; y: number }[] = [];
  for (let r = 0; r < rows; r++)
    for (let k = 0; k < cols; k++) {
      if (!r && !k) continue;
      const x = dx * k;
      const y = dy * r;
      out.push({ x: x * c - y * s, y: x * s + y * c });
    }
  return out;
}

/**
 * 클래식 원형 배열의 항목 각도(첫 항목 0 빼고, 라디안).
 * n 항목, fill 채울 각도(0이면 between 사용), between 항목 사이 각도. 360°(또는 -360°) 채우기면 끝 항목이 첫 항목과 겹치지 않게 n으로 나눈다
 */
export function polarArrayAngles(n: number, fill: number, between = 0): number[] {
  let step: number;
  if (!fill) step = between;
  else if (Math.abs(Math.abs(fill) - 2 * Math.PI) < 1e-9) step = fill / n;
  else step = fill / (n - 1);
  const out: number[] = [];
  for (let i = 1; i < n; i++) out.push(step * i);
  return out;
}

/** 항목 수 없이 채울 각도와 사이 각도로 항목 수(AutoCAD: 내림 + 1) */
export function polarCountFrom(fill: number, between: number): number {
  if (!between) return 0;
  const n = Math.floor(Math.abs(fill / between) + 1e-9);
  return Math.abs(Math.abs(fill) - 2 * Math.PI) < 1e-9 ? n : n + 1;
}

/** 이름을 여러 열로 나열(명령행 ? 목록) */
export function columns(names: readonly string[], width = 4): string[] {
  const out: string[] = [];
  const w = Math.max(8, ...names.map((n) => n.length + 2));
  for (let i = 0; i < names.length; i += width) out.push(names.slice(i, i + width).map((n) => n.padEnd(w)).join('').trimEnd());
  return out;
}

/** 각도(라디안)를 도 단위 글로(소수 자리 없앤 꼴) */
export function degText(a: number): string {
  return String(+((a * 180) / Math.PI).toFixed(6));
}
