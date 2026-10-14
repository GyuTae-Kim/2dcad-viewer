/** DWG 선가중치 번호 → 1/100 mm(-1 ByLayer, -2 ByBlock, -3 기본값) */
const LW_TABLE = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];

export function lineweightFromIndex(i: number): number {
  if (i >= 0 && i < LW_TABLE.length) return LW_TABLE[i];
  if (i === 29) return -1;
  if (i === 30) return -2;
  if (i === 31) return -3;
  return -3;
}

/** 이미 1/100 mm 값으로 저장된 선가중치(레이어 등)를 정리한다. */
export function normalizeLineweight(v: number): number {
  if (v === 29 || v === -1) return -1;
  if (v === 30 || v === -2) return -2;
  if (v === 31 || v === -3) return -3;
  return v;
}
