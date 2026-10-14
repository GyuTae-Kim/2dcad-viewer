import { describe, expect, it } from 'vitest';
import { alignTransform } from '../../src/edit/geom/align';
import { blendEntities, curveEnd, pieceCurvature } from '../../src/edit/geom/blend';
import { type NurbsPiece, pieceTangent } from '../../src/edit/geom/curve';
import { affApply, affDet } from '../../src/edit/geom/math';
import { nurbsPoint } from '../../src/edit/geom/nurbs';
import { entityPath, makeSpline } from '../../src/edit/geom/path';
import { V, arc, line, lw, near, newDoc, renders } from '../edit/helpers';

describe('alignTransform', () => {
  it('한 쌍은 이동', () => {
    const m = alignTransform([V(1, 2)], [V(4, 6)])!;
    near(affApply(m, V(1, 2)), V(4, 6));
    near(affApply(m, V(0, 0)), V(3, 4));
  });
  it('두 쌍은 이동 + 회전, 축척은 선택', () => {
    const m = alignTransform([V(0, 0), V(1, 0)], [V(10, 10), V(10, 12)])!;
    near(affApply(m, V(0, 0)), V(10, 10));
    near(affApply(m, V(1, 0)), V(10, 11));
    const k = alignTransform([V(0, 0), V(1, 0)], [V(10, 10), V(10, 12)], true)!;
    near(affApply(k, V(1, 0)), V(10, 12));
    near(affApply(k, V(0, 1)), V(8, 10));
  });
  it('세 쌍은 세 번째 점 쪽에 맞춰 뒤집는다(축척 없음)', () => {
    const m = alignTransform([V(0, 0), V(2, 0), V(0, 1)], [V(0, 0), V(4, 0), V(0, -5)])!;
    expect(affDet(m)).toBeCloseTo(-1);
    near(affApply(m, V(2, 0)), V(2, 0));
    near(affApply(m, V(0, 1)), V(0, -1));
    const n = alignTransform([V(0, 0), V(2, 0), V(0, 1)], [V(0, 0), V(4, 0), V(0, 5)])!;
    expect(affDet(n)).toBeCloseTo(1);
  });
});

/** 베지어 끝의 접선·곡률 */
function endInfo(ctrlCurve: ReturnType<typeof blendEntities>, atEnd: boolean) {
  if (typeof ctrlCurve === 'string') throw new Error(ctrlCurve);
  const pc: NurbsPiece = { k: 'nurbs', n: ctrlCurve, u0: 0, u1: 1 };
  const t = atEnd ? 1 : 0;
  return { p: nurbsPoint(ctrlCurve, t), tan: pieceTangent(pc, t), k: pieceCurvature(pc, t) };
}

describe('BLEND', () => {
  it('두 선 사이 접선(G1): 끝점과 접선 방향이 맞는다', () => {
    const a = line(0, 0, 10, 0);
    const b = line(20, 10, 20, 20);
    const n = blendEntities(a, V(9, 0), b, V(20, 11), 'tangent');
    expect(typeof n).not.toBe('string');
    if (typeof n === 'string') return;
    expect(n.degree).toBe(3);
    expect(n.ctrl.length).toBe(4);
    const s = endInfo(n, false);
    const e = endInfo(n, true);
    near(s.p, V(10, 0));
    near(e.p, V(20, 10));
    near(s.tan, V(1, 0), 1e-6);
    near(e.tan, V(0, 1), 1e-6);
    renders(newDoc(), [makeSpline(a, n)]);
  });
  it('부드럽게(G2): 호의 끝 곡률까지 맞춘다(5차)', () => {
    // 반지름 5인 호(반시계, 0°→90°)의 끝(0, 5)에서, 선의 시작(−10, 20)으로
    const a = arc(0, 0, 5, 0, 90);
    const b = line(-10, 20, -20, 20);
    const n = blendEntities(a, V(0, 5), b, V(-11, 20), 'smooth');
    if (typeof n === 'string') throw new Error(n);
    expect(n.degree).toBe(5);
    const s = endInfo(n, false);
    const e = endInfo(n, true);
    near(s.p, V(0, 5));
    near(e.p, V(-10, 20));
    near(s.tan, V(-1, 0), 1e-6);
    near(e.tan, V(-1, 0), 1e-6);
    expect(s.k).toBeCloseTo(1 / 5, 3);
    expect(e.k).toBeCloseTo(0, 3);
  });
  it('폴리선 시작 끝: 떠나는 방향은 첫 세그먼트의 반대', () => {
    const p = lw([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    const end = curveEnd(entityPath(p)!, false);
    near(end.p, V(0, 0));
    near(end.dir, V(-1, 0));
  });
  it('닫힌 객체는 거절한다', () => {
    const c = lw(
      [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
      true,
    );
    expect(typeof blendEntities(c, V(0, 0), line(5, 5, 6, 6), V(5, 5), 'tangent')).toBe('string');
  });
});
