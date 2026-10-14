/**
 * DWG 리더를 기준 요약(엔진 read_dwg → DXF → ezdxf)과 비교한다. 비교용 도면은 저장소에 없다.
 * - CAD_FIXTURES/samples: 같은 도면을 AC1014~AC1032로 저장한 것
 * - CAD_FIXTURES/all-samples, templates: AutoCAD 예제 도면과 서식
 * 알려진 기준 쪽 차이는 normalize.ts에 근거와 함께 적어 두었다.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDwg, dwgVersion } from '../../src/io/dwg';
import { summarizeDocument } from '../oracle/summarize';
import { compareSummaries } from '../oracle/compare';
import { ezdxfSummary } from '../oracle/ezdxf';
import { FIXTURES, dwgFixtures, engineDxf, hasPython } from './oracle';
import { normalizePair } from './normalize';

const fixtures = dwgFixtures();
const timings: string[] = [];

describe.skipIf(!existsSync(join(FIXTURES, 'samples')) || !hasPython)('DWG 리더 ↔ 기준 요약', () => {
  for (const f of fixtures) {
    it(`${f.group}/${f.name}`, () => {
      const data = new Uint8Array(readFileSync(f.path));
      const t0 = performance.now();
      const doc = readDwg(data);
      const ms = performance.now() - t0;
      timings.push(`${f.group}/${f.name} ${dwgVersion(data)} ${(data.length / 1024).toFixed(0)}KB ${ms.toFixed(1)}ms`);
      expect(doc.version).toBe(dwgVersion(data));
      const dxf = engineDxf(f.path);
      if (!dxf) return; // 기준을 만들 수 없는 환경
      const expected = ezdxfSummary(dxf) as Record<string, unknown>;
      const actual = summarizeDocument(doc) as Record<string, unknown>;
      normalizePair(expected, actual, doc);
      // 블록마다 도형 수부터 따로 확인(실패 원인을 짧게 보여 준다)
      const eb = expected.blocks as Record<string, unknown[]>;
      const ab = actual.blocks as Record<string, unknown[]>;
      const counts = (b: Record<string, unknown[]>) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.length]));
      expect(counts(ab)).toEqual(counts(eb));
      const diff = compareSummaries(expected, actual);
      if (diff.length) console.log(f.name, JSON.stringify(diff.slice(0, 12), null, 1));
      expect(diff).toEqual([]);
    });
  }
  it('읽기 시간', () => {
    console.log('DWG 읽기 시간\n' + timings.join('\n'));
    expect(timings.length).toBeGreaterThan(0);
  });
});
