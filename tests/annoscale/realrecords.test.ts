/**
 * 공개 도면(AutoCAD가 저장한 DWG와 같은 도면의 DXF)에서 확인한 컨텍스트 레코드 배치를 손으로 만든 최소 자료로 옮긴 시험.
 * 공개 도면 자체는 넣지 않는다 — 비트 순서·형식만 옮겼고 값은 이 시험이 정했다.
 * - 치수 레코드의 15비트 묶음: B 293·298·291·70·292·71, RC 280, B 295(실물: 71 = 1·280 = 16 → 비트 000001 00010000 0).
 * - MTEXT 레코드: 동적 열(71 = 2)이고 자동 높이가 아니면 열마다 BD 46 높이.
 * - HATCHVIEW: 축척 레코드마다 하나, HATCHSCALE 필드(40 = 1, 10 = 0 벡터) + 뷰포트 0·시선 (0, 0, 1)·비틀림 0·290 0.
 * - 여러 줄 속성 레코드(포함 MTEXT 레코드)는 실물이 없어 기능 명세의 배치로 왕복만 본다.
 */
import { describe, expect, it } from 'vitest';
import type { CadDocument, DictionaryObject, DimensionEntity, Entity, GenericObject, HatchEntity, MTextEntity, RawTag } from '../../src/core/model';
import { MODEL_SPACE } from '../../src/core/model';
import {
  CLASS_HATCH,
  CLASS_HATCHVIEW,
  MANAGER_KEY,
  SCALES_KEY,
  VIEWS_KEY,
  contextRecords,
  dimFields,
  followEdit,
  hatchFields,
  makeNonAnnotative,
  mtextFields,
  parseRecord,
  removeScales,
  switchScale,
  textFields,
} from '../../src/edit/annoscale';
import { BitReader } from '../../src/io/dwg/bitstream';
import { decodeCtx, encodeCtx, writeCtxOps } from '../../src/io/dwg/ctxcodec';
import { readDwg, writeDwg } from '../../src/io/dwg';
import { BitWriter } from '../../src/io/dwg/writer/bitwriter';
import { encoderFor } from '../../src/io/dwg/writer/codepage';
import { annotate, ctxFixture, hatch2 } from './ctxfix';
import { addModel, commit, envOf, mtext, newDoc } from './helpers';

const bits = (w: BitWriter): string => {
  const b = w.bytes();
  let s = '';
  for (let i = 0; i < w.pos; i++) s += (b[i >> 3]! >> (7 - (i & 7))) & 1;
  return s;
};

interface Made {
  d: BitWriter;
  h: BitWriter;
}

function writers(ver: number): Made {
  const enc = encoderFor('UTF-8');
  const d = new BitWriter(ver, enc);
  if (ver >= 1021) d.strWriter = new BitWriter(ver, enc);
  return { d, h: new BitWriter(ver, enc) };
}

function readerOf(w: BitWriter, ver: number): BitReader {
  const r = new BitReader(w.bytes(), ver, new TextDecoder());
  r.end = w.pos;
  if (ver >= 1021 && w.strWriter !== w) {
    const sr = new BitReader(w.strWriter.bytes(), ver, new TextDecoder());
    sr.end = w.strWriter.pos;
    r.strReader = sr;
  }
  return r;
}

/** 손으로 쓴 비트 → 태그, 그 태그 → 다시 쓴 비트(같아야 한다). 치수 블록(2)은 핸들 16진 문자열을 이름처럼 쓴다 */
function roundTrip(type: string, ver: number, m: Made): RawTag[] {
  const r = readerOf(m.d, ver);
  const hr = readerOf(m.h, ver);
  const tags = decodeCtx(type, r, hr, 0, ver);
  expect(r.pos, `${type} 남은 자료 비트`).toBe(m.d.pos);
  expect(hr.pos, `${type} 남은 핸들 비트`).toBe(m.h.pos);
  const ops = encodeCtx(type, tags, ver);
  expect(ops, type).toBeTruthy();
  const again = writers(ver);
  writeCtxOps(again.d, again.h, ops!, ver, (h) => parseInt(h, 16) || 0, (name) => parseInt(name, 16) || 0);
  expect(bits(again.d), `${type} 자료 비트`).toBe(bits(m.d));
  expect(bits(again.h), `${type} 핸들 비트`).toBe(bits(m.h));
  return tags;
}

const values = (tags: readonly RawTag[], code: number): (string | number)[] => tags.filter((t) => t.code === code).map((t) => t.value);

describe('치수 레코드의 15비트 묶음(공개 도면 DWG·DXF 짝의 배치)', () => {
  /** 정렬 치수 레코드: 머리, 2RD 문자 위치, B 294, BD 140, H 블록, 15비트, B 296·297, 3BD 11 */
  function dimBits(ver: number, flags: { b: number[]; rc: number; last: number }, flip = [0, 0]): Made {
    const m = writers(ver);
    m.d.BS(ver >= 1024 ? 4 : 3);
    m.d.B(1);
    m.h.H(5, 0x10d);
    m.d.RD(146.5);
    m.d.RD(131.25);
    m.d.B(1);
    m.d.BD(0);
    m.h.H(5, 0x2a);
    for (const b of flags.b) m.d.B(b);
    m.d.RC(flags.rc);
    m.d.B(flags.last);
    m.d.B(flip[0]!);
    m.d.B(flip[1]!);
    m.d.BD3({ x: 164.5, y: 129.5, z: 0 });
    return m;
  }

  it('71 = 1·280 = 16(AutoCAD R2013 레코드에 있는 값)이 그 자리의 비트로 풀리고 같은 비트로 다시 쓰인다', () => {
    const m = dimBits(1027, { b: [0, 0, 0, 0, 0, 1], rc: 16, last: 0 });
    // 머리 11비트 + 문자 위치 128 + 294 1 + 140 2 = 142번째 비트부터 15비트
    expect(bits(m.d).slice(142, 157)).toBe('000001000100000');
    const tags = roundTrip('ACDB_ALDIMOBJECTCONTEXTDATA_CLASS', 1027, m);
    expect(tags.map((t) => t.code)).toEqual([100, 70, 290, 100, 340, 100, 2, 293, 10, 20, 294, 140, 298, 291, 70, 292, 71, 280, 295, 296, 297, 100, 11, 21, 31]);
    const after = tags.slice(tags.findIndex((t) => t.value === 'AcDbDimensionObjectContextData'));
    expect(values(after, 71)).toEqual([1]);
    expect(values(after, 280)).toEqual([16]);
    expect(values(after, 70)).toEqual([0]);
    expect(values(tags, 2)).toEqual(['2A']);
  });

  it('각 칸이 제자리로 돌아온다(293·298·291·70·292·71·295는 B, 280은 RC)', () => {
    const codes = [293, 298, 291, 70, 292, 71];
    for (let k = 0; k < codes.length; k++) {
      const b = [0, 0, 0, 0, 0, 0];
      b[k] = 1;
      const tags = roundTrip('ACDB_DMDIMOBJECTCONTEXTDATA_CLASS', 1032, (() => {
        const m = dimBits(1032, { b, rc: 0, last: 0 });
        m.d.BD3({ x: 1, y: 2, z: 0 });
        return m;
      })());
      const after = tags.slice(tags.findIndex((t) => t.value === 'AcDbDimensionObjectContextData'));
      for (const c of codes) expect(Number(values(after, c)[0]), `${codes[k]} → ${c}`).toBe(c === codes[k] ? 1 : 0);
    }
    const tags = roundTrip('ACDB_ALDIMOBJECTCONTEXTDATA_CLASS', 1018, dimBits(1018, { b: [0, 0, 0, 0, 0, 0], rc: 255, last: 1 }, [1, 0]));
    expect(values(tags, 280)).toEqual([255]);
    expect(values(tags, 295)).toEqual([1]);
    expect(values(tags, 296)).toEqual([1]);
    expect(values(tags, 297)).toEqual([0]);
  });

  it('레코드를 다시 만들 때(다른 편집을 따라갈 때) 뜻을 모르는 값을 이어받는다', () => {
    const f = ctxFixture();
    const doc = f.doc;
    const h = f.handles.linear!;
    // 보이는 축척 레코드에 AutoCAD 값(71 = 1·280 = 16)을 넣는다
    const rec = contextRecords(doc, doc.entityIndex.get(h)!).find((r) => r.isDefault)!;
    let seen = false;
    const raw = rec.raw.map((t) => {
      if (t.code === 100 && t.value === 'AcDbDimensionObjectContextData') seen = true;
      if (seen && t.code === 71) return { code: 71, value: 1 };
      if (seen && t.code === 280) return { code: 280, value: 16 };
      return t;
    });
    commit(f.session, [{ kind: 'object', key: rec.handle, before: rec.obj, after: { ...rec.obj, raw } }]);
    expect(dimFields(contextRecords(doc, doc.entityIndex.get(h)!).find((r) => r.isDefault)!)!.flags).toEqual([0, 0, 0, 0, 0, 1, 16, 0]);
    const before = doc.entityIndex.get(h) as DimensionEntity;
    const after: DimensionEntity = { ...before, textMid: { ...before.textMid, y: before.textMid.y + 5 }, dimType: before.dimType | 0x80 };
    const r = followEdit(envOf(doc, f.session), before, after);
    commit(f.session, [...r.ops, { kind: 'modify', block: MODEL_SPACE, before, after: r.entity }]);
    const recs = contextRecords(doc, doc.entityIndex.get(h)!);
    expect(dimFields(recs.find((x) => x.isDefault)!)!.flags).toEqual([0, 0, 0, 0, 0, 1, 16, 0]);
    expect(dimFields(recs.find((x) => !x.isDefault)!)!.flags).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('MTEXT 레코드의 열 높이(공개 도면 DWG·DXF 짝의 배치)', () => {
  function mtextBits(ver: number, ct: number, n: number, auto: number, heights: number[]): Made {
    const m = writers(ver);
    m.d.BS(4);
    m.d.B(1);
    m.h.H(5, 0xb7);
    m.d.BL(3);
    m.d.BD3({ x: 0, y: -1, z: 0 });
    m.d.BD3({ x: 8.25, y: 3.5, z: 0 });
    m.d.BD(0.33);
    m.d.BD(0);
    m.d.BD(0.23);
    m.d.BD(0.1);
    m.d.BL(ct);
    if (ct) {
      m.d.BL(n);
      m.d.BD(0.33);
      m.d.BD(0.5);
      m.d.B(auto);
      m.d.B(0);
      for (const h of heights) m.d.BD(h);
    }
    return m;
  }
  const type = 'ACDB_MTEXTOBJECTCONTEXTDATA_CLASS';

  it('동적 열(2)이고 자동 높이가 아니면 열마다 BD 46이 74 뒤에 온다', () => {
    const one = roundTrip(type, 1032, mtextBits(1032, 2, 1, 0, [-0.1]));
    expect(one.slice(-8).map((t) => t.code)).toEqual([43, 71, 72, 44, 45, 73, 74, 46]);
    expect(values(one, 46)).toEqual([-0.1]);
    const two = roundTrip(type, 1027, mtextBits(1027, 2, 2, 0, [0, 3.5]));
    expect(values(two, 46)).toEqual([0, 3.5]);
    const rec = parseRecord({ type, handle: '1', raw: two } as GenericObject)!;
    expect(mtextFields(rec)!.columnHeights).toEqual([0, 3.5]);
  });

  it('자동 높이이거나 정적 열(1)·열 없음이면 높이가 없다', () => {
    expect(values(roundTrip(type, 1032, mtextBits(1032, 2, 1, 1, [])), 46)).toEqual([]);
    expect(values(roundTrip(type, 1032, mtextBits(1032, 1, 2, 0, [])), 46)).toEqual([]);
    expect(values(roundTrip(type, 1024, mtextBits(1024, 0, 0, 0, [])), 72)).toEqual([]);
  });

  it('새로 만드는 레코드: 정의 높이가 없는 MTEXT는 AutoCAD 꼴(71 = 2, 72 = 1, 44 = 폭, 73·74 = 0, 46 하나), 정의 높이가 있으면 71 = 0', () => {
    const { doc, session } = newDoc('metric');
    const a = annotate(doc, session, addModel(doc, session, mtext(0, 0, 2.5, 40)));
    const b = annotate(doc, session, addModel(doc, session, { ...mtext(0, 50, 2.5, 40), rectHeight: 12 }));
    for (const r of contextRecords(doc, doc.entityIndex.get(a)!)) {
      const f = mtextFields(r)!;
      expect(f.columnType).toBe(2);
      expect(f.columnCount).toBe(1);
      expect(f.columnWidth).toBeCloseTo(f.width);
      expect(f.autoHeight).toBe(false);
      expect(f.flowReversed).toBe(false);
      expect(f.columnHeights).toEqual([0]);
      expect(r.body.map((t) => t.code).slice(-8)).toEqual([43, 71, 72, 44, 45, 73, 74, 46]);
      // 거터는 그 축척의 문자 높이 × 5
      const m = doc.entityIndex.get(a) as MTextEntity;
      const ratio = f.width / m.width;
      expect(f.gutter).toBeCloseTo(m.height * ratio * 5);
    }
    for (const r of contextRecords(doc, doc.entityIndex.get(b)!)) expect(mtextFields(r)!.columnType).toBe(0);
    // DWG로 쓰고 읽어도 같다
    const back = readDwg(writeDwg(doc, { version: 'AC1032' }).data);
    for (const h of [a, b]) {
      const want = contextRecords(doc, doc.entityIndex.get(h)!).map((r) => r.body.map((t) => t.code));
      const got = contextRecords(back, back.entityIndex.get(h)!).map((r) => r.body.map((t) => t.code));
      expect(got).toEqual(want);
    }
  });
});

describe('여러 줄 속성 레코드(포함 MTEXT 레코드, 기능 명세 6.1의 배치)', () => {
  const type = 'ACDB_MTEXTATTRIBUTEOBJECTCONTEXTDATA_CLASS';
  const tags = (v: number): RawTag[] => [
    { code: 100, value: 'AcDbObjectContextData' },
    { code: 70, value: v },
    { code: 290, value: 1 },
    { code: 100, value: 'AcDbAnnotScaleObjectContextData' },
    { code: 340, value: 'A1' },
    { code: 70, value: 0 },
    { code: 50, value: 0 },
    { code: 10, value: 10 },
    { code: 20, value: 20 },
    { code: 11, value: 0 },
    { code: 21, value: 0 },
    { code: 290, value: 1 },
    { code: 101, value: 'Embedded Object' },
    { code: 70, value: v },
    { code: 290, value: 1 },
    { code: 340, value: 'A1' },
    { code: 70, value: 1 },
    { code: 10, value: 1 },
    { code: 20, value: 0 },
    { code: 30, value: 0 },
    { code: 11, value: 10 },
    { code: 21, value: 20 },
    { code: 31, value: 0 },
    { code: 40, value: 30 },
    { code: 41, value: 0 },
    { code: 42, value: 12 },
    { code: 43, value: 5 },
    { code: 71, value: 2 },
    { code: 72, value: 1 },
    { code: 44, value: 30 },
    { code: 45, value: 12.5 },
    { code: 73, value: 0 },
    { code: 74, value: 0 },
    { code: 46, value: 0 },
  ];

  for (const ver of [1015, 1018, 1021, 1024, 1027, 1032]) {
    it(`AC${ver}: 태그 → 비트 → 태그`, () => {
      const want = tags(ver >= 1024 ? 4 : 3);
      const ops = encodeCtx(type, want, ver)!;
      expect(ops).toBeTruthy();
      const m = writers(ver);
      writeCtxOps(m.d, m.h, ops, ver, (h) => parseInt(h, 16) || 0, () => 0);
      const r = readerOf(m.d, ver);
      const hr = readerOf(m.h, ver);
      const got = decodeCtx(type, r, hr, 0, ver);
      expect(r.pos).toBe(m.d.pos);
      expect(got).toEqual(want);
      // 포함 객체 머리: 여러 줄 290 다음 BL 반응자 0("10"), (R2004+) 확장 사전 없음 1, (R2013+) 자료 저장소 0
      const b = bits(m.d);
      const at = 10 + 1 + 2 + 2 + 64 * 4 + 1;
      expect(b.slice(at, at + 2 + (ver >= 1018 ? 1 : 0) + (ver >= 1027 ? 1 : 0))).toBe('10' + (ver >= 1018 ? '1' : '') + (ver >= 1027 ? '0' : ''));
      const rec = parseRecord({ type, handle: '1', raw: got } as GenericObject)!;
      expect(textFields(rec)!.multiline).toBe(true);
      expect(textFields(rec)!.insert).toEqual({ x: 10, y: 20 });
    });
  }
});

describe('해치의 뷰포트별 표현(HATCHVIEW)', () => {
  function views(doc: CadDocument, e: Entity): { keys: string[]; recs: GenericObject[] } {
    const xd = doc.objects.get(e.xdict!) as DictionaryObject;
    const mgr = doc.objects.get(xd.entries.get(MANAGER_KEY)!) as DictionaryObject;
    const keys = [...mgr.entries.keys()];
    const vh = mgr.entries.get(VIEWS_KEY);
    const vd = vh ? (doc.objects.get(vh) as DictionaryObject) : null;
    return { keys, recs: vd ? [...vd.entries.values()].map((h) => doc.objects.get(h) as GenericObject) : [] };
  }
  const tail = (raw: readonly RawTag[]) => raw.slice(raw.findIndex((t) => t.value === 'AcDbHatchViewContextData'));

  it('주석 해치의 축척 레코드마다 하나: 같은 축척·기본 표지·패턴 선, 40 = 1·10 = 0 벡터, 뷰포트 0·시선 (0, 0, 1)·비틀림 0·290 0', () => {
    const { doc, session } = newDoc('metric');
    const h = annotate(doc, session, addModel(doc, session, hatch2()));
    const e = doc.entityIndex.get(h)!;
    const v = views(doc, e);
    // AutoCAD의 사전 순서: 모음이 축척 사전 앞
    expect(v.keys).toEqual([VIEWS_KEY, SCALES_KEY]);
    const scales = contextRecords(doc, e);
    expect(v.recs).toHaveLength(scales.length);
    v.recs.forEach((o, i) => {
      expect(o.type).toBe(CLASS_HATCHVIEW);
      const vr = parseRecord(o)!;
      const sr = scales[i]!;
      expect(sr.type).toBe(CLASS_HATCH);
      expect(vr.scale).toBe(sr.scale);
      expect(vr.isDefault).toBe(sr.isDefault);
      expect(hatchFields(vr)!.lines).toEqual(hatchFields(sr)!.lines);
      expect(hatchFields(vr)!.factor).toBe(1);
      const i40 = vr.body.findIndex((t, k) => t.code === 40 && k > vr.body.findIndex((x) => x.code === 78));
      expect(vr.body.slice(i40, i40 + 4).map((t) => Number(t.value))).toEqual([1, 0, 0, 0]);
      expect(tail(o.raw!).map((t) => [t.code, t.value])).toEqual([
        [100, 'AcDbHatchViewContextData'],
        [330, '0'],
        [10, 0],
        [20, 0],
        [30, 1],
        [51, 0],
        [290, 0],
      ]);
      expect(o.owner).toBeTruthy();
      expect(o.reactors).toEqual([o.owner]);
    });
  });

  it('보이는 축척 바꾸기·축척 지우기를 따라가고, 주석 아님이면 모음을 지운다. DWG로 쓰고 읽어도 같다', () => {
    const { doc, session } = newDoc('metric');
    const h = annotate(doc, session, addModel(doc, session, hatch2()));
    const env = () => envOf(doc, session);
    let e = doc.entityIndex.get(h) as HatchEntity;
    const sw = switchScale(env(), e, '1:20');
    commit(session, [...sw.ops, { kind: 'modify', block: MODEL_SPACE, before: e, after: sw.entity }]);
    e = doc.entityIndex.get(h) as HatchEntity;
    const defaults = () => views(doc, doc.entityIndex.get(h)!).recs.map((o) => parseRecord(o)!.isDefault);
    expect(defaults()).toEqual(contextRecords(doc, e).map((r) => r.isDefault));
    expect(defaults()).toContain(true);
    // DWG 왕복
    const back = readDwg(writeDwg(doc, { version: 'AC1032' }).data);
    const vb = views(back, back.entityIndex.get(h)!);
    expect(vb.recs.map((o) => o.type)).toEqual(views(doc, e).recs.map((o) => o.type));
    vb.recs.forEach((o, i) => expect(o.raw!.map((t) => t.code)).toEqual(views(doc, e).recs[i]!.raw!.map((t) => t.code)));
    // 축척 지우기
    const rm = removeScales(env(), e, ['1:10']);
    commit(session, [...rm.ops, { kind: 'modify', block: MODEL_SPACE, before: e, after: rm.entity }]);
    e = doc.entityIndex.get(h) as HatchEntity;
    expect(views(doc, e).recs).toHaveLength(1);
    expect(parseRecord(views(doc, e).recs[0]!)!.scale).toBe(contextRecords(doc, e)[0]!.scale);
    // 주석 아님
    const na = makeNonAnnotative(env(), e);
    commit(session, [...na.ops, { kind: 'modify', block: MODEL_SPACE, before: e, after: na.entity }]);
    const v = views(doc, doc.entityIndex.get(h)!);
    expect(v.keys).not.toContain(VIEWS_KEY);
    expect(v.recs).toHaveLength(0);
  });
});
