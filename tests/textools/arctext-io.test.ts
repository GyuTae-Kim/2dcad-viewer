/** 원호 정렬 문자 저장·읽기: DXF ARCALIGNEDTEXT 읽기와 원본 태그 보존, 이 편집기 기록(익명 블록 참조)의 DXF·DWG 왕복 */
import { describe, expect, it } from 'vitest';
import type { ArcEntity, ArcTextEntity, CadDocument, Entity, InsertEntity, RawTag, UnknownEntity } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { EditSession } from '../../src/edit/session';
import { readCadFile } from '../../src/io';
import { readDxf } from '../../src/io/dxf/reader';
import { writeDxf } from '../../src/io/dxf/writer';
import { writeDwg } from '../../src/io/dwg';
import { ARCTEXT_APP, arcTextFromRecord, arcTextRecord, arcTextsForWrite, readArcTextRecord } from '../../src/io/arctext';
import { arcTextDefaults, arcTextSig, layoutArcText } from '../../src/text/arctext';

function bench(): { doc: CadDocument; s: EditSession; arc: ArcEntity; text: ArcTextEntity } {
  const doc = createNewDocument('metric');
  const s = new EditSession(doc, () => {});
  const arc: ArcEntity = { ...entityDefaults(), type: 'ARC', handle: s.newHandle(), center: { x: 10, y: 20, z: 0 }, radius: 50, startAngle: 0.2, endAngle: 2.9 };
  const text: ArcTextEntity = {
    ...entityDefaults(),
    ...arcTextDefaults(),
    handle: s.newHandle(),
    layer: '0',
    color: { aci: 1 },
    text: '원호 ABC',
    center: { ...arc.center },
    radius: arc.radius,
    startAngle: arc.startAngle,
    endAngle: arc.endAngle,
    arc: arc.handle,
    style: 'Standard',
    height: 5,
    alignment: 2,
    leftOffset: 3,
    charSpacing: 0.5,
    underline: true,
    italic: true,
  };
  s.commit({
    label: 'TEST',
    ops: [
      { kind: 'add', block: MODEL_SPACE, entity: arc },
      { kind: 'add', block: MODEL_SPACE, entity: text },
    ],
  });
  return { doc, s, arc, text };
}

const DEF_KEYS = ['text', 'radius', 'style', 'height', 'widthFactor', 'charSpacing', 'offset', 'leftOffset', 'rightOffset', 'alignment', 'position', 'direction', 'reversed', 'bold', 'italic', 'underline'] as const;

function expectSameDef(a: ArcTextEntity, b: ArcTextEntity): void {
  for (const k of DEF_KEYS) {
    const x = a[k];
    if (typeof x === 'number') expect(b[k] as number).toBeCloseTo(x, 7);
    else expect(b[k]).toEqual(x);
  }
  expect(b.center.x).toBeCloseTo(a.center.x, 7);
  expect(b.center.y).toBeCloseTo(a.center.y, 7);
  const ga = layoutArcText(a)!.glyphs;
  const gb = layoutArcText(b)!.glyphs;
  expect(gb.length).toBe(ga.length);
  for (let i = 0; i < ga.length; i++) {
    expect(gb[i]!.x).toBeCloseTo(ga[i]!.x, 6);
    expect(gb[i]!.y).toBeCloseTo(ga[i]!.y, 6);
  }
}

const model = (d: CadDocument) => d.blocks.get(MODEL_SPACE)!.entities;
const arcTexts = (d: CadDocument) => model(d).filter((e): e is ArcTextEntity => e.type === 'ARCALIGNEDTEXT');

describe('원호 정렬 문자 기록(익명 블록 참조 + OPENCAD_ARCTEXT)', () => {
  it('확장 자료는 ASCII JSON을 250자씩 담고 다시 읽힌다', () => {
    const { text } = bench();
    const x = arcTextRecord({ ...text, text: '가'.repeat(80) }, true);
    expect(x.app).toBe(ARCTEXT_APP);
    expect(x.items[0]).toEqual({ code: 1070, value: 1 });
    expect(x.items[1]).toEqual({ code: 1005, value: text.arc });
    const strs = x.items.filter((i) => i.code === 1000).map((i) => String(i.value));
    expect(strs.length).toBeGreaterThan(1);
    expect(strs.every((s) => s.length <= 250 && /^[\x20-\x7e]*$/.test(s))).toBe(true);
    const r = readArcTextRecord(x)!;
    expect(r.def.t).toBe('가'.repeat(80));
    expect(r.arc).toBe(text.arc);
    expect(readArcTextRecord({ app: ARCTEXT_APP, items: [{ code: 1070, value: 9 }] })).toBeNull();
  });

  it('쓰기 전 문서: 블록 참조(삽입점 = 중심)와 글자 TEXT의 익명 블록, 원래 문서는 그대로', () => {
    const { doc, text } = bench();
    const { doc: out, warnings } = arcTextsForWrite(doc, 'dxf', 'AC1032');
    expect(arcTexts(doc)).toHaveLength(1);
    const ins = model(out).find((e) => e.handle === text.handle) as InsertEntity;
    expect(ins.type).toBe('INSERT');
    expect(ins.insert).toEqual(text.center);
    expect(ins.block).toMatch(/^\*U\d+$/);
    const blk = out.blocks.get(ins.block.toUpperCase())!;
    expect(blk.flags & 1).toBe(1);
    // '원호 ABC'에서 빈칸을 뺀 다섯 글자
    expect(blk.entities.filter((e) => e.type === 'TEXT')).toHaveLength(5);
    expect(blk.entities.filter((e) => e.type === 'ARC')).toHaveLength(1);
    expect(out.appIds.has(ARCTEXT_APP)).toBe(true);
    expect(warnings.map((w) => w.code)).toEqual(['arctext.saved_as_block']);
  });

  it('닮음 변환으로 놓인 참조는 원호 정렬 문자로 돌아온다(회전·축척·대칭)', () => {
    const { text } = bench();
    const base = { ...text, center: { x: 0, y: 0, z: 0 } };
    const rec = readArcTextRecord(arcTextRecord(base, false))!;
    const ins = (over: Partial<InsertEntity>): InsertEntity => ({ ...entityDefaults(), type: 'INSERT', handle: 'X', block: '*U1', insert: { x: 5, y: 5, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotation: 0, columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0, attribs: [], ...over });
    const r = arcTextFromRecord(ins({ rotation: Math.PI / 2, scale: { x: 2, y: 2, z: 2 } }), undefined, rec)!;
    expect(r.center).toEqual({ x: 5, y: 5, z: 0 });
    expect(r.radius).toBeCloseTo(100, 9);
    expect(r.height).toBeCloseTo(10, 9);
    expect(r.startAngle).toBeCloseTo(text.startAngle + Math.PI / 2, 9);
    const m = arcTextFromRecord(ins({ scale: { x: -1, y: 1, z: 1 } }), undefined, rec)!;
    // x 대칭: 각도 a → π − a, 시작·끝이 바뀐다
    expect(Math.cos(m.startAngle)).toBeCloseTo(Math.cos(Math.PI - text.endAngle), 9);
    expect(Math.cos(m.endAngle)).toBeCloseTo(Math.cos(Math.PI - text.startAngle), 9);
    expect(arcTextFromRecord(ins({ scale: { x: 2, y: 1, z: 1 } }), undefined, rec)).toBeNull();
  });

  for (const [fmt, version] of [
    ['dxf', 'AC1032'],
    ['dxf', 'AC1015'],
    ['dxf', 'AC1009'],
    ['dwg', 'AC1032'],
    ['dwg', 'AC1018'],
    ['dwg', 'AC1015'],
  ] as const) {
    it(`${fmt.toUpperCase()} ${version}로 저장하고 다시 열면 원호 정렬 문자·연관이 돌아온다`, () => {
      const { doc, text, arc } = bench();
      const w = fmt === 'dxf' ? writeDxf(doc, { version }) : writeDwg(doc, { version });
      expect(w.warnings.some((x) => x.code === 'arctext.saved_as_block')).toBe(true);
      const back = readCadFile(w.data, `t.${fmt}`);
      const list = arcTexts(back);
      expect(list).toHaveLength(1);
      const r = list[0]!;
      expectSameDef(text, r);
      if (version !== 'AC1009') expect(r.arc).toBe(arc.handle);
      expect(r.color.aci).toBe(1);
      // 기록 블록은 지웠다(저장할 때 다시 만든다)
      expect([...back.blocks.keys()].filter((k) => /^\*U/.test(k))).toHaveLength(0);
      // 다시 저장해도 블록이 늘지 않는다
      const w2 = fmt === 'dxf' ? writeDxf(back, { version }) : writeDwg(back, { version });
      const back2 = readCadFile(w2.data, `t.${fmt}`);
      expect(arcTexts(back2)).toHaveLength(1);
      expect([...back2.blocks.keys()].filter((k) => /^\*U/.test(k))).toHaveLength(0);
    });
  }
});

/** AutoCAD ARCALIGNEDTEXT 꼴의 원본 태그(DXF 참조의 그룹 코드) */
function acadTags(arcHandle: string): RawTag[] {
  return [
    { code: 100, value: 'AcDbArcAlignedText' },
    { code: 1, value: 'HELLO' },
    { code: 2, value: 'Arial' },
    { code: 3, value: '' },
    { code: 7, value: 'Standard' },
    { code: 10, value: 10 },
    { code: 20, value: 20 },
    { code: 30, value: 0 },
    { code: 40, value: 50 },
    { code: 41, value: 1 },
    { code: 42, value: 5 },
    { code: 43, value: 0 },
    { code: 44, value: 1 },
    { code: 45, value: 0 },
    { code: 46, value: 0 },
    { code: 50, value: 0.2 },
    { code: 51, value: 2.9 },
    { code: 70, value: 0 },
    { code: 71, value: 1 },
    { code: 72, value: 4 },
    { code: 73, value: 1 },
    { code: 74, value: 0 },
    { code: 75, value: 0 },
    { code: 76, value: 0 },
    { code: 77, value: 0 },
    { code: 78, value: 34 },
    { code: 79, value: 0 },
    { code: 90, value: 256 },
    { code: 210, value: 0 },
    { code: 220, value: 0 },
    { code: 230, value: 1 },
    { code: 280, value: 1 },
    { code: 330, value: arcHandle },
  ];
}

describe('DXF ARCALIGNEDTEXT', () => {
  /** 원본 태그를 가진 모르는 객체로 ARCALIGNEDTEXT를 쓴 DXF */
  function acadDxf(): { data: Uint8Array; arc: ArcEntity } {
    const { doc, s, arc } = bench();
    const ms = model(doc);
    ms.splice(ms.findIndex((e) => e.type === 'ARCALIGNEDTEXT'), 1);
    const u: UnknownEntity = { ...entityDefaults(), type: 'UNKNOWN', handle: s.newHandle(), originalType: 'ARCALIGNEDTEXT', raw: acadTags(arc.handle) };
    ms.push(u as Entity);
    doc.classes.push({ dxfName: 'ARCALIGNEDTEXT', cppName: 'AcDbArcAlignedText', appName: 'AcDbArcAlignedText', proxyFlags: 0, instanceCount: 1, wasProxy: false, isEntity: true });
    return { data: writeDxf(doc, { version: 'AC1032' }).data, arc };
  }

  it('그룹 코드로 정의를 읽고, 살아 있는 330 호의 원호를 쓴다', () => {
    const { data, arc } = acadDxf();
    const doc = readCadFile(data, 'a.dxf');
    const [e] = arcTexts(doc);
    expect(e).toBeDefined();
    expect(e!.text).toBe('HELLO');
    expect(e!.font).toBe('Arial');
    expect(e!.height).toBe(5);
    expect(e!.offset).toBe(1);
    expect(e!.alignment).toBe(4);
    expect(e!.arc).toBe(arc.handle);
    expect(e!.startAngle).toBeCloseTo(0.2, 12);
    expect(e!.raw?.length).toBeGreaterThan(10);
    expect(e!.rawSig).toBe(arcTextSig(e!));
    // 필수 코드가 없으면 예전처럼 모르는 객체
    const bad = readDxf(new TextEncoder().encode(new TextDecoder().decode(data).replace(/\n 42\nHELLO/, '')));
    expect(bad).toBeDefined();
  });

  it('고치지 않았으면 DXF로 쓸 때 원본 태그를 그대로 쓰고, 고치면 이 편집기 기록으로 쓴다', () => {
    const { data } = acadDxf();
    const doc = readCadFile(data, 'a.dxf');
    const txt = new TextDecoder().decode(writeDxf(doc, { version: 'AC1032' }).data);
    expect(txt).toMatch(/\n\s*0\r?\nARCALIGNEDTEXT\r?\n/);
    expect(txt).toMatch(/AcDbArcAlignedText/);
    expect(txt).not.toMatch(ARCTEXT_APP);
    const again = arcTexts(readCadFile(new TextEncoder().encode(txt), 'b.dxf'));
    expect(again[0]!.text).toBe('HELLO');
    // 고치기
    const e = arcTexts(doc)[0]!;
    const ms = model(doc);
    ms[ms.indexOf(e)] = { ...e, text: 'WORLD' };
    const res = writeDxf(doc, { version: 'AC1032' });
    const t2 = new TextDecoder().decode(res.data);
    expect(t2).not.toMatch(/\n\s*0\r?\nARCALIGNEDTEXT\r?\n/);
    expect(t2).toMatch(ARCTEXT_APP);
    expect(res.warnings.some((w) => w.code === 'arctext.converted')).toBe(true);
    expect(arcTexts(readCadFile(res.data, 'c.dxf'))[0]!.text).toBe('WORLD');
    // DWG로는 원본 태그를 쓸 수 없어 기록으로
    const dw = writeDwg(readCadFile(data, 'a.dxf'), { version: 'AC1032' });
    expect(arcTexts(readCadFile(dw.data, 'a.dwg'))[0]!.text).toBe('HELLO');
  });
});
