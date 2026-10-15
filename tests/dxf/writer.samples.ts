/**
 * 쓰기 검증용 표본 객체: 새 도면에 흔한 객체를 종류마다 하나씩 넣는다.
 * (편집 명령이 만드는 객체처럼 모델 값만 채우고, 핸들 일부는 비워 두어 쓰기가 붙이게 한다.)
 */
import type { AttribEntity, BlockDef, CadDocument, DictionaryObject, Entity, HatchEntity, ImageDefObject, MLeaderEntity } from '../../src/core/model';
import { entityDefaults, tableKey } from '../../src/core/model';
import { finalizeDocument } from '../../src/core/finalize';
import { packLw } from '../../src/core/lwpoly';

/** 문서의 $HANDSEED에서 핸들을 하나씩(편집 세션과 같은 방식) */
function handles(doc: CadDocument): () => string {
  return () => {
    const seed = BigInt('0x' + String(doc.header.get('$HANDSEED')));
    doc.header.set('$HANDSEED', (seed + 1n).toString(16).toUpperCase());
    return seed.toString(16).toUpperCase();
  };
}

const p = (x: number, y: number, z = 0) => ({ x, y, z });

/** 흔한 객체를 하나씩 넣는다(핸들 일부는 비워 두어 쓰기가 붙이게 한다). */
export function addSampleEntities(doc: CadDocument): void {
  const h = handles(doc);
  const model = doc.blocks.get('*MODEL_SPACE')!;
  const owner = model.recordHandle;
  const base = (type: string, handle = h()) => ({ ...entityDefaults(), type, handle, owner });
  const ents: Entity[] = [];
  const push = (e: object) => ents.push(e as Entity);

  // 도면층·선종류
  doc.layers.set('벽', { name: '벽', handle: h(), flags: 0, color: { aci: 1 }, off: false, frozen: false, locked: false, linetype: 'Continuous', lineweight: 35, plot: true, transparency: 128 });
  doc.linetypes.set('DASHED', {
    name: 'DASHED',
    handle: h(),
    flags: 0,
    description: '__ __ __',
    patternLength: 0.75,
    elements: [
      { length: 0.5, flags: 0, scale: 1, rotation: 0, offset: { x: 0, y: 0 } },
      { length: -0.25, flags: 0, scale: 1, rotation: 0, offset: { x: 0, y: 0 } },
    ],
  });

  push({ ...base('LINE'), layer: '벽', linetype: 'DASHED', color: { aci: 3, rgb: 0x112233 }, lineweight: 50, transparency: 77, start: p(0, 0), end: p(100, 50) });
  push({ ...base('LINE', ''), start: p(0, 10), end: p(10, 10) });
  push({ ...base('POINT'), position: p(5, 5), angle: 0 });
  push({ ...base('CIRCLE'), center: p(50, 50), radius: 10 });
  push({ ...base('ARC'), center: p(80, 50), radius: 10, startAngle: 0.25, endAngle: 2.5 });
  push({ ...base('ELLIPSE'), center: p(120, 50), majorAxis: p(20, 5), ratio: 0.4, startParam: 0, endParam: Math.PI * 1.5 });
  push({
    ...base('LWPOLYLINE'),
    ...packLw([
      { x: 0, y: 0, bulge: 0, startWidth: 0, endWidth: 0 },
      { x: 10, y: 0, bulge: 0.5, startWidth: 0, endWidth: 0 },
      { x: 10, y: 10, bulge: 0, startWidth: 1, endWidth: 2 },
    ]),
    closed: true,
    plinegen: false,
    constantWidth: 0,
    elevation: 0,
  });
  const pv = (x: number, y: number, z = 0, flags = 0) => ({ location: p(x, y, z), bulge: 0, startWidth: 0, endWidth: 0, flags });
  const poly = { defaultStartWidth: 0, defaultEndWidth: 0, mCount: 0, nCount: 0, mDensity: 0, nDensity: 0, smoothType: 0, elevation: 0 };
  push({ ...base('POLYLINE'), ...poly, kind: '2d', flags: 0, vertices: [pv(0, 20), pv(10, 25), pv(20, 20)] });
  push({ ...base('POLYLINE'), ...poly, kind: '3d', flags: 8, vertices: [pv(0, 30, 1), pv(10, 35, 2), pv(20, 30, 3)] });
  push({ ...base('POLYLINE'), ...poly, kind: 'mesh', flags: 16, mCount: 2, nCount: 2, vertices: [pv(0, 0, 0), pv(0, 1, 0), pv(1, 0, 1), pv(1, 1, 1)] });
  push({
    ...base('POLYLINE'),
    ...poly,
    kind: 'polyface',
    flags: 64,
    mCount: 3,
    nCount: 1,
    vertices: [pv(0, 0, 0, 192), pv(1, 0, 0, 192), pv(0, 1, 0, 192), { ...pv(0, 0, 0, 128), faceIndices: [1, 2, 3] }],
  });
  push({
    ...base('SPLINE'),
    flags: 8,
    degree: 3,
    knots: [0, 0, 0, 0, 1, 1, 1, 1],
    controlPoints: [p(0, 0), p(10, 20), p(20, -20), p(30, 0)],
    fitPoints: [],
    knotTolerance: 1e-10,
    controlTolerance: 1e-10,
    fitTolerance: 1e-10,
  });
  push({ ...base('SPLINE'), flags: 8, degree: 3, knots: [], controlPoints: [], fitPoints: [p(0, 0), p(5, 5), p(10, 0)], knotTolerance: 1e-10, controlTolerance: 1e-10, fitTolerance: 1e-10 });
  push({ ...base('XLINE'), base: p(0, 0), direction: p(1, 0) });
  push({ ...base('RAY'), base: p(0, 0), direction: p(0, 1) });
  const text = { height: 2.5, rotation: 0, widthFactor: 1, oblique: 0, style: 'Standard', generation: 0 };
  push({ ...base('TEXT'), ...text, insert: p(0, -10), text: '왼쪽 기준선 ABC', halign: 0, valign: 0 });
  push({ ...base('TEXT'), ...text, insert: p(0, -15), alignPoint: p(20, -15), text: '가운데', halign: 1, valign: 2 });
  push({ ...base('TEXT'), ...text, insert: p(0, -20), alignPoint: p(40, -20), text: 'Aligned', halign: 3, valign: 0 });
  push({ ...base('TEXT'), ...text, insert: p(0, -25), alignPoint: p(40, -25), text: 'Fit', halign: 5, valign: 0, rotation: 0.3 });
  const long = '긴 여러 줄 문자 '.repeat(40) + '\\P두 번째 문단 {\\fArial|b1;굵게} ' + 'x'.repeat(300);
  push({
    ...base('MTEXT'),
    insert: p(0, -40),
    height: 2.5,
    width: 80,
    attachment: 1,
    drawingDirection: 1,
    text: long,
    style: 'Standard',
    rotation: 0,
    lineSpacingStyle: 1,
    lineSpacingFactor: 1,
    backgroundFlags: 1,
    backgroundColor: { aci: 2 },
    backgroundScale: 1.5,
  });
  push({ ...base('SOLID'), points: [p(0, 0), p(5, 0), p(0, 5), p(5, 5)], invisibleEdges: 0 });
  push({ ...base('TRACE'), points: [p(10, 0), p(15, 0), p(10, 5), p(15, 5)], invisibleEdges: 0 });
  push({ ...base('3DFACE'), points: [p(0, 0, 1), p(5, 0, 1), p(5, 5, 2), p(0, 5, 2)], invisibleEdges: 2 });

  // 블록 + 속성
  const blkRec = h();
  const attdef: AttribEntity = {
    ...entityDefaults(),
    type: 'ATTDEF',
    handle: h(),
    owner: blkRec,
    ...text,
    insert: p(0, 0),
    text: '기본값',
    halign: 0,
    valign: 0,
    tag: '번호',
    prompt: '번호를 입력',
    attFlags: 0,
  };
  const blk: BlockDef = {
    name: '문',
    handle: h(),
    recordHandle: blkRec,
    basePoint: p(0, 0),
    flags: 2,
    layer: '0',
    endHandle: h(),
    entities: [{ ...entityDefaults(), type: 'LINE', handle: h(), owner: blkRec, start: p(0, 0), end: p(10, 0) } as Entity, attdef],
  };
  doc.blocks.set(tableKey(blk.name), blk);
  doc.blockRecords.set(tableKey(blk.name), { name: blk.name, handle: blkRec, flags: 0, insertUnits: 4, explodable: true, scalable: true });
  const ins = { ...base('INSERT'), block: '문', insert: p(30, 30), scale: p(2, 2, 1), rotation: 0.5, columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0, attribs: [] as AttribEntity[] };
  ins.attribs.push({ ...attdef, type: 'ATTRIB', handle: h(), owner: ins.handle, text: '12', insert: p(30, 30) });
  push(ins);
  push({ ...base('INSERT'), block: '문', insert: p(60, 30), scale: p(1, 1, 1), rotation: 0, columnCount: 3, rowCount: 2, columnSpacing: 15, rowSpacing: 10, attribs: [] });

  // 치수(그림 블록은 없음 → 쓰기가 빈 익명 블록을 만든다)
  const dim = {
    block: '',
    dimStyle: String(doc.header.get('$DIMSTYLE') ?? 'Standard'),
    textMid: p(50, 75),
    defPoint2: p(0, 70),
    defPoint3: p(100, 70),
    defPoint4: p(0, 0),
    defPoint5: p(0, 0),
    text: '',
    measurement: 100,
    rotation: 0,
    obliqueAngle: 0,
    textRotation: 0,
    horizontalDirection: 0,
    attachment: 5,
    leaderLength: 0,
    lineSpacingStyle: 1,
    lineSpacingFactor: 1,
  };
  push({ ...base('DIMENSION'), ...dim, dimType: 32, defPoint: p(100, 80), overrides: { 140: 3.5, 178: 1 } });
  push({ ...base('DIMENSION'), ...dim, dimType: 33, defPoint: p(100, 85) });
  push({ ...base('DIMENSION'), ...dim, dimType: 36, defPoint: p(50, 50), defPoint4: p(60, 50), leaderLength: 0 });
  push({
    ...base('DIMENSION'),
    ...dim,
    subtype: 'ARC_DIMENSION',
    dimType: 37,
    defPoint: p(80, 65),
    arc: { center: p(80, 50), start: p(90, 50), end: p(80, 60), startAngle: 0, endAngle: Math.PI / 2, partial: false },
  });
  push({ ...base('LEADER'), dimStyle: 'Standard', vertices: [p(0, 0), p(10, 10), p(20, 10)], arrowHead: true, pathType: 0, creation: 3, hooklineDirection: 0, hookline: false, textHeight: 2.5, textWidth: 0 });
  const ml: MLeaderEntity = {
    ...(base('MULTILEADER') as unknown as MLeaderEntity),
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
    blockScale: p(1, 1, 1),
    blockRotation: 0,
    blockConnection: 0,
    scale: 1,
    context: {
      scale: 1,
      contentBase: p(40, 110),
      textHeight: 4,
      arrowSize: 4,
      landingGap: 2,
      leaders: [
        {
          lastLeaderPoint: p(38, 110),
          doglegVector: p(1, 0),
          doglegLength: 8,
          hasLastPoint: true,
          hasDogleg: true,
          index: 0,
          attachmentDirection: 0,
          lines: [{ vertices: [p(20, 90)], index: 0 }],
        },
      ],
      text: {
        text: '지시선 문자',
        location: p(40, 112),
        direction: p(1, 0),
        normal: p(0, 0, 1),
        rotation: 0,
        width: 0,
        height: 4,
        lineSpacingFactor: 1,
        lineSpacingStyle: 1,
        color: { aci: 256 },
        attachment: 1,
        flowDirection: 1,
        backgroundFill: false,
        backgroundScale: 1.5,
      },
      basePoint: p(40, 110),
      baseDirection: p(1, 0),
      baseVertical: p(0, 1),
      normal: p(0, 0, 1),
    },
  };
  push(ml);

  // 해치: 폴리선 경계 + 모서리 경계(반시계·시계 호, 타원, 스플라인), 무늬·그라데이션
  const hatchBase = { patternType: 1, patternAngle: 0, patternScale: 1, patternDouble: false, elevation: 0, pixelSize: 0, seedPoints: [], associative: false, hatchStyle: 0 };
  push({
    ...base('HATCH'),
    ...hatchBase,
    patternName: 'SOLID',
    solid: true,
    patternLines: [],
    paths: [{ flags: 3, polyline: { closed: true, vertices: [ { x: 0, y: 0, bulge: 0 }, { x: 10, y: 0, bulge: 1 }, { x: 10, y: 10, bulge: 0 } ] } }],
  } as HatchEntity);
  push({
    ...base('HATCH'),
    ...hatchBase,
    patternName: 'ANSI31',
    solid: false,
    patternAngle: 0,
    patternScale: 2,
    patternLines: [{ angle: Math.PI / 4, base: { x: 0, y: 0 }, offset: { x: -2.2, y: 2.2 }, dashes: [] }],
    paths: [
      {
        flags: 1,
        edges: [
          { type: 'line', start: { x: 0, y: 0 }, end: { x: 20, y: 0 } },
          { type: 'arc', center: { x: 20, y: 10 }, radius: 10, startAngle: -Math.PI / 2, endAngle: Math.PI / 2, ccw: true },
          { type: 'line', start: { x: 20, y: 20 }, end: { x: 0, y: 20 } },
          { type: 'arc', center: { x: 0, y: 10 }, radius: 10, startAngle: -Math.PI / 2, endAngle: Math.PI / 2, ccw: false },
        ],
      },
      {
        flags: 0,
        edges: [
          { type: 'ellipse', center: { x: 10, y: 10 }, majorAxis: { x: 4, y: 0 }, ratio: 0.5, startAngle: 0, endAngle: Math.PI * 2, ccw: true },
        ],
      },
      {
        flags: 0,
        edges: [
          { type: 'spline', degree: 3, rational: false, periodic: false, knots: [0, 0, 0, 0, 1, 1, 1, 1], controlPoints: [ { x: 30, y: 0 }, { x: 35, y: 5 }, { x: 40, y: -5 }, { x: 45, y: 0 } ] },
          { type: 'line', start: { x: 45, y: 0 }, end: { x: 30, y: 0 } },
        ],
      },
    ],
  } as HatchEntity);
  push({
    ...base('HATCH'),
    ...hatchBase,
    patternName: 'SOLID',
    solid: true,
    patternLines: [],
    gradient: { enabled: true, name: 'LINEAR', color1: { aci: 5, rgb: 0x0000ff }, color2: { aci: 2, rgb: 0xffff00 }, singleColor: false, tint: 0, angle: 0, shift: 0 },
    paths: [{ flags: 1, polyline: { closed: true, vertices: [ { x: 50, y: 0, bulge: 0 }, { x: 60, y: 0, bulge: 0 }, { x: 60, y: 10, bulge: 0 } ] } }],
  } as HatchEntity);

  // 이미지·와이프아웃
  const imgDefH = h();
  const imgDictH = h();
  const root = doc.objects.get(doc.rootDictionary!) as DictionaryObject;
  root.entries.set('ACAD_IMAGE_DICT', imgDictH);
  doc.objects.set(imgDictH, { type: 'DICTIONARY', handle: imgDictH, owner: root.handle, reactors: [root.handle], entries: new Map([['photo', imgDefH]]), hardOwner: false, cloning: 1 } as DictionaryObject);
  doc.objects.set(imgDefH, { type: 'IMAGEDEF', handle: imgDefH, owner: imgDictH, reactors: [imgDictH], fileName: 'photo.png', imageSize: { x: 640, y: 480 }, pixelSize: { x: 1, y: 1 }, loaded: true, resolutionUnits: 0 } as ImageDefObject);
  const img = { insert: p(200, 0), uVector: p(0.1, 0), vVector: p(0, 0.1), imageSize: { x: 640, y: 480 }, displayFlags: 7, clipping: false, brightness: 50, contrast: 50, fade: 0, clipBoundaryType: 1, clipBoundary: [] };
  push({ ...base('IMAGE'), ...img, imageDef: imgDefH });
  push({ ...base('WIPEOUT'), ...img, insert: p(300, 0), uVector: p(10, 0), vVector: p(0, 10), imageSize: { x: 1, y: 1 }, clipBoundary: [ { x: -0.5, y: -0.5 }, { x: 0.5, y: -0.5 }, { x: 0, y: 0.5 }, { x: -0.5, y: -0.5 } ], clipBoundaryType: 2 });

  // 다중선·공차·메시·나선·표(그림 블록 없음)·OLE·ACIS(자료 없음 → 빠진다)
  push({
    ...base('MLINE'),
    styleName: 'Standard',
    scale: 1,
    justification: 0,
    flags: 1,
    startPoint: p(0, 200),
    normal: p(0, 0, 1),
    elementCount: 2,
    vertices: [
      { position: p(0, 200), direction: p(1, 0), miter: p(0, 1), elements: [ { params: [0.5, 0], fillParams: [] }, { params: [-0.5, 0], fillParams: [] } ] },
      { position: p(50, 200), direction: p(1, 0), miter: p(0, 1), elements: [ { params: [0.5, 0], fillParams: [] }, { params: [-0.5, 0], fillParams: [] } ] },
    ],
  });
  push({ ...base('TOLERANCE'), dimStyle: 'Standard', insert: p(0, 250), text: '{\\Fgdt;j}%%v0.1%%v', direction: p(1, 0) });
  push({ ...base('MESH'), vertices: [p(0, 0), p(1, 0), p(1, 1), p(0, 1), p(0.5, 0.5, 1)], faces: [[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]], edges: [], subdivision: 0 });
  push({
    ...base('SPLINE'),
    flags: 0,
    degree: 3,
    knots: [0, 0, 0, 0, 1, 1, 1, 1],
    controlPoints: [p(10, 0, 0), p(10, 10, 1), p(-10, 10, 2), p(-10, 0, 3)],
    fitPoints: [],
    knotTolerance: 1e-10,
    controlTolerance: 1e-10,
    fitTolerance: 1e-10,
    helix: { axisBase: p(0, 0), start: p(10, 0), axis: p(0, 0, 1), radius: 10, turns: 1, turnHeight: 3, ccw: true, constrain: 1 },
  });
  push({ ...base('OLE2FRAME'), upperLeft: p(0, 10), lowerRight: p(10, 0) });
  push({ ...base('REGION') });

  model.entities.push(...ents);

  // 종이 공간 뷰포트(전체 + 모형 창)
  const ps = doc.blocks.get('*PAPER_SPACE')!;
  const vp = (id: number, w: number, hgt: number) => ({
    ...entityDefaults(),
    type: 'VIEWPORT',
    handle: h(),
    owner: ps.recordHandle,
    paperSpace: true,
    center: p(210, 148.5),
    width: w,
    height: hgt,
    status: id,
    id,
    viewCenter: { x: 50, y: 50 },
    snapBase: { x: 0, y: 0 },
    snapSpacing: { x: 10, y: 10 },
    gridSpacing: { x: 10, y: 10 },
    viewDirection: p(0, 0, 1),
    viewTarget: p(0, 0, 0),
    lensLength: 50,
    frontClip: 0,
    backClip: 0,
    viewHeight: hgt,
    snapAngle: 0,
    twistAngle: 0,
    circleSides: 1000,
    flags: 32864,
    frozenLayers: id === 2 ? ['벽'] : [],
    renderMode: 0,
    ucsPerViewport: true,
  });
  ps.entities.push(vp(1, 420, 297) as Entity, vp(2, 380, 250) as Entity);
  finalizeDocument(doc);
}
