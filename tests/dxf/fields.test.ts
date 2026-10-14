/**
 * AutoCAD 필드(FIELD·FIELDLIST): DXF 태그 ↔ 모델 값, fieldCodesOf(객체의 필드 코드), DXF 쓰기·다시 읽기, ezdxf.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CadDocument, FieldObject, GenericObject, MTextEntity, RawTag } from '../../src/core/model';
import { readDxf } from '../../src/io/dxf/reader';
import { decodeCadEscapes } from '../../src/core/codepage';
import { writeDxf } from '../../src/io/dxf/writer';
import { fieldCodesOf, fieldFromTags, fieldListHandles, fieldOf, fieldTags } from '../../src/io/fields';
import { PYTHON } from '../oracle/ezdxf';
import { OUT, ROOT, hasPython } from './writer.helpers';
import { fieldFixture } from './field.fixture';

function mtextOf(doc: CadDocument): MTextEntity {
  return doc.blocks.get('*MODEL_SPACE')!.entities.find((e) => e.type === 'MTEXT') as MTextEntity;
}

/** R2007 이전 형식에는 값의 플래그·단위·형식·값 문자열이 없다 */
function forVersion(f: FieldObject, ver: number): FieldObject {
  if (ver >= 1021) return { ...f, format: undefined };
  const strip = (v: FieldObject['value']) => (v ? { type: v.type, value: v.value } : v);
  return { ...f, format: f.format ?? '', value: strip(f.value), data: f.data?.map((d) => ({ key: d.key, value: strip(d.value)! })) };
}

/** 비교용: undefined 빼기, R2007 이전 DXF의 \\U+XXXX 풀기 */
const clean = (o: unknown) => JSON.parse(JSON.stringify(o, (_k, v: unknown) => (typeof v === 'string' ? decodeCadEscapes(v) : v)));

describe('FIELD 태그 ↔ 모델', () => {
  it('fieldCodesOf: _FldIdx·_ObjIdx를 풀어 앱 템플릿 표기로', () => {
    const f = fieldFixture();
    const r = fieldCodesOf(f.doc, f.mtext)!;
    expect(r.template).toBe(f.template);
    expect(r.codes).toEqual(['%<\\AcVar Date \\f "yyyy-MM-dd">%', `%<\\AcObjProp Object(%<\\_ObjId ${f.circle.handle}>%).Area \\f "%lu2">%`]);
    expect(r.handle).toBe(f.handles.top);
    expect(r.value).toBe('2026-01-02 날짜 314.16');
    // 필드가 없는 객체
    expect(fieldCodesOf(f.doc, f.circle)).toBeNull();
  });

  for (const ver of [1018, 1032]) {
    it(`태그 왕복(${ver})`, () => {
      const f = fieldFixture(false);
      for (const h of Object.values(f.handles).slice(0, 3)) {
        const fo = fieldOf(f.doc.objects.get(h))!;
        expect(clean(fieldFromTags(fieldTags(fo, ver)))).toEqual(clean(forVersion(fo, ver)));
      }
    });
  }

  it('긴 코드·값 문자열은 255자 조각(2·3, 301·9)', () => {
    const code = '\\AcVar ' + 'x'.repeat(600);
    const f: FieldObject = { evaluator: 'AcVar', code, children: [], objects: [], evalOptions: 1, filingOptions: 0, state: 0, evalStatus: 1, errorCode: 0, errorMessage: '', valueString: 'y'.repeat(300) };
    const tags = fieldTags(f, 1032);
    expect(tags.filter((t) => t.code === 3)).toHaveLength(2);
    expect(tags.filter((t) => t.code === 9)).toHaveLength(1);
    expect(tags.find((t) => t.code === 98)?.value).toBe(300);
    const back = fieldFromTags(tags)!;
    expect(back.code).toBe(code);
    expect(back.valueString).toBe('y'.repeat(300));
  });

  it('DXF 참조 순서의 태그(값 문자열 값, 정수 값, 객체 ID 값)', () => {
    const raw: RawTag[] = [
      { code: 100, value: 'AcDbField' },
      { code: 1, value: 'AcObjProp' },
      { code: 2, value: '\\AcObjProp Object(%<\\_ObjIdx 0>%).Layer' },
      { code: 90, value: 0 },
      { code: 97, value: 1 },
      { code: 331, value: '2A' },
      { code: 91, value: 63 },
      { code: 92, value: 0 },
      { code: 94, value: 59 },
      { code: 95, value: 2 },
      { code: 96, value: 0 },
      { code: 300, value: '' },
      { code: 93, value: 1 },
      { code: 6, value: 'ACFD_FIELDTEXT_CHECKSUM' },
      { code: 93, value: 0 },
      { code: 90, value: 1 },
      { code: 91, value: 77 },
      { code: 94, value: 0 },
      { code: 300, value: '' },
      { code: 302, value: '' },
      { code: 304, value: 'ACVALUE_END' },
      { code: 7, value: 'ACFD_FIELD_VALUE' },
      { code: 93, value: 0 },
      { code: 90, value: 64 },
      { code: 330, value: '2A' },
      { code: 94, value: 0 },
      { code: 300, value: '' },
      { code: 302, value: '0' },
      { code: 304, value: 'ACVALUE_END' },
      { code: 301, value: '0' },
      { code: 98, value: 1 },
    ];
    const f = fieldFromTags(raw)!;
    expect(f.objects).toEqual(['2A']);
    expect(f.evalOptions).toBe(63);
    expect(f.data).toEqual([{ key: 'ACFD_FIELDTEXT_CHECKSUM', value: { flags: 0, type: 1, value: 77, unit: 0, format: '', text: '' } }]);
    expect(f.value).toEqual({ flags: 0, type: 64, value: '2A', unit: 0, format: '', text: '0' });
    expect(f.valueString).toBe('0');
  });
});

describe('FIELD DXF 쓰기·다시 읽기', () => {
  for (const version of ['AC1018', 'AC1021', 'AC1032'] as const) {
    it(version, () => {
      const f = fieldFixture();
      const res = writeDxf(f.doc, { version });
      const back = readDxf(res.data);
      const r = fieldCodesOf(back, mtextOf(back));
      expect(r?.template).toBe(f.template);
      const ver = Number(version.slice(2));
      for (const h of [f.handles.top, f.handles.date, f.handles.area]) {
        const o = back.objects.get(h) as GenericObject;
        expect(o.type).toBe('FIELD');
        expect(clean(o.field)).toEqual(clean(forVersion(fieldOf(f.doc.objects.get(h))!, ver)));
      }
      expect(fieldListHandles((back.objects.get(f.handles.list) as GenericObject).raw)).toEqual([f.handles.top, f.handles.date, f.handles.area]);
    });
  }

  it('AC1015: FIELD는 R2004부터라 빠진다', () => {
    const f = fieldFixture();
    const back = readDxf(writeDxf(f.doc, { version: 'AC1015' }).data);
    expect([...back.objects.values()].some((o) => o.type === 'FIELD')).toBe(false);
    expect(fieldCodesOf(back, mtextOf(back))).toBeNull();
  });
});

describe.skipIf(!hasPython)('FIELD DXF ↔ ezdxf', () => {
  for (const version of ['AC1018', 'AC1032'] as const) {
    it(`${version}: audit 오류 없음, FIELD 3개·FIELDLIST 1개`, () => {
      const f = fieldFixture();
      mkdirSync(OUT, { recursive: true });
      const src = join(OUT, `fields-${version}.dxf`);
      writeFileSync(src, writeDxf(f.doc, { version }).data);
      const out = src + '.audit.json';
      execFileSync(PYTHON, ['-I', join(ROOT, 'scripts/oracle/ezdxf_audit.py'), out, '--summary', src], { stdio: 'pipe', timeout: 120_000 });
      const res = JSON.parse(readFileSync(out, 'utf8'))[src];
      expect(res.ok).toBe(true);
      expect(res.errors).toEqual([]);
      const count = execFileSync(PYTHON, ['-I', '-c', 'import sys, ezdxf\nd = ezdxf.readfile(sys.argv[1])\nprint(sum(1 for e in d.objects if e.dxftype() == "FIELD"), sum(1 for e in d.objects if e.dxftype() == "FIELDLIST"))', src], { encoding: 'utf8' }).trim();
      expect(count).toBe('3 1');
    });
  }
});
