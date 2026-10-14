/**
 * DWG 동적 블록 객체(src/io/dwg/dyncodec.ts):
 * - AutoCAD 표본 DWG에서 푼 원본 태그 = 같은 도면 AutoCAD DXF의 태그(같은 핸들, ACadSharp sample_AC1015~AC1032).
 * - 표본·예제 도면의 모든 해당 객체가 풀리고, 푼 태그로 다시 쓴 본문 비트가 AutoCAD 원본과 같다.
 * - DWG에서 연 동적 블록의 정의·참조 = DXF에서 연 것. 값을 바꾸고 R2018·R2010·R2004로 저장한 뒤 다시 열어도
 *   정의·참조 캐시·표현 자료가 남는다.
 * - 표본 없이: DWG로 쓸 수 있는 종류만 쓴 동적 블록(dynMiniFixture)과 새로 만든 표현 자료가 DWG로 왕복한다.
 * - 엔진(블랙박스 read_dwg)이 우리가 쓴 DWG를 오류·경고 없이 연다.
 * 표본(CAD_FIXTURES)은 읽기만 한다.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CadDocument, CircleEntity, GenericObject, InsertEntity, RawTag, XRecordObject } from '../../src/core/model';
import { applyOps } from '../../src/edit/session';
import { dynProperties, dynSetOps, readDefinition, readReference } from '../../src/edit/dynblock';
import type { DynDefinition } from '../../src/edit/dynblock';
import { splitRecord } from '../../src/edit/dynblock/reference';
import { readDwg, writeDwg } from '../../src/io/dwg';
import { DYN_TYPES, decodeDyn, encodeDyn, writeDynOps } from '../../src/io/dwg/dyncodec';
import { BitWriter } from '../../src/io/dwg/writer/bitwriter';
import { encoderFor } from '../../src/io/dwg/writer/codepage';
import { readDxf } from '../../src/io/dxf/reader';
import { writeDxf } from '../../src/io/dxf/writer';
import { FIXTURES } from '../dim/compare';
import { dynFixture, dynMiniFixture, loadDyn } from '../dynblock/fixture';
import { engineAvailable, engineRead } from './engine';

const DWG = (v: string) => join(FIXTURES, 'samples', `sample_${v}.dwg`);
const DXF = (v: string) => join(FIXTURES, 'samples-dxf', `sample_${v}_ascii.dxf`);
const VERSIONS = ['AC1015', 'AC1018', 'AC1021', 'AC1024', 'AC1027', 'AC1032'];
const hasSamples = existsSync(DWG('AC1032')) && existsSync(DXF('AC1032'));

function handles(start: number): () => string {
  let n = start;
  return () => (n++).toString(16).toUpperCase();
}

/** 태그 값이 같은지: 수는 상대 1e-9(AutoCAD DXF는 아주 작은 수를 소수 16자리로 자르고, 1.79e+307을 E+99로 쓴다) */
function sameValue(a: string | number, b: string | number): boolean {
  const sa = String(a).trim();
  const sb = String(b).trim();
  const na = Number(sa);
  const nb = Number(sb);
  if (sa !== '' && sb !== '' && Number.isFinite(na) && Number.isFinite(nb)) {
    if (Math.abs(na) > 1e98 && Math.abs(nb) > 1e98) return Math.sign(na) === Math.sign(nb);
    return Math.abs(na - nb) <= 1e-9 * Math.max(1, Math.abs(na), Math.abs(nb));
  }
  return sa.toUpperCase() === sb.toUpperCase();
}

function expectSameTags(a: readonly RawTag[] | undefined, b: readonly RawTag[] | undefined, what: string): void {
  const x = a ?? [];
  const y = b ?? [];
  expect(x.map((t) => t.code), what).toEqual(y.map((t) => t.code));
  x.forEach((t, i) => expect(sameValue(t.value, y[i]!.value), `${what} #${i} ${t.code}: ${t.value} ≠ ${y[i]!.value}`).toBe(true));
}

/** 비교용 직렬화: 수는 1e-9로 반올림(Map은 배열로) */
const ser = (x: unknown): string =>
  JSON.stringify(x, (_k, v: unknown) => {
    if (v instanceof Map) return [...v];
    if (typeof v === 'number') return Math.round(v * 1e9) / 1e9 + 0;
    return v;
  });

/** 정의 비교: 블록 키·이름(R2010 이전 DXF는 *U 이름, DWG 리더는 본래 이름)은 빼고 */
const defShape = (d: DynDefinition | null | undefined) => d && ser({ ...d, key: undefined, blockName: undefined });

const bits = (b: Uint8Array, n: number) => {
  let s = '';
  for (let i = 0; i < n; i++) s += (b[i >> 3]! >> (7 - (i & 7))) & 1;
  return s;
};

/** 다른 형식 계열로 쓴 태그: AcDbBlockElement의 판(300 다음 98·99)은 R2004 이전 25/104, R2007 이후 33/329
 *  (AutoCAD가 같은 도면을 그 형식으로 저장한 값). 같은 계열이면 그대로 */
function elementVersion(raw: readonly RawTag[], from: number, to: number): RawTag[] {
  const old = (v: number) => v < 1021;
  const out = raw.map((t) => ({ ...t }));
  if (old(from) === old(to)) return out;
  const i = out.findIndex((t) => t.code === 100 && t.value === 'AcDbBlockElement');
  if (i >= 0 && out[i + 2]?.code === 98 && out[i + 3]?.code === 99) {
    out[i + 2]!.value = old(to) ? 25 : 33;
    out[i + 3]!.value = old(to) ? 104 : 329;
  }
  return out;
}

const dynObjects = (doc: CadDocument): GenericObject[] => [...doc.objects.values()].filter((o) => DYN_TYPES.has(o.type)) as GenericObject[];

/** 표본과 예제 도면 DWG(있는 것만) */
function dwgFiles(): string[] {
  const out = VERSIONS.map(DWG).filter(existsSync);
  const dir = join(FIXTURES, 'all-samples');
  if (existsSync(dir)) for (const n of readdirSync(dir).sort()) if (n.endsWith('.dwg') && !n.startsWith('sample_')) out.push(join(dir, n));
  return out;
}

// ---------------------------------------------------------------------------

describe.skipIf(!hasSamples)('DWG 동적 블록 객체 = AutoCAD DXF 태그(ACadSharp 표본, 같은 핸들)', () => {
  for (const v of VERSIONS) {
    it(v, () => {
      const a = readDwg(readFileSync(DWG(v)));
      const b = readDxf(readFileSync(DXF(v)));
      const mine = dynObjects(a);
      expect(mine.length).toBeGreaterThanOrEqual(16);
      for (const o of mine) expect(o.raw, `${o.type} ${o.handle}`).toBeTruthy();
      // AutoCAD DXF의 동적 블록 객체는 모두 같은 핸들·같은 태그(R2004 이전 DXF에는 입체 이력의 평가 그래프 둘이 없다)
      const theirs = dynObjects(b);
      expect(theirs.length).toBeGreaterThanOrEqual(16);
      for (const t of theirs) {
        const o = a.objects.get(t.handle) as GenericObject | undefined;
        expect(o?.type, t.handle).toBe(t.type);
        expectSameTags(o!.raw, t.raw, `${t.type} ${t.handle}`);
      }
    });
  }
});

describe.skipIf(!hasSamples)('표본·예제 도면: 모든 동적 블록 객체가 풀리고 다시 쓴 비트가 원본과 같다', () => {
  for (const f of dwgFiles()) {
    const name = f.split('/').pop()!;
    it(name, () => {
      const doc = readDwg(readFileSync(f));
      let n = 0;
      for (const o of dynObjects(doc)) {
        const raw = o.dwgRaw;
        if (!raw) continue;
        const what = `${name} ${o.type} ${o.handle}`;
        // 독립 기준점이 있는 축척 동작은 1011·1012 이름을 확인하지 못해 일부러 풀지 않는다(dyncodec.ts)
        if (!o.raw && o.type === 'BLOCKSCALEACTION' && !/^sample_/.test(name)) continue;
        expect(o.raw, what).toBeTruthy();
        const ver = Number(raw.version.slice(2));
        const block = o.owner ? doc.objects.get(o.owner)?.owner : undefined;
        const ops = encodeDyn(o.type, o.raw, ver, { block });
        expect(ops, what).toBeTruthy();
        const enc = encoderFor('ANSI_1252');
        const d = new BitWriter(ver, enc);
        const s = new BitWriter(ver, enc);
        const hd = new BitWriter(ver, enc);
        if (ver >= 1021) d.strWriter = s;
        writeDynOps(d, hd, ops!, (h) => parseInt(h, 16) || 0);
        expect(bits(d.bytes(), d.pos), what).toBe(bits(raw.data, raw.dataBits));
        expect(bits(s.bytes(), s.pos), what).toBe(bits(raw.strings ?? new Uint8Array(0), raw.stringBits ?? 0));
        n++;
      }
      if (/^sample_/.test(name)) expect(n).toBeGreaterThanOrEqual(18);
    });
  }

  it('같은 버전으로 원본 본문 없이(모델 값으로) 다시 써도 본문 비트가 같다', () => {
    for (const v of ['AC1015', 'AC1018', 'AC1024', 'AC1027', 'AC1032']) {
      const a = readDwg(readFileSync(DWG(v)));
      const b = readDwg(writeDwg(a, { version: v as never, raw: false }).data);
      // my-dynamic-block의 그래프·노드·지움 막기·표현 자료(입체 이력 그래프 둘은 노드가 ACIS 이력이라 빠진다)
      let n = 0;
      for (const o of dynObjects(a)) {
        const x = b.objects.get(o.handle) as GenericObject | undefined;
        if (!x) {
          expect(['D67', 'D6C'], `${v} ${o.type} ${o.handle}`).toContain(o.handle);
          continue;
        }
        const ra = o.dwgRaw!;
        const rb = x.dwgRaw!;
        expect(bits(rb.data, rb.dataBits), `${v} ${o.type} ${o.handle}`).toBe(bits(ra.data, ra.dataBits));
        expect(rb.stringBits ?? 0).toBe(ra.stringBits ?? 0);
        expect(x.raw).toEqual(o.raw);
        n++;
      }
      expect(n).toBe(16);
    }
  });

  it('입체 이력이 아닌 그래프의 노드는 다른 버전으로 써도 남는다(블록 요소 판은 그 형식 계열의 값)', () => {
    const a = readDwg(readFileSync(DWG('AC1032')));
    for (const v of ['AC1015', 'AC1018', 'AC1024'] as const) {
      const b = readDwg(writeDwg(a, { version: v }).data);
      for (const o of dynObjects(a)) {
        if (o.handle === 'D67' || o.handle === 'D6C') continue;
        const x = b.objects.get(o.handle) as GenericObject | undefined;
        expect(x?.type, `${v} ${o.handle}`).toBe(o.type);
        expectSameTags(x!.raw, elementVersion(o.raw!, 1032, Number(v.slice(2))), `${v} ${o.type} ${o.handle}`);
      }
      // AutoCAD가 그 버전으로 저장한 DXF와도 같다
      if (v !== 'AC1024') {
        const ref = readDxf(readFileSync(DXF(v)));
        for (const t of dynObjects(ref)) expectSameTags((b.objects.get(t.handle) as GenericObject).raw, t.raw, `${v} ${t.type} ${t.handle}`);
      }
    }
  });
});

describe.skipIf(!hasSamples)('DWG에서 연 동적 블록(my-dynamic-block, 참조 ABA)', () => {
  for (const v of VERSIONS) {
    it(`${v}: DXF에서 연 것과 같은 정의·참조, 값을 바꾸고 R2018·R2010·R2004로 저장·다시 열어도 남는다`, () => {
      const a = readDwg(readFileSync(DWG(v)));
      const b = readDxf(readFileSync(DXF(v)));
      const ia = a.entityIndex.get('ABA') as InsertEntity;
      const ib = b.entityIndex.get('ABA') as InsertEntity;
      const ra = readReference(a, ia)!;
      const rb = readReference(b, ib)!;
      expect(ra.def.undecoded).toEqual([]);
      expect(defShape(ra.def)).toBe(defShape(rb.def));
      expect(ra.blockKey).toBe(rb.blockKey);
      expect(ra.direct).toBe(rb.direct);
      expect(ser(ra.values)).toBe(ser(rb.values));
      expect(ser(ra.cache)).toBe(ser(rb.cache));
      expect(ser(dynProperties(a, ia))).toBe(ser(dynProperties(b, ib)));

      // 값 바꾸기: 지름 4, 모두 숨김
      const r = dynSetOps(a, ia, [{ key: 'dynamic-diameter', value: 4 }, { key: 'custom_visibility', value: 'visibility_state_hide_all' }], handles(0x20000));
      expect(r.ops.length).toBeGreaterThan(0);
      applyOps(a, r.ops);
      const ins = a.entityIndex.get('ABA') as InsertEntity;
      const want = readReference(a, ins)!;
      expect(want.values.get(23)?.state).toBe('visibility_state_hide_all');
      const radius = (doc: CadDocument, i: InsertEntity) => (doc.blocks.get(i.block.toUpperCase())!.entities.find((e) => e.type === 'CIRCLE') as CircleEntity).radius;

      for (const out of ['AC1032', 'AC1024', 'AC1018'] as const) {
        const w = writeDwg(a, { version: out });
        const c = readDwg(w.data);
        const ic = c.entityIndex.get('ABA') as InsertEntity;
        const rc = readReference(c, ic)!;
        expect(rc, `${v}→${out}`).toBeTruthy();
        expect(rc.def.undecoded).toEqual([]);
        expect(defShape(rc.def)).toBe(defShape(want.def));
        expect(rc.blockKey).toBe(want.blockKey);
        expect(ser(rc.values)).toBe(ser(want.values));
        expect(rc.cache?.records.size).toBe(want.cache?.records.size);
        expect(radius(c, ic)).toBeCloseTo(radius(a, ins), 9);
        // 표현 자료: 정의 블록 레코드를 가리킨다
        const rep = c.objects.get(rc.cache!.repData!) as GenericObject;
        expect(rep.type).toBe('ACDB_BLOCKREPRESENTATION_DATA');
        expectSameTags(rep.raw, [
          { code: 100, value: 'AcDbBlockRepresentationData' },
          { code: 70, value: 1 },
          { code: 340, value: rc.def.recordHandle },
        ], `${out} 표현 자료`);
        // 캐시 레코드는 그대로(DWG 리더는 점을 "x,y,z" 태그 하나로 담으므로 풀어서 비교)
        for (const [id, h] of want.cache!.records) {
          const x = c.objects.get(rc.cache!.records.get(id)!) as XRecordObject;
          expect(ser(splitRecord(x.data)), `${out} 캐시 ${id}`).toBe(ser(splitRecord((a.objects.get(h) as XRecordObject).data)));
        }
        // 다시 연 도면에서 이어서 고칠 수 있다
        const r2 = dynSetOps(c, ic, { key: 'custom_visibility', value: 'visibility_state_show_all' }, handles(0x30000));
        expect(r2.ops.length).toBeGreaterThan(0);
        applyOps(c, r2.ops);
        expect(readReference(c, c.entityIndex.get('ABA') as InsertEntity)!.values.get(23)?.state).toBe('visibility_state_show_all');
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 표본 없이

const OUT_VERSIONS = ['AC1032', 'AC1027', 'AC1024', 'AC1018', 'AC1015'] as const;

describe('표본 없이: DWG로 쓸 수 있는 동적 블록(dynMiniFixture)', () => {
  function edited() {
    const f = dynMiniFixture();
    const doc = loadDyn(f.text);
    const ins = doc.entityIndex.get(f.h.insM!) as InsertEntity;
    const r = dynSetOps(doc, ins, [{ key: '지름', value: 4 }, { key: '보기', value: '원만' }], handles(0x9000));
    applyOps(doc, r.ops);
    return { f, doc };
  }

  it('DXF에서 읽은 정의를 모두 해석한다', () => {
    const f = dynMiniFixture();
    const doc = loadDyn(f.text);
    const def = readDefinition(doc, 'DYN-MINI')!;
    expect(def.undecoded).toEqual([]);
    expect(def.params.map((p) => [p.id, p.kind, p.label])).toEqual([
      [1, 'linear', '지름'],
      [23, 'visibility', '보기'],
    ]);
    expect(def.actions.map((a) => a.kind)).toEqual(['scale']);
    for (const o of dynObjects(doc)) expect(encodeDyn(o.type, o.raw, 1032, { block: f.h.rec }), o.type).toBeTruthy();
  });

  for (const v of OUT_VERSIONS) {
    it(`${v}: 새로 만든 *U·캐시·표현 자료와 정의가 DWG로 왕복한다`, () => {
      const { f, doc } = edited();
      const ins = doc.entityIndex.get(f.h.insM!) as InsertEntity;
      const want = readReference(doc, ins)!;
      expect(want.direct).toBe(false);
      const repWant = doc.objects.get(want.cache!.repData!) as GenericObject;
      expect(repWant.type).toBe('ACDB_BLOCKREPRESENTATION_DATA');

      const w = writeDwg(doc, { version: v });
      expect(w.warnings.filter((x) => /dropped/.test(x.code))).toEqual([]);
      const c = readDwg(w.data);
      // 정의 노드·그래프·지움 막기는 같은 태그(블록 요소 판은 형식 계열의 값)
      for (const o of dynObjects(doc)) {
        const x = c.objects.get(o.handle) as GenericObject | undefined;
        expect(x?.type, `${o.type} ${o.handle}`).toBe(o.type);
        expectSameTags(x!.raw, elementVersion(o.raw!, 1032, Number(v.slice(2))), `${v} ${o.type} ${o.handle}`);
      }
      const ic = c.entityIndex.get(f.h.insM!) as InsertEntity;
      const rc = readReference(c, ic)!;
      expect(rc.def.undecoded).toEqual([]);
      expect(defShape(rc.def)).toBe(defShape(want.def));
      expect(rc.blockKey).toBe(want.blockKey);
      expect(ser(rc.values)).toBe(ser(want.values));
      expect(ser(dynProperties(c, ic)?.map((p) => [p.label, p.value]))).toBe(ser([['지름', 4], ['보기', '원만']]));
      const rep = c.objects.get(rc.cache!.repData!) as GenericObject;
      expectSameTags(rep.raw, repWant.raw, '표현 자료');
      expect(rep.owner).toBe(rc.cache!.rep);
      // 지움 막기 객체의 블록 핸들(DXF에 없는 값)은 소유 사전의 소유자로 쓴다: 같은 버전으로 다시 써도 같은 비트
      const d = readDwg(writeDwg(c, { version: v, raw: false }).data);
      for (const o of dynObjects(c)) {
        const ra = o.dwgRaw!;
        const rb = (d.objects.get(o.handle) as GenericObject).dwgRaw!;
        expect(bits(rb.data, rb.dataBits), `${o.type} ${o.handle}`).toBe(bits(ra.data, ra.dataBits));
        expect(bits(rb.handles, rb.handleBits), `${o.type} ${o.handle} 핸들`).toBe(bits(ra.handles, ra.handleBits));
      }
      // DWG에서 DXF로
      const x = readDxf(writeDxf(c, { version: 'AC1032' }).data);
      expect(ser(readReference(x, x.entityIndex.get(f.h.insM!) as InsertEntity)!.values)).toBe(ser(want.values));
    });
  }

  it('정의 노드를 다른 버전으로 쓸 수 없으면 그래프와 그 노드를 함께 빼고, 새 표현 자료는 남긴다', () => {
    // dynFixture에는 이 쓰기가 아직 모르는 종류(뒤집기·조회·회전·신축·이동)가 있다
    const f = dynFixture();
    const doc = loadDyn(f.text);
    const ins = doc.entityIndex.get(f.h.insA!) as InsertEntity;
    applyOps(doc, dynSetOps(doc, ins, { key: '모양', value: 'B' }, handles(0x9000)).ops);
    const want = readReference(doc, doc.entityIndex.get(f.h.insA!) as InsertEntity)!;
    const repH = want.cache!.repData!;
    const w = writeDwg(doc, { version: 'AC1032' });
    const c = readDwg(w.data);
    const graph = readDefinition(doc, 'DYN-TEST')!.graphHandle;
    expect(c.objects.has(graph)).toBe(false);
    for (const o of doc.objects.values()) if (o.owner === graph) expect(c.objects.has(o.handle), o.type).toBe(false);
    expect(w.warnings.some((x) => x.code === 'dwg.write_object_dropped')).toBe(true);
    const rep = c.objects.get(repH) as GenericObject;
    expectSameTags(rep.raw, (doc.objects.get(repH) as GenericObject).raw, '표현 자료');
    expect(rep.owner).toBe(want.cache!.rep);
    // 표현 블록(*U)과 캐시는 남는다
    const ic = c.entityIndex.get(f.h.insA!) as InsertEntity;
    expect(ic.block.toUpperCase()).toBe(want.blockKey);
    expect([...(c.objects.get(want.cache!.data!) as { entries: Map<string, string> }).entries.keys()]).toEqual([...(doc.objects.get(want.cache!.data!) as { entries: Map<string, string> }).entries.keys()]);
  });

  it('배치가 맞지 않는 태그는 쓰지 않는다(원본 비트 보존 또는 빼기)', () => {
    const tags = (raw: RawTag[]) => encodeDyn('BLOCKLINEARGRIP', raw, 1032);
    const f = dynMiniFixture();
    const doc = loadDyn(f.text);
    const g = dynObjects(doc).find((o) => o.type === 'BLOCKLINEARGRIP')!;
    expect(tags(g.raw!)).toBeTruthy();
    // 서브클래스가 빠짐
    expect(tags(g.raw!.filter((t) => !(t.code === 100 && t.value === 'AcDbBlockLinearGrip')).filter((t) => t.code < 140 || t.code > 142))).toBeNull();
    // 모르는 서브클래스(다른 프로그램이 덧붙인 자료)가 있으면 DWG에 담을 수 없다
    expect(tags([...g.raw!, { code: 100, value: 'AcDbSomethingElse' }, { code: 1, value: 'x' }])).toBeNull();
    // 서브클래스 안에 남는 태그
    expect(tags([...g.raw!, { code: 143, value: 1 }])).toBeNull();
    // 모르는 값 종류의 평가식
    const ge = dynObjects(doc).find((o) => o.type === 'BLOCKGRIPLOCATIONCOMPONENT')!;
    expect(encodeDyn(ge.type, ge.raw!.map((t) => (t.code === 70 ? { ...t, value: 1 } : t)), 1032)).toBeNull();
    // 지움 막기: 블록을 모르면 쓰지 않는다
    const pp = dynObjects(doc).find((o) => o.type === 'ACDB_DYNAMICBLOCKPURGEPREVENTER_VERSION')!;
    expect(encodeDyn(pp.type, pp.raw, 1032)).toBeNull();
    expect(encodeDyn(pp.type, pp.raw, 1032, { block: f.h.rec })).toBeTruthy();
    // 기준점 동작: 1011·1012가 0이 아니면(어느 DWG 점인지 확인하지 못함) 쓰지 않는다
    const sc = dynObjects(doc).find((o) => o.type === 'BLOCKSCALEACTION')!;
    expect(encodeDyn(sc.type, sc.raw, 1032)).toBeTruthy();
    expect(encodeDyn(sc.type, sc.raw!.map((t) => (t.code === 1011 ? { ...t, value: 2 } : t)), 1032)).toBeNull();
    // 읽기: 머리가 -1이 아니면 풀지 않는다
    expect(() => decodeDyn('BLOCKLINEARGRIP', { BL: () => 5 } as never, {} as never, 0)).toThrow();
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(!engineAvailable)('동적 블록 DWG ↔ 엔진(블랙박스)', () => {
  it('엔진이 오류·경고 없이 연다', () => {
    const files = new Map<string, Uint8Array>();
    const f = dynMiniFixture();
    const doc = loadDyn(f.text);
    applyOps(doc, dynSetOps(doc, doc.entityIndex.get(f.h.insM!) as InsertEntity, [{ key: '지름', value: 6 }, { key: '보기', value: '숨김' }], handles(0x9000)).ops);
    for (const v of ['AC1015', 'AC1018', 'AC1024', 'AC1032'] as const) files.set(`mini@${v}`, writeDwg(doc, { version: v }).data);
    if (hasSamples) {
      const a = readDwg(readFileSync(DWG('AC1032')));
      applyOps(a, dynSetOps(a, a.entityIndex.get('ABA') as InsertEntity, { key: 'dynamic-diameter', value: 4 }, handles(0x20000)).ops);
      for (const v of ['AC1018', 'AC1024', 'AC1032'] as const) files.set(`sample@${v}`, writeDwg(a, { version: v, raw: false }).data);
    }
    const res = engineRead(files);
    for (const [k, r] of res) {
      expect(r.ok, `${k}: ${r.error}`).toBe(true);
      // 엔진은 이 객체들을 해석하지 않고 원본으로 남긴다는 알림(dwg.object_preserved)만 낸다
      expect((r.warnings ?? []).filter((w) => !w.includes("'dwg.object_preserved'")), k).toEqual([]);
      expect(r.counts?.ACAD_EVALUATION_GRAPH ?? 0, k).toBeGreaterThanOrEqual(1);
      expect(r.counts?.ACDB_BLOCKREPRESENTATION_DATA ?? 0, k).toBeGreaterThanOrEqual(1);
      expect(r.counts?.BLOCKLINEARPARAMETER ?? 0, k).toBe(1);
    }
  }, 600_000);
});
