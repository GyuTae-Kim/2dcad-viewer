/**
 * 점진 빌드의 첫 화면 정하기(워커).
 *
 * 장면을 다 만들기 전에는 도면 범위를 모르므로 최상위 객체마다 대표점(선의 가운데, 원의 중심, 문자·블록 참조의 삽입점 …)으로
 * 범위를 어림하고, 앱이 여는 첫 화면(app.initialView와 같은 규칙: 저장된 *Active 뷰가 범위와 겹치고 알맞은 크기면 그 화면,
 * 아니면 전체 보기)을 정한다. 첫 화면이 도면 일부만 보이면 그 안(조금 넉넉히)에 대표점이 있는 객체를 먼저 그려 보낸다.
 */
import type { CadDocument, Entity, Vec3 } from '../core/model';
import { tableKey } from '../core/model';

export interface PreviewPlan {
  /** 맞춰 보일 사각형과 여백 비율(View.zoomRect와 같은 뜻) */
  rect: [number, number, number, number];
  margin: number;
  /** 첫 화면에 실제로 보이는 범위(화면 비율에 맞춘 것) */
  visible: [number, number, number, number];
  /** 첫 화면이 도면 일부만 보이면 먼저 그릴 객체 고르기(대표점이 없으면 넣는다) */
  only?: (index: number, e: Entity) => boolean;
}

/** OCS가 기본(Z축 위)인지 */
function flat(e: { extrusion?: Vec3 }): boolean {
  const z = e.extrusion;
  return !z || (Math.abs(z.x) < 1e-9 && Math.abs(z.y) < 1e-9 && z.z > 0);
}

/** 최상위 객체의 대표점(WCS). 모르는 종류나 기울어진 OCS면 null */
export function anchorOf(e: Entity): [number, number] | null {
  switch (e.type) {
    case 'LINE':
      return [(e.start.x + e.end.x) / 2, (e.start.y + e.end.y) / 2];
    case 'CIRCLE':
    case 'ARC':
      return flat(e) ? [e.center.x, e.center.y] : null;
    case 'ELLIPSE':
      return [e.center.x, e.center.y];
    case 'POINT':
      return flat(e) ? [e.position.x, e.position.y] : null;
    case 'TEXT':
    case 'ATTRIB':
    case 'ATTDEF':
    case 'INSERT':
      return flat(e) ? [e.insert.x, e.insert.y] : null;
    case 'MTEXT':
      return [e.insert.x, e.insert.y];
    case 'LWPOLYLINE': {
      const v = e.verts;
      return v.length >= 3 && flat(e) ? [v[0]!, v[1]!] : null;
    }
    case 'POLYLINE': {
      const v = e.vertices[0];
      return v && (e.kind !== '2d' || flat(e)) ? [v.location.x, v.location.y] : null;
    }
    case 'HATCH': {
      if (!flat(e)) return null;
      const p = e.paths[0];
      const v = p?.polyline?.vertices[0];
      if (v) return [v.x, v.y];
      const ed = p?.edges?.[0];
      if (ed?.type === 'line') return [ed.start.x, ed.start.y];
      if (ed?.type === 'arc') return [ed.center.x, ed.center.y];
      return null;
    }
    case 'DIMENSION':
      return [e.defPoint.x, e.defPoint.y];
  }
  return null;
}

/**
 * 첫 화면 계획. aspect: 화면 가로/세로(없으면 4:3). 대표점이 하나도 없으면 null(미리 보기 원점은 0, 0).
 */
export function planPreview(doc: CadDocument, blockName: string, aspect = 4 / 3): PreviewPlan | null {
  const block = doc.blocks.get(tableKey(blockName));
  if (!block) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of block.entities) {
    if (e.type === 'VIEWPORT') continue;
    const a = anchorOf(e);
    if (!a || !Number.isFinite(a[0]) || !Number.isFinite(a[1])) continue;
    if (a[0] < minX) minX = a[0];
    if (a[0] > maxX) maxX = a[0];
    if (a[1] < minY) minY = a[1];
    if (a[1] > maxY) maxY = a[1];
  }
  if (!(minX <= maxX)) return null;
  const ext = Math.max(maxX - minX, maxY - minY);
  let rect: [number, number, number, number] = [minX, minY, maxX, maxY];
  let margin = 0.04;
  let sub = false;
  // app.initialView: 저장된 *Active 뷰
  const vp = tableKey(blockName) === '*MODEL_SPACE' ? doc.vports.find((v) => v.name.toUpperCase() === '*ACTIVE') : undefined;
  if (vp && vp.height > 0 && Number.isFinite(vp.center.x) && ext > 0) {
    const ar = vp.aspect > 0 ? vp.aspect : aspect;
    const hw = (vp.height * ar) / 2;
    const hh = vp.height / 2;
    const overlaps = !(vp.center.x + hw < minX || vp.center.x - hw > maxX || vp.center.y + hh < minY || vp.center.y - hh > maxY);
    if (overlaps && vp.height >= ext * 0.02 && vp.height <= ext * 50) {
      rect = [vp.center.x - hw, vp.center.y - hh, vp.center.x + hw, vp.center.y + hh];
      margin = 0;
      sub = true;
    }
  }
  // 화면 비율에 맞춘 실제로 보이는 범위(View.zoomRect와 같은 셈)
  const w = Math.max(rect[2] - rect[0], 1e-9);
  const h = Math.max(rect[3] - rect[1], 1e-9);
  const k = Math.max(w / aspect, h) / (1 - margin * 2);
  const cx = (rect[0] + rect[2]) / 2;
  const cy = (rect[1] + rect[3]) / 2;
  const visible: [number, number, number, number] = [cx - (k * aspect) / 2, cy - k / 2, cx + (k * aspect) / 2, cy + k / 2];
  const plan: PreviewPlan = { rect, margin, visible };
  // 도면의 절반 넘게 보이면 먼저 그릴 것이 따로 없다(차례로 그리며 보낸다)
  const seen = Math.max(0, Math.min(visible[2], maxX) - Math.max(visible[0], minX)) * Math.max(0, Math.min(visible[3], maxY) - Math.max(visible[1], minY));
  const area = Math.max(maxX - minX, 1e-9) * Math.max(maxY - minY, 1e-9);
  if (sub && seen < area * 0.5) {
    const mx = (visible[2] - visible[0]) * 0.25;
    const my = (visible[3] - visible[1]) * 0.25;
    const x0 = visible[0] - mx;
    const y0 = visible[1] - my;
    const x1 = visible[2] + mx;
    const y1 = visible[3] + my;
    plan.only = (_i, e) => {
      const a = anchorOf(e);
      return !a || (a[0] >= x0 && a[0] <= x1 && a[1] >= y0 && a[1] <= y1);
    };
  }
  return plan;
}
