/** 쓰기 공용: 확장 자료(EED)와 색 */
import type { CadColor, XData, XDataItem } from '../../../core/model';
import { tableKey } from '../../../core/model';
import { R2004 } from '../version';
import type { WColor } from './bitwriter';
import { nearestAci } from '../color';
import type { WCtx } from './context';
import type { EedOut } from './objwriter';
import { parseHandle } from './util';

/** 모델 확장 자료 → EED(앱 이름은 APPID 핸들로) */
export function eedOf(ctx: WCtx, xdata: XData[] | undefined): EedOut[] | null {
  if (!xdata || !xdata.length) return null;
  const out: EedOut[] = [];
  for (const x of xdata) {
    const app = ctx.appid(x.app);
    if (!app) continue;
    out.push({ app, items: x.items.map((it) => fixItem(ctx, it)) });
  }
  return out.length ? out : null;
}

/** 1003(도면층)은 DWG에서 도면층 핸들이다. DXF에서 읽은 문서는 이름이므로 핸들로 바꾼다 */
function fixItem(ctx: WCtx, it: XDataItem): XDataItem {
  if (it.code !== 1003) return it;
  const v = String(it.value);
  const byName = ctx.layerH.get(tableKey(v));
  if (ctx.doc.format !== 'dwg' && byName) return { code: 1003, value: byName.toString(16) };
  const h = parseHandle(v);
  if (h) return { code: 1003, value: v };
  return { code: 1003, value: (byName ?? 0).toString(16) };
}

/**
 * 모델 색 → DWG 색. 색상표 이름이 있으면 같은 이름의 DBCOLOR 객체를 가리킨다(R2004+ 도형).
 * table이 참이면 표 레코드 색(CMC)이라 DBCOLOR를 쓰지 않는다.
 */
export function wcolor(ctx: WCtx, c: CadColor | undefined, transparency?: number, table = false): WColor {
  const col = c ?? { aci: 256 };
  const out: WColor = { index: col.aci };
  if (col.rgb !== undefined) {
    out.rgb = col.rgb & 0xffffff;
    // 트루컬러의 ACI 칸은 가장 가까운 색(R2000은 이 값만 남는다)
    if (!(col.aci >= 1 && col.aci <= 255)) out.index = nearestAci(out.rgb);
  }
  if (col.name && ctx.ver >= R2004) {
    const i = col.name.indexOf('$');
    if (table) {
      if (i >= 0) {
        out.book = col.name.slice(0, i);
        out.name = col.name.slice(i + 1);
      } else out.name = col.name;
    } else {
      const db = ctx.dbColorH.get(col.name.toUpperCase());
      if (db) out.dbColor = db;
    }
  }
  if (transparency !== undefined && transparency !== -1) out.transparency = transparency;
  return out;
}
