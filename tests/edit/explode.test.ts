import { describe, expect, it } from 'vitest';
import type {
  ArcEntity,
  AttribEntity,
  CircleEntity,
  DimensionEntity,
  EllipseEntity,
  Entity,
  FaceEntity,
  HatchEntity,
  InsertEntity,
  LeaderEntity,
  LineEntity,
  MLineEntity,
  MeshEntity,
  PolylineEntity,
  TableEntity,
  TextEntity,
  ToleranceEntity,
} from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { explodeEntity } from '../../src/edit/geom/explode';
import { entityPath } from '../../src/edit/geom/path';
import { flattenPath, pathNearest, pathSize } from '../../src/edit/geom/curve';
import { NEG_Z, P, V, arc, circle, deg, line, lw, mtext, near, newDoc, poly2d, renders, text } from './helpers';

const base = (h = '') => ({ ...entityDefaults(), handle: h });

/** 조각들이 원본 경로 위에 있고 길이 합이 같은지 */
function coversPath(orig: Entity, parts: Entity[]): void {
  const po = entityPath(orig)!;
  let total = 0;
  for (const e of parts) {
    const p = entityPath(e)!;
    for (const q of flattenPath(p, pathSize(p) * 1e-3)) expect(pathNearest(po, q).d).toBeLessThan(1e-7);
    total += flattenPath(p, 1e-4).reduce((a, q, i, arr) => (i ? a + Math.hypot(q.x - arr[i - 1]!.x, q.y - arr[i - 1]!.y) : 0), 0);
  }
  const L = flattenPath(po, 1e-4).reduce((a, q, i, arr) => (i ? a + Math.hypot(q.x - arr[i - 1]!.x, q.y - arr[i - 1]!.y) : 0), 0);
  expect(total).toBeCloseTo(L, 3);
}

function insert(block: string, x: number, y: number, extra: Partial<InsertEntity> = {}): InsertEntity {
  return {
    type: 'INSERT',
    ...base('I' + Math.random().toString(16).slice(2, 6)),
    block,
    insert: P(x, y),
    scale: P(1, 1, 1),
    rotation: 0,
    columnCount: 1,
    rowCount: 1,
    columnSpacing: 0,
    rowSpacing: 0,
    attribs: [],
    ...extra,
  };
}

function attdef(tag: string, x: number, y: number, flags = 0, value = ''): AttribEntity {
  return {
    type: 'ATTDEF',
    ...base('AD' + tag),
    insert: P(x, y),
    height: 0.5,
    text: value,
    rotation: 0,
    widthFactor: 1,
    oblique: 0,
    style: 'Standard',
    generation: 0,
    halign: 0,
    valign: 0,
    tag,
    attFlags: flags,
  };
}

describe('explodeEntity — 폴리선', () => {
  const doc = newDoc();
  it('LWPOLYLINE → LINE·ARC(폭은 버린다)', () => {
    const p = lw(
      [
        [0, 0],
        [10, 0, 0.5],
        [10, 10],
        [0, 10, -1],
      ],
      true,
      undefined,
      0.3,
    );
    const r = explodeEntity(p, doc);
    expect(r.remove).toEqual([p.handle]);
    expect(r.add!.map((e) => e.type)).toEqual(['LINE', 'ARC', 'LINE', 'ARC']);
    coversPath(p, r.add!);
    renders(doc, r.add!);
  });
  it('−Z 폴리선: 호는 같은 OCS(−Z) ARC로', () => {
    const p = lw(
      [
        [0, 0],
        [10, 0, 0.5],
        [10, 10],
      ],
      false,
      NEG_Z,
    );
    const r = explodeEntity(p, doc);
    const a = r.add!.find((e) => e.type === 'ARC') as ArcEntity;
    expect(a.extrusion?.z).toBe(-1);
    const l = r.add!.find((e) => e.type === 'LINE') as LineEntity;
    near(l.start, P(0, 0));
    near(l.end, P(-10, 0));
    coversPath(p, r.add!);
    renders(doc, r.add!);
  });
  it('2D POLYLINE → LINE·ARC, 3D POLYLINE → LINE(Z 유지)', () => {
    const p = poly2d([[0, 0, 0.3], [5, 1], [8, 6, -0.7], [2, 9]]);
    const r = explodeEntity(p, doc);
    expect(r.add!.length).toBe(3);
    coversPath(p, r.add!);
    const p3: PolylineEntity = {
      type: 'POLYLINE',
      ...base('P3'),
      kind: '3d',
      flags: 8,
      vertices: [P(0, 0, 0), P(5, 0, 2), P(5, 5, 4)].map((location) => ({ location, bulge: 0, startWidth: 0, endWidth: 0, flags: 32 })),
      elevation: 0,
      defaultStartWidth: 0,
      defaultEndWidth: 0,
      mCount: 0,
      nCount: 0,
      mDensity: 0,
      nDensity: 0,
      smoothType: 0,
    };
    const r3 = explodeEntity(p3, doc);
    expect(r3.add!.length).toBe(2);
    expect((r3.add![1] as LineEntity).end.z).toBe(4);
  });
  it('폴리페이스 → 3DFACE(보이지 않는 모서리), 다각형 메시 → 3DFACE, MESH → 3DFACE', () => {
    const v = (x: number, y: number, z = 0) => ({ location: P(x, y, z), bulge: 0, startWidth: 0, endWidth: 0, flags: 128 | 64 });
    const pf: PolylineEntity = {
      type: 'POLYLINE',
      ...base('PF'),
      kind: 'polyface',
      flags: 64,
      vertices: [v(0, 0), v(1, 0), v(1, 1), v(0, 1), { location: P(0, 0), bulge: 0, startWidth: 0, endWidth: 0, flags: 128, faceIndices: [1, 2, 3, -4] }],
      elevation: 0,
      defaultStartWidth: 0,
      defaultEndWidth: 0,
      mCount: 4,
      nCount: 1,
      mDensity: 0,
      nDensity: 0,
      smoothType: 0,
    };
    const r = explodeEntity(pf, doc);
    expect(r.add!.length).toBe(1);
    const f = r.add![0] as FaceEntity;
    expect(f.type).toBe('3DFACE');
    expect(f.invisibleEdges).toBe(8); // −4: 네 번째 정점에서 시작하는 모서리
    const mesh: PolylineEntity = {
      ...pf,
      handle: 'PM',
      kind: 'mesh',
      flags: 16,
      vertices: [v(0, 0), v(0, 1), v(0, 2), v(1, 0), v(1, 1), v(1, 2)],
      mCount: 2,
      nCount: 3,
    };
    expect(explodeEntity(mesh, doc).add!.length).toBe(2);
    const m: MeshEntity = { type: 'MESH', ...base('M'), vertices: [P(0, 0), P(1, 0), P(1, 1), P(0, 1), P(2, 0)], faces: [[0, 1, 2, 3], [1, 4, 2]], edges: [], subdivision: 0 };
    expect(explodeEntity(m, doc).add!.length).toBe(2);
  });
});

describe('explodeEntity — 블록 참조', () => {
  const doc = newDoc();
  doc.blocks.set('B', {
    name: 'B',
    handle: 'B1',
    recordHandle: 'B2',
    basePoint: P(0, 0),
    flags: 2,
    entities: [{ ...line(0, 0, 1, 0), layer: '0', color: { aci: 0 } }, circle(0, 0, 0.5), attdef('T', 0, 1), attdef('C', 0, 2, 2, 'CONST'), text(0, -1, 'AB', 0.5)],
  });
  doc.blocks.set('N', { name: 'N', handle: 'N1', recordHandle: 'N2', basePoint: P(1, 1), flags: 0, entities: [insert('B', 0, 0), line(1, 1, 2, 1)] });
  it('이동·회전·축척, 도면층 0·ByBlock 그대로, 속성은 값의 TEXT, 상수 아닌 ATTDEF는 버린다', () => {
    const at: AttribEntity = { ...attdef('T', 5, 7), type: 'ATTRIB', handle: 'AT1', text: 'VALUE', layer: 'A' };
    const ins = insert('B', 5, 5, { scale: P(2, 2, 1), rotation: deg(90), attribs: [at] });
    const r = explodeEntity(ins, doc);
    expect(r.remove).toEqual([ins.handle]);
    const types = r.add!.map((e) => e.type);
    expect(types.filter((t) => t === 'TEXT').length).toBe(3); // 상수 ATTDEF, 블록의 TEXT, 속성
    expect(types).not.toContain('ATTDEF');
    const l = r.add!.find((e) => e.type === 'LINE') as LineEntity;
    near(l.start, P(5, 5));
    near(l.end, P(5, 7));
    expect(l.layer).toBe('0');
    expect(l.color.aci).toBe(0);
    const c = r.add!.find((e) => e.type === 'CIRCLE') as CircleEntity;
    expect(c.radius).toBeCloseTo(1);
    const val = r.add!.find((e) => e.type === 'TEXT' && (e as TextEntity).text === 'VALUE') as TextEntity;
    near(val.insert, P(5, 7));
    expect(val.layer).toBe('A');
    expect(r.add!.every((e) => e.handle === '')).toBe(true);
    renders(doc, r.add!);
  });
  it('비균등 축척의 원 → 타원, 대칭 블록의 문자는 정확히 거울상', () => {
    const r = explodeEntity(insert('B', 0, 0, { scale: P(2, 1, 1) }), doc);
    const e = r.add!.find((x) => x.type === 'ELLIPSE') as EllipseEntity;
    expect(Math.hypot(e.majorAxis.x, e.majorAxis.y)).toBeCloseTo(1);
    expect(e.ratio).toBeCloseTo(0.5);
    const m = explodeEntity(insert('B', 0, 0, { scale: P(-1, 1, 1) }), doc);
    const t = m.add!.find((x) => x.type === 'TEXT' && (x as TextEntity).text === 'AB') as TextEntity;
    expect(t.generation & 2).toBe(2);
    near(t.insert, P(0, -1));
    renders(doc, [...r.add!, ...m.add!]);
  });
  it('MINSERT 격자, 중첩 블록은 한 단계만, 블록 기준점', () => {
    const r = explodeEntity(insert('B', 0, 0, { rowCount: 2, columnCount: 3, rowSpacing: 5, columnSpacing: 4 }), doc);
    expect(r.add!.filter((e) => e.type === 'CIRCLE').length).toBe(6);
    const cs = r.add!.filter((e) => e.type === 'CIRCLE').map((e) => (e as CircleEntity).center);
    expect(cs.some((c) => Math.abs(c.x - 8) < 1e-9 && Math.abs(c.y - 5) < 1e-9)).toBe(true);
    const n = explodeEntity(insert('N', 10, 0), doc);
    const inner = n.add!.find((e) => e.type === 'INSERT') as InsertEntity;
    near(inner.insert, P(9, -1));
    const l = n.add!.find((e) => e.type === 'LINE') as LineEntity;
    near(l.start, P(10, 0));
    renders(doc, n.add!);
  });
  it('−Z 블록 참조', () => {
    const r = explodeEntity(insert('B', 5, 0, { extrusion: NEG_Z }), doc);
    const l = r.add!.find((e) => e.type === 'LINE') as LineEntity;
    near(l.start, P(-5, 0));
    near(l.end, P(-6, 0));
    renders(doc, r.add!);
  });
  it('없는 블록·외부 참조는 안내', () => {
    expect(explodeEntity(insert('NONE', 0, 0), doc).message).toBeTruthy();
  });
});

describe('explodeEntity — 주석·문자·해치', () => {
  const doc = newDoc();
  doc.blocks.set('*D1', { name: '*D1', handle: 'D1', recordHandle: 'D2', basePoint: P(0, 0), flags: 1, entities: [line(0, 0, 10, 0), line(0, 0, 0, 3), line(10, 0, 10, 3), mtext(5, 3.5, '10', 2.5, { attachment: 8 })] });
  it('치수 → 블록 그림', () => {
    const d: DimensionEntity = {
      type: 'DIMENSION',
      ...base('DM'),
      block: '*D1',
      dimStyle: 'Standard',
      dimType: 32,
      defPoint: P(10, 3),
      textMid: P(5, 3.5),
      defPoint2: P(0, 0),
      defPoint3: P(10, 0),
      defPoint4: P(0, 0),
      defPoint5: P(0, 0),
      text: '',
      measurement: 10,
      rotation: 0,
      obliqueAngle: 0,
      textRotation: 0,
      horizontalDirection: 0,
      attachment: 5,
      leaderLength: 0,
      lineSpacingStyle: 1,
      lineSpacingFactor: 1,
    };
    const r = explodeEntity(d, doc);
    expect(r.add!.length).toBe(4);
    expect(r.add!.map((e) => e.type).sort()).toEqual(['LINE', 'LINE', 'LINE', 'MTEXT']);
    renders(doc, r.add!);
  });
  it('여러 줄 문자 → 줄마다 TEXT', () => {
    const m = mtext(0, 10, 'Hello\\PWorld', 2);
    const r = explodeEntity(m, doc);
    const ts = r.add as TextEntity[];
    expect(ts.map((t) => t.text)).toEqual(['Hello', 'World']);
    expect(ts[0]!.insert.y).toBeCloseTo(8);
    expect(ts[1]!.insert.y).toBeLessThan(ts[0]!.insert.y - 2);
    // 가운데 부착: 정렬점
    const c = explodeEntity(mtext(0, 0, 'A', 2, { attachment: 2, width: 20 }), doc).add![0] as TextEntity;
    expect(c.halign).toBe(1);
    renders(doc, [...ts, c]);
  });
  it('무늬 해치 → 선, 솔리드는 안내', () => {
    const h: HatchEntity = {
      type: 'HATCH',
      ...base('H'),
      patternName: 'ANSI31',
      solid: false,
      associative: false,
      hatchStyle: 0,
      patternType: 1,
      patternAngle: 0,
      patternScale: 1,
      patternDouble: false,
      elevation: 0,
      paths: [{ flags: 3, polyline: { closed: true, vertices: [V(0, 0), V(10, 0), V(10, 10), V(0, 10)].map((p) => ({ ...p, bulge: 0 })) } }],
      patternLines: [{ angle: deg(45), base: V(0, 0), offset: V(-2.245, 2.245), dashes: [] }],
      pixelSize: 0,
      seedPoints: [],
    };
    const r = explodeEntity(h, doc);
    expect(r.add!.length).toBeGreaterThan(3);
    for (const l of r.add! as LineEntity[]) {
      expect(Math.abs(l.end.y - l.start.y - (l.end.x - l.start.x))).toBeLessThan(1e-6);
      for (const p of [l.start, l.end]) {
        expect(p.x).toBeGreaterThan(-1e-6);
        expect(p.x).toBeLessThan(10 + 1e-6);
      }
    }
    expect(explodeEntity({ ...h, solid: true }, doc).message).toBeTruthy();
  });
  it('지시선 → 선 + 화살촉', () => {
    const l: LeaderEntity = { type: 'LEADER', ...base('L'), dimStyle: 'Standard', vertices: [P(0, 0), P(5, 5), P(10, 5)], arrowHead: true, pathType: 0, creation: 3, hooklineDirection: 0, hookline: false, textHeight: 0, textWidth: 0 };
    const r = explodeEntity(l, doc);
    expect(r.add!.filter((e) => e.type === 'LINE').length).toBeGreaterThanOrEqual(2);
    expect(r.add!.some((e) => e.type === 'SOLID')).toBe(true);
    renders(doc, r.add!);
  });
  it('여러 줄(MLINE) → 선', () => {
    const ml: MLineEntity = {
      type: 'MLINE',
      ...base('ML'),
      styleName: 'Standard',
      scale: 1,
      justification: 1,
      flags: 1,
      startPoint: P(0, 0),
      normal: P(0, 0, 1),
      elementCount: 2,
      vertices: [
        { position: P(0, 0), direction: P(1, 0), miter: P(0, 1), elements: [{ params: [0.5, 0], fillParams: [] }, { params: [-0.5, 0], fillParams: [] }] },
        { position: P(10, 0), direction: P(1, 0), miter: P(0, 1), elements: [{ params: [0.5, 0], fillParams: [] }, { params: [-0.5, 0], fillParams: [] }] },
      ],
    };
    const r = explodeEntity(ml, doc);
    const ls = r.add as LineEntity[];
    expect(ls.length).toBe(2);
    expect(ls.map((l) => l.start.y).sort()).toEqual([-0.5, 0.5]);
  });
  it('공차 → 틀 선 + MTEXT, 표 → 블록 그림', () => {
    const t: ToleranceEntity = { type: 'TOLERANCE', ...base('TO'), dimStyle: 'Standard', insert: P(0, 0), text: '{\\Fgdt;j}%%v0.1', direction: P(1, 0) };
    const r = explodeEntity(t, doc);
    expect(r.add!.filter((e) => e.type === 'LINE').length).toBe(4);
    expect(r.add!.some((e) => e.type === 'MTEXT')).toBe(true);
    doc.blocks.set('*T1', { name: '*T1', handle: 'T1', recordHandle: 'T2', basePoint: P(0, 0), flags: 1, entities: [line(0, 0, 10, 0), line(0, -5, 10, -5)] });
    const tb: TableEntity = { type: 'ACAD_TABLE', ...base('TB'), block: '*T1', insert: P(100, 0), direction: P(0, 1), scale: P(1, 1, 1), rotation: 0, rows: 1, columns: 1, rowHeights: [5], columnWidths: [10] };
    const rt = explodeEntity(tb, doc);
    const l0 = rt.add![0] as LineEntity;
    near(l0.start, P(100, 0));
    near(l0.end, P(100, 10));
    renders(doc, [...r.add!, ...rt.add!]);
  });
  it('분해할 수 없는 객체', () => {
    expect(explodeEntity(line(0, 0, 1, 1), doc).message).toBe('이 객체는 분해할 수 없습니다.');
    expect(explodeEntity({ type: 'REGION', ...base('RG') } as Entity, doc).message).toBe('이 객체는 분해할 수 없습니다.');
    expect(explodeEntity(arc(0, 0, 1, 0, 90), doc).message).toBeTruthy();
  });
});
