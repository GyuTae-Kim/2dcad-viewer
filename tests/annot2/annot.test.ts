/** QDIM·TOLERANCE·CENTERMARK·CENTERLINE·QLEADER·MLEADER 편집·MLEADERSTYLE 계산 */
import { describe, expect, it } from 'vitest';
import type { MLeaderEntity, MLeaderStyleObject } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { centerLineSegment, centerMarkLines, defaultCenterSettings, lengthOrMultiple } from '../../src/edit/annot/center';
import { addLeaderLine, alignMleaders, breakRuns, collectLayout, landingOf, lineCount, mleaderBreakPairs, mleaderManualBreak, removeLeaderLine, translateContent } from '../../src/edit/annot/mleader';
import { copyStyle, styleInUse, updateStyle } from '../../src/edit/annot/mlstyle';
import { qdimCreate, qdimGeometry, qdimRotation } from '../../src/edit/annot/qdim';
import { buildLeader } from '../../src/edit/annot/qleader';
import { GDT_SYMBOLS, buildToleranceText, emptySpec, gdtGlyph, parseToleranceText, toleranceLayout } from '../../src/edit/annot/tolerance';
import { generateDimensionGeometry } from '../../src/edit/dim';
import { line, circle, arc, lw } from '../edit/make';
import { makeDoc } from '../dim/doc';

describe('QDIM', () => {
  const ents = [line(0, 0, 30, 0), line(30, 0, 30, 20), line(30, 20, 80, 20), circle(50, -20, 5), arc(100, 0, 10, 0, 90), lw([[120, 0], [140, 0]])];
  const g = qdimGeometry(ents);

  it('치수 점: 끝점·원 중심·호 끝점·폴리선 꼭짓점(중복 없음), 원·호', () => {
    expect(g.points).toEqual([
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 20 },
      { x: 80, y: 20 },
      { x: 50, y: -20 },
      { x: 110, y: 0 },
      { x: 100, y: 10 },
      { x: 120, y: 0 },
      { x: 140, y: 0 },
    ]);
    expect(g.circles.length).toBe(2);
  });

  it('방향: 위·아래면 수평, 옆이면 수직', () => {
    expect(qdimRotation(g.points, { x: 50, y: 60 })).toBe(0);
    expect(qdimRotation(g.points, { x: 200, y: 0 })).toBeCloseTo(Math.PI / 2, 12);
  });

  it('연속·기준선·다중·세로좌표·반지름·지름', () => {
    const doc = makeDoc();
    const at = { x: 50, y: 60 };
    const geo = { points: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 20 }, { x: 80, y: 20 }], circles: g.circles };
    const cont = qdimCreate(doc, 'C', geo, at);
    // x = 0, 30, 80 (30이 둘이면 하나)
    expect(cont.map((d) => d.measurement)).toEqual([30, 50]);
    expect(cont.every((d) => Math.abs(d.defPoint.y - 60) < 1e-9)).toBe(true);
    const base = qdimCreate(doc, 'B', geo, at);
    expect(base.map((d) => d.measurement)).toEqual([30, 80]);
    expect(base[1]!.defPoint.y - base[0]!.defPoint.y).toBeCloseTo(3.75, 9);
    const stag = qdimCreate(doc, 'S', { points: [0, 10, 20, 30, 40].map((x) => ({ x, y: 0 })), circles: [] }, { x: 20, y: 20 });
    expect(stag.map((d) => d.measurement)).toEqual([20, 40]);
    const ord = qdimCreate(doc, 'O', geo, at, { datum: { x: 30, y: 0 } });
    expect(ord.length).toBe(3);
    expect(ord.every((d) => (d.dimType & 64) !== 0)).toBe(true);
    // 데이텀(30,0)에서 잰 X 거리
    expect(generateDimensionGeometry(doc, ord[0]!).measurement).toBeCloseTo(30, 9);
    expect(ord[0]!.defPoint).toMatchObject({ x: 30, y: 0 });
    const rad = qdimCreate(doc, 'R', geo, at);
    expect(rad.map((d) => d.measurement)).toEqual([5, 10]);
    expect(qdimCreate(doc, 'D', geo, at).map((d) => d.measurement)).toEqual([10, 20]);
  });
});

describe('TOLERANCE', () => {
  it('대화상자 값 ↔ 공차 문자열', () => {
    const s = emptySpec();
    s.rows[0].sym = 'j';
    s.rows[0].tol1 = { dia: true, value: '0.05', mc: 'M' };
    s.rows[0].datum[0] = { value: 'A', mc: '' };
    s.rows[0].datum[1] = { value: 'B', mc: 'M' };
    s.rows[1].sym = 'f';
    s.rows[1].tol1 = { dia: false, value: '0.02', mc: '' };
    s.height = '10';
    s.projected = true;
    s.datumId = 'C';
    const t = buildToleranceText(s);
    expect(t).toBe('{\\Fgdt;j}%%v{\\Fgdt;n}0.05{\\Fgdt;m}%%v%%vA%%vB{\\Fgdt;m}^J{\\Fgdt;f}%%v0.02^J10{\\Fgdt;p}^JC');
    const p = parseToleranceText(t);
    expect(p.rows[0]).toEqual(s.rows[0]);
    expect(p.rows[1]).toEqual(s.rows[1]);
    expect(p.height).toBe('10');
    expect(p.projected).toBe(true);
    expect(p.datumId).toBe('C');
    expect(buildToleranceText(emptySpec())).toBe('');
  });

  it('기호 외곽선과 프레임 배치', () => {
    for (const g of GDT_SYMBOLS) expect(gdtGlyph(g.key)).not.toBeNull();
    for (const c of ['n', 'm', 'l', 's', 'p']) expect(gdtGlyph(c)).not.toBeNull();
    const lay = toleranceLayout('{\\Fgdt;j}%%v{\\Fgdt;n}0.05%%vA', 2.5, 0.625);
    // 줄 높이 5, 기호 칸 5 × 5, 칸 셋
    expect(lay.height).toBeCloseTo(5, 12);
    const boxes = lay.strokes.filter((s) => s.closed && s.pts.length === 4);
    expect(boxes.length).toBe(3);
    expect(lay.texts.map((t) => t.text)).toEqual(['0.05', 'A']);
    // 같은 기호 두 줄은 기호 칸을 함께 쓴다
    const two = toleranceLayout('{\\Fgdt;f}%%v0.1%%vA^J{\\Fgdt;f}%%v0.05', 2.5, 0.625);
    const tall = two.strokes.filter((s) => s.closed && s.pts.length === 4 && Math.abs(s.pts[2]!.y - s.pts[0]!.y) > 9.99);
    expect(tall.length).toBe(1);
  });
});

describe('CENTERMARK·CENTERLINE', () => {
  const s = defaultCenterSettings(true);
  it('배수 값', () => {
    expect(lengthOrMultiple('0.1x', 20)).toBeCloseTo(2, 12);
    expect(lengthOrMultiple(3, 20)).toBe(3);
  });
  it('원: 십자(지름의 0.1) + 연장선 넷(간격 지름의 0.05, 원 밖 3.5)', () => {
    const l = centerMarkLines({ x: 0, y: 0 }, 10, 2 * Math.PI, s);
    expect(l.length).toBe(6);
    expect(l[0]).toEqual([{ x: -1, y: 0 }, { x: 1, y: 0 }]);
    const ext = l[2]!;
    expect(ext[0].x).toBeCloseTo(2, 12);
    expect(ext[1].x).toBeCloseTo(13.5, 12);
  });
  it('240°보다 짧은 호는 연장선이 없다', () => {
    expect(centerMarkLines({ x: 0, y: 0 }, 10, Math.PI, s).length).toBe(2);
    expect(centerMarkLines({ x: 0, y: 0 }, 10, (250 * Math.PI) / 180, s).length).toBe(6);
  });
  it('평행한 두 선: 가운데 선, 양 끝 연장', () => {
    const seg = centerLineSegment([{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: 10, y: 20 }, { x: 90, y: 20 }], 3.5)!;
    // 대응하는 끝의 가운데: (0+10)/2 = 5, (100+90)/2 = 95
    expect(seg[0]).toMatchObject({ x: 1.5, y: 10 });
    expect(seg[1]).toMatchObject({ x: 98.5, y: 10 });
  });
  it('기운 두 선: 각의 이등분선(가까운 끝끼리 → 먼 끝끼리)', () => {
    const seg = centerLineSegment([{ x: 10, y: 0 }, { x: 100, y: 0 }], [{ x: 10, y: 10 }, { x: 100, y: 100 }], 0)!;
    const a = Math.atan2(seg[1].y - seg[0].y, seg[1].x - seg[0].x);
    expect(a).toBeCloseTo(Math.PI / 8, 9);
    expect(centerLineSegment([{ x: 0, y: 0 }, { x: 10, y: 0 }], [{ x: 20, y: 0 }, { x: 30, y: 0 }], 1)).toBeNull();
  });
});

describe('QLEADER', () => {
  it('마지막 세그먼트가 15°보다 가파르면 갈고리선 시작점을 넣는다', () => {
    const r = buildLeader([{ x: 0, y: 0 }, { x: 10, y: 10 }], { hook: true, hookLength: 2.5 });
    expect(r.vertices).toEqual([{ x: 0, y: 0 }, { x: 7.5, y: 10 }, { x: 10, y: 10 }]);
    expect(r).toMatchObject({ hooked: true, hookDirection: 0, right: true });
    const l = buildLeader([{ x: 0, y: 0 }, { x: -10, y: 10 }], { hook: true, hookLength: 2.5 });
    expect(l.vertices[1]).toEqual({ x: -7.5, y: 10 });
    expect(l.hookDirection).toBe(1);
    expect(buildLeader([{ x: 0, y: 0 }, { x: 10, y: 1 }], { hook: true, hookLength: 2.5 }).hooked).toBe(false);
  });
});

function ml(): MLeaderEntity {
  return {
    ...entityDefaults(),
    type: 'MULTILEADER',
    handle: 'M1',
    leaderLineType: 1,
    leaderLineColor: { aci: 0 },
    leaderLineWeight: -2,
    landing: true,
    dogleg: true,
    doglegLength: 8,
    arrowSize: 4,
    contentType: 2,
    textColor: { aci: 0 },
    textFrame: false,
    blockColor: { aci: 0 },
    blockScale: { x: 1, y: 1, z: 1 },
    blockRotation: 0,
    blockConnection: 0,
    scale: 1,
    context: {
      scale: 1,
      contentBase: { x: 58, y: 50, z: 0 },
      textHeight: 4,
      arrowSize: 4,
      landingGap: 2,
      leaders: [{ lastLeaderPoint: { x: 50, y: 50, z: 0 }, doglegVector: { x: 1, y: 0, z: 0 }, doglegLength: 8, hasLastPoint: true, hasDogleg: true, lines: [{ vertices: [{ x: 0, y: 0, z: 0 }], index: 0 }], index: 0, attachmentDirection: 0 }],
      text: { text: 'ABC', location: { x: 60, y: 52, z: 0 }, direction: { x: 1, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, rotation: 0, width: 0, height: 4, lineSpacingFactor: 1, lineSpacingStyle: 1, color: { aci: 0 }, attachment: 1, flowDirection: 1, backgroundFill: false, backgroundScale: 1.5 },
      basePoint: { x: 58, y: 50, z: 0 },
      baseDirection: { x: 1, y: 0, z: 0 },
      baseVertical: { x: 0, y: 1, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
    },
  };
}

describe('MLEADEREDIT·MLEADERALIGN·끊기', () => {
  it('같은 쪽은 선을 더하고, 반대쪽은 연결선이 있는 새 지시선', () => {
    const e = ml();
    const a = addLeaderLine(e, { x: 10, y: 0 }, 20);
    expect(a.context.leaders.length).toBe(1);
    expect(a.context.leaders[0]!.lines.length).toBe(2);
    expect(a.context.leaders[0]!.lines[1]!.index).toBe(1);
    const b = addLeaderLine(e, { x: 150, y: 0 }, 20);
    expect(b.context.leaders.length).toBe(2);
    const nl = b.context.leaders[1]!;
    expect(nl.doglegVector!.x).toBe(-1);
    // 내용 오른쪽 끝 60 + 20 = 80, 간격 2, 연결선 8
    expect(nl.lastLeaderPoint!.x).toBeCloseTo(90, 12);
    expect(lineCount(b)).toBe(2);
    const r = removeLeaderLine(b, { x: 140, y: 5 })!;
    expect(r.context.leaders.length).toBe(1);
    expect(removeLeaderLine(e, { x: 0, y: 0 })).toBeNull();
  });

  it('내용 옮기기와 정렬', () => {
    const e = ml();
    const t = translateContent(e, { x: 5, y: -3 });
    expect(t.context.text!.location).toMatchObject({ x: 65, y: 49 });
    expect(landingOf(t)).toMatchObject({ x: 55, y: 47 });
    expect(t.context.leaders[0]!.lines[0]!.vertices[0]).toMatchObject({ x: 0, y: 0 });
    const o1 = translateContent(e, { x: 3, y: 20 });
    o1.handle = 'M2';
    const o2 = translateContent(e, { x: -4, y: 40 });
    o2.handle = 'M3';
    // 세로 방향 정렬(현재 간격): x만 50으로
    const cur = alignMleaders(e, [o1, o2], { x: 0, y: 1 }, { kind: 'current' });
    expect(cur.map((x) => landingOf(x))).toEqual([
      { x: 50, y: 70, z: 0 },
      { x: 50, y: 90, z: 0 },
    ]);
    const sp = alignMleaders(e, [o1, o2], { x: 0, y: 1 }, { kind: 'spacing', spacing: 10 });
    expect(sp.map((x) => landingOf(x).y)).toEqual([60, 70]);
    const dist = alignMleaders(e, [e, o1, o2], { x: 1, y: 0 }, { kind: 'distribute', from: { x: 0, y: 100 }, to: { x: 100, y: 100 } });
    expect(dist.map((x) => landingOf(x).x).sort((a, b) => a - b)).toEqual([0, 50, 100]);
  });

  it('끊기 쌍: 만나는 곳 양쪽으로 크기/2, 수동은 두 점의 발 사이', () => {
    const e = ml();
    // 지시선 (0,0)→(50,50)을 x = 25 세로선이 끊는다
    const m = mleaderBreakPairs(e, [{ k: 'line', a: { x: 25, y: -10 }, b: { x: 25, y: 100 } }], 4);
    const p = m.get('0:0')!;
    expect(p.length).toBe(1);
    const L = Math.hypot(p[0]!.end.x - p[0]!.start.x, p[0]!.end.y - p[0]!.start.y);
    expect(L).toBeCloseTo(4, 9);
    expect((p[0]!.start.x + p[0]!.end.x) / 2).toBeCloseTo(25, 9);
    const man = mleaderManualBreak(e, { x: 10, y: 12 }, { x: 20, y: 18 })!;
    expect(man.pair.start.x).toBeCloseTo(11, 9);
    expect(man.pair.end.x).toBeCloseTo(19, 9);
  });

  it('그리기용 토막: 끊기 사이를 빼고 중간 꼭짓점은 남긴다', () => {
    const P = (x: number, y: number) => ({ x, y, z: 0 });
    const pts = [P(0, 0), P(10, 0), P(10, 10)];
    expect(breakRuns(pts, undefined)).toEqual([pts]);
    // 첫 세그먼트 4~6, 꺾임점을 지나는 9~(10,1) 끊기
    const runs = breakRuns(pts, [
      { start: P(4, 0), end: P(6, 0) },
      { start: P(9, 0), end: P(10, 1) },
    ]);
    expect(runs.length).toBe(3);
    expect(runs[0]).toEqual([P(0, 0), P(4, 0)]);
    expect(runs[1]).toEqual([P(6, 0), P(9, 0)]);
    expect(runs[2]![0]!.x).toBeCloseTo(10, 12);
    expect(runs[2]![0]!.y).toBeCloseTo(1, 12);
    expect(runs[2]![1]).toEqual(P(10, 10));
    // 겹치는 끊기는 합친다, 끝까지 끊으면 남는 토막이 없다
    expect(breakRuns(pts, [{ start: P(0, 0), end: P(10, 0) }, { start: P(5, 0), end: P(10, 10) }])).toEqual([]);
  });

  it('블록 모으기 배치', () => {
    const s = [
      { w: 10, h: 5 },
      { w: 20, h: 8 },
      { w: 10, h: 5 },
    ];
    expect(collectLayout(s, { kind: 'H' }, 1)).toEqual([
      { x: 0, y: -5 },
      { x: 11, y: -8 },
      { x: 32, y: -5 },
    ]);
    expect(collectLayout(s, { kind: 'V' }, 1).map((q) => q.y)).toEqual([-5, -14, -20]);
    expect(collectLayout(s, { kind: 'W', count: 2 }, 1)[2]).toEqual({ x: 0, y: -14 });
  });
});

describe('MLEADERSTYLE', () => {
  const base: MLeaderStyleObject = {
    type: 'MLEADERSTYLE',
    handle: 'A0',
    owner: 'D0',
    name: 'Standard',
    contentType: 2,
    leaderLineType: 1,
    leaderLineColor: { aci: 0 },
    leaderLineWeight: -2,
    landing: true,
    doglegLength: 8,
    arrowSize: 4,
    textHeight: 4,
    textColor: { aci: 0 },
    landingGap: 2,
    scale: 1,
    raw: [
      { code: 100, value: 'AcDbMLeaderStyle' },
      { code: 170, value: 2 },
      { code: 173, value: 1 },
      { code: 290, value: 1 },
      { code: 42, value: 2 },
      { code: 43, value: 8 },
      { code: 3, value: 'Standard' },
      { code: 44, value: 4 },
      { code: 45, value: 4 },
      { code: 142, value: 1 },
      { code: 143, value: 3.75 },
    ],
  };
  const vals = { leaderLineType: 2, arrowSize: 3, breakGap: 2, landing: false, doglegLength: 5, contentType: 1, textHeight: 3.5, landingGap: 1, scale: 2 };
  it('모델 값과 원본 태그를 함께 고친다', () => {
    const u = updateStyle(base, vals);
    expect(u).toMatchObject({ leaderLineType: 2, arrowSize: 3, landing: false, doglegLength: 5, contentType: 1, textHeight: 3.5, landingGap: 1, scale: 2 });
    const tag = (c: number) => u.raw!.find((t) => t.code === c)!.value;
    expect([tag(173), tag(44), tag(290), tag(43), tag(170), tag(45), tag(42), tag(142), tag(143)]).toEqual([2, 3, 0, 5, 1, 3.5, 1, 2, 2]);
    // 원본 태그에 없는 코드(342 문자 스타일)를 바꾸면 원본 태그를 버린다
    expect(updateStyle(base, { ...vals, textStyleHandle: '11' }).raw).toBeUndefined();
    expect(base.arrowSize).toBe(4);
  });
  it('복사와 사용 여부', () => {
    const c = copyStyle(base, '새 스타일', 'B1', 'D0');
    expect(c).toMatchObject({ name: '새 스타일', handle: 'B1', owner: 'D0' });
    expect(c.raw!.find((t) => t.code === 3)!.value).toBe('새 스타일');
    const doc = makeDoc();
    expect(styleInUse(doc, 'A0')).toBe(false);
    doc.blocks.set('*MODEL_SPACE', { name: '*Model_Space', handle: '1F', recordHandle: '1E', basePoint: { x: 0, y: 0, z: 0 }, flags: 0, entities: [{ ...ml(), styleHandle: 'A0' }] });
    expect(styleInUse(doc, 'a0')).toBe(true);
  });
});
