/**
 * DWG 리더가 모델이 따로 담지 않는 객체를 DXF와 같은 원본 태그(raw)로 채우는지:
 * - DIMASSOC·ACDB_TEXTOBJECTCONTEXTDATA_CLASS: AutoCAD 표본 DWG의 태그 = 같은 도면 AutoCAD DXF의 태그(같은 핸들).
 * - 모델 값으로 다시 쓴 DWG(raw: false, 같은 버전)의 본문 비트가 원본과 같다. 다른 버전으로 써도 태그가 같다.
 * - FIELD·FIELDLIST: 표본이 없어 사양 배치로 쓴 DWG를 다시 읽어 필드 값·fieldCodesOf가 같은지, 엔진이 여는지.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CadDocument, FieldObject, GenericObject, MTextEntity, RawTag } from '../../src/core/model';
import { readDwg, writeDwg } from '../../src/io/dwg';
import { readDxf } from '../../src/io/dxf/reader';
import { writeDxf } from '../../src/io/dxf/writer';
import { fieldCodesOf, fieldListHandles, fieldOf } from '../../src/io/fields';
import { FIXTURES } from '../oracle/ezdxf';
import { fieldFixture } from '../dxf/field.fixture';
import { engineAvailable, engineRead } from './engine';

const RAW_TYPES = ['DIMASSOC', 'ACDB_TEXTOBJECTCONTEXTDATA_CLASS'];
const DWG = (v: string) => join(FIXTURES, 'samples', `sample_${v}.dwg`);
const DXF = (v: string) => join(FIXTURES, 'samples-dxf', `sample_${v}_ascii.dxf`);

/** 태그 비교용: 숫자는 12자리, 문자열은 앞뒤 공백 없이 */
function norm(raw: readonly RawTag[] | undefined): string[] {
  return (raw ?? []).map((t) => {
    const s = String(t.value).trim();
    if (t.code >= 320 && t.code <= 369) return `${t.code}=${s.toUpperCase()}`;
    const n = Number(s);
    return `${t.code}=${s !== '' && Number.isFinite(n) ? +n.toPrecision(12) : s}`;
  });
}

function rawObjects(doc: CadDocument): Map<string, GenericObject> {
  const m = new Map<string, GenericObject>();
  for (const o of doc.objects.values()) if (RAW_TYPES.includes(o.type)) m.set(o.handle, o as GenericObject);
  return m;
}

const VERSIONS = ['AC1015', 'AC1018', 'AC1021', 'AC1024', 'AC1027', 'AC1032'];

describe.skipIf(!existsSync(DWG('AC1032')))('DWG 원본 태그 = AutoCAD DXF 태그', () => {
  for (const v of VERSIONS) {
    it(v, () => {
      const a = rawObjects(readDwg(readFileSync(DWG(v))));
      const b = rawObjects(readDxf(readFileSync(DXF(v))));
      expect(a.size).toBeGreaterThanOrEqual(3);
      expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
      for (const [h, o] of a) {
        expect(o.raw, `${o.type} ${h}`).toBeTruthy();
        expect(norm(o.raw), `${o.type} ${h}`).toEqual(norm(b.get(h)!.raw));
      }
    });
  }
  it('AC1014(R14) DIMASSOC도 풀린다', () => {
    const a = rawObjects(readDwg(readFileSync(DWG('AC1014'))));
    const b = rawObjects(readDxf(readFileSync(DXF('AC1015'))));
    for (const [h, o] of a) expect(norm(o.raw)).toEqual(norm(b.get(h)!.raw));
  });
});

const bits = (b: Uint8Array, n: number) => {
  let s = '';
  for (let i = 0; i < n; i++) s += (b[i >> 3]! >> (7 - (i & 7))) & 1;
  return s;
};

describe.skipIf(!existsSync(DWG('AC1032')))('DWG 쓰기: 원본 태그로 쓴 객체', () => {
  for (const v of ['AC1015', 'AC1018', 'AC1024', 'AC1027', 'AC1032']) {
    it(`${v}: 모델 값으로 다시 쓴 본문이 AutoCAD 원본과 같은 비트`, () => {
      const a = readDwg(readFileSync(DWG(v)));
      const b = readDwg(writeDwg(a, { version: v as never, raw: false }).data);
      for (const [h, o] of rawObjects(a)) {
        const ra = o.dwgRaw!;
        const rb = (b.objects.get(h) as GenericObject | undefined)?.dwgRaw;
        expect(rb, `${o.type} ${h}`).toBeTruthy();
        expect(bits(rb!.data, rb!.dataBits)).toBe(bits(ra.data, ra.dataBits));
        expect(rb!.stringBits ?? 0).toBe(ra.stringBits ?? 0);
        expect((b.objects.get(h) as GenericObject).raw).toEqual(o.raw);
      }
    });
  }
  for (const [src, dst] of [
    ['AC1032', 'AC1015'],
    ['AC1015', 'AC1032'],
    ['AC1024', 'AC1018'],
  ]) {
    it(`${src} → ${dst}: 다른 버전으로 써도 태그가 같다`, () => {
      const a = readDwg(readFileSync(DWG(src!)));
      const res = writeDwg(a, { version: dst as never });
      const b = readDwg(res.data);
      const dstVer = Number(dst!.slice(2));
      for (const [h, o] of rawObjects(a)) {
        // 주석 축척 자료는 R2000부터 쓴다(AutoCAD SAVEFIDELITY 0과 같다). 클래스 판(70)만 저장 버전의 값(AC1024 이상 4, 그 전 3)
        if (o.type === 'ACDB_TEXTOBJECTCONTEXTDATA_CLASS') {
          const want = o.raw!.map((t, i) => (i === 1 && t.code === 70 ? { code: 70, value: dstVer >= 1024 ? 4 : 3 } : t));
          expect((b.objects.get(h) as GenericObject).raw, `${o.type} ${h}`).toEqual(want);
          continue;
        }
        expect((b.objects.get(h) as GenericObject).raw, `${o.type} ${h}`).toEqual(o.raw);
      }
    });
  }
  it('DXF(AutoCAD) → DWG: DIMASSOC가 남는다', () => {
    const a = readDxf(readFileSync(DXF('AC1032')));
    const b = readDwg(writeDwg(a, { version: 'AC1032' }).data);
    const ra = rawObjects(a);
    const rb = rawObjects(b);
    expect([...rb.keys()].sort()).toEqual([...ra.keys()].sort());
    for (const [h, o] of ra) expect(norm(rb.get(h)!.raw)).toEqual(norm(o.raw));
  });
});

// ---------------------------------------------------------------------------
// FIELD

function mtextOf(doc: CadDocument): MTextEntity {
  return doc.blocks.get('*MODEL_SPACE')!.entities.find((e) => e.type === 'MTEXT') as MTextEntity;
}

function forVersion(f: FieldObject, ver: number): FieldObject {
  if (ver >= 1021) return { ...f, format: undefined };
  const strip = (v: FieldObject['value']) => (v ? { type: v.type, value: v.value } : v);
  return { ...f, format: f.format ?? '', value: strip(f.value), data: f.data?.map((d) => ({ key: d.key, value: strip(d.value)! })) };
}
const clean = (o: unknown) => JSON.parse(JSON.stringify(o));

describe('FIELD DWG 쓰기·다시 읽기', () => {
  for (const version of ['AC1018', 'AC1024', 'AC1027', 'AC1032'] as const) {
    it(version, () => {
      const f = fieldFixture();
      const res = writeDwg(f.doc, { version });
      expect(res.warnings.map((w) => w.code)).not.toContain('dwg.write_object_dropped');
      const back = readDwg(res.data);
      expect(fieldCodesOf(back, mtextOf(back))?.template).toBe(f.template);
      const ver = Number(version.slice(2));
      for (const h of [f.handles.top, f.handles.date, f.handles.area]) {
        const o = back.objects.get(h) as GenericObject;
        expect(o.type).toBe('FIELD');
        expect(clean(o.field)).toEqual(clean(forVersion(fieldOf(f.doc.objects.get(h))!, ver)));
      }
      expect(fieldListHandles((back.objects.get(f.handles.list) as GenericObject).raw)).toEqual([f.handles.top, f.handles.date, f.handles.area]);
      // 다시 DXF로
      const dxf = readDxf(writeDxf(back, { version: 'AC1032' }).data);
      expect(fieldCodesOf(dxf, mtextOf(dxf))?.template).toBe(f.template);
    });
  }
  it('AC1015: FIELD는 R2004부터라 빠진다', () => {
    const f = fieldFixture();
    const back = readDwg(writeDwg(f.doc, { version: 'AC1015' }).data);
    expect([...back.objects.values()].some((o) => o.type === 'FIELD')).toBe(false);
  });
  it('같은 버전으로 다시 쓰면 본문 비트가 같다(원본 본문 없이 모델 값으로)', () => {
    const f = fieldFixture();
    const a = readDwg(writeDwg(f.doc, { version: 'AC1032' }).data);
    const b = readDwg(writeDwg(a, { version: 'AC1032', raw: false }).data);
    for (const h of Object.values(f.handles)) {
      const ra = (a.objects.get(h) as GenericObject).dwgRaw!;
      const rb = (b.objects.get(h) as GenericObject).dwgRaw!;
      expect(bits(rb.data, rb.dataBits)).toBe(bits(ra.data, ra.dataBits));
      expect(rb.stringBits).toBe(ra.stringBits);
    }
  });
});

describe.skipIf(!engineAvailable)('FIELD·DIMASSOC DWG ↔ 엔진(블랙박스)', () => {
  it('엔진이 오류·버린 객체 없이 연다', () => {
    const files = new Map<string, Uint8Array>();
    for (const v of ['AC1018', 'AC1024', 'AC1032'] as const) files.set(`field@${v}`, writeDwg(fieldFixture().doc, { version: v }).data);
    if (existsSync(DXF('AC1032'))) {
      const a = readDxf(readFileSync(DXF('AC1032')));
      for (const v of ['AC1015', 'AC1032'] as const) files.set(`dimassoc-dxf@${v}`, writeDwg(a, { version: v }).data);
      const d = readDwg(readFileSync(DWG('AC1032')));
      files.set('dimassoc-dwg@AC1018', writeDwg(d, { version: 'AC1018' }).data);
    }
    const res = engineRead(files);
    for (const [k, r] of res) {
      expect(r.ok, `${k}: ${r.error}`).toBe(true);
      const bad = (r.warnings ?? []).filter((w) => /invalid|skipped|corrupt/i.test(w));
      expect(bad, k).toEqual([]);
      if (k.startsWith('field')) expect(r.counts?.FIELD ?? 0, k).toBeGreaterThanOrEqual(0);
      if (k.startsWith('dimassoc')) expect(r.counts?.DIMASSOC ?? 0, k).toBe(3);
    }
  }, 600_000);
});
