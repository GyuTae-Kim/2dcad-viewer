/** 여러 줄 형상·끊기·정점·교차 편집 */
import { describe, expect, it } from 'vitest';
import type { MLineEntity, MLineStyleObject, Vec2 } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import {
  addVertex,
  cornerJoint,
  crossJoint,
  cutAll,
  cutSingle,
  deleteVertex,
  elementDistancesOf,
  elementPoint,
  elementPolylines,
  hasBreaks,
  mlineGeometry,
  paramsFromRuns,
  runsOf,
  segmentFrame,
  teeJoint,
  weldAll,
} from '../../src/edit/mline/geom';
import { newMLineStyle, validateMLineStyle } from '../../src/edit/mline/style';
import { mlineDrawing } from '../../src/edit/mline/draw';

const STD: Pick<MLineStyleObject, 'elements' | 'startAngle' | 'endAngle' | 'name' | 'handle'> = {
  name: 'Standard',
  handle: '18',
  startAngle: Math.PI / 2,
  endAngle: Math.PI / 2,
  elements: [
    { offset: 0.5, color: { aci: 256 }, linetype: 'BYLAYER' },
    { offset: -0.5, color: { aci: 256 }, linetype: 'BYLAYER' },
  ],
};
const THREE = { ...STD, elements: [...STD.elements, { offset: 0, color: { aci: 1 }, linetype: 'BYLAYER' }] };

function ml(points: Vec2[], opt: { closed?: boolean; scale?: number; just?: number; style?: typeof STD } = {}): MLineEntity {
  return { ...entityDefaults(), type: 'MLINE', handle: 'A', ...mlineGeometry({ points, closed: !!opt.closed, style: opt.style ?? STD, scale: opt.scale ?? 2, justification: opt.just ?? 1 }) };
}

const near = (a: Vec2, b: Vec2, tol = 1e-9) => expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(tol);

describe('여러 줄 만들기', () => {
  it('자리맞추기·축척·마이터', () => {
    const e = ml([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
    expect(e.vertices).toHaveLength(3);
    expect(elementDistancesOf(e).map((d) => +d.toFixed(9))).toEqual([1, -1]);
    near(elementPoint(e, 0, 0), { x: 0, y: 1 });
    near(elementPoint(e, 1, 0), { x: 9, y: 1 });
    near(elementPoint(e, 1, 1), { x: 11, y: -1 });
    near(elementPoint(e, 2, 1), { x: 11, y: 10 });
    const top = ml(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      { just: 0, scale: 20 },
    );
    expect(elementDistancesOf(top).map((d) => +d.toFixed(9))).toEqual([0, -20]);
    const bottom = ml(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      { just: 2, scale: 20 },
    );
    expect(elementDistancesOf(bottom).map((d) => +d.toFixed(9))).toEqual([20, 0]);
    expect(top.flags).toBe(1);
  });

  it('닫힌 여러 줄은 첫 정점도 이등분 마이터', () => {
    const e = ml(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      { closed: true },
    );
    expect(e.flags & 2).toBe(2);
    near(elementPoint(e, 0, 0), { x: 1, y: 1 });
    const polys = elementPolylines(e, 0);
    expect(polys).toHaveLength(1);
    expect(polys[0]!.length).toBe(5);
  });

  it('스타일 검사', () => {
    const s = newMLineStyle('벽');
    expect(validateMLineStyle(s)).toBeNull();
    expect(validateMLineStyle({ ...s, name: 'a b' })).not.toBeNull();
    expect(validateMLineStyle({ ...s, startAngle: Math.PI })).not.toBeNull();
    expect(validateMLineStyle({ ...s, elements: [] })).not.toBeNull();
  });
});

describe('끊기', () => {
  it('매개변수 ↔ 구간', () => {
    expect(runsOf([1, 0], 10)).toEqual([[0, 10]]);
    expect(runsOf([1], 10)).toEqual([[0, 10]]);
    expect(runsOf([1, 0, 3, 5], 10)).toEqual([
      [0, 3],
      [5, 10],
    ]);
    expect(runsOf([1, 0, 3, 5, 7], 10)).toEqual([
      [0, 3],
      [5, 7],
    ]);
    expect(runsOf([1, 0, 0], 10)).toEqual([]);
    expect(paramsFromRuns(1, [[0, 10]], 10)).toEqual([1, 0]);
    expect(paramsFromRuns(1, [], 10)).toEqual([1, 0, 0]);
    expect(
      paramsFromRuns(
        1,
        [
          [5, 7],
          [0, 3],
        ],
        10,
      ),
    ).toEqual([1, 0, 3, 5, 7]);
  });

  it('단일 자르기·전체 자르기·전체 용접', () => {
    const e = ml([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
    ]);
    const a = cutSingle(e, 0, { x: 3, y: 1.2 }, { x: 14, y: 0.8 });
    expect(elementPolylines(a, 0).map((p) => p.map((q) => +q.x.toFixed(6) + 0))).toEqual([
      [0, 3],
      [14, 20],
    ]);
    expect(elementPolylines(a, 1)).toHaveLength(1);
    expect(hasBreaks(a)).toBe(true);
    const b = cutAll(e, { x: 4, y: 0 }, { x: 6, y: 0 });
    expect(elementPolylines(b, 1).map((p) => p.map((q) => +q.x.toFixed(6) + 0))).toEqual([
      [0, 4],
      [6, 10, 20],
    ]);
    const c = weldAll(b, { x: 2, y: 0 }, { x: 8, y: 0 });
    expect(hasBreaks(c)).toBe(false);
    expect(elementPolylines(c, 0)).toHaveLength(1);
  });
});

describe('정점', () => {
  it('정점 추가는 끊기를 나누고 형상은 그대로', () => {
    const e = cutAll(
      ml([
        { x: 0, y: 0 },
        { x: 20, y: 0 },
      ]),
      { x: 12, y: 0 },
      { x: 14, y: 0 },
    );
    const r = addVertex(e, { x: 5, y: 0.3 })!;
    expect(r.vertices).toHaveLength(3);
    near(r.vertices[1]!.position, { x: 5, y: 0 });
    expect(elementPolylines(r, 0).map((p) => p.map((q) => +q.x.toFixed(6) + 0))).toEqual([
      [0, 5, 12],
      [14, 20],
    ]);
    expect(segmentFrame(r, 1, 0).len).toBeCloseTo(15);
    expect(addVertex(e, { x: 0, y: 0 })).toBeNull();
  });

  it('정점 삭제', () => {
    const e = ml([
      { x: 0, y: 0 },
      { x: 10, y: 5 },
      { x: 20, y: 0 },
    ]);
    const r = deleteVertex(e, { x: 9, y: 5 })!;
    expect(r.vertices).toHaveLength(2);
    near(elementPoint(r, 1, 0), { x: 20, y: 1 });
    expect(deleteVertex(r, { x: 0, y: 0 })).toBeNull();
  });
});

describe('교차 편집', () => {
  const h = () =>
    ml([
      { x: -10, y: 0 },
      { x: 10, y: 0 },
    ]);
  const v = (style = STD) =>
    ml(
      [
        { x: 0, y: -10 },
        { x: 0, y: 10 },
      ],
      { style },
    );

  it('닫힌 십자형: 첫 번째의 모든 요소만 끊긴다', () => {
    const r = crossJoint(h(), 0, v(), 0, 'closed')!;
    expect(elementPolylines(r.a, 0).map((p) => p.map((q) => +q.x.toFixed(6) + 0))).toEqual([
      [-10, -1],
      [1, 10],
    ]);
    expect(hasBreaks(r.b)).toBe(false);
  });

  it('열린·병합된 십자형', () => {
    const o = crossJoint(h(), 0, v(THREE), 0, 'open')!;
    // 두 번째의 바깥 요소만 끊기고 가운데 요소는 이어진다
    expect(elementPolylines(o.b, 0)).toHaveLength(2);
    expect(elementPolylines(o.b, 2)).toHaveLength(1);
    expect(elementPolylines(o.a, 1)).toHaveLength(2);
    const h3 = ml(
      [
        { x: -10, y: 0 },
        { x: 10, y: 0 },
      ],
      { style: THREE },
    );
    const m = crossJoint(v(THREE), 0, h3, 0, 'merged')!;
    expect(elementPolylines(m.a, 2)).toHaveLength(1);
    expect(elementPolylines(m.b, 2)).toHaveLength(1);
    expect(elementPolylines(m.a, 0)).toHaveLength(2);
  });

  it('닫힌·열린 T자형: 줄기를 막대 가까운 선까지', () => {
    const stem = ml([
      { x: 0, y: -10 },
      { x: 0, y: 10 },
    ]);
    const bar = h();
    const c = teeJoint(stem, 0, { x: 0, y: -8 }, bar, 0, 'closed')!;
    expect(c.a.vertices).toHaveLength(2);
    near(c.a.vertices[1]!.position, { x: 0, y: -1 });
    near(elementPoint(c.a, 1, 0), { x: -1, y: -1 });
    near(elementPoint(c.a, 1, 1), { x: 1, y: -1 });
    expect(hasBreaks(c.b)).toBe(false);
    const o = teeJoint(stem, 0, { x: 0, y: -8 }, bar, 0, 'open')!;
    // 막대의 아래 요소(오른쪽 = -1)가 줄기 폭만큼 끊긴다
    expect(elementPolylines(o.b, 1).map((p) => p.map((q) => +q.x.toFixed(6) + 0))).toEqual([
      [-10, -1],
      [1, 10],
    ]);
    expect(elementPolylines(o.b, 0)).toHaveLength(1);
    // 반대쪽을 남기면 시작 정점이 옮겨진다
    const up = teeJoint(stem, 0, { x: 0, y: 8 }, bar, 0, 'closed')!;
    near(up.a.vertices[0]!.position, { x: 0, y: 1 });
    // 짧은 줄기는 늘어난다
    const short = ml([
      { x: 0, y: -10 },
      { x: 0, y: -5 },
    ]);
    near(teeJoint(short, 0, { x: 0, y: -8 }, bar, 0, 'closed')!.a.vertices[1]!.position, { x: 0, y: -1 });
  });

  it('구석 접합: 교점까지 자르고 늘인 뒤 이등분 마이터', () => {
    const a = ml([
      { x: -10, y: 0 },
      { x: 5, y: 0 },
    ]);
    const b = ml([
      { x: 0, y: 3 },
      { x: 0, y: 10 },
    ]);
    const r = cornerJoint(a, 0, { x: -8, y: 0 }, b, 0, { x: 0, y: 8 })!;
    near(r.a.vertices[1]!.position, { x: 0, y: 0 });
    near(r.b.vertices[0]!.position, { x: 0, y: 0 });
    // 바깥 모서리(왼쪽 위)와 안쪽 모서리가 서로 맞는다
    const outsA = [elementPoint(r.a, 1, 0), elementPoint(r.a, 1, 1)];
    const outsB = [elementPoint(r.b, 0, 0), elementPoint(r.b, 0, 1)];
    for (const p of outsA) expect(outsB.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < 1e-9)).toBe(true);
  });
});

describe('그림 조각', () => {
  const L = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ];
  it('끊긴 요소 선·선 마구리·연결부·채우기', () => {
    const e = cutAll(ml(L), { x: 4, y: 0 }, { x: 6, y: 0 });
    const d = mlineDrawing(e, { flags: 1 | 2 | 16 | 256 });
    expect(d.elements).toHaveLength(2);
    expect(d.elements[0]).toHaveLength(2);
    expect(d.caps).toHaveLength(2);
    // 시작 마구리: 정점 0의 바깥 두 요소(축척 2 → ±1)
    near(d.caps[0]![0]!, { x: 0, y: 1 });
    near(d.caps[0]![1]!, { x: 0, y: -1 });
    near(d.caps[1]![0]!, { x: 9, y: 10 });
    near(d.caps[1]![1]!, { x: 11, y: 10 });
    expect(d.joints).toHaveLength(1);
    near(d.joints[0]![0]!, { x: 9, y: 1 });
    expect(d.fill).toHaveLength(1);
    expect(d.fill[0]).toHaveLength(6);
  });

  it('호 마구리는 바깥으로 볼록하고, 객체 플래그 4·8은 마구리를 뺀다', () => {
    const e = ml(L, { style: { ...THREE, elements: [...THREE.elements, { offset: 0.25, color: { aci: 2 }, linetype: 'BYLAYER' }] } });
    const d = mlineDrawing(e, { flags: 64 | 32 | 1024 }, 8);
    // 시작: 외부 호 1 + 내부 호 1(요소 4개 → 안쪽 한 쌍), 끝: 외부 호 1
    expect(d.caps).toHaveLength(3);
    const arc = d.caps[0]!;
    expect(arc).toHaveLength(9);
    // 시작 방향(+x)의 반대쪽으로 볼록: 가운데 점 x = -1
    near(arc[4]!, { x: -1, y: 0 }, 1e-9);
    const endArc = d.caps[2]!;
    near(endArc[4]!, { x: 10, y: 11 }, 1e-9);
    expect(mlineDrawing({ ...e, flags: e.flags | 4 | 8 }, { flags: 64 | 32 | 1024 }).caps).toHaveLength(0);
  });

  it('닫힌 여러 줄: 마구리 없음, 모든 정점 연결부, 채우기 두 고리', () => {
    const e = ml([...L, { x: 0, y: 10 }], { closed: true });
    const d = mlineDrawing(e, { flags: 1 | 2 | 16 | 256 | 64 });
    expect(d.caps).toHaveLength(0);
    expect(d.joints).toHaveLength(4);
    expect(d.fill).toHaveLength(2);
    expect(d.elements[0]).toHaveLength(1);
    expect(mlineDrawing(e, null).joints).toHaveLength(0);
  });
});
