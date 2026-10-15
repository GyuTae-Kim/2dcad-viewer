/**
 * 컨텍스트 데이터(주석 축척 레코드) 쓰기·읽기:
 * - DWG 코덱(src/io/dwg/ctxcodec.ts): 모든 종류의 원본 태그 → 비트 → 원본 태그가 같다(R2000~R2018).
 * - DXF 왕복(R2018·R2013·R2010·R2007), DWG 왕복(R2018·R2013·R2010·R2004·R2000): 레코드 태그·상태가 같다.
 * - 치수·해치·다중 지시선의 레코드 꼴(기능 명세의 DXF 태그 순서), 주석 치수의 DIMSCALE, R2018 주석 MTEXT.
 * - 예전 빌드의 자체 기록(OPENCAD_ANNOSCALE)은 계속 읽히고 AutoCAD 레코드로 바뀐다.
 * - 편집: 보이는 축척 바꾸기·축척 삭제·복사본·주석 아님.
 */
import { describe, expect, it } from 'vitest';
import type { CadDocument, DimensionEntity, Entity, GenericObject, HatchEntity, MLeaderEntity, MTextEntity, RawTag } from '../../src/core/model';
import { MODEL_SPACE, tableKey } from '../../src/core/model';
import {
  ScaleIndex,
  annoState,
  cloneRecordsForCopy,
  contextRecords,
  dimFields,
  hatchFields,
  makeNonAnnotative,
  removeScales,
  representation,
  switchScale,
  upgradeOwnRecords,
  withOwnRecord,
} from '../../src/edit/annoscale';
import { BitReader } from '../../src/io/dwg/bitstream';
import { CTX_TYPES, decodeCtx, encodeCtx, writeCtxOps } from '../../src/io/dwg/ctxcodec';
import { readDwg, writeDwg } from '../../src/io/dwg';
import { BitWriter } from '../../src/io/dwg/writer/bitwriter';
import { encoderFor } from '../../src/io/dwg/writer/codepage';
import { writeDxf } from '../../src/io/dxf/writer';
import { readCadFile } from '../../src/io/index';
import { ctxFixture, mleader } from './ctxfix';
import { addModel, commit, envOf, newDoc } from './helpers';
import { createDimension } from './dimfix';

/** 값 비교(수는 상대 1e-9, 문자열은 앞뒤 공백·대소문자 무시) */
function sameValue(a: string | number, b: string | number): boolean {
  const na = Number(a);
  const nb = Number(b);
  if (String(a).trim() !== '' && String(b).trim() !== '' && Number.isFinite(na) && Number.isFinite(nb)) return Math.abs(na - nb) <= 1e-9 * Math.max(1, Math.abs(na), Math.abs(nb));
  return String(a).trim().toUpperCase() === String(b).trim().toUpperCase();
}

function expectSameTags(a: readonly RawTag[], b: readonly RawTag[], what: string, skip = new Set<number>()): void {
  expect(a.map((t) => t.code), what).toEqual(b.map((t) => t.code));
  a.forEach((t, i) => {
    if (skip.has(i)) return;
    expect(sameValue(t.value, b[i]!.value), `${what} #${i} ${t.code}: ${t.value} ≠ ${b[i]!.value}`).toBe(true);
  });
}

/** R2007 이하 다중 지시선 레코드에는 없는 태그(지시선 271, 끝 272·273)를 뺀 것 */
function withoutR2010(raw: readonly RawTag[]): RawTag[] {
  return raw.filter((t) => t.code !== 271 && t.code !== 272 && t.code !== 273);
}

const allRecords = (doc: CadDocument, h: string) => contextRecords(doc, doc.entityIndex.get(h)!);

// ---------------------------------------------------------------------------

describe('DWG 코덱: 원본 태그 → 비트 → 원본 태그', () => {
  const f = ctxFixture();
  const objs = [...f.doc.objects.values()].filter((o) => CTX_TYPES.has(o.type)) as GenericObject[];
  it('시험 도면에 모든 종류가 있다', () => {
    const types = new Set(objs.map((o) => o.type));
    for (const t of ['TEXT', 'MTEXT', 'BLKREF', 'MTEXTATTRIBUTE', 'ALDIM', 'ANGDIM', 'RADIM', 'DMDIM', 'ORDDIM', 'MLEADER']) expect(types.has(`ACDB_${t}OBJECTCONTEXTDATA_CLASS`), t).toBe(true);
    expect(types.has('ACDB_HATCHSCALECONTEXTDATA_CLASS')).toBe(true);
  });
  for (const ver of [1015, 1018, 1021, 1024, 1027, 1032]) {
    it(`AC${ver}`, () => {
      const blocks = new Map<string, number>();
      let n = 1000;
      for (const k of f.doc.blocks.keys()) blocks.set(k, n++);
      const byH = new Map([...blocks].map(([k, h]) => [h, f.doc.blocks.get(k)!.name]));
      for (const o of objs) {
        const ops = encodeCtx(o.type, o.raw, ver);
        expect(ops, `${o.type} ${o.handle}`).toBeTruthy();
        const enc = encoderFor('UTF-8');
        const d = new BitWriter(ver, enc);
        const s = new BitWriter(ver, enc);
        const hd = new BitWriter(ver, enc);
        if (ver >= 1021) d.strWriter = s;
        writeCtxOps(d, hd, ops!, ver, (h) => parseInt(h, 16) || 0, (name) => blocks.get(tableKey(name)) ?? 0);
        const dec = new TextDecoder('utf-8');
        const r = new BitReader(d.bytes(), ver, dec);
        r.end = d.pos;
        if (ver >= 1021) {
          const sr = new BitReader(s.bytes(), ver, dec);
          sr.end = s.pos;
          r.strReader = sr;
        }
        const hr = new BitReader(hd.bytes(), ver, dec);
        hr.end = hd.pos;
        const tags = decodeCtx(o.type, r, hr, 0, ver);
        expect(r.pos, `${o.type} 남은 비트`).toBe(d.pos);
        // 치수의 블록(2)은 읽을 때 핸들이다
        for (const t of tags) if (t.code === 2 && o.type.includes('DIM')) t.value = byH.get(parseInt(String(t.value), 16)) ?? '';
        const want = o.raw!.map((t, i) => (i === 1 && t.code === 70 ? { code: 70, value: ver >= 1024 ? 4 : 3 } : t));
        if (o.type === 'ACDB_MLEADEROBJECTCONTEXTDATA_CLASS' && ver < 1024) expectSameTags(tags, withoutR2010(want), `${o.type} ${o.handle}`);
        else expectSameTags(tags, want, `${o.type} ${o.handle}`);
      }
    });
  }

  it('해치 뷰포트별 레코드(HATCHVIEW)·지시선 레코드(LEADER)도 같은 태그로 돌아온다', () => {
    const head = (v: number): RawTag[] => [
      { code: 100, value: 'AcDbObjectContextData' },
      { code: 70, value: v },
      { code: 290, value: 0 },
      { code: 100, value: 'AcDbAnnotScaleObjectContextData' },
      { code: 340, value: 'A1' },
    ];
    const cases: [string, RawTag[]][] = [
      [
        'ACDB_HATCHVIEWCONTEXTDATA_CLASS',
        [
          ...head(4),
          { code: 100, value: 'AcDbHatchObjectContextData' },
          { code: 78, value: 1 },
          { code: 53, value: 45 },
          { code: 43, value: 0 },
          { code: 44, value: 0 },
          { code: 45, value: -2.5 },
          { code: 46, value: 2.5 },
          { code: 79, value: 2 },
          { code: 49, value: 3 },
          { code: 49, value: -1 },
          { code: 40, value: 1 },
          { code: 10, value: 0 },
          { code: 20, value: 0 },
          { code: 30, value: 0 },
          { code: 90, value: 2 },
          { code: 90, value: 17 },
          { code: 290, value: 1 },
          { code: 90, value: 0 },
          { code: 290, value: 1 },
          { code: 100, value: 'AcDbHatchViewContextData' },
          { code: 330, value: 'B2' },
          { code: 10, value: 0 },
          { code: 20, value: 0 },
          { code: 30, value: 1 },
          { code: 51, value: 0.5 },
          { code: 290, value: 0 },
        ],
      ],
      [
        'ACDB_LEADEROBJECTCONTEXTDATA_CLASS',
        [
          ...head(4),
          { code: 70, value: 2 },
          { code: 10, value: 1 },
          { code: 20, value: 2 },
          { code: 30, value: 0 },
          { code: 10, value: 5 },
          { code: 20, value: 6 },
          { code: 30, value: 0 },
          { code: 11, value: 1 },
          { code: 21, value: 0 },
          { code: 31, value: 0 },
          { code: 290, value: 1 },
          { code: 12, value: 0 },
          { code: 22, value: 0 },
          { code: 32, value: 0 },
          { code: 13, value: 0 },
          { code: 23, value: 0 },
          { code: 33, value: 0 },
        ],
      ],
    ];
    for (const [type, raw] of cases) {
      const ops = encodeCtx(type, raw, 1032)!;
      expect(ops, type).toBeTruthy();
      const enc = encoderFor('UTF-8');
      const d = new BitWriter(1032, enc);
      const hd = new BitWriter(1032, enc);
      d.strWriter = new BitWriter(1032, enc);
      writeCtxOps(d, hd, ops, 1032, (h) => parseInt(h, 16) || 0, () => 0);
      const r = new BitReader(d.bytes(), 1032, new TextDecoder());
      r.end = d.pos;
      const hr = new BitReader(hd.bytes(), 1032, new TextDecoder());
      hr.end = hd.pos;
      expectSameTags(decodeCtx(type, r, hr, 0, 1032), raw, type);
    }
  });

  it('치수 레코드의 15비트 묶음(293·298·291·70·292·71 B, 280 RC, 295 B): 값을 그대로 쓰고, 칸에 맞지 않는 값이면 쓰지 않는다', () => {
    const d = objs.find((o) => o.type === 'ACDB_ALDIMOBJECTCONTEXTDATA_CLASS')!;
    const set = (code: number, value: number) => {
      let seen = false;
      return d.raw!.map((t) => {
        // 머리의 70(판) 말고 치수 표지 뒤의 것
        if (t.code === 100 && t.value === 'AcDbDimensionObjectContextData') seen = true;
        return seen && t.code === code ? { code, value } : t;
      });
    };
    expect(encodeCtx(d.type, set(291, 1), 1032)).toBeTruthy();
    expect(encodeCtx(d.type, set(280, 16), 1032)).toBeTruthy();
    expect(encodeCtx(d.type, set(291, 2), 1032)).toBeNull();
    expect(encodeCtx(d.type, set(280, 256), 1032)).toBeNull();
  });
});

describe('레코드의 DXF 꼴', () => {
  const f = ctxFixture();
  it('치수: AcDbDimensionObjectContextData(2·293·10·20·294·140·298·291·70·292·71·280·295·296·297) + 종류 표지 + 점', () => {
    const want: Record<string, [string, number[]]> = {
      linear: ['AcDbAlignedDimensionObjectContextData', [11]],
      aligned: ['AcDbAlignedDimensionObjectContextData', [11]],
      angular2: ['AcDbAngularDimensionObjectContextData', [11]],
      angular3: ['AcDbAngularDimensionObjectContextData', [11]],
      arc: ['AcDbAngularDimensionObjectContextData', [11]],
      radius: ['AcDbRadialDimensionObjectContextData', [11]],
      diameter: ['AcDbDiametricDimensionObjectContextData', [11, 12]],
      ordinate: ['AcDbOrdinateDimensionObjectContextData', [11, 12]],
    };
    for (const [k, [marker, pts]] of Object.entries(want)) {
      const d = f.doc.entityIndex.get(f.handles[k]!) as DimensionEntity;
      for (const r of allRecords(f.doc, d.handle)) {
        expect(r.body.map((t) => t.code)).toEqual([100, 2, 293, 10, 20, 294, 140, 298, 291, 70, 292, 71, 280, 295, 296, 297, 100, ...pts.flatMap((c) => [c, c + 10, c + 20])]);
        expect(r.body[0]!.value).toBe('AcDbDimensionObjectContextData');
        expect(r.body[16]!.value, k).toBe(marker);
        expect(f.doc.blocks.get(tableKey(dimFields(r)!.block))?.entities.length, k).toBeGreaterThan(0);
      }
      // 보이는 축척 레코드 = 객체 자신(블록·문자 위치·점)
      const cur = allRecords(f.doc, d.handle).find((r) => r.isDefault)!;
      const fd = dimFields(cur)!;
      expect(fd.block).toBe(d.block);
      expect(fd.textPos.x).toBeCloseTo(d.textMid.x);
    }
    // 정의점 대응: 선형 11 = 10, 2선 각도 11 = 16, 반지름 11 = 15, 지름 11·12 = 15·10, 세로좌표 11·12 = 10·14
    const pt = (k: string) => dimFields(allRecords(f.doc, f.handles[k]!).find((r) => r.isDefault)!)!.points!;
    const ent = (k: string) => f.doc.entityIndex.get(f.handles[k]!) as DimensionEntity;
    expect(pt('linear')[0]).toEqual(ent('linear').defPoint);
    expect(pt('angular2')[0]).toEqual(ent('angular2').defPoint5);
    expect(pt('radius')[0]).toEqual(ent('radius').defPoint4);
    expect(pt('diameter')).toEqual([ent('diameter').defPoint4, ent('diameter').defPoint]);
    expect(pt('ordinate')).toEqual([ent('ordinate').defPoint, ent('ordinate').defPoint3]);
  });

  it('해치: AcDbHatchObjectContextData, 패턴 선, 그 축척의 배율, 패턴 방향, 루프 종류(폴리선 비트 없음)', () => {
    const h = f.doc.entityIndex.get(f.handles.hatch!) as HatchEntity;
    const recs = allRecords(f.doc, h.handle);
    expect(recs).toHaveLength(2);
    const r20 = recs.find((r) => !r.isDefault)!;
    expect(r20.body[0]).toEqual({ code: 100, value: 'AcDbHatchObjectContextData' });
    const fl = hatchFields(r20)!;
    expect(fl.factor).toBe(20);
    expect(fl.lines).toHaveLength(2);
    expect(fl.lines[1]!.dashes[0]).toBeCloseTo(h.patternLines[1]!.dashes[0]! * 2);
    const tail = r20.body.slice(r20.body.findIndex((t) => t.code === 40));
    expect(tail.map((t) => t.code)).toEqual([40, 10, 20, 30, 90, 90, 290, 90, 290]);
    expect(tail.filter((t) => t.code === 90).map((t) => t.value)).toEqual([2, 17, 0]);
  });

  it('다중 지시선: CONTEXT_DATA{ 안의 태그(내용 → 지시선 → 272·273), 다른 축척은 연결점 기준 배율 비', () => {
    const m = f.doc.entityIndex.get(f.handles.mleader!) as MLeaderEntity;
    expect(m.props?.[293]).toBe(1);
    const recs = allRecords(f.doc, m.handle);
    const r20 = recs.find((r) => !r.isDefault)!;
    const codes = r20.body.map((t) => t.code);
    expect(codes.slice(0, 10)).toEqual([40, 10, 20, 30, 41, 140, 145, 174, 175, 176]);
    expect(codes.indexOf(302)).toBeGreaterThan(codes.indexOf(297));
    expect(codes.slice(-2)).toEqual([272, 273]);
    // 1:10이 보이고 문자 높이 40(4 × 10), 1:20 레코드는 80
    expect(m.context.textHeight).toBeCloseTo(40);
    expect(r20.body.find((t) => t.code === 41)!.value).toBeCloseTo(80);
    // 객체의 화살촉 크기·연결선 길이는 용지 값(AutoCAD와 같다)
    expect(m.arrowSize).toBe(4);
    expect(m.doglegLength).toBe(8);
  });
});

describe('DXF 왕복', () => {
  const f = ctxFixture();
  for (const v of ['AC1032', 'AC1027', 'AC1024', 'AC1021'] as const) {
    it(v, () => {
      const out = writeDxf(f.doc, { version: v as never });
      const txt = new TextDecoder().decode(out.data);
      for (const c of ['ACDB_ALDIMOBJECTCONTEXTDATA_CLASS', 'ACDB_HATCHSCALECONTEXTDATA_CLASS', 'ACDB_MLEADEROBJECTCONTEXTDATA_CLASS']) expect(new RegExp(`CLASS\\r?\\n\\s*1\\r?\\n${c}`).test(txt), c).toBe(true);
      const back = readCadFile(out.data, 'rt.dxf');
      const idx = new ScaleIndex(back);
      for (const [k, h] of Object.entries(f.handles)) {
        const a = allRecords(f.doc, h);
        const b = allRecords(back, h);
        expect(b.length, k).toBe(a.length);
        a.forEach((r, i) => {
          const want = r.raw.map((t, j) => (j === 1 ? { code: 70, value: Number(v.slice(2)) >= 1024 ? 4 : 3 } : t));
          expectSameTags(b[i]!.raw, r.type === 'ACDB_MLEADEROBJECTCONTEXTDATA_CLASS' && v === 'AC1021' ? withoutR2010(want) : want, `${k} #${i}`);
        });
        const st = annoState(back, back.entityIndex.get(h)!, idx)!;
        expect(st.scales, k).toEqual(['1:10', '1:20']);
        expect(st.current, k).toBe('1:10');
        expect(st.own, k).toBe(false);
      }
    });
  }

  it('주석 치수의 DIMSCALE은 AutoCAD 값(주석이 아닌 스타일이면 0)으로 쓰고, 읽을 때 보이는 축척의 배율로 돌린다', () => {
    const out = writeDxf(f.doc, { version: 'AC1032' as never });
    const back = readCadFile(out.data, 'rt.dxf');
    const h = f.handles.linear!;
    const raw = back.entityIndex.get(h)!.xdata?.find((x) => x.app === 'ACAD')?.items ?? [];
    const i = raw.findIndex((it) => it.code === 1070 && Number(it.value) === 40);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(Number(raw[i + 1]!.value)).toBe(0);
    expect((back.entityIndex.get(h) as DimensionEntity).overrides?.[40]).toBe(10);
    expect((f.doc.entityIndex.get(h) as DimensionEntity).overrides?.[40]).toBe(10);
  });
});

describe('DWG 왕복', () => {
  const f = ctxFixture();
  for (const v of ['AC1032', 'AC1027', 'AC1024', 'AC1018', 'AC1015'] as const) {
    it(v, () => {
      const res = writeDwg(f.doc, { version: v });
      expect(res.warnings.filter((w) => /dropped/.test(w.code))).toEqual([]);
      const back = readCadFile(res.data, 'rt.dwg');
      const idx = new ScaleIndex(back);
      const ver = Number(v.slice(2));
      for (const [k, h] of Object.entries(f.handles)) {
        const a = allRecords(f.doc, h);
        const b = allRecords(back, h);
        expect(b.length, k).toBe(a.length);
        a.forEach((r, i) => {
          const want = r.raw.map((t, j) => (j === 1 ? { code: 70, value: ver >= 1024 ? 4 : 3 } : t));
          // 치수 블록 이름은 DWG에서 순번으로 다시 매겨진다: 다시 읽은 도면의 블록이 있는지만 본다
          const skip = new Set<number>();
          if (r.kind === 'dim') {
            const bi = b[i]!.raw.findIndex((t) => t.code === 2);
            skip.add(bi);
            expect(back.blocks.get(tableKey(String(b[i]!.raw[bi]!.value)))?.entities.length, `${k} 블록`).toBeGreaterThan(0);
          }
          const w = r.type === 'ACDB_MLEADEROBJECTCONTEXTDATA_CLASS' && ver < 1024 ? withoutR2010(want) : want;
          expectSameTags(b[i]!.raw, w, `${k} #${i}`, skip);
        });
        const st = annoState(back, back.entityIndex.get(h)!, idx)!;
        expect(st.scales, k).toEqual(['1:10', '1:20']);
        expect(st.current, k).toBe('1:10');
      }
      // 다시 읽은 주석 치수는 보이는 축척 그림 = 객체의 블록
      const d = back.entityIndex.get(f.handles.linear!) as DimensionEntity;
      const st = annoState(back, d, idx)!;
      expect(dimFields(st.byScale.get('1:10')!)!.block.toUpperCase()).toBe(d.block.toUpperCase());
      expect(d.overrides?.[40]).toBe(10);
      // 파일의 DSTYLE DIMSCALE은 AutoCAD 값 0(주석이 아닌 치수 스타일)
      const items = readDwg(res.data).entityIndex.get(f.handles.linear!)!.xdata?.find((x) => x.app.toUpperCase() === 'ACAD')?.items ?? [];
      const at = items.findIndex((it) => it.code === 1070 && Number(it.value) === 40);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(Number(items[at + 1]!.value)).toBe(0);
    });
  }

  it('R2018 주석 MTEXT: 레코드에서 위치·폭이 돌아온다(객체의 인라인 기록 없음)', () => {
    const back = readDwg(writeDwg(f.doc, { version: 'AC1032' }).data);
    const a = f.doc.entityIndex.get(f.handles.mtext!) as MTextEntity;
    const b = back.entityIndex.get(f.handles.mtext!) as MTextEntity;
    expect(b.width).toBeCloseTo(a.width);
    expect(b.insert.x).toBeCloseTo(a.insert.x);
    expect(b.height).toBeCloseTo(a.height);
  });
});

describe('예전 빌드의 자체 기록(OPENCAD_ANNOSCALE)', () => {
  /** 예전 빌드가 쓰던 꼴: 치수·해치·다중 지시선은 레코드 없이 자체 기록만 */
  function legacy(): { doc: CadDocument; handles: string[] } {
    const { doc, session } = newDoc();
    const own = { current: '1:10', scales: ['1:10', '1:20'] };
    const d = addModel(doc, session, createDimension(doc, session));
    const m = addModel(doc, session, mleader());
    const after = [
      { ...d, overrides: { 40: 10 }, xdata: withOwnRecord(undefined, own) },
      { ...m, xdata: withOwnRecord(undefined, own) },
    ] as Entity[];
    commit(session, [
      { kind: 'modify', block: MODEL_SPACE, before: d, after: after[0]! },
      { kind: 'modify', block: MODEL_SPACE, before: m, after: after[1]! },
    ]);
    return { doc, handles: [d.handle, m.handle] };
  }

  it('DXF로 저장한 파일을 다시 읽어도 축척 목록이 남고, 바꾸면 AutoCAD 레코드가 된다', () => {
    const l = legacy();
    const back = readCadFile(writeDxf(l.doc, { version: 'AC1032' as never }).data, 'old.dxf');
    let n = 1;
    const env = { doc: back, alloc: () => `F${(n++).toString(16).toUpperCase()}`, idx: new ScaleIndex(back) };
    for (const h of l.handles) {
      const e = back.entityIndex.get(h)!;
      const st = annoState(back, e, env.idx)!;
      expect(st.own).toBe(true);
      expect(st.scales).toEqual(['1:10', '1:20']);
      const r = upgradeOwnRecords(env, e);
      expect(r.ops.length).toBeGreaterThan(0);
      expect(r.entity.xdata?.some((x) => x.app === 'OPENCAD_ANNOSCALE')).toBeFalsy();
      const types = r.ops.filter((o) => o.kind === 'object' && o.after && CTX_TYPES.has(o.after.type)).map((o) => (o as { after: GenericObject }).after.type);
      expect(types).toHaveLength(2);
    }
  });
});

describe('편집', () => {
  it('해치·다중 지시선의 보이는 축척 바꾸기는 그 레코드의 선·컨텍스트 자료를 쓰고 기본 표지를 옮긴다', () => {
    const f = ctxFixture();
    const { doc, session } = f;
    for (const k of ['hatch', 'mleader'] as const) {
      const e = doc.entityIndex.get(f.handles[k]!)!;
      const r = switchScale(envOf(doc, session), e, '1:20');
      commit(session, [...r.ops, { kind: 'modify', block: MODEL_SPACE, before: e, after: r.entity }]);
      const now = doc.entityIndex.get(e.handle)!;
      const st = annoState(doc, now)!;
      expect(st.current).toBe('1:20');
      expect(st.records.filter((x) => x.isDefault)).toHaveLength(1);
      if (k === 'hatch') expect((now as HatchEntity).patternLines[0]!.offset.y).toBeCloseTo(2.2450640303 * 20);
      else expect((now as MLeaderEntity).context.textHeight).toBeCloseTo(80);
    }
  });

  it('보이는 축척을 지우면 남은 축척을 보이고 그 레코드·그림만 남는다(치수)', () => {
    const f = ctxFixture();
    const { doc, session } = f;
    const d = doc.entityIndex.get(f.handles.linear!) as DimensionEntity;
    const old = d.block;
    const r = removeScales(envOf(doc, session), d, ['1:10']);
    commit(session, [...r.ops, { kind: 'modify', block: MODEL_SPACE, before: d, after: r.entity }]);
    const now = doc.entityIndex.get(d.handle) as DimensionEntity;
    const st = annoState(doc, now)!;
    expect(st.scales).toEqual(['1:20']);
    expect(now.overrides?.[40]).toBe(20);
    expect(dimFields(st.records[0]!)!.block).toBe(now.block);
    expect(now.block).not.toBe(old);
  });

  it('복사본(확장 사전이 원본 것을 가리킴)은 자기 레코드와 축척마다 새 그림을 얻는다', () => {
    const f = ctxFixture();
    const { doc, session } = f;
    const d = doc.entityIndex.get(f.handles.radius!) as DimensionEntity;
    const copy = { ...d, handle: session.newHandle(), defPoint: { ...d.defPoint, x: d.defPoint.x + 1000 }, defPoint4: { ...d.defPoint4, x: d.defPoint4.x + 1000 }, textMid: { ...d.textMid, x: d.textMid.x + 1000 } };
    const r = cloneRecordsForCopy(envOf(doc, session), copy, d);
    commit(session, [...r.ops, { kind: 'add', block: MODEL_SPACE, entity: r.entity }]);
    const c = doc.entityIndex.get(copy.handle) as DimensionEntity;
    expect(c.xdict).not.toBe(d.xdict);
    const rc = contextRecords(doc, c);
    const ro = contextRecords(doc, d);
    expect(rc).toHaveLength(2);
    const b20c = dimFields(rc.find((x) => !x.isDefault)!)!.block;
    const b20o = dimFields(ro.find((x) => !x.isDefault)!)!.block;
    expect(b20c).not.toBe(b20o);
    expect(doc.blocks.has(tableKey(b20o))).toBe(true);
    expect(dimFields(rc.find((x) => !x.isDefault)!)!.points![0]!.x).toBeGreaterThan(1000);
  });

  it('주석 아님: 레코드와 다른 축척의 그림을 지운다', () => {
    const f = ctxFixture();
    const { doc, session } = f;
    const d = doc.entityIndex.get(f.handles.aligned!) as DimensionEntity;
    const b20 = dimFields(contextRecords(doc, d).find((x) => !x.isDefault)!)!.block;
    const r = makeNonAnnotative(envOf(doc, session), d);
    commit(session, [...r.ops, { kind: 'modify', block: MODEL_SPACE, before: d, after: r.entity }]);
    const now = doc.entityIndex.get(d.handle)!;
    expect(annoState(doc, now)).toBeNull();
    expect(contextRecords(doc, now)).toHaveLength(0);
    expect(doc.blocks.has(tableKey(b20))).toBe(false);
  });

  it('뷰포트의 다른 축척 표현: 다중 지시선은 그 레코드의 컨텍스트 자료로', () => {
    const f = ctxFixture();
    const m = f.doc.entityIndex.get(f.handles.mleader!) as MLeaderEntity;
    const idx = new ScaleIndex(f.doc);
    const v = representation(f.doc, m, annoState(f.doc, m, idx)!, '1:20', idx).entity as MLeaderEntity;
    expect(v.context.textHeight).toBeCloseTo(80);
    expect(v.context.leaders[0]!.lines[0]!.vertices[0]!.x).toBeCloseTo(200);
  });
});
