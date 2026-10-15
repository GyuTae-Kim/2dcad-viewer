/**
 * 컨텍스트 데이터 시험용 도면: 문자·여러 줄 문자·주석 블록 참조(속성)·치수 8종(선형·정렬·각도 2선·3점·반지름·지름·세로좌표·
 * 호 길이)·해치(무늬 2선, 루프 둘)·다중 지시선을 두 축척(1:10 보이는 축척, 1:20)의 주석 객체로 만든다.
 */
import type { AttribEntity, BlockDef, CadDocument, DimensionEntity, Entity, HatchEntity, MLeaderEntity } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults } from '../../src/core/model';
import { addScales, makeAnnotative, regenerateDimension, withAnnotativeFlag } from '../../src/edit/annoscale';
import {
  createAlignedDimension,
  createAngular2LineDimension,
  createAngularDimension,
  createArcLengthDimension,
  createDiameterDimension,
  createLinearDimension,
  createOrdinateDimension,
  createRadialDimension,
} from '../../src/edit/dim/create';
import type { EditOp, EditSession } from '../../src/edit/session';
import { addModel, commit, envOf, hatch, insert, mtext, newDoc, text } from './helpers';

export const SCALES = ['1:10', '1:20'];

function withBlock(doc: CadDocument, session: EditSession, d: DimensionEntity): DimensionEntity {
  const ops: EditOp[] = [];
  const out = regenerateDimension(envOf(doc, session), d, null, ops);
  session.commit({ label: 'DIM', ops });
  return out;
}

export function annotate(doc: CadDocument, session: EditSession, e: Entity, scales = SCALES): string {
  const r = makeAnnotative(envOf(doc, session), e, scales[0]!);
  commit(session, [...r.ops, { kind: 'modify', block: MODEL_SPACE, before: e, after: r.entity }]);
  const cur = doc.entityIndex.get(e.handle)!;
  const a = addScales(envOf(doc, session), cur, scales.slice(1));
  commit(session, [...a.ops, ...(a.entity !== cur ? [{ kind: 'modify' as const, block: MODEL_SPACE, before: cur, after: a.entity }] : [])]);
  return e.handle;
}

export function mleader(): MLeaderEntity {
  return {
    type: 'MULTILEADER',
    ...entityDefaults(),
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
      contentBase: { x: 220, y: 110, z: 0 },
      textHeight: 4,
      arrowSize: 4,
      landingGap: 2,
      leaders: [
        {
          lastLeaderPoint: { x: 210, y: 110, z: 0 },
          doglegVector: { x: 1, y: 0, z: 0 },
          doglegLength: 8,
          hasLastPoint: true,
          hasDogleg: true,
          lines: [{ vertices: [{ x: 200, y: 100, z: 0 }, { x: 205, y: 105, z: 0 }], index: 0, breaks: [{ start: { x: 201, y: 101, z: 0 }, end: { x: 202, y: 102, z: 0 } }] }],
          index: 0,
          attachmentDirection: 0,
        },
      ],
      text: { text: '주석 A', location: { x: 220, y: 112, z: 0 }, direction: { x: 1, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, rotation: 0, width: 0, height: 0, lineSpacingFactor: 1, lineSpacingStyle: 1, color: { aci: 0 }, attachment: 1, flowDirection: 1, backgroundFill: false, backgroundScale: 1.5 },
      basePoint: { x: 210, y: 110, z: 0 },
      baseDirection: { x: 1, y: 0, z: 0 },
      baseVertical: { x: 0, y: 1, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
    },
  };
}

/** 패턴 선 둘(대시 포함)·루프 둘(바깥 + 안쪽 섬)인 해치 */
export function hatch2(): HatchEntity {
  const h = hatch();
  h.patternName = 'ANSI32';
  h.patternLines = [
    { angle: Math.PI / 4, base: { x: 0, y: 0 }, offset: { x: -2.2450640303, y: 2.2450640303 }, dashes: [] },
    { angle: Math.PI / 4, base: { x: 0.4490128061, y: 0 }, offset: { x: -2.2450640303, y: 2.2450640303 }, dashes: [2, -1] },
  ];
  h.paths = [
    { flags: 1 | 2 | 16, polyline: { closed: true, vertices: [{ x: 0, y: 0, bulge: 0 }, { x: 100, y: 0, bulge: 0 }, { x: 100, y: 100, bulge: 0 }, { x: 0, y: 100, bulge: 0 }] } },
    { flags: 2, polyline: { closed: true, vertices: [{ x: 40, y: 40, bulge: 0 }, { x: 60, y: 40, bulge: 0 }, { x: 60, y: 60, bulge: 0 }, { x: 40, y: 60, bulge: 0 }] } },
  ];
  return h;
}

export interface CtxFixture {
  doc: CadDocument;
  session: EditSession;
  /** 종류 이름 → 핸들 */
  handles: Record<string, string>;
}

/** 모든 종류의 주석 객체를 두 축척으로 둔 도면 */
export function ctxFixture(): CtxFixture {
  const { doc, session } = newDoc('metric');
  const handles: Record<string, string> = {};
  // 주석 블록(속성 정의 하나)
  const def: BlockDef = { name: 'TAG', handle: session.newHandle(), recordHandle: session.newHandle(), basePoint: { x: 0, y: 0, z: 0 }, flags: 2, entities: [] };
  doc.blocks.set('TAG', def);
  doc.blockRecords.set('TAG', { name: 'TAG', handle: def.recordHandle, flags: 0, insertUnits: 0, explodable: true, scalable: true, xdata: withAnnotativeFlag(undefined, true) });
  handles.text = annotate(doc, session, addModel(doc, session, text(10, 20, 2.5)));
  handles.mtext = annotate(doc, session, addModel(doc, session, mtext(0, 50, 2.5, 30)));
  const ins = insert('TAG', 100, 0);
  const at: AttribEntity = { ...text(100, 0, 2.5, 'Standard', 'V1'), type: 'ATTRIB', tag: 'NO', attFlags: 0, handle: '' } as unknown as AttribEntity;
  at.handle = session.newHandle();
  ins.attribs = [at];
  handles.insert = annotate(doc, session, addModel(doc, session, ins));
  const O = { x: 0, y: 0, z: 0 };
  const dims: Record<string, DimensionEntity> = {
    linear: createLinearDimension(doc, { x: 0, y: -100, z: 0 }, { x: 100, y: -100, z: 0 }, { x: 50, y: -80, z: 0 }),
    aligned: createAlignedDimension(doc, { x: 0, y: -200, z: 0 }, { x: 80, y: -140, z: 0 }, { x: 30, y: -150, z: 0 }),
    angular2: createAngular2LineDimension(doc, { x: 300, y: 0, z: 0 }, { x: 400, y: 0, z: 0 }, { x: 300, y: 0, z: 0 }, { x: 370, y: 70, z: 0 }, { x: 360, y: 30, z: 0 }),
    angular3: createAngularDimension(doc, { x: 500, y: 0, z: 0 }, { x: 600, y: 0, z: 0 }, { x: 500, y: 100, z: 0 }, { x: 560, y: 60, z: 0 }),
    radius: createRadialDimension(doc, { x: 300, y: -300, z: 0 }, 40, Math.PI / 4),
    diameter: createDiameterDimension(doc, { x: 500, y: -300, z: 0 }, 40, Math.PI / 6),
    ordinate: createOrdinateDimension(doc, { x: 50, y: 30, z: 0 }, { x: 50, y: 90, z: 0 }),
    arc: createArcLengthDimension(doc, { x: 700, y: 0, z: 0 }, 50, 0, Math.PI / 2, { x: 750, y: 50, z: 0 }),
  };
  void O;
  for (const [k, d] of Object.entries(dims)) handles[k] = annotate(doc, session, addModel(doc, session, withBlock(doc, session, d)));
  handles.hatch = annotate(doc, session, addModel(doc, session, hatch2()));
  handles.mleader = annotate(doc, session, addModel(doc, session, mleader()));
  return { doc, session, handles };
}
