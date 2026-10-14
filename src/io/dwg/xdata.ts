/** 확장 자료 해석 도우미 */
import type { XData } from '../../core/model';

/**
 * ACAD 앱의 DSTYLE 재지정: 1000 "DSTYLE", 1002 "{", (1070 그룹 코드, 값)… 1002 "}"
 * 그룹 코드 → 값
 */
export function parseDimOverrides(xdata: XData[] | undefined): Record<number, string | number> | undefined {
  const x = xdata?.find((d) => d.app.toUpperCase() === 'ACAD');
  if (!x) return undefined;
  const items = x.items;
  let i = items.findIndex((it) => it.code === 1000 && typeof it.value === 'string' && it.value.toUpperCase() === 'DSTYLE');
  if (i < 0) return undefined;
  i++;
  if (items[i]?.code === 1002) i++;
  const out: Record<number, string | number> = {};
  for (; i + 1 < items.length; i += 2) {
    const k = items[i];
    if (k.code !== 1070) break;
    const v = items[i + 1].value;
    out[Number(k.value)] = typeof v === 'number' || typeof v === 'string' ? v : String(v);
  }
  return out;
}
