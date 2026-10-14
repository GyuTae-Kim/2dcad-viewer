/** AutoCAD 레코드 꼴(치수·해치·블록 참조)의 표현, 실물 샘플(있으면) */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DictionaryObject, DimensionEntity, Entity, GenericObject, HatchEntity, RawTag } from '../../src/core/model';
import { MODEL_SPACE } from '../../src/core/model';
import { readCadFile } from '../../src/io/index';
import { ScaleIndex, annoState, findScale, hatchFields, hatchRecordWithLines, parseRecord, readScaleList, representation, withAnnotativeFlag } from '../../src/edit/annoscale';
import { createDimension } from './dimfix';
import { addModel, commit, hatch, newDoc } from './helpers';
import { FIXTURES } from '../dim/compare';

const HEAD = (scale: string, def: boolean): RawTag[] => [
  { code: 100, value: 'AcDbObjectContextData' },
  { code: 70, value: 4 },
  { code: 290, value: def ? 1 : 0 },
  { code: 100, value: 'AcDbAnnotScaleObjectContextData' },
  { code: 340, value: scale },
];

/** 객체에 AutoCAD 꼴 레코드 사슬을 직접 붙인다 */
function attach(doc: ReturnType<typeof newDoc>['doc'], session: ReturnType<typeof newDoc>['session'], e: Entity, type: string, records: RawTag[][]): Entity {
  const h = () => session.newHandle();
  const xd = h();
  const mg = h();
  const sc = h();
  const recs = records.map((raw) => ({ type, handle: h(), owner: sc, reactors: [sc], raw }) as GenericObject);
  const d = (handle: string, owner: string, entries: [string, string][], hard = false): DictionaryObject => ({ type: 'DICTIONARY', handle, owner, entries: new Map(entries), hardOwner: hard, cloning: 1 });
  const after = { ...e, xdict: xd, xdata: withAnnotativeFlag(e.xdata, true) } as Entity;
  commit(session, [
    { kind: 'object', key: xd, before: null, after: d(xd, e.handle, [['AcDbContextDataManager', mg]], true) },
    { kind: 'object', key: mg, before: null, after: d(mg, xd, [['ACDB_ANNOTATIONSCALES', sc]]) },
    { kind: 'object', key: sc, before: null, after: d(sc, mg, recs.map((r, i) => [`*A${i + 1}`, r.handle])) },
    ...recs.map((r) => ({ kind: 'object' as const, key: r.handle, before: null, after: r })),
    { kind: 'modify', block: MODEL_SPACE, before: e, after },
  ]);
  return doc.entityIndex.get(e.handle)!;
}

describe('AutoCAD 레코드 꼴', () => {
  it('치수: 그 축척 레코드의 익명 블록과 문자 위치를 그린다', () => {
    const { doc, session } = newDoc();
    const d1 = createDimension(doc, session);
    const d2 = createDimension(doc, session); // 다른 축척의 그림으로 쓸 블록
    const list = readScaleList(doc);
    const s1 = findScale(list, '1:1')!.handle!;
    const s2 = findScale(list, '1:2')!.handle!;
    let d = addModel(doc, session, d1) as Entity;
    d = attach(doc, session, d, 'ACDB_ALDIMOBJECTCONTEXTDATA_CLASS', [
      [...HEAD(s1, true), { code: 10, value: 50 }, { code: 20, value: 21 }, { code: 294, value: 1 }, { code: 140, value: 0 }, { code: 2, value: d1.block }],
      [...HEAD(s2, false), { code: 10, value: 50 }, { code: 20, value: 33 }, { code: 294, value: 0 }, { code: 140, value: 0 }, { code: 2, value: d2.block }],
    ]);
    const idx = new ScaleIndex(doc);
    const st = annoState(doc, d, idx)!;
    expect(st.scales).toEqual(['1:1', '1:2']);
    expect(st.current).toBe('1:1');
    const r = representation(doc, d, st, '1:2', idx).entity as DimensionEntity;
    expect(r.block).toBe(d2.block);
    expect(r.textMid.y).toBeCloseTo(33);
  });

  it('해치: 그 축척 레코드의 패턴 선, 패턴 선 바꿔 쓰기', () => {
    const { doc, session } = newDoc();
    const list = readScaleList(doc);
    const s1 = findScale(list, '1:1')!.handle!;
    const s5 = findScale(list, '1:5')!.handle!;
    const lines = (k: number): RawTag[] => [
      { code: 78, value: 1 },
      { code: 53, value: 45 },
      { code: 43, value: 0 },
      { code: 44, value: 0 },
      { code: 45, value: -2.245 * k },
      { code: 46, value: 2.245 * k },
      { code: 79, value: 0 },
      { code: 40, value: k },
      { code: 10, value: 0.7 },
      { code: 20, value: 0.7 },
      { code: 30, value: 0 },
      { code: 90, value: 1 },
      { code: 90, value: 1 },
      { code: 290, value: 1 },
    ];
    let h = addModel(doc, session, hatch()) as Entity;
    h = attach(doc, session, h, 'ACDB_HATCHSCALECONTEXTDATA_CLASS', [
      [...HEAD(s1, true), { code: 100, value: 'AcDbHatchObjectContextData' }, ...lines(1)],
      [...HEAD(s5, false), { code: 100, value: 'AcDbHatchObjectContextData' }, ...lines(5)],
    ]);
    const idx = new ScaleIndex(doc);
    const st = annoState(doc, h, idx)!;
    const r = representation(doc, h, st, '1:5', idx).entity as HatchEntity;
    expect(r.patternLines[0]!.offset.y).toBeCloseTo(11.225);
    expect(r.patternLines[0]!.angle).toBeCloseTo(Math.PI / 4);
    const raw = [...HEAD(s5, false), ...lines(5)];
    const rewritten = hatchRecordWithLines(raw, [{ angle: 0, base: { x: 1, y: 2 }, offset: { x: 0, y: 3 }, dashes: [1, -1] }]);
    const f = hatchFields(parseRecord({ type: 'ACDB_HATCHSCALECONTEXTDATA_CLASS', handle: '1', raw: rewritten })!)!;
    expect(f.lines).toHaveLength(1);
    expect(f.lines[0]!.dashes).toEqual([1, -1]);
    expect(f.factor).toBe(5);
  });
});

const SAMPLE = `${FIXTURES}/samples-dxf/sample_AC1032_ascii.dxf`;
describe.skipIf(!existsSync(SAMPLE))('AutoCAD 실물(ACadSharp sample_AC1032_ascii.dxf, 있을 때만)', () => {
  it('주석 TEXT 두 개가 1:1 레코드 하나씩, 리스트 33개, CANNOSCALE 1:1', () => {
    const doc = readCadFile(new Uint8Array(readFileSync(SAMPLE)), 'sample.dxf');
    const idx = new ScaleIndex(doc);
    expect(idx.list).toHaveLength(33);
    const anns = [...doc.entityIndex.values()].map((e) => annoState(doc, e, idx)).filter((s) => s && !s.foreign);
    expect(anns).toHaveLength(2);
    expect(anns.every((s) => s!.scales.join() === '1:1' && s!.current === '1:1')).toBe(true);
  });
});
