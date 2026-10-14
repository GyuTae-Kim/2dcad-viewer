/**
 * 리더가 채운 문서를 뷰어가 바로 쓸 수 있게 마무리한다.
 * DXF·DWG 리더가 모두 마지막에 부른다.
 * - 빠진 기본 표 항목(도면층 0, 선종류 ByLayer·ByBlock·Continuous, 문자 스타일 Standard)을 채운다.
 * - 모형 공간 블록과 모형 배치를 보장하고, 배치를 탭 순서로 정렬한다(모형이 처음).
 * - entityIndex(핸들 → 객체)를 만든다.
 */
import {
  type BlockDef,
  type CadDocument,
  type Entity,
  type Layout,
  type PlotSettings,
  MODEL_SPACE,
  PAPER_SPACE,
  tableKey,
  v2,
  v3,
} from './model';

export function defaultPlotSettings(): PlotSettings {
  return {
    pageSetupName: '',
    printerName: '',
    paperName: '',
    paperWidth: 297,
    paperHeight: 210,
    margins: [0, 0, 0, 0],
    plotOrigin: v2(),
    windowMin: v2(),
    windowMax: v2(),
    scaleNumerator: 1,
    scaleDenominator: 1,
    flags: 0,
    paperUnits: 1,
    rotation: 0,
    plotType: 5,
    styleSheet: '',
    standardScaleType: 16,
  };
}

export function defaultLayout(name: string, blockName: string, tabOrder: number): Layout {
  return {
    name,
    handle: '',
    tabOrder,
    blockRecord: '',
    blockName,
    flags: 0,
    limitsMin: v2(),
    limitsMax: v2(420, 297),
    insertionBase: v3(),
    extMin: v3(1e20, 1e20, 1e20),
    extMax: v3(-1e20, -1e20, -1e20),
    elevation: 0,
    ucsOrigin: v3(),
    ucsXAxis: v3(1, 0, 0),
    ucsYAxis: v3(0, 1, 0),
    plot: defaultPlotSettings(),
  };
}

function ensureBlock(doc: CadDocument, name: string): BlockDef {
  const key = tableKey(name);
  let b = doc.blocks.get(key);
  if (!b) {
    b = { name, handle: '', recordHandle: '', basePoint: v3(), flags: 0, entities: [] };
    doc.blocks.set(key, b);
  }
  return b;
}

function indexEntity(index: Map<string, Entity>, e: Entity): void {
  if (e.handle) index.set(e.handle, e);
  if (e.type === 'INSERT') for (const a of e.attribs) if (a.handle) index.set(a.handle, a);
}

export function finalizeDocument(doc: CadDocument): CadDocument {
  if (!doc.layers.has('0')) {
    doc.layers.set('0', {
      name: '0',
      handle: '',
      flags: 0,
      color: { aci: 7 },
      off: false,
      frozen: false,
      locked: false,
      linetype: 'Continuous',
      lineweight: -3,
      plot: true,
      transparency: 255,
    });
  }
  for (const name of ['ByBlock', 'ByLayer', 'Continuous']) {
    if (!doc.linetypes.has(tableKey(name))) {
      doc.linetypes.set(tableKey(name), {
        name,
        handle: '',
        flags: 0,
        description: name === 'Continuous' ? 'Solid line' : '',
        patternLength: 0,
        elements: [],
      });
    }
  }
  if (!doc.textStyles.has('STANDARD')) {
    doc.textStyles.set('STANDARD', {
      name: 'Standard',
      handle: '',
      flags: 0,
      height: 0,
      widthFactor: 1,
      oblique: 0,
      generation: 0,
      lastHeight: 2.5,
      font: 'txt',
      bigFont: '',
    });
  }

  ensureBlock(doc, '*Model_Space');

  // 배치: 모형이 없으면 만들고, 블록 이름을 대문자 키와 맞춘다.
  const layouts = doc.layouts;
  if (!layouts.some((l) => tableKey(l.blockName) === MODEL_SPACE)) {
    layouts.push(defaultLayout('Model', '*Model_Space', 0));
  }
  if (!layouts.some((l) => tableKey(l.blockName) !== MODEL_SPACE)) {
    const ps = [...doc.blocks.values()].find((b) => tableKey(b.name) === PAPER_SPACE);
    if (ps) layouts.push(defaultLayout('Layout1', ps.name, 1));
  }
  layouts.sort((a, b) => {
    const am = tableKey(a.blockName) === MODEL_SPACE ? 0 : 1;
    const bm = tableKey(b.blockName) === MODEL_SPACE ? 0 : 1;
    return am - bm || a.tabOrder - b.tabOrder;
  });

  const index = doc.entityIndex;
  index.clear();
  for (const b of doc.blocks.values()) for (const e of b.entities) indexEntity(index, e);
  return doc;
}
