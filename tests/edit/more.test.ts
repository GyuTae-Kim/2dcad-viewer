/** 여러 연산의 나머지 조합(절단 모서리로 쓰는 블록 참조, 구성선 모따기, 신축·그립·분해의 주석 객체 등) */
import { describe, expect, it } from 'vitest';
import type {
  Entity,
  FaceEntity,
  HatchEntity,
  InsertEntity,
  LineEntity,
  MLeaderEntity,
  MLineEntity,
  PolylineEntity,
  TextEntity,
  XLineEntity,
} from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import * as G from '../../src/edit/geom';
import { entityPath } from '../../src/edit/geom/path';
import { pathNearest } from '../../src/edit/geom/curve';
import { NEG_Z, P, V, circle, deg, line, lw, near, newDoc, renders, text, xline } from './helpers';

const base = (h: string) => ({ ...entityDefaults(), handle: h });
const all = (r: G.EditResult) => [...(r.replace ?? []), ...(r.add ?? [])];

function mleader(): MLeaderEntity {
  return {
    type: 'MULTILEADER',
    ...base('MLD'),
    leaderLineType: 1,
    leaderLineColor: { aci: 256 },
    leaderLineWeight: -1,
    landing: true,
    dogleg: true,
    doglegLength: 2,
    arrowSize: 2.5,
    contentType: 2,
    textColor: { aci: 256 },
    textFrame: false,
    blockColor: { aci: 256 },
    blockScale: P(1, 1, 1),
    blockRotation: 0,
    blockConnection: 0,
    scale: 1,
    context: {
      scale: 1,
      contentBase: P(12, 5),
      textHeight: 2.5,
      arrowSize: 2.5,
      landingGap: 1,
      leaders: [{ lastLeaderPoint: P(10, 5), doglegVector: P(1, 0), doglegLength: 2, hasLastPoint: true, hasDogleg: true, lines: [{ vertices: [P(0, 0), P(4, 3)], index: 0 }], index: 0, attachmentDirection: 0 }],
      text: { text: 'Note', location: P(13, 6), direction: P(1, 0), normal: P(0, 0, 1), rotation: 0, width: 0, height: 0, lineSpacingFactor: 1, lineSpacingStyle: 1, color: { aci: 256 }, attachment: 1, flowDirection: 1, backgroundFill: false, backgroundScale: 1.5 },
      basePoint: P(12, 5),
      baseDirection: P(1, 0),
      baseVertical: P(0, 1),
      normal: P(0, 0, 1),
    },
  };
}

function mline(): MLineEntity {
  return {
    type: 'MLINE',
    ...base('MLN'),
    styleName: 'Standard',
    scale: 1,
    justification: 1,
    flags: 1,
    startPoint: P(0, 0),
    normal: P(0, 0, 1),
    elementCount: 2,
    vertices: [P(0, 0), P(10, 0)].map((p) => ({ position: p, direction: P(1, 0), miter: P(0, 1), elements: [{ params: [0.5, 0], fillParams: [] }, { params: [-0.5, 0], fillParams: [] }] })),
  };
}

describe('공개 API(index.ts)', () => {
  it('모든 함수가 공개되어 있다', () => {
    for (const k of ['transformEntity', 'intersections', 'offsetEntity', 'trimEntity', 'extendEntity', 'fillet', 'filletPolyline', 'chamfer', 'chamferAngle', 'chamferPolyline', 'breakEntity', 'joinEntities', 'lengthenEntity', 'explodeEntity', 'stretch', 'gripPoints', 'gripMove', 'arrayRectangular', 'arrayPolar', 'nearestPointOn', 'entityBounds', 'reverseEntity', 'copyEntity'])
      expect(typeof (G as Record<string, unknown>)[k], k).toBe('function');
  });
});

describe('자르기·연장: 블록 참조와 구성선 모서리', () => {
  const doc = newDoc();
  doc.blocks.set('W', { name: 'W', handle: 'W1', recordHandle: 'W2', basePoint: P(0, 0), flags: 0, entities: [line(0, -5, 0, 5)] });
  const wall: InsertEntity = { type: 'INSERT', ...base('IW'), block: 'W', insert: P(6, 0), scale: P(1, 1, 1), rotation: 0, columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0, attribs: [] };
  it('블록 참조 안의 선이 절단 모서리', () => {
    const l = line(0, 0, 10, 0);
    const r = G.trimEntity(l, [wall], V(8, 0), { doc });
    near((r.replace![0] as LineEntity).end, P(6, 0));
    const e = G.extendEntity(line(0, 1, 3, 1), [wall], V(2.5, 1), { doc });
    near((e.replace![0] as LineEntity).end, P(6, 1));
  });
  it('구성선이 절단·경계 모서리', () => {
    const x = xline(5, 0, 0, 1);
    near((G.trimEntity(line(0, 0, 10, 0), [x], V(8, 0)).replace![0] as LineEntity).end, P(5, 0));
    near((G.extendEntity(line(0, 0, 2, 0), [x], V(1.9, 0)).replace![0] as LineEntity).end, P(5, 0));
  });
});

describe('빠른 자르기: 도면 전체를 절단 모서리로', () => {
  it('선 5000개 + 블록 참조 500개에서도 빠르다', () => {
    const doc = newDoc();
    doc.blocks.set('W', { name: 'W', handle: 'W1', recordHandle: 'W2', basePoint: P(0, 0), flags: 0, entities: [line(0, -1, 0, 1), circle(0, 0, 0.3)] });
    const list: Entity[] = [];
    for (let i = 0; i < 5000; i++) list.push(line(i * 3 + 100, -1, i * 3 + 100, 1));
    for (let i = 0; i < 500; i++) list.push({ type: 'INSERT', ...base('X' + i), block: 'W', insert: P(-i * 3 - 100, 0), scale: P(1, 1, 1), rotation: 0, columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0, attribs: [] } as InsertEntity);
    list.push(line(5, -1, 5, 1), line(7, -1, 7, 1));
    const target = line(0, 0, 10, 0);
    list.push(target);
    const t0 = performance.now();
    const r = G.trimEntity(target, 'all', V(6, 0), { all: list, doc });
    const ms = performance.now() - t0;
    expect(r.add!.length).toBe(1);
    near((r.replace![0] as LineEntity).end, P(5, 0));
    expect(ms).toBeLessThan(1500);
  });
});

describe('모따기·모깎기: 구성선·3D 폴리선', () => {
  it('구성선 두 개의 모따기 → 광선 두 개 + 선', () => {
    const a = xline(0, 0, 1, 0);
    const b = xline(0, 0, 0, 1);
    const r = G.chamfer(a, V(5, 0), b, V(0, 5), 1, 2);
    const rays = (r.add ?? []).filter((e) => e.type === 'RAY') as XLineEntity[];
    expect(rays.length).toBe(2);
    const c = (r.add ?? []).find((e) => e.type === 'LINE') as LineEntity;
    near(c.start, P(1, 0));
    near(c.end, P(0, 2));
  });
  it('3D 폴리선 끝 세그먼트와 선', () => {
    const p: PolylineEntity = {
      type: 'POLYLINE',
      ...base('P3'),
      kind: '3d',
      flags: 8,
      vertices: [P(0, 10), P(0, 0)].map((location) => ({ location, bulge: 0, startWidth: 0, endWidth: 0, flags: 32 })),
      elevation: 0,
      defaultStartWidth: 0,
      defaultEndWidth: 0,
      mCount: 0,
      nCount: 0,
      mDensity: 0,
      nDensity: 0,
      smoothType: 0,
    };
    const r = G.fillet(p, V(0, 5), line(0, 0, 10, 0), V(5, 0), 2);
    const np = r.replace!.find((e) => e.handle === 'P3') as PolylineEntity;
    expect(np.kind).toBe('3d');
    near(np.vertices.at(-1)!.location, P(0, 2));
  });
});

describe('주석 객체: 신축·그립·분해', () => {
  const doc = newDoc();
  it('다중 지시선: 신축(내용이 안이면 내용·착지 이동), 그립, 분해', () => {
    const m = mleader();
    const s = G.stretch([m], [V(8, 3), V(20, 10)], V(2, 1), doc).replace![0] as MLeaderEntity;
    near(s.context.text!.location, P(15, 7));
    near(s.context.leaders[0]!.lastLeaderPoint!, P(12, 6));
    near(s.context.leaders[0]!.lines[0]!.vertices[0]!, P(0, 0));
    const ids = G.gripPoints(m, doc).map((g) => g.id);
    expect(ids).toContain('content');
    expect(ids).toContain('l0.0.1');
    const gv = G.gripMove(m, 'l0.0.0', V(-1, -1), doc).replace![0] as MLeaderEntity;
    near(gv.context.leaders[0]!.lines[0]!.vertices[0]!, P(-1, -1));
    const ex = G.explodeEntity(m, doc);
    expect(ex.add!.some((e) => e.type === 'MTEXT')).toBe(true);
    expect(ex.add!.filter((e) => e.type === 'LINE').length).toBeGreaterThanOrEqual(2);
    renders(doc, [s, gv, ...ex.add!]);
  });
  it('여러 줄: 신축·그립은 방향·마이터를 다시 구한다', () => {
    const s = G.stretch([mline()], [V(5, -5), V(20, 5)], V(0, 10), doc).replace![0] as MLineEntity;
    near(s.vertices[1]!.position, P(10, 10));
    expect(Math.hypot(s.vertices[0]!.direction.x - Math.SQRT1_2, s.vertices[0]!.direction.y - Math.SQRT1_2)).toBeLessThan(1e-9);
    const g = G.gripMove(mline(), 'v1', V(10, -10), doc).replace![0] as MLineEntity;
    near(g.vertices[1]!.position, P(10, -10));
    renders(doc, [s, g]);
  });
  it('솔리드(−Z)·해치 꼭짓점 그립', () => {
    const so: FaceEntity = { type: 'SOLID', ...base('SO'), points: [P(0, 0), P(4, 0), P(0, 3), P(4, 3)], invisibleEdges: 0, extrusion: NEG_Z };
    const gp = G.gripPoints(so, doc);
    near(gp[1]!.point, V(-4, 0));
    const r = G.gripMove(so, 'v1', V(-6, 0), doc).replace![0] as FaceEntity;
    const w = G.gripPoints(r, doc)[1]!.point;
    near(w, V(-6, 0));
    const h: HatchEntity = {
      type: 'HATCH',
      ...base('H'),
      patternName: 'SOLID',
      solid: true,
      associative: false,
      hatchStyle: 0,
      patternType: 1,
      patternAngle: 0,
      patternScale: 1,
      patternDouble: false,
      elevation: 0,
      paths: [{ flags: 1, edges: [{ type: 'line', start: V(0, 0), end: V(5, 0) }, { type: 'line', start: V(5, 0), end: V(5, 5) }, { type: 'line', start: V(5, 5), end: V(0, 0) }] }],
      patternLines: [],
      pixelSize: 0,
      seedPoints: [],
    };
    const hg = G.gripMove(h, 'p0.1', V(7, 0), doc).replace![0] as HatchEntity;
    const ed = hg.paths[0]!.edges!;
    expect(ed[1]!.type === 'line' && ed[1]!.start.x).toBe(7);
    expect(ed[0]!.type === 'line' && ed[0]!.end.x).toBe(7);
    renders(doc, [r, hg]);
  });
});

describe('작업 흐름', () => {
  it('그리기 → 간격띄우기 → 자르기 → 모깎기 → 결합 → 분해가 이어진다', () => {
    const doc = newDoc();
    const a = line(0, 0, 10, 0);
    const b = line(10, 0, 10, 10);
    const off = G.offsetEntity(line(0, 0, 12, 0), 2, V(5, 5)).add![0] as LineEntity; // y = 2
    const t = G.trimEntity(off, [b], V(11, 2), { extendEdges: true });
    const off2 = all(t)[0] as LineEntity;
    near(off2.end, P(10, 2));
    const f = G.fillet(a, V(5, 0), b, V(10, 5), 1);
    const parts = all(f);
    const j = G.joinEntities(parts);
    const pl = all(j).find((e) => e.type === 'LWPOLYLINE')!;
    expect(pl).toBeTruthy();
    const ex = G.explodeEntity(pl, doc);
    expect(ex.add!.map((e) => e.type).sort()).toEqual(['ARC', 'LINE', 'LINE']);
    const rev = G.reverseEntity(pl).replace![0]!;
    expect(pathNearest(entityPath(rev)!, V(9, 1)).d).toBeCloseTo(pathNearest(entityPath(pl)!, V(9, 1)).d, 9);
    const copies = G.arrayPolar([pl, text(5, 5, 'X') as TextEntity, circle(3, 3, 1) as Entity], V(0, 0), 4, 2 * Math.PI, true, doc);
    expect(copies.add!.length).toBe(9);
    renders(doc, [off2, ...parts, pl, ...ex.add!, rev, ...copies.add!]);
    expect(G.entityBounds(pl, doc)!.maxX).toBeCloseTo(10);
    expect(G.intersections(pl, line(5, -5, 5, 5)).length).toBe(1);
    expect(deg(180)).toBeCloseTo(Math.PI);
    void lw;
  });
});
