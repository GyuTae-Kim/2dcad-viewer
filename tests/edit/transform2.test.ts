import { describe, expect, it } from 'vitest';
import type {
  AttribEntity,
  DimensionEntity,
  Entity,
  FaceEntity,
  HatchEntity,
  ImageEntity,
  InsertEntity,
  LeaderEntity,
  MLeaderEntity,
  MLineEntity,
  MeshEntity,
  PointEntity,
  PolylineEntity,
  ShapeEntity,
  TableEntity,
  TextEntity,
  ToleranceEntity,
  UnderlayEntity,
  ViewportEntity,
} from '../../src/core/model';
import { entityDefaults, tableKey } from '../../src/core/model';
import { transformEntity } from '../../src/edit/geom/transform';
import { copyEntity } from '../../src/edit/geom/query';
import { type Affine, affApply, affInv, affMirror, affMul, affRotate, affScale, affTranslate } from '../../src/edit/geom/math';
import { NEG_Z, P, V, circle, deg, line, mtext, near, newDoc, renders, text } from './helpers';

const base = (h: string) => ({ ...entityDefaults(), handle: h });
const one = (r: { replace?: Entity[]; add?: Entity[] }) => [...(r.replace ?? []), ...(r.add ?? [])][0]!;

const MATS: [string, Affine][] = [
  ['이동', affTranslate(10, -5)],
  ['회전', affRotate(deg(30), V(3, 4))],
  ['축척', affScale(2.5, 2.5, V(1, 1))],
  ['대칭', affMirror(V(0, 0), V(0, 1))],
  ['대칭(비스듬히)', affMirror(V(1, 2), V(4, 7))],
  ['비균등', affScale(2, 0.5, V(1, -1))],
];

function makeDoc() {
  const doc = newDoc();
  doc.blocks.set('*D1', { name: '*D1', handle: 'DB', recordHandle: 'DR', basePoint: P(0, 0), flags: 1, entities: [line(0, 0, 0, 3.6), line(10, 0, 10, 3.6), line(0, 3, 10, 3), mtext(5, 3.6, '10', 2.5, { attachment: 8 })] });
  doc.blocks.set('*T1', { name: '*T1', handle: 'TB', recordHandle: 'TR', basePoint: P(0, 0), flags: 1, entities: [line(0, 0, 20, 0), line(0, -5, 20, -5), mtext(1, -1, 'Cell', 2)] });
  doc.blocks.set('B', { name: 'B', handle: 'BB', recordHandle: 'BR', basePoint: P(0, 0), flags: 0, entities: [line(0, 0, 1, 0), circle(0, 0, 0.5)] });
  return doc;
}

function dim(): DimensionEntity {
  return {
    type: 'DIMENSION',
    ...base('DM'),
    block: '*D1',
    dimStyle: 'Standard',
    dimType: 32,
    defPoint: P(10, 3),
    textMid: P(5, 3.6),
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
}

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
      leaders: [{ lastLeaderPoint: P(10, 5), doglegVector: P(1, 0), doglegLength: 2, hasLastPoint: true, hasDogleg: true, lines: [{ vertices: [P(0, 0)], index: 0 }], index: 0, attachmentDirection: 0 }],
      text: { text: 'Note', location: P(13, 6), direction: P(1, 0), normal: P(0, 0, 1), rotation: 0, width: 0, height: 0, lineSpacingFactor: 1, lineSpacingStyle: 1, color: { aci: 256 }, attachment: 1, flowDirection: 1, backgroundFill: false, backgroundScale: 1.5 },
      basePoint: P(12, 5),
      baseDirection: P(1, 0),
      baseVertical: P(0, 1),
      normal: P(0, 0, 1),
    },
  };
}

function hatch(): HatchEntity {
  return {
    type: 'HATCH',
    ...base('HT'),
    patternName: 'ANSI31',
    solid: false,
    associative: false,
    hatchStyle: 0,
    patternType: 1,
    patternAngle: 0,
    patternScale: 1,
    patternDouble: false,
    elevation: 0,
    paths: [
      { flags: 3, polyline: { closed: true, vertices: [{ x: 0, y: 0, bulge: 0 }, { x: 10, y: 0, bulge: 0.4 }, { x: 10, y: 10, bulge: 0 }, { x: 0, y: 10, bulge: 0 }] } },
      {
        flags: 0,
        edges: [
          { type: 'line', start: V(2, 2), end: V(4, 2) },
          { type: 'arc', center: V(4, 3), radius: 1, startAngle: -Math.PI / 2, endAngle: Math.PI / 2, ccw: true },
          { type: 'line', start: V(4, 4), end: V(2, 4) },
          { type: 'ellipse', center: V(2, 3), majorAxis: V(0, 1), ratio: 0.5, startAngle: 0, endAngle: Math.PI, ccw: true },
        ],
      },
    ],
    patternLines: [{ angle: deg(45), base: V(0, 0), offset: V(-2.245, 2.245), dashes: [] }],
    pixelSize: 0,
    seedPoints: [V(5, 5)],
  };
}

const others = (): [string, Entity][] => [
  ['점', { type: 'POINT', ...base('PT'), position: P(1, 2), angle: 0 } as PointEntity],
  ['치수', dim()],
  ['지시선', { type: 'LEADER', ...base('LD'), dimStyle: 'Standard', vertices: [P(0, 0), P(5, 5), P(10, 5)], arrowHead: true, pathType: 0, creation: 3, hooklineDirection: 0, hookline: false, textHeight: 2, textWidth: 5 } as LeaderEntity],
  ['다중 지시선', mleader()],
  ['해치', hatch()],
  ['솔리드(−Z)', { type: 'SOLID', ...base('SO'), points: [P(0, 0), P(4, 0), P(0, 3), P(4, 3)], invisibleEdges: 0, extrusion: NEG_Z } as FaceEntity],
  ['3D 면', { type: '3DFACE', ...base('3F'), points: [P(0, 0, 1), P(4, 0, 1), P(4, 3, 2), P(0, 3, 2)], invisibleEdges: 0 } as FaceEntity],
  ['이미지', { type: 'IMAGE', ...base('IM'), insert: P(1, 1), uVector: P(0.1, 0), vVector: P(0, 0.1), imageSize: V(100, 50), displayFlags: 1, clipping: false, brightness: 50, contrast: 50, fade: 0, clipBoundaryType: 1, clipBoundary: [] } as ImageEntity],
  ['여러 줄', { type: 'MLINE', ...base('MLN'), styleName: 'Standard', scale: 1, justification: 1, flags: 1, startPoint: P(0, 0), normal: P(0, 0, 1), elementCount: 2, vertices: [P(0, 0), P(10, 0), P(10, 10)].map((p, i) => ({ position: p, direction: i < 2 ? P(1, 0) : P(0, 1), miter: i === 1 ? P(-Math.SQRT1_2, Math.SQRT1_2) : i === 0 ? P(0, 1) : P(-1, 0), elements: [{ params: [i === 1 ? 0.5 * Math.SQRT2 : 0.5, 0], fillParams: [] }, { params: [i === 1 ? -0.5 * Math.SQRT2 : -0.5, 0], fillParams: [] }] })) } as MLineEntity],
  ['공차', { type: 'TOLERANCE', ...base('TO'), dimStyle: 'Standard', insert: P(2, 2), text: '{\\Fgdt;j}%%v0.1', direction: P(1, 0) } as ToleranceEntity],
  ['메시', { type: 'MESH', ...base('MS'), vertices: [P(0, 0), P(1, 0), P(1, 1)], faces: [[0, 1, 2]], edges: [], subdivision: 0 } as MeshEntity],
  ['표', { type: 'ACAD_TABLE', ...base('TB'), block: '*T1', insert: P(3, 3), direction: P(1, 0), scale: P(1, 1, 1), rotation: 0, rows: 1, columns: 1, rowHeights: [5], columnWidths: [20] } as TableEntity],
  ['3D 폴리선', { type: 'POLYLINE', ...base('P3'), kind: '3d', flags: 8, vertices: [P(0, 0, 0), P(5, 0, 1), P(5, 5, 2)].map((location) => ({ location, bulge: 0, startWidth: 0, endWidth: 0, flags: 32 })), elevation: 0, defaultStartWidth: 0, defaultEndWidth: 0, mCount: 0, nCount: 0, mDensity: 0, nDensity: 0, smoothType: 0 } as PolylineEntity],
  ['블록 참조(속성, −Z)', { type: 'INSERT', ...base('IN'), block: 'B', insert: P(3, 1), scale: P(2, 1.5, 1), rotation: deg(20), columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0, extrusion: NEG_Z, attribs: [{ ...(text(3, 2, 'V', 1) as TextEntity), type: 'ATTRIB', handle: 'AT', tag: 'T', attFlags: 0, extrusion: NEG_Z } as AttribEntity] } as InsertEntity],
  ['MINSERT', { type: 'INSERT', ...base('MI'), block: 'B', insert: P(0, 0), scale: P(1, 1, 1), rotation: 0, columnCount: 3, rowCount: 2, columnSpacing: 4, rowSpacing: 3, attribs: [] } as InsertEntity],
  ['모양', { type: 'SHAPE', ...base('SH'), insert: P(1, 1), size: 2, name: 'BOX', rotation: 0, widthFactor: 1, oblique: 0 } as ShapeEntity],
  ['PDF 언더레이', { type: 'PDFUNDERLAY', ...base('UN'), insert: P(1, 1), scale: P(1, 1, 1), rotation: 0, flags: 0, contrast: 50, fade: 0, clipBoundary: [V(0, 0), V(10, 5)] } as UnderlayEntity],
  ['뷰포트', { type: 'VIEWPORT', ...base('VP'), center: P(5, 5), width: 10, height: 6, status: 1, id: 2, viewCenter: V(0, 0), snapBase: V(0, 0), snapSpacing: V(1, 1), gridSpacing: V(1, 1), viewDirection: P(0, 0, 1), viewTarget: P(0, 0), lensLength: 50, frontClip: 0, backClip: 0, viewHeight: 10, snapAngle: 0, twistAngle: 0, circleSides: 100, flags: 0, frozenLayers: [], renderMode: 0, ucsPerViewport: false } as ViewportEntity],
];

describe('transformEntity — 주석·기타 객체', () => {
  for (const [mn, m] of MATS)
    for (const [cn, e] of others())
      it(`${cn} × ${mn}: 결과가 그려진다`, () => {
        const doc = makeDoc();
        const r = transformEntity(e, m, doc);
        const out = [...(r.replace ?? []), ...(r.add ?? [])];
        expect(out.length).toBe(1);
        for (const b of r.blocks ?? []) doc.blocks.set(tableKey(b.name), b);
        // 모양(SHAPE)·모형 공간 뷰포트는 그리지 않는다 — 실패 경고만 없으면 된다
        renders(doc, out, e.type === 'SHAPE' || e.type === 'VIEWPORT');
      });

  it('치수: 정의점·문자점이 옮겨지고 새 익명 블록', () => {
    const doc = makeDoc();
    const m = affMul(affTranslate(5, 5), affRotate(deg(90)));
    const r = transformEntity(dim(), m, doc);
    const d = one(r) as DimensionEntity;
    near(d.defPoint2, affApply(m, V(0, 0)));
    near(d.defPoint3, affApply(m, V(10, 0)));
    near(d.textMid, affApply(m, V(5, 3.6)));
    expect(d.rotation).toBeCloseTo(deg(90));
    expect(d.measurement).toBeCloseTo(10);
    expect(r.blocks!.length).toBe(1);
    expect(d.block).toBe(r.blocks![0]!.name);
    expect(d.block).toMatch(/^\*D\d+$/);
    expect(doc.blocks.has(tableKey(d.block))).toBe(false);
    const l = r.blocks![0]!.entities[2] as { start: { x: number; y: number } };
    near(l.start, affApply(m, V(0, 3)));
    // 축척은 측정값과 숫자 문자도
    const s = transformEntity(dim(), affScale(2), doc);
    expect((one(s) as DimensionEntity).measurement).toBeCloseTo(20);
    const txt = s.blocks![0]!.entities.find((e) => e.type === 'MTEXT') as { text: string };
    expect(txt.text).toContain('20');
  });
  it('해치: 경로·무늬·씨앗점, 대칭은 무늬 방향 유지(MIRRHATCH 0)', () => {
    const doc = makeDoc();
    const mir = affMirror(V(0, 0), V(0, 1));
    const h = one(transformEntity(hatch(), mir, doc)) as HatchEntity;
    expect(h.patternLines[0]!.angle).toBeCloseTo(deg(45));
    near(h.seedPoints[0]!, V(-5, 5));
    near(h.paths[0]!.polyline!.vertices[1]!, V(-10, 0));
    expect(h.paths[0]!.polyline!.vertices[1]!.bulge).toBeCloseTo(-0.4);
    const h2 = one(transformEntity(hatch(), mir, doc, { mirrorHatch: true })) as HatchEntity;
    expect(h2.patternLines[0]!.angle).toBeCloseTo(deg(135));
    const rot = one(transformEntity(hatch(), affRotate(deg(30)), doc)) as HatchEntity;
    expect(rot.patternLines[0]!.angle).toBeCloseTo(deg(75));
    const sc = one(transformEntity(hatch(), affScale(2), doc)) as HatchEntity;
    expect(sc.patternScale).toBeCloseTo(2);
    expect(Math.hypot(sc.patternLines[0]!.offset.x, sc.patternLines[0]!.offset.y)).toBeCloseTo(2 * Math.hypot(2.245, 2.245));
    // 비균등: 볼록도 경로 → 모서리 경로(타원)
    const nu = one(transformEntity(hatch(), affScale(2, 1), doc)) as HatchEntity;
    expect(nu.paths[0]!.edges!.some((e) => e.type === 'ellipse')).toBe(true);
  });
  it('다중 지시선: 점·문자 방향, 대칭은 읽을 수 있게', () => {
    const doc = makeDoc();
    const r = one(transformEntity(mleader(), affRotate(deg(90)), doc)) as MLeaderEntity;
    near(r.context.leaders[0]!.lines[0]!.vertices[0]!, P(0, 0));
    near(r.context.leaders[0]!.lastLeaderPoint!, P(-5, 10));
    expect(r.context.text!.direction.y).toBeCloseTo(1);
    const m = one(transformEntity(mleader(), affMirror(V(0, 0), V(0, 1)), doc)) as MLeaderEntity;
    expect(m.context.text!.direction.x).toBeCloseTo(1);
    near(m.context.leaders[0]!.lastLeaderPoint!, P(-10, 5));
  });
  it('블록 참조: −Z 참조를 옮기면 같은 모양, 속성도', () => {
    const doc = makeDoc();
    const e = others().find(([n]) => n.startsWith('블록 참조'))![1] as InsertEntity;
    const r = one(transformEntity(e, affTranslate(1, 2), doc)) as InsertEntity;
    expect(r.attribs.length).toBe(1);
    renders(doc, [r]);
  });
  it('뷰포트·이미지·점', () => {
    const doc = makeDoc();
    const vp = others().find(([n]) => n === '뷰포트')![1] as ViewportEntity;
    const r = one(transformEntity(vp, affScale(2, 2, V(0, 0)), doc)) as ViewportEntity;
    expect(r.width).toBeCloseTo(20);
    near(r.center, P(10, 10));
    const im = others().find(([n]) => n === '이미지')![1] as ImageEntity;
    const ri = one(transformEntity(im, affRotate(deg(90)), doc)) as ImageEntity;
    near(ri.uVector, P(0, 0.1));
    near(ri.insert, P(-1, 1));
    const pt = one(transformEntity(others()[0]![1], affTranslate(1, 1), doc)) as PointEntity;
    near(pt.position, P(2, 3));
  });
  it('복사: 치수의 복사본은 새 블록을 쓰고 원본 블록은 그대로', () => {
    const doc = makeDoc();
    const r = copyEntity(dim(), affTranslate(0, 20), doc);
    expect(r.add![0]!.handle).toBe('');
    expect((r.add![0] as DimensionEntity).block).not.toBe('*D1');
    expect(doc.blocks.get('*D1')!.entities.length).toBe(4);
  });
  it('변환 후 역변환 = 원래(속성 시험, 정의점)', () => {
    const doc = makeDoc();
    for (const [, m] of MATS.filter(([n]) => n !== '비균등')) {
      const inv = affInv(m)!;
      const d0 = dim();
      const d1 = one(transformEntity(one(transformEntity(d0, m, doc)), inv, doc)) as DimensionEntity;
      for (const k of ['defPoint', 'defPoint2', 'defPoint3', 'textMid'] as const) near(d1[k], d0[k], 1e-9);
      const l0 = others()[2]![1] as LeaderEntity;
      const l1 = one(transformEntity(one(transformEntity(l0, m, doc)), inv, doc)) as LeaderEntity;
      l0.vertices.forEach((v, i) => near(l1.vertices[i]!, v, 1e-9));
      const h0 = hatch();
      const h1 = one(transformEntity(one(transformEntity(h0, m, doc)), inv, doc)) as HatchEntity;
      h0.paths[0]!.polyline!.vertices.forEach((v, i) => {
        near(h1.paths[0]!.polyline!.vertices[i]!, v, 1e-9);
        expect(h1.paths[0]!.polyline!.vertices[i]!.bulge).toBeCloseTo(v.bulge, 9);
      });
      expect(h1.patternLines[0]!.angle).toBeCloseTo(h0.patternLines[0]!.angle, 9);
    }
  });
});
