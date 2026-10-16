/**
 * 저장 왕복: 주석 편집이 새로 쓰는 값 — 편집기가 만든 MTEXT 서식(굵게·글머리 기호 내어쓰기·탭 정지·필드 없는 서식),
 * MTEXT 정적 열·줄 간격 정확하게·부착점, TEXT 자리맞추기(중간 중심), 치수 문자 각도·재지정(문자 높이), 부분 호 길이 치수,
 * 문자 스타일의 트루타입 굵게·기울임과 거꾸로·반대로, 머리말 치수 변수(<스타일 재지정>), 다중 지시선(내용 폭·중간 점·내용 없음).
 * DXF R2018·R2000과 DWG R2018·R2000에 써서 다시 읽은 값이 같아야 한다.
 */
import { describe, expect, it } from 'vitest';
import type { BlockDef, CadDocument, DimensionEntity, Entity, MLeaderEntity, MTextEntity, TextEntity } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults, tableKey } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { createArcLengthDimension, createLinearDimension, generateDimensionGeometry, nextDimBlockName } from '../../src/edit/dim';
import { applyOverrides } from '../../src/edit/annot/override';
import { type EditOp, EditSession } from '../../src/edit/session';
import { writeDxf } from '../../src/io/dxf/writer';
import { writeDwg } from '../../src/io/dwg/writer/index';
import { readCadFile } from '../../src/io/index';
import { makeMLeader } from '../../src/app/annotate';
import type { App } from '../../src/app/app';
import { mtextMeaning } from '../../src/text/mtextedit';
import { withFontStyle } from '../../src/app/textedit/styledlg';
import { decodeCadEscapes } from '../../src/core/codepage';

const P = (x: number, y: number) => ({ x, y, z: 0 });
const FORMATTED = '{\\fArial|b1|i0|c0|p34;굵게} 보통\\P\\pxi-3.75,l3.75,t3.75;•^I항목 하나\\P•^I항목 둘\\P\\pxi0,l0,qc;{\\C1;\\L가운데}';

function build(): { doc: CadDocument; h: Record<string, string> } {
  const doc = createNewDocument('metric');
  const s = new EditSession(doc, () => {});
  const ms = doc.blocks.get(MODEL_SPACE)!;
  const h: Record<string, string> = {};
  const add = (k: string, e: Entity) => {
    e.handle ||= s.newHandle();
    e.owner = ms.recordHandle;
    s.commit({ label: 'ADD', ops: [{ kind: 'add', block: MODEL_SPACE, entity: e }] });
    h[k] = e.handle;
  };
  const addDim = (k: string, d: DimensionEntity) => {
    const g = generateDimensionGeometry(doc, d);
    d.measurement = g.measurement;
    d.textMid = g.textMid;
    const name = nextDimBlockName(doc);
    const key = tableKey(name);
    const rh = s.newHandle();
    for (const e of g.entities) {
      e.handle = s.newHandle();
      e.owner = rh;
    }
    const def: BlockDef = { name, handle: s.newHandle(), recordHandle: rh, basePoint: P(0, 0), flags: 1, entities: g.entities, endHandle: s.newHandle() };
    const ops: EditOp[] = [
      { kind: 'blockRecord', key, before: null, after: { name, handle: rh, flags: 1, insertUnits: 0, explodable: true, scalable: true } },
      { kind: 'blockDef', key, before: null, after: def },
    ];
    d.block = name;
    d.handle = s.newHandle();
    d.owner = ms.recordHandle;
    ops.push({ kind: 'add', block: MODEL_SPACE, entity: d });
    s.commit({ label: 'DIM', ops });
    h[k] = d.handle;
  };
  // 편집기가 만든 서식 + 정적 열 + 줄 간격 정확하게 + 중간 중심
  add('mtext', {
    ...entityDefaults(),
    type: 'MTEXT',
    handle: '',
    insert: P(0, 100),
    height: 2.5,
    width: 40,
    attachment: 5,
    drawingDirection: 1,
    text: FORMATTED,
    style: 'Standard',
    rotation: 0,
    lineSpacingStyle: 2,
    lineSpacingFactor: 1.5,
    backgroundFlags: 0,
    backgroundScale: 1.5,
    columns: { type: 1, count: 2, width: 40, gutter: 12.5, autoHeight: false, flowReversed: false, heights: [20] },
    rectHeight: 20,
  } as MTextEntity);
  // TEXT 자리맞추기 MC
  add('text', { ...entityDefaults(), type: 'TEXT', handle: '', insert: P(10, 10), alignPoint: P(10, 10), height: 3, text: '%%c20 가운데', rotation: 0, widthFactor: 1, oblique: 0, style: 'Standard', generation: 0, halign: 1, valign: 2 } as TextEntity);
  // 치수 문자 각도 + 재지정(DIMTXT)
  let d = createLinearDimension(doc, P(0, 0), P(60, 0), P(30, 15));
  d.textRotation = Math.PI / 6;
  d = applyOverrides(d, { 140: 5 });
  d.text = '<> TYP';
  addDim('dim', d);
  // 부분 호 길이
  const a = createArcLengthDimension(doc, P(100, 0), 20, 0.2, 1.2, P(125, 15));
  a.arc!.partial = true;
  addDim('arc', a);
  // 다중 지시선: 내용 폭·중간 점, 내용 없음
  const fake = { active: { doc }, text: { layoutMText: () => ({ minY: -2.5, maxY: 0 }) } } as unknown as App;
  const ml = makeMLeader(fake, P(0, -40), P(20, -30), '메모', 2.5, { lineType: 1, landing: true, doglegLength: 4 }, { text: '메모', width: 30, vertices: [P(10, -32)] });
  add('ml', ml);
  const none = makeMLeader(fake, P(50, -40), P(60, -30), '', 2.5, { lineType: 1, landing: false, doglegLength: 0 }, {});
  add('none', none);
  // 문자 스타일: 트루타입 굵은 기울임 + 거꾸로·반대로
  const ts = { name: 'Bold', handle: s.newHandle(), flags: 0, height: 0, widthFactor: 0.9, oblique: 0, generation: 6, lastHeight: 2.5, font: 'arial.ttf', bigFont: '', fontFamily: 'Arial', fontFlags: 34 };
  s.commit({ label: 'STYLE', ops: [{ kind: 'textStyle', key: 'BOLD', before: null, after: withFontStyle(ts, 3) }] });
  // <스타일 재지정>: 머리말 치수 변수
  s.commit({ label: 'DIMSTYLE', ops: [{ kind: 'header', name: '$DIMTXT', before: doc.header.get('$DIMTXT'), after: 3.5 }] });
  return { doc, h };
}

const FORMATS: [string, (doc: CadDocument) => CadDocument][] = [
  ['DXF R2018', (doc) => readCadFile(writeDxf(doc, { version: 'AC1032' }).data, 'x.dxf')],
  ['DXF R2000', (doc) => readCadFile(writeDxf(doc, { version: 'AC1015' }).data, 'x.dxf')],
  ['DWG R2018', (doc) => readCadFile(writeDwg(doc, { version: 'AC1032' }).data, 'x.dwg')],
  ['DWG R2000', (doc) => readCadFile(writeDwg(doc, { version: 'AC1015' }).data, 'x.dwg')],
];

describe('주석 편집 값의 저장 왕복', () => {
  const { doc, h } = build();
  for (const [name, back] of FORMATS) {
    it(name, () => {
      const r = back(doc);
      const m = r.entityIndex.get(h.mtext!) as MTextEntity;
      expect(mtextMeaning(m.text, 2.5, 5)).toEqual(mtextMeaning(FORMATTED, 2.5, 5));
      expect(m).toMatchObject({ attachment: 5, lineSpacingStyle: 2, width: 40 });
      expect(m.lineSpacingFactor).toBeCloseTo(1.5, 6);
      // 열은 R2018에만(그 전 버전은 한 열로 쓰고 경고)
      if (name.includes('R2018')) expect(m.columns).toMatchObject({ type: 1, count: 2 });
      const t = r.entityIndex.get(h.text!) as TextEntity;
      // R2007 이전 DXF는 한글을 \U+로 쓰고 리더는 그대로 둔다(편집 모델은 둘 다 같은 글자로 읽는다)
      expect(decodeCadEscapes(t.text)).toBe('%%c20 가운데');
      expect(t).toMatchObject({ halign: 1, valign: 2 });
      expect(t.alignPoint).toMatchObject({ x: 10, y: 10 });
      const d = r.entityIndex.get(h.dim!) as DimensionEntity;
      expect(d.textRotation).toBeCloseTo(Math.PI / 6, 6);
      expect(Number(d.overrides?.[140])).toBeCloseTo(5, 9);
      expect(d.text).toBe('<> TYP');
      const a = r.entityIndex.get(h.arc!) as DimensionEntity;
      // 호 길이 치수(ARC_DIMENSION)는 R2004부터: DXF R2000에서는 정의가 없는 치수로 돌아온다
      if (name !== 'DXF R2000') expect(a.arc?.partial).toBe(true);
      // 다중 지시선은 R2008부터: DXF R2000에는 객체가 없다
      if (name !== 'DXF R2000') {
        const ml = r.entityIndex.get(h.ml!) as MLeaderEntity;
        expect(ml.context.text?.text).toBe('메모');
        expect(ml.context.text?.width).toBeCloseTo(30, 6);
        expect(ml.context.leaders[0]!.lines[0]!.vertices.length).toBe(2);
        const none = r.entityIndex.get(h.none!) as MLeaderEntity;
        expect(none.contentType).toBe(0);
      }
      const ts = r.textStyles.get('BOLD')!;
      expect(ts.generation).toBe(6);
      expect((ts.fontFlags ?? 0) & 0x3000000).toBe(0x3000000);
      expect(Number(r.header.get('$DIMTXT'))).toBeCloseTo(3.5, 9);
    });
  }
});
