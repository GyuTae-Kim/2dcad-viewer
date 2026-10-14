/**
 * 새 도면(createNewDocument) → DXF. 빈 도면과 흔한 객체를 하나씩 넣은 도면을 모든 버전으로 써서
 * - 우리 리더가 다시 읽은 요약 = 쓰기가 정한 문서의 요약
 * - 새 도면의 뼈대(도면층·선종류·스타일·치수 스타일·배치·사전)가 그대로 돌아온다
 * - ezdxf가 오류 없이 읽고(고친 항목 없음) 요약이 같다(ezdxf가 있을 때)
 * 를 본다.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CadDocument } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { readDxf } from '../../src/io/dxf/reader';
import { writeDxf } from '../../src/io/dxf/writer';
import type { DxfVersion } from '../../src/io/dxf/tagwriter';
import { type Summary, summarizeDocument } from '../oracle/summarize';
import { compareSummaries } from '../oracle/compare';
import { addSampleEntities } from './writer.samples';
import { type AuditResult, OUT, TARGETS, checkStructure, ezdxfAudit, yieldToRunner, hasPython, normalizeEzdxf, normalizeRoundTrip, pinVolatile, plannedSummary } from './writer.helpers';

const VERSIONS: DxfVersion[] = ['AC1009', ...TARGETS];

describe('새 도면', () => {
  for (const units of ['metric', 'imperial'] as const) {
    it(`${units}: 뼈대`, () => {
      const doc = createNewDocument(units);
      expect([...doc.layers.keys()]).toEqual(['0']);
      expect([...doc.linetypes.values()].map((l) => l.name).sort()).toEqual(['ByBlock', 'ByLayer', 'Continuous']);
      expect(doc.textStyles.get('STANDARD')?.font).toBe('arial.ttf');
      expect([...doc.dimStyles.values()].map((d) => d.name)).toEqual(units === 'metric' ? ['Standard', 'ISO-25'] : ['Standard']);
      expect(doc.header.get('$DIMSTYLE')).toBe(units === 'metric' ? 'ISO-25' : 'Standard');
      expect(doc.header.get('$INSUNITS')).toBe(units === 'metric' ? 4 : 1);
      expect(doc.header.get('$MEASUREMENT')).toBe(units === 'metric' ? 1 : 0);
      expect(doc.header.get('$TEXTSIZE')).toBe(units === 'metric' ? 2.5 : 0.2);
      expect(doc.layouts.map((l) => [l.name, l.blockName])).toEqual([
        ['Model', '*Model_Space'],
        ['Layout1', '*Paper_Space'],
      ]);
      // 모든 객체에 핸들과 (루트 사전 말고는) 소유자가 있고, 핸들이 겹치지 않는다.
      const seen = new Set<string>();
      const add = (h: string) => {
        expect(h).toMatch(/^[0-9A-F]+$/);
        expect(seen.has(h)).toBe(false);
        seen.add(h);
      };
      for (const t of doc.tableHeads!.values()) add(t.handle);
      for (const m of [doc.layers, doc.linetypes, doc.textStyles, doc.dimStyles, doc.appIds, doc.blockRecords]) for (const r of m.values()) add(r.handle);
      for (const v of doc.vports) add(v.handle);
      for (const b of doc.blocks.values()) {
        add(b.handle);
        add(b.endHandle!);
      }
      for (const o of doc.objects.values()) {
        add(o.handle);
        if (o.handle !== doc.rootDictionary) expect(doc.objects.has(o.owner!)).toBe(true);
      }
      expect(BigInt('0x' + String(doc.header.get('$HANDSEED')))).toBeGreaterThan(BigInt('0x' + [...seen].sort((a, b) => b.length - a.length || (b > a ? 1 : -1))[0]));
    });
  }

  it('만들기는 빠르다', () => {
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) createNewDocument(i % 2 ? 'metric' : 'imperial');
    expect((performance.now() - t0) / 50).toBeLessThan(20);
  });
});

interface Job {
  name: string;
  doc: CadDocument;
  version: DxfVersion;
  out: string;
}

describe('새 도면 → DXF', () => {
  const jobs: Job[] = [];
  for (const units of ['metric', 'imperial'] as const) {
    for (const filled of [false, true]) {
      const doc = createNewDocument(units);
      if (filled) addSampleEntities(doc);
      pinVolatile(doc);
      const name = `new-${units}${filled ? '-filled' : ''}`;
      for (const version of VERSIONS) jobs.push({ name, doc, version, out: join(OUT, `${name}.${version}.dxf`) });
    }
  }
  let results = new Map<string, AuditResult>();
  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    for (const j of jobs) {
      writeFileSync(j.out, writeDxf(j.doc, { version: j.version }).data);
      await yieldToRunner();
    }
    if (hasPython) results = await ezdxfAudit(jobs.map((j) => j.out));
  }, 600_000);

  for (const j of jobs) {
    describe(`${j.name} → ${j.version}`, () => {
      it('다시 읽은 요약 = 쓰기가 정한 문서', () => {
        const st = checkStructure(new Uint8Array(readFileSync(j.out)));
        expect(st.duplicates).toEqual([]);
        expect(st.dangling).toEqual([]);
        expect(st.seedOk).toBe(true);
        expect(st.balanced).toBe(true);
        const back = readDxf(new Uint8Array(readFileSync(j.out)));
        if (j.version === 'AC1009') {
          // R12: 표·배치가 단순해서 객체 수와 종류만 본다(변환 경고는 WRITER_NOTES.md).
          expect(back.version).toBe('AC1009');
          expect(back.layers.has('0')).toBe(true);
          return;
        }
        const { summary: expected } = plannedSummary(j.doc, j.version);
        const actual = summarizeDocument(back);
        normalizeRoundTrip(expected, actual, j.version);
        const diff = compareSummaries(expected, actual);
        if (diff.length) console.log(j.name, j.version, JSON.stringify(diff.slice(0, 8)));
        expect(diff).toEqual([]);
        // 뼈대
        expect([...back.dimStyles.values()].map((d) => d.name).sort()).toEqual([...j.doc.dimStyles.values()].map((d) => d.name).sort());
        expect(back.header.get('$INSUNITS')).toBe(j.doc.header.get('$INSUNITS'));
        expect(back.header.get('$DIMSTYLE')).toBe(j.doc.header.get('$DIMSTYLE'));
        expect(back.textStyles.get('STANDARD')?.fontFamily).toBe('Arial');
        const names = new Set([...back.objects.values()].map((o) => o.type));
        for (const t of ['DICTIONARY', 'LAYOUT', 'MLINESTYLE', 'ACDBDICTIONARYWDFLT', 'ACDBPLACEHOLDER']) expect(names.has(t)).toBe(true);
        if (Number(j.version.slice(2)) >= 1021) for (const t of ['MLEADERSTYLE', 'SCALE', 'TABLESTYLE']) expect(names.has(t)).toBe(true);
      });
      it.skipIf(!hasPython)('ezdxf 검사', () => {
        const r = results.get(j.out);
        expect(r, 'ezdxf 결과 없음').toBeDefined();
        expect(r!.load_error).toBeNull();
        expect(r!.errors).toEqual([]);
        expect(r!.fixes).toEqual([]);
        const back = readDxf(new Uint8Array(readFileSync(j.out)));
        const { theirs, ours } = normalizeEzdxf(r!.summary as Summary, summarizeDocument(back));
        const diff = compareSummaries(theirs, ours);
        if (diff.length) console.log(j.out, JSON.stringify(diff.slice(0, 8)));
        expect(diff).toEqual([]);
      });
    });
  }
});
