/**
 * DWG에서 읽은 문서 → DXF 쓰기. DWG 리더가 만든 문서(원본 태그가 없는 객체, DWG 전용 값)도 AutoCAD가 읽을 수 있는
 * DXF가 되는지 본다(로컬 개발 전용).
 * - 우리 리더로 다시 읽은 요약이 쓰기가 정한 문서의 요약과 같다(writer.helpers.ts의 의도된 차이만 맞춘다).
 * - ezdxf가 오류 없이 읽고, ezdxf가 본 요약이 우리 리더가 본 요약과 같다.
 * 대상 버전: R2018(기본)과 원본 DWG 버전(DXF로 쓸 수 있는 버전일 때), R2000.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { CadDocument } from '../../src/core/model';
import { readDwg } from '../../src/io/dwg/index';
import { readDxf } from '../../src/io/dxf/reader';
import { writeDxf } from '../../src/io/dxf/writer';
import type { DxfVersion } from '../../src/io/dxf/tagwriter';
import { type Summary, summarizeDocument } from '../oracle/summarize';
import { compareSummaries } from '../oracle/compare';
import { type AuditResult, DATA_LOSS_WARNINGS, OUT, TARGETS, checkStructure, dictionaryXdicts, dwgFixtures, ezdxfAudit, yieldToRunner, harmfulFixes, hasPython, normalizeEzdxf, normalizeRoundTrip, outName, pinVolatile, plannedSummary } from './writer.helpers';

const fixtures = dwgFixtures();

interface Job {
  name: string;
  path: string;
  version: DxfVersion;
  out: string;
}

describe.skipIf(fixtures.length === 0)('DWG → DXF 쓰기', () => {
  const docs = new Map<string, CadDocument>();
  const jobs: Job[] = [];
  for (const f of fixtures) {
    const versions = new Set<DxfVersion>(['AC1032', 'AC1015']);
    const m = /AC10\d\d/.exec(f.name);
    if (m && (TARGETS as string[]).includes(m[0])) versions.add(m[0] as DxfVersion);
    for (const version of versions) jobs.push({ name: `${f.group}/${f.name}`, path: f.path, version, out: outName(f.path, version, '.dwg') });
  }
  let results = new Map<string, AuditResult>();

  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    for (const j of jobs) {
      let doc = docs.get(j.path);
      if (!doc) {
        doc = readDwg(new Uint8Array(readFileSync(j.path)));
        pinVolatile(doc);
        docs.set(j.path, doc);
      }
      writeFileSync(j.out, writeDxf(doc, { version: j.version }).data);
      await yieldToRunner();
    }
    if (hasPython) results = await ezdxfAudit(jobs.map((j) => j.out));
  }, 1_800_000);

  for (const j of jobs) {
    describe(`${j.name} → ${j.version}`, () => {
      it('다시 읽은 요약 = 쓰기가 정한 문서', () => {
        const doc = docs.get(j.path)!;
        const { summary: expected, ctx } = plannedSummary(doc, j.version);
        // R2018로 쓸 때 원본과 달라지는 객체는 자료가 없어 뺀 것(ACIS·OLE·이름 없는 SHAPE 등)뿐이다.
        if (j.version === 'AC1032') for (const w of ctx.warnings) if (w.code.startsWith('entity.')) expect(DATA_LOSS_WARNINGS.has(w.code), w.code).toBe(true);
        const st = checkStructure(new Uint8Array(readFileSync(j.out)));
        expect(st.duplicates).toEqual([]);
        expect(st.dangling).toEqual([]);
        expect(st.seedOk).toBe(true);
        expect(st.balanced).toBe(true);
        const back = readDxf(new Uint8Array(readFileSync(j.out)));
        const actual = summarizeDocument(back);
        normalizeRoundTrip(expected, actual, j.version);
        const diff = compareSummaries(expected, actual);
        if (diff.length) console.log(j.name, j.version, JSON.stringify(diff.slice(0, 8)));
        expect(diff).toEqual([]);
      });
      it.skipIf(!hasPython)('ezdxf 검사', () => {
        const r = results.get(j.out);
        expect(r, 'ezdxf 결과 없음').toBeDefined();
        expect(r!.load_error).toBeNull();
        expect(r!.errors).toEqual([]);
        const back = readDxf(new Uint8Array(readFileSync(j.out)));
        expect(harmfulFixes(r!, dictionaryXdicts(back))).toEqual([]);
        const { theirs, ours } = normalizeEzdxf(r!.summary as Summary, summarizeDocument(back));
        const diff = compareSummaries(theirs, ours);
        if (diff.length) console.log(j.out, JSON.stringify(diff.slice(0, 8)));
        expect(diff).toEqual([]);
      });
    });
  }
});
