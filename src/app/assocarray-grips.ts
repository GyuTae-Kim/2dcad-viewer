/**
 * 연관 배열 그립(AutoCAD 다기능 그립의 핵심): 블록 참조 그립 목록(src/edit/geom/grips insertGripProviders)에 더하고,
 * GRIPEDIT가 'arr:'로 시작하는 그립을 누르면 arrayGripEdit로 넘긴다(src/app/modify.ts GRIPEDIT 한 줄).
 *  - 직사각형: 열 간격(둘째 열), 열 수(끝 열 바깥), 행 간격(둘째 행), 행 수(끝 행 바깥), 행 및 열 수(끝 구석 바깥).
 *    기준점(이동)은 블록 참조의 삽입점 그립이 한다.
 *  - 원형: 중심(이동, 삽입점과 다를 때), 반지름(첫 항목), 항목 사이의 각도(둘째 항목), 채울 각도(끝 항목, 한 바퀴가 아닐 때),
 *    행 간격(둘째 행).
 *  - 경로: 항목 사이 거리(둘째 항목, 길이 분할), 항목 수(끝 항목 바깥), 행 간격(둘째 행).
 * 끌면 다시 계산한 배열을 미리 보여 주고, 점을 찍으면 적용한다.
 */
import type { CadDocument, InsertEntity, Vec2 } from '../core/model';
import { insertAffine } from '../edit/dynblock/build';
import { insertGripProviders } from '../edit/geom/grips';
import type { GripPoint } from '../edit/geom/types';
import { type Affine, affApply, affInv, affLin, affMul } from '../edit/geom/math';
import { pathLength, pathNearest, pathTangent } from '../edit/geom/curve';
import { isFullCircle, itemCount, pathMaxItems, pathSpacingOf, polarWithAngle, polarWithFill } from '../edit/assocarray/layout';
import { type ArrayInfo, arrayPath, expectedItems, readArray } from '../edit/assocarray/read';
import { type ArrayItem, type ArrayParams, type ArrayState, MAX_ITEMS, cloneState, itemKey } from '../edit/assocarray/types';
import type { App, CommandContext } from './app';
import { unlockedOnly } from './layers';
import { applyArrayState, arrayPreview } from './assocarray-core';
import type { Ghost } from './modify';
import type { Pt } from './view';

const LABEL: Record<string, string> = {
  colsp: '열 간격',
  cols: '열 수',
  rowsp: '행 간격',
  rows: '행 수',
  corner: '행 및 열 수',
  center: '이동',
  radius: '반지름',
  angle: '항목 사이의 각도',
  fill: '채울 각도',
  spacing: '항목 사이 거리',
  count: '항목 수',
};

interface Frame {
  info: ArrayInfo;
  W: Affine;
  inv: Affine;
  byKey: Map<string, ArrayItem>;
}

function frame(info: ArrayInfo, doc: CadDocument): Frame | null {
  const W = insertAffine(info.def, info.ins);
  const inv = affInv(W);
  if (!inv) return null;
  const byKey = new Map<string, ArrayItem>();
  for (const it of expectedItems(doc, info.ins, info.def, info.state.params)) byKey.set(it.key, it);
  return { info, W, inv, byKey };
}

/** 항목 기준점(도면 좌표) */
function itemPoint(f: Frame, i: number, r: number): Vec2 | null {
  const it = f.byKey.get(itemKey(i, r, 0));
  return it ? affApply(affMul(f.W, it.matrix), f.info.state.params.base) : null;
}

const plus = (a: Vec2, d: Vec2, k: number): Vec2 => ({ x: a.x + d.x * k, y: a.y + d.y * k });
const unit = (v: Vec2): Vec2 => {
  const l = Math.hypot(v.x, v.y);
  return l > 1e-12 ? { x: v.x / l, y: v.y / l } : { x: 1, y: 0 };
};

/** 배열의 그립(도면 좌표). 배열이 아니면 빈 배열 */
export function arrayGripPoints(doc: CadDocument, ins: InsertEntity): GripPoint[] {
  const info = readArray(doc, ins);
  if (!info) return [];
  const f = frame(info, doc);
  if (!f) return [];
  const p = info.state.params;
  const out: GripPoint[] = [];
  const add = (id: string, pt: Vec2 | null, kind: GripPoint['kind'] = 'ctrl') => {
    if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) out.push({ id: `arr:${id}`, point: { x: pt.x, y: pt.y }, kind });
  };
  if (p.kind === 'rect') {
    const cu = unit(affLin(f.W, { x: Math.sign(p.columnSpacing) || 1, y: 0 }));
    const ru = unit(affLin(f.W, { x: Math.cos(p.axesAngle) * (Math.sign(p.rowSpacing) || 1), y: Math.sin(p.axesAngle) * (Math.sign(p.rowSpacing) || 1) }));
    const cs = Math.abs(p.columnSpacing) * Math.hypot(f.W[0], f.W[1]);
    const rs = Math.abs(p.rowSpacing) * Math.hypot(f.W[2], f.W[3]);
    if (p.columns > 1) add('colsp', itemPoint(f, 1, 0));
    const lastCol = itemPoint(f, p.columns - 1, 0);
    if (lastCol) add('cols', plus(lastCol, cu, 0.3 * cs || 1));
    if (p.rows > 1) add('rowsp', itemPoint(f, 0, 1));
    const lastRow = itemPoint(f, 0, p.rows - 1);
    if (lastRow) add('rows', plus(lastRow, ru, 0.3 * rs || 1));
    const corner = itemPoint(f, p.columns - 1, p.rows - 1);
    if (corner) add('corner', plus(plus(corner, cu, 0.3 * cs || 1), ru, 0.3 * rs || 1));
    return out;
  }
  if (p.kind === 'polar') {
    const c = affApply(f.W, p.center);
    if (Math.hypot(c.x - ins.insert.x, c.y - ins.insert.y) > 1e-9 * Math.max(1, Math.abs(c.x), Math.abs(c.y))) add('center', c, 'cen');
    add('radius', itemPoint(f, 0, 0));
    if (p.items > 1) add('angle', itemPoint(f, 1, 0));
    if (p.items > 2 && !isFullCircle(p.fillAngle)) add('fill', itemPoint(f, p.items - 1, 0));
    if (p.rows > 1) add('rowsp', itemPoint(f, 0, 1));
    return out;
  }
  const n = Math.max(1, Math.round(p.items));
  if (p.method === 'measure' && n > 1) add('spacing', itemPoint(f, 1, 0));
  const last = f.byKey.get(itemKey(n - 1, 0, 0));
  if (last) {
    const lp = affApply(affMul(f.W, last.matrix), p.base);
    const dir = unit(affLin(affMul(f.W, last.matrix), { x: 1, y: 0 }));
    const sp = Math.abs(p.spacing) || 1;
    add('count', plus(lp, p.align ? dir : { x: 0, y: 0 }, p.align ? 0.3 * sp : 0));
  }
  if (p.rows > 1) add('rowsp', itemPoint(f, 0, 1));
  return out;
}

/** 그립을 점 q로 끌었을 때의 새 상태(바꿀 수 없으면 null) */
export function gripState(doc: CadDocument, info: ArrayInfo, id: string, q: Pt): ArrayState | null {
  const f = frame(info, doc);
  if (!f) return null;
  const kind = id.replace(/^arr:/, '');
  const p = info.state.params;
  const qb = affApply(f.inv, q);
  const next = cloneState(info.state);
  const set = (np: ArrayParams): ArrayState | null => (itemCount(np) > MAX_ITEMS ? null : { ...next, params: np });
  if (p.kind === 'rect') {
    const v = { x: Math.cos(p.axesAngle), y: Math.sin(p.axesAngle) };
    // 열 축(1,0)·행 축(v) 성분
    const det = v.y;
    const dx = qb.x - p.origin.x;
    const dy = qb.y - p.origin.y;
    const a = Math.abs(det) > 1e-12 ? dx - (v.x * dy) / det : dx;
    const b = Math.abs(det) > 1e-12 ? dy / det : 0;
    if (kind === 'colsp') return Math.abs(a) > 1e-9 ? set({ ...p, columnSpacing: a }) : null;
    if (kind === 'rowsp') return Math.abs(b) > 1e-9 ? set({ ...p, rowSpacing: b }) : null;
    const cols = Math.max(1, Math.round(a / (p.columnSpacing || 1)) + 1);
    const rows = Math.max(1, Math.round(b / (p.rowSpacing || 1)) + 1);
    if (kind === 'cols') return set({ ...p, columns: cols });
    if (kind === 'rows') return set({ ...p, rows });
    if (kind === 'corner') return set({ ...p, columns: cols, rows });
    return null;
  }
  if (p.kind === 'polar') {
    const d = { x: qb.x - p.center.x, y: qb.y - p.center.y };
    const r = Math.hypot(d.x, d.y);
    const ang = Math.atan2(d.y, d.x);
    if (kind === 'radius') return r > 1e-9 ? set({ ...p, radius: r }) : null;
    if (kind === 'rowsp') return Math.abs(r - p.radius) > 1e-9 ? set({ ...p, rowSpacing: r - p.radius }) : null;
    let rel = ang - p.startAngle;
    while (rel <= -Math.PI) rel += 2 * Math.PI;
    while (rel > Math.PI) rel -= 2 * Math.PI;
    if (kind === 'angle') {
      if (Math.abs(rel) < 1e-9 || Math.abs(rel * (p.items - 1)) > 2 * Math.PI + 1e-9) return null;
      return set(polarWithAngle(p, rel));
    }
    if (kind === 'fill') {
      let fill = ang - p.startAngle;
      if (p.fillAngle > 0) while (fill <= 0) fill += 2 * Math.PI;
      else while (fill >= 0) fill -= 2 * Math.PI;
      return Math.abs(fill) > 1e-9 ? set(polarWithFill(p, fill)) : null;
    }
    return null;
  }
  const ap = arrayPath(doc, p);
  if (!ap) return null;
  const at = ap.world ? q : qb;
  const nr = pathNearest(ap.path, at);
  const L = pathLength(ap.path, 0, nr.s);
  if (kind === 'rowsp') {
    const t = pathTangent(ap.path, nr.s);
    const off = (at.x - nr.p.x) * -t.y + (at.y - nr.p.y) * t.x;
    return Math.abs(off) > 1e-9 ? set({ ...p, rowSpacing: off }) : null;
  }
  if (kind === 'spacing') {
    if (!(L > 1e-9)) return null;
    const max = pathMaxItems({ ...p, spacing: L }, ap.path);
    return set({ ...p, spacing: L, items: Math.min(p.items, max) });
  }
  if (kind === 'count') {
    const sp = pathSpacingOf(p, ap.path) || 1;
    let n = Math.max(1, Math.round(L / sp) + 1);
    if (p.method === 'measure') n = Math.min(n, pathMaxItems(p, ap.path));
    const np = { ...p, items: n };
    if (p.method === 'divide') np.spacing = pathSpacingOf(np, ap.path);
    return n >= 1 ? set(np) : null;
  }
  return null;
}

/** 배열 그립 편집(GRIPEDIT가 부른다) */
export async function arrayGripEdit(app: App, ctx: CommandContext, handle: string, id: string): Promise<void> {
  const st = app.active!;
  const info = readArray(st.doc, st.doc.entityIndex.get(handle));
  if (!info || !unlockedOnly(app, [handle]).length) return;
  const kind = id.replace(/^arr:/, '');
  const label = LABEL[kind] ?? '배열';
  const grip = arrayGripPoints(st.doc, info.ins).find((g) => g.id === id);
  if (!grip) return;
  ctx.print(`** ${label} **`);
  if (kind === 'center') {
    // 원형 중심 이동 = 배열 이동
    const r = await ctx.getPoint('이동점 지정 또는 [종료(X)]:', { base: grip.point, keywords: [{ key: 'X', label: '종료' }] });
    if (!('point' in r)) return;
    const dx = r.point.x - grip.point.x;
    const dy = r.point.y - grip.point.y;
    const after = { ...info.ins, insert: { ...info.ins.insert, x: info.ins.insert.x + dx, y: info.ins.insert.y + dy } };
    applyArrayState(app, ctx, info, info.state, 'GRIP', { insert: after });
    return;
  }
  const cache = new Map<string, Ghost>();
  const r = await ctx.getPoint(`${label} 지정 또는 [종료(X)]:`, {
    base: grip.point,
    keywords: [{ key: 'X', label: '종료' }],
    ghost: (q) => {
      const s = gripState(st.doc, info, id, q);
      return s ? arrayPreview(app, info, s, info.ins, cache) : [];
    },
  });
  if (!('point' in r)) return;
  const next = gripState(st.doc, info, id, r.point);
  if (!next) {
    ctx.print('그 자리로는 배열을 바꿀 수 없습니다.', 'err');
    return;
  }
  applyArrayState(app, ctx, info, next, 'GRIP');
}

let installed = false;

/** 블록 참조 그립 목록에 배열 그립을 더한다(한 번) */
export function installArrayGrips(_app: App): void {
  if (installed) return;
  installed = true;
  insertGripProviders.push((e, doc) => {
    try {
      return arrayGripPoints(doc, e);
    } catch {
      return [];
    }
  });
}
