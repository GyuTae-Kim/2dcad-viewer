/**
 * 배치 뷰포트 계산(DOM 없음): VPSCALE(축척), VPSYNC(마스터 뷰포트에 맞춘 축척·중심), VPMAX(뷰포트가 보이는 모형 범위).
 *
 * 뷰포트의 모형 → 종이: P = C + k·R(−τ)·(M − ref). k = 높이 / 뷰 높이(종이 단위 / 모형 단위),
 * τ = 비틀기, C = 뷰포트 중심(종이), ref = 뷰포트 중심에 오는 모형 점 = 대상점 + R(τ)·뷰 중심(DCS).
 */

import type { Vec } from './iso';

/** 계산에 쓰는 뷰포트 값(VIEWPORT 객체의 일부) */
export interface VpView {
  center: Vec;
  width: number;
  height: number;
  viewCenter: Vec;
  viewHeight: number;
  viewTarget: Vec;
  twistAngle: number;
}

const rot = (a: number, v: Vec): Vec => ({ x: Math.cos(a) * v.x - Math.sin(a) * v.y, y: Math.sin(a) * v.x + Math.cos(a) * v.y });

/** 뷰포트 축척(종이 단위 / 모형 단위). 뷰 높이가 0이면 NaN */
export function vpScale(vp: Pick<VpView, 'height' | 'viewHeight'>): number {
  return vp.viewHeight > 0 && vp.height > 0 ? vp.height / vp.viewHeight : NaN;
}

/** 뷰포트 중심에 오는 모형 점 */
export function vpRef(vp: Pick<VpView, 'viewCenter' | 'viewTarget' | 'twistAngle'>): Vec {
  const r = rot(vp.twistAngle || 0, vp.viewCenter);
  return { x: vp.viewTarget.x + r.x, y: vp.viewTarget.y + r.y };
}

/** 모형 점 → 뷰포트 중심이 그 점이 되는 뷰 중심(DCS) */
export function viewCenterFor(vp: Pick<VpView, 'viewTarget' | 'twistAngle'>, ref: Vec): Vec {
  return rot(-(vp.twistAngle || 0), { x: ref.x - vp.viewTarget.x, y: ref.y - vp.viewTarget.y });
}

/** 종이 점 → 그 뷰포트의 모형 점 */
export function paperToModel(vp: VpView, p: Vec): Vec {
  const k = vpScale(vp);
  const ref = vpRef(vp);
  const d = rot(vp.twistAngle || 0, { x: (p.x - vp.center.x) / k, y: (p.y - vp.center.y) / k });
  return { x: ref.x + d.x, y: ref.y + d.y };
}

/**
 * VPSYNC: 대상 뷰포트를 마스터와 같은 축척으로, 두 뷰포트의 모형이 종이 위에서 이어지게 옮긴다.
 * 비틀기가 다르면 null(맞출 수 없다).
 */
export function syncViewport(master: VpView, target: VpView): { viewHeight: number; viewCenter: Vec } | null {
  const k = vpScale(master);
  if (!(k > 0) || !(target.height > 0)) return null;
  if (Math.abs((master.twistAngle || 0) - (target.twistAngle || 0)) > 1e-9) return null;
  const ref = paperToModel(master, target.center);
  return { viewHeight: target.height / k, viewCenter: viewCenterFor(target, ref) };
}

/** 숫자를 짧게(유효 숫자 6자리, 끝의 0 없음) */
export function shortNumber(v: number): string {
  if (!Number.isFinite(v)) return '-';
  const a = Math.abs(v);
  const s = a >= 1e6 || (a > 0 && a < 1e-4) ? v.toPrecision(6) : String(+v.toPrecision(6));
  return s;
}

/** VPSCALE 출력 두 줄: `PS:MS == 1:20`, `뷰포트 축척 비율: 0.05xp` */
export function vpScaleLines(vp: Pick<VpView, 'height' | 'viewHeight'>): string[] {
  const k = vpScale(vp);
  if (!(k > 0)) return ['뷰포트의 축척을 알 수 없습니다(뷰 높이가 0).'];
  const ratio = k >= 1 ? `${shortNumber(k)}:1` : `1:${shortNumber(1 / k)}`;
  return [`PS:MS == ${ratio}`, `뷰포트 축척 비율: ${shortNumber(k)}xp`];
}

/** VPMAX: 뷰포트가 보이는 모형 범위(비틀기 없는 뷰포트). 중심과 폭·높이 */
export function vpModelWindow(vp: VpView): { cx: number; cy: number; w: number; h: number } | null {
  const k = vpScale(vp);
  if (!(k > 0) || !(vp.width > 0)) return null;
  const r = vpRef(vp);
  return { cx: r.x, cy: r.y, w: vp.width / k, h: vp.height / k };
}

/** 종이 점이 뷰포트 사각형 안인지 */
export function insideViewport(vp: Pick<VpView, 'center' | 'width' | 'height'>, p: Vec): boolean {
  return Math.abs(p.x - vp.center.x) <= vp.width / 2 + 1e-9 && Math.abs(p.y - vp.center.y) <= vp.height / 2 + 1e-9;
}
