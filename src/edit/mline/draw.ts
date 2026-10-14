/**
 * 여러 줄(MLINE) 그림: 요소 선(끊기 반영), 마구리(선·외부 호·내부 호), 연결부(조인) 선, 채우기 다각형.
 * 좌표는 객체 좌표계(OCS) 평면 x·y다. 화면 그리기·미리보기·분해가 같은 결과를 쓰게 순수 함수로 둔다.
 *
 * 마구리는 열린 여러 줄의 첫·마지막 정점에서만, 객체 플래그(71) 4·8(시작·끝 마구리 없음)이면 그리지 않는다.
 * 호 마구리는 두 요소 끝점을 지름으로 하는 반원이며 여러 줄 바깥쪽으로 볼록하다.
 */
import type { MLineEntity, MLineStyleObject, Vec2 } from '../../core/model';
import { ML_END_INNER, ML_END_LINE, ML_END_OUTER, ML_FILL, ML_JOINTS, ML_START_INNER, ML_START_LINE, ML_START_OUTER } from './style';
import { elementCount, elementDistancesOf, elementPoint, elementPolylines, isClosed } from './geom';

export interface MLineDrawing {
  /** 요소 k마다 보이는 꺾은선(끊기 반영). 색·선종류는 스타일 요소 k를 따른다 */
  elements: Vec2[][][];
  /** 마구리 선·호(객체 색) */
  caps: Vec2[][];
  /** 정점의 연결부 선(스타일 플래그 2, 객체 색) */
  joints: Vec2[][];
  /** 채우기 고리(짝홀 규칙: 닫힌 여러 줄은 바깥·안쪽 두 고리). 채우기가 없으면 빈 목록 */
  fill: Vec2[][];
}

/** 요소 번호를 기준선 왼쪽 거리 큰 순서로 */
function byDistance(e: MLineEntity): number[] {
  const d = elementDistancesOf(e);
  return d.map((_, k) => k).sort((a, b) => d[b]! - d[a]!);
}

/** a에서 b까지 반원(바깥 방향 out 쪽으로 볼록) */
function halfCircle(a: Vec2, b: Vec2, out: Vec2, steps: number): Vec2[] {
  const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const r = Math.hypot(b.x - a.x, b.y - a.y) / 2;
  if (!(r > 1e-12)) return [a, b];
  const u = { x: (a.x - c.x) / r, y: (a.y - c.y) / r };
  // 지름에 수직이고 바깥쪽을 향하는 단위 벡터
  let w = { x: -u.y, y: u.x };
  if (w.x * out.x + w.y * out.y < 0) w = { x: -w.x, y: -w.y };
  const pts: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (Math.PI * i) / steps;
    pts.push({ x: c.x + r * (u.x * Math.cos(t) + w.x * Math.sin(t)), y: c.y + r * (u.y * Math.cos(t) + w.y * Math.sin(t)) });
  }
  return pts;
}

function unit(x: number, y: number): Vec2 {
  const l = Math.hypot(x, y);
  return l > 1e-12 ? { x: x / l, y: y / l } : { x: 1, y: 0 };
}

/**
 * 여러 줄 그림 조각. style이 없으면(스타일을 찾지 못한 파일) 요소 선만 그린다.
 * arcSteps는 반원 하나의 선분 수다.
 */
export function mlineDrawing(e: MLineEntity, style: Pick<MLineStyleObject, 'flags'> | null | undefined, arcSteps = 16): MLineDrawing {
  const n = e.vertices.length;
  const nEl = elementCount(e);
  const out: MLineDrawing = { elements: [], caps: [], joints: [], fill: [] };
  if (n < 2 || nEl < 1) return out;
  for (let k = 0; k < nEl; k++) out.elements.push(elementPolylines(e, k));
  const flags = style?.flags ?? 0;
  const closed = isClosed(e);
  const order = byDistance(e);
  const hi = order[0]!;
  const lo = order[order.length - 1]!;
  // 마구리
  if (!closed && nEl >= 2) {
    const ends: { i: number; out: Vec2; line: number; outer: number; inner: number; skip: boolean }[] = [];
    const d0 = e.vertices[0]!.direction;
    const dn = e.vertices[n - 2]!.direction;
    ends.push({ i: 0, out: unit(-d0.x, -d0.y), line: ML_START_LINE, outer: ML_START_OUTER, inner: ML_START_INNER, skip: (e.flags & 4) !== 0 });
    ends.push({ i: n - 1, out: unit(dn.x, dn.y), line: ML_END_LINE, outer: ML_END_OUTER, inner: ML_END_INNER, skip: (e.flags & 8) !== 0 });
    for (const end of ends) {
      if (end.skip) continue;
      const pt = (k: number) => elementPoint(e, end.i, k);
      if (flags & end.line) out.caps.push([pt(hi), pt(lo)]);
      if (flags & end.outer) out.caps.push(halfCircle(pt(hi), pt(lo), end.out, arcSteps));
      if (flags & end.inner)
        for (let a = 1, b = order.length - 2; a < b; a++, b--) out.caps.push(halfCircle(pt(order[a]!), pt(order[b]!), end.out, arcSteps));
    }
  }
  // 연결부: 열린 여러 줄은 안쪽 정점, 닫힌 여러 줄은 모든 정점
  if (flags & ML_JOINTS && nEl >= 2) for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) out.joints.push([elementPoint(e, i, hi), elementPoint(e, i, lo)]);
  // 채우기: 바깥 두 요소 사이(끊기와 상관없이 이어진다)
  if (flags & ML_FILL && nEl >= 2) {
    const a = e.vertices.map((_, i) => elementPoint(e, i, hi));
    const b = e.vertices.map((_, i) => elementPoint(e, i, lo));
    if (closed) out.fill.push(a, b);
    else out.fill.push([...a, ...b.reverse()]);
  }
  return out;
}
