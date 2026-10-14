/** 쓰기 도우미: 선가중치 번호, 핸들 문자열, 경고 */
import type { ReadWarning } from '../../../core/model';

const LW_TABLE = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];

/** 1/100 mm 선가중치 → DWG 번호(표에 없으면 가장 가까운 아래 값) */
export function lwIndex(v: number): number {
  if (v === -1 || v === 29) return 29;
  if (v === -2 || v === 30) return 30;
  if (v === -3 || v === 31 || !Number.isFinite(v) || v < 0) return 31;
  let best = 0;
  for (let i = 0; i < LW_TABLE.length; i++) if (LW_TABLE[i] <= v) best = i;
  return best;
}

/** "1F" → 0x1F. 잘못된 값은 0 */
export function parseHandle(h: string | undefined): number {
  if (!h) return 0;
  const t = h.trim();
  if (!/^[0-9A-Fa-f]{1,13}$/.test(t)) return 0;
  return parseInt(t, 16);
}

/** 같은 경고는 한 번만 넣고 개수를 센다 */
export function warnOnce(list: ReadWarning[], code: string, message: string, detail?: Record<string, unknown>): void {
  const w = list.find((x) => x.code === code && x.message === message);
  if (w) {
    w.count = (w.count ?? 1) + 1;
    return;
  }
  list.push(detail ? { code, message, count: 1, detail } : { code, message, count: 1 });
}
