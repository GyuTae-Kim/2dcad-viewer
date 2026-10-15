/**
 * DWG 동적 블록 객체(src/io/dwg/dyncodec.ts):
 * - AutoCAD 표본 DWG에서 푼 원본 태그 = 같은 도면 AutoCAD DXF의 태그(같은 핸들, ACadSharp sample_AC1015~AC1032).
 * - 표본·예제 도면의 모든 해당 객체가 풀리고, 푼 태그로 다시 쓴 본문 비트가 AutoCAD 원본과 같다.
 * - DWG에서 연 동적 블록의 정의·참조 = DXF에서 연 것. 값을 바꾸고 R2018·R2010·R2004로 저장한 뒤 다시 열어도
 *   정의·참조 캐시·표현 자료가 남는다.
 * - 표본 없이: DWG로 쓸 수 있는 종류만 쓴 동적 블록(dynMiniFixture)과 새로 만든 표현 자료가 DWG로 왕복한다.
 * - 표본 없이: 뒤집기·XY·회전·조회·점·기준점·정렬·극좌표 매개변수, 이동·신축·회전·뒤집기·배열·조회·극좌표 신축 동작과
 *   그 그립(손으로 만든 태그, 배치는 공개 짝 도면에서 확인한 AutoCAD DXF 배치)이 모든 쓰기 버전에서 비트로 왕복하고,
 *   그 종류로 된 정의(dynFixture·dynPointPolarFixture)가 DWG로 저장·다시 열기 뒤에도 같고 고칠 수 있다.
 * - 예제 도면을 다른 버전으로 저장해도 정의가 남는다(값 목록이 있는 XY 매개변수의 정의만 빠진다).
 * - 엔진(블랙박스 read_dwg)이 우리가 쓴 DWG를 오류·경고 없이 연다.
 * 표본(CAD_FIXTURES)은 읽기만 한다. 공개 짝 도면 자체는 시험에 넣지 않는다(확인은 .runtime/dynblock/ 개발 도구로 했다).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CadDocument, CircleEntity, GenericObject, InsertEntity, LineEntity, RawTag, XRecordObject } from '../../src/core/model';
import { applyOps } from '../../src/edit/session';
import { dynProperties, dynSetOps, readDefinition, readReference } from '../../src/edit/dynblock';
import type { DynDefinition } from '../../src/edit/dynblock';
import { splitRecord } from '../../src/edit/dynblock/reference';
import { readDwg, writeDwg } from '../../src/io/dwg';
import { BitReader } from '../../src/io/dwg/bitstream';
import { DYN_TYPES, decodeDyn, encodeDyn, writeDynOps } from '../../src/io/dwg/dyncodec';
import { BitWriter } from '../../src/io/dwg/writer/bitwriter';
import { encoderFor } from '../../src/io/dwg/writer/codepage';
import { readDxf } from '../../src/io/dxf/reader';
import { writeDxf } from '../../src/io/dxf/writer';
import { FIXTURES } from '../dim/compare';
import { dynFixture, dynMiniFixture, dynPointPolarFixture, loadDyn } from '../dynblock/fixture';
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
        // 값 목록이 있는 XY 매개변수(구조 예제 넷)는 목록의 DXF 코드를 확인하지 못해 일부러 풀지 않는다(dyncodec.ts)
        if (!o.raw && o.type === 'BLOCKXYPARAMETER' && /^Structural/.test(name)) continue;
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
        // 핸들 흐름(종류 코드 포함): 원본은 끝에 바이트 맞춤 비트가 붙는다
        expect(bits(raw.handles, raw.handleBits).startsWith(bits(hd.bytes(), hd.pos)) && raw.handleBits - hd.pos < 8, `${what} 핸들`).toBe(true);
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
    // XY-TEST의 XY 매개변수에는 값 목록이 있다(목록의 DXF 코드를 확인하지 못해 DWG로 쓰지 않는다). DYN-TEST는 모두 쓴다.
    const f = dynFixture();
    const doc = loadDyn(f.text);
    const ins = doc.entityIndex.get(f.h.insA!) as InsertEntity;
    applyOps(doc, dynSetOps(doc, ins, { key: '모양', value: 'B' }, handles(0x9000)).ops);
    const want = readReference(doc, doc.entityIndex.get(f.h.insA!) as InsertEntity)!;
    const repH = want.cache!.repData!;
    const w = writeDwg(doc, { version: 'AC1032' });
    const c = readDwg(w.data);
    const graph = readDefinition(doc, 'XY-TEST')!.graphHandle;
    expect(c.objects.has(graph)).toBe(false);
    for (const o of doc.objects.values()) if (o.owner === graph) expect(c.objects.has(o.handle), o.type).toBe(false);
    expect(w.warnings.some((x) => x.code === 'dwg.write_object_dropped')).toBe(true);
    const keep = readDefinition(doc, 'DYN-TEST')!.graphHandle;
    for (const o of doc.objects.values()) if (o.owner === keep || o.handle === keep) expect(c.objects.get(o.handle)?.type, o.type).toBe(o.type);
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
    // 기준점 동작: 1011은 첫 3BD, 1012는 둘째 3BD(독립 기준점 회전 동작의 공개 짝 도면으로 확인)
    const sc = dynObjects(doc).find((o) => o.type === 'BLOCKSCALEACTION')!;
    expect(encodeDyn(sc.type, sc.raw, 1032)).toBeTruthy();
    const moved = encodeDyn(sc.type, sc.raw!.map((t) => (t.code === 1011 ? { ...t, value: 2 } : t)), 1032)!;
    expect(moved.filter((op) => op.t === '3BD').map((op) => (op as { v: { x: number } }).v.x)).toEqual([0, 2, 0]);
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
    // 새 종류(뒤집기·조회·회전·신축·이동·점·극좌표)로 된 정의
    const dyn = loadDyn(dynFixture().text);
    const pp = loadDyn(dynPointPolarFixture().text);
    const more = new Map<string, Uint8Array>();
    for (const v of ['AC1015', 'AC1018', 'AC1024', 'AC1032'] as const) {
      more.set(`dyn@${v}`, writeDwg(dyn, { version: v }).data);
      more.set(`pointpolar@${v}`, writeDwg(pp, { version: v }).data);
    }
    for (const [k, r] of engineRead(more)) {
      expect(r.ok, `${k}: ${r.error}`).toBe(true);
      expect((r.warnings ?? []).filter((w) => !w.includes("'dwg.object_preserved'")), k).toEqual([]);
      expect(r.counts?.ACAD_EVALUATION_GRAPH ?? 0, k).toBeGreaterThanOrEqual(k.startsWith('dyn') ? 1 : 2);
      if (k.startsWith('dyn')) for (const t of ['BLOCKFLIPPARAMETER', 'BLOCKLOOKUPACTION', 'BLOCKROTATEACTION', 'BLOCKSTRETCHACTION']) expect(r.counts?.[t] ?? 0, `${k} ${t}`).toBeGreaterThanOrEqual(1);
      else for (const t of ['BLOCKPOINTPARAMETER', 'BLOCKPOLARPARAMETER', 'BLOCKPOLARSTRETCHACTION', 'BLOCKMOVEACTION']) expect(r.counts?.[t] ?? 0, `${k} ${t}`).toBe(1);
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

// ---------------------------------------------------------------------------
// 새 종류(뒤집기·XY·회전·조회·이동·신축 등): 손으로 만든 태그로

// 손으로 만든 자료에 한글 이름이 있어 R2007 이전 문자열은 한국어 코드 페이지로
const ENC = encoderFor('ANSI_949');
const DEC = new TextDecoder('euc-kr');

/** 태그 → DWG 본문 비트 → 태그(쓰기 버전 ver). 풀 수 없으면 null */
function codecRoundTrip(type: string, raw: readonly RawTag[], ver: number, block?: string): RawTag[] | null {
  const ops = encodeDyn(type, raw, ver, { block });
  if (!ops) return null;
  const d = new BitWriter(ver, ENC);
  const s = new BitWriter(ver, ENC);
  const hd = new BitWriter(ver, ENC);
  if (ver >= 1021) d.strWriter = s;
  writeDynOps(d, hd, ops, (h) => parseInt(h, 16) || 0);
  const r = new BitReader(d.bytes(), ver, DEC);
  r.end = d.pos;
  if (ver >= 1021) {
    const sr = new BitReader(s.bytes(), ver, DEC);
    sr.end = s.pos;
    r.strReader = sr;
  }
  const hr = new BitReader(hd.bytes(), ver, DEC);
  hr.end = hd.pos;
  const tags = decodeDyn(type, r, hr, 0x10, { block });
  expect(r.pos, `${type} 자료 끝`).toBe(r.end);
  if (ver >= 1021) expect(r.strReader.pos, `${type} 문자열 끝`).toBe(r.strReader.end);
  return tags;
}

const T = (list: [number, string | number][]): RawTag[] => list.map(([code, value]) => ({ code, value }));
const HEAD = (id: number, name: string): [number, string | number][] => [
  [100, 'AcDbEvalExpr'],
  [90, id],
  [98, 33],
  [99, 329],
  [100, 'AcDbBlockElement'],
  [300, name],
  [98, 33],
  [99, 329],
  [1071, 0],
];
const PARAM: [number, number][] = [
  [100, 'AcDbBlockParameter'] as never,
  [280, 1],
  [281, 0],
];
const TWO_PT = (a: [number, number], b: [number, number]): [number, string | number][] => [
  [100, 'AcDbBlock2PtParameter'],
  [1010, a[0]],
  [1020, a[1]],
  [1030, 0],
  [1011, b[0]],
  [1021, b[1]],
  [1031, 0],
  [170, 4],
  [91, 2],
  [91, 0],
  [91, 0],
  [91, 0],
  [171, 0],
  [172, 0],
  [173, 1],
  [94, 2],
  [303, 'DisplacementX'],
  [174, 1],
  [95, 2],
  [304, 'DisplacementY'],
  [177, 0],
];
const ACTION = (id: number, name: string, ents: string[]): [number, string | number][] => [
  ...HEAD(id, name),
  [100, 'AcDbBlockAction'],
  [70, 1],
  [91, 7],
  [71, ents.length],
  ...ents.map((h) => [330, h] as [number, string]),
  [1010, 1.5],
  [1020, -0.5],
  [1030, 0],
];

/** 손으로 만든 태그(값은 시험용) — dynFixture·dynPointPolarFixture에 없는 종류 */
const HAND: [string, RawTag[]][] = [
  ['BLOCKALIGNMENTPARAMETER', T([...HEAD(1, 'Alignment'), ...PARAM, ...TWO_PT([5, 5], [19.5, 13.25]), [100, 'AcDbBlockAlignmentParameter'], [280, 1]])],
  [
    'BLOCKALIGNMENTGRIP',
    T([...HEAD(2, 'Grip'), [100, 'AcDbBlockGrip'], [91, 3], [92, 4], [1010, 5], [1020, 5], [1030, 0], [280, 1], [93, -1], [100, 'AcDbBlockAlignmentGrip'], [140, 14.5], [141, 8.25], [142, 0]]),
  ],
  [
    'BLOCKBASEPOINTPARAMETER',
    T([
      ...HEAD(1, 'Base Point'),
      ...PARAM,
      [100, 'AcDbBlock1PtParameter'],
      [1010, 5],
      [1020, 5],
      [1030, 0],
      [93, 0],
      [170, 0],
      [171, 0],
      [100, 'AcDbBlockBasepointParameter'],
      [1011, 1],
      [1021, 2],
      [1031, 0],
      [1012, 3],
      [1022, 4],
      [1032, 0],
    ]),
  ],
  [
    'BLOCKXYPARAMETER',
    T([
      ...HEAD(1, 'XY'),
      ...PARAM,
      ...TWO_PT([0, 5], [5, 0]),
      [100, 'AcDbBlockXYParameter'],
      [305, 'Height'],
      [306, 'Width'],
      [307, 'height desc'],
      [308, 'width desc'],
      [141, 1.5],
      [140, 1.25],
      [309, ''],
      [97, 5],
      [146, 1],
      [147, 0],
      [148, 1],
      [176, 0],
      [410, ''],
      [96, 7],
      [142, 0.5],
      [143, 9],
      [144, 0.25],
      [175, 0],
    ]),
  ],
  [
    'BLOCKARRAYACTION',
    T([...ACTION(14, 'Array', ['27F', '280']), [100, 'AcDbBlockArrayAction'], [92, 1], [93, 1], [94, 1], [95, 1], [301, 'Base'], [302, 'End'], [303, 'UpdatedBase'], [304, 'UpdatedEnd'], [140, 20], [141, 25]]),
  ],
  [
    'BLOCKSTRETCHACTION',
    T([
      ...ACTION(19, 'Stretch', ['5FC', '5FD']),
      [100, 'AcDbBlockStretchAction'],
      [92, 11],
      [301, 'EndXDelta'],
      [93, 11],
      [302, 'EndYDelta'],
      [72, 2],
      [1011, 4.25],
      [1021, -0.25],
      [1011, 5.5],
      [1021, 1.25],
      [73, 2],
      [331, '5FC'],
      [74, 2],
      [94, 1],
      [94, 2],
      [331, '5FD'],
      [74, 1],
      [94, 0],
      [75, 2],
      [95, 31],
      [76, 1],
      [94, 1],
      [95, 54],
      [76, 2],
      [94, 0],
      [94, 1],
      [140, 1],
      [141, 0.5],
      [280, 2],
    ]),
  ],
  [
    'BLOCKGRIPLOCATIONCOMPONENT',
    T([[100, 'AcDbEvalExpr'], [90, 3], [98, 33], [99, 329], [1, ''], [70, 70], [70, 1], [100, 'AcDbBlockGripExpr'], [91, 1], [300, 'UpdatedFlip']]),
  ],
];

/** 손으로 만든 자료의 동적 블록 객체(지움 막기 객체의 블록 = 소유 사전의 소유자) */
function fixtureObjects(): { o: GenericObject; block?: string }[] {
  const out: { o: GenericObject; block?: string }[] = [];
  for (const text of [dynFixture().text, dynPointPolarFixture().text, dynMiniFixture().text]) {
    const doc = loadDyn(text);
    for (const o of dynObjects(doc)) out.push({ o, block: o.owner ? doc.objects.get(o.owner)?.owner : undefined });
  }
  return out;
}

describe('새 종류: 손으로 만든 태그 → DWG 본문 비트 → 같은 태그', () => {
  for (const ver of [1015, 1018, 1024, 1027, 1032]) {
    it(`AC${ver}`, () => {
      const seen = new Set<string>();
      for (const { o, block } of fixtureObjects()) {
        // XY-TEST의 XY 매개변수는 값 목록이 있어 풀지 않는다(아래에서 따로)
        if (o.type === 'BLOCKXYPARAMETER') continue;
        const back = codecRoundTrip(o.type, o.raw!, ver, block);
        expect(back, `${o.type} ${o.handle}`).toBeTruthy();
        expectSameTags(back!, elementVersion(o.raw!, 1032, ver), `AC${ver} ${o.type} ${o.handle}`);
        seen.add(o.type);
      }
      for (const [type, raw] of HAND) {
        const back = codecRoundTrip(type, raw, ver);
        expect(back, type).toBeTruthy();
        expectSameTags(back!, elementVersion(raw, 1032, ver), `AC${ver} ${type}`);
        seen.add(type);
      }
      // 풀고 쓸 수 있는 종류를 모두 거쳤다
      expect([...DYN_TYPES].filter((t) => !seen.has(t))).toEqual([]);
    });
  }

  it('확인하지 못한 자료는 쓰지 않는다: XY·극좌표 값 목록, 극좌표 신축의 점 묶음, 비지 않은 DXF 자리 표시', () => {
    const xy = HAND.find(([t]) => t === 'BLOCKXYPARAMETER')![1];
    expect(encodeDyn('BLOCKXYPARAMETER', xy, 1032)).toBeTruthy();
    const withList = xy.flatMap((t) => (t.code === 175 ? [{ code: 175, value: 1 }, { code: 145, value: 2 }] : [t]));
    expect(encodeDyn('BLOCKXYPARAMETER', withList, 1032)).toBeNull();
    expect(encodeDyn('BLOCKXYPARAMETER', xy.map((t) => (t.code === 309 ? { ...t, value: 'x' } : t)), 1032)).toBeNull();
    const ps = fixtureObjects().find(({ o }) => o.type === 'BLOCKPOLARSTRETCHACTION')!.o.raw!;
    expect(encodeDyn('BLOCKPOLARSTRETCHACTION', ps.map((t) => (t.code === 72 ? { ...t, value: 1 } : t)), 1032)).toBeNull();
    expect(encodeDyn('BLOCKPOLARSTRETCHACTION', ps.map((t) => (t.code === 75 ? { ...t, value: 1 } : t)).flatMap((t) => (t.code === 75 ? [t, { code: 76, value: 1 }, { code: 78, value: 2 }] : [t])), 1032)).toBeNull();
    const pp = fixtureObjects().find(({ o }) => o.type === 'BLOCKPOLARPARAMETER')!.o.raw!;
    expect(encodeDyn('BLOCKPOLARPARAMETER', pp.flatMap((t) => (t.code === 176 ? [{ code: 176, value: 1 }, { code: 148, value: 1 }] : [t])), 1032)).toBeNull();
    // 평가식 값 종류 70(정수)은 쓰고, 모르는 값 종류는 쓰지 않는다
    const ge = HAND.find(([t]) => t === 'BLOCKGRIPLOCATIONCOMPONENT')![1];
    expect(encodeDyn('BLOCKGRIPLOCATIONCOMPONENT', ge, 1032)).toBeTruthy();
    expect(encodeDyn('BLOCKGRIPLOCATIONCOMPONENT', ge.map((t, i) => (i === 5 ? { ...t, value: 90 } : t)), 1032)).toBeNull();
  });
});

describe('새 종류로 된 정의(dynFixture DYN-TEST, dynPointPolarFixture)가 DWG로 왕복한다', () => {
  for (const v of OUT_VERSIONS) {
    it(v, () => {
      // DYN-TEST: 선형·가시성·뒤집기·조회·회전 매개변수, 신축·이동·뒤집기·조회·회전 동작
      const f = dynFixture();
      const doc = loadDyn(f.text);
      applyOps(doc, dynSetOps(doc, doc.entityIndex.get(f.h.insA!) as InsertEntity, [{ key: '반전', value: true }, { key: '각도', value: Math.PI / 2 }], handles(0x9000)).ops);
      const g = dynPointPolarFixture();
      const pdoc = loadDyn(g.text);
      applyOps(pdoc, dynSetOps(pdoc, pdoc.entityIndex.get(g.h.insQ!) as InsertEntity, [{ key: '1:d', value: 2 }, { key: '1:a', value: Math.PI / 2 }], handles(0x9000)).ops);
      applyOps(pdoc, dynSetOps(pdoc, pdoc.entityIndex.get(g.h.insP!) as InsertEntity, { key: '1:x', value: 5 }, handles(0x9100)).ops);
      for (const [d, keys] of [
        [doc, [f.h.insA!, f.h.insB!]],
        [pdoc, [g.h.insP!, g.h.insQ!]],
      ] as const) {
        const w = writeDwg(d, { version: v });
        const c = readDwg(w.data);
        for (const o of dynObjects(d)) {
          if (readDefinition(d, 'XY-TEST')?.graphHandle === o.owner || readDefinition(d, 'XY-TEST')?.graphHandle === o.handle) continue;
          const x = c.objects.get(o.handle) as GenericObject | undefined;
          expect(x?.type, `${v} ${o.type} ${o.handle}`).toBe(o.type);
          expectSameTags(x!.raw, elementVersion(o.raw!, 1032, Number(v.slice(2))), `${v} ${o.type} ${o.handle}`);
        }
        for (const k of keys) {
          const want = readReference(d, d.entityIndex.get(k) as InsertEntity)!;
          const got = readReference(c, c.entityIndex.get(k) as InsertEntity)!;
          expect(got.def.undecoded).toEqual([]);
          expect(defShape(got.def)).toBe(defShape(want.def));
          expect(ser(got.values)).toBe(ser(want.values));
          expect(ser(dynProperties(c, c.entityIndex.get(k) as InsertEntity))).toBe(ser(dynProperties(d, d.entityIndex.get(k) as InsertEntity)));
        }
      }
      // 다시 연 도면에서 이어서 고칠 수 있다(극좌표 각도 0 → 지시선이 오른쪽)
      const c = readDwg(writeDwg(pdoc, { version: v }).data);
      const r = dynSetOps(c, c.entityIndex.get(g.h.insQ!) as InsertEntity, { key: '1:a', value: 0 }, handles(0x30000));
      expect(r.ops.length).toBeGreaterThan(0);
      applyOps(c, r.ops);
      const ins = c.entityIndex.get(g.h.insQ!) as InsertEntity;
      const line = c.blocks.get(ins.block.toUpperCase())!.entities.find((e) => e.type === 'LINE') as LineEntity;
      expect(line.start.x).toBeCloseTo(2, 9);
      expect(line.end.x).toBeCloseTo(0.25, 9);
    });
  }
});

const EXAMPLES = ['Annotation - Imperial.dwg', 'Architectural - Imperial.dwg', 'Civil - Metric.dwg', 'Electrical - Imperial.dwg', 'Mechanical - Metric.dwg', 'Structural - Metric.dwg'].map((n) => join(FIXTURES, 'all-samples', n));

describe.skipIf(!EXAMPLES.every(existsSync))('예제 도면: 다른 버전으로 저장해도 동적 블록 정의가 남는다', () => {
  for (const file of EXAMPLES) {
    const name = file.split('/').pop()!;
    it(name, () => {
      const a = readDwg(readFileSync(file));
      const keys = [...a.blocks.keys()].filter((k) => readDefinition(a, k));
      expect(keys.length).toBeGreaterThan(0);
      // 값 목록이 있는 XY 매개변수(구조 예제)만 풀지 않고, 그 정의는 다른 버전으로 쓸 수 없다
      const writable = (k: string) => !readDefinition(a, k)!.undecoded.length;
      for (const k of keys) {
        const u = readDefinition(a, k)!.undecoded;
        expect(u.filter((t) => t !== 'BLOCKXYPARAMETER'), `${name} ${k}`).toEqual([]);
        if (u.length) expect(name).toMatch(/^Structural/);
      }
      const ver = a.header.get('$ACADVER') === 'AC1032' ? 'AC1018' : 'AC1032';
      const b = readDwg(writeDwg(a, { version: ver }).data);
      let n = 0;
      for (const k of keys) {
        const da = readDefinition(a, k)!;
        const db = readDefinition(b, k);
        if (!writable(k)) {
          expect(db, `${name} ${k}`).toBeNull();
          continue;
        }
        expect(db?.undecoded, `${name} ${k}`).toEqual([]);
        expect(defShape(db), `${name} ${k}`).toBe(defShape(da));
        n++;
      }
      // 구조 예제는 두 정의 모두 값 목록이 있는 XY 매개변수를 쓴다
      if (!/^Structural/.test(name)) expect(n).toBeGreaterThan(0);
    }, 120_000);
  }
});
