/**
 * DXF 리더를 ezdxf 요약과 비교한다. 비교용 도면은 저장소에 없고 로컬 경로에만 있다.
 * - CAD_FIXTURES/samples-dxf: AutoCAD가 저장한 버전별 DXF
 * - .runtime/gen: scripts/oracle/make_samples.py가 만든 DXF(이진·한글 포함)
 * - .runtime/oracle-dxf: 로컬 DWG 샘플을 DXF로 바꾼 것
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDxf } from '../../src/io/dxf/reader';
import { summarizeDocument } from '../oracle/summarize';
import { compareSummaries } from '../oracle/compare';
import { FIXTURES, ezdxfSummary, hasPython } from '../oracle/ezdxf';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const dirs = [join(FIXTURES, 'samples-dxf'), join(ROOT, '.runtime/gen'), join(ROOT, '.runtime/oracle-dxf')];
const files = dirs.flatMap((d) => (existsSync(d) ? readdirSync(d).filter((f) => f.toLowerCase().endsWith('.dxf')).map((f) => join(d, f)) : []));

describe.skipIf(!hasPython || files.length === 0)('DXF 리더 ↔ ezdxf', () => {
  for (const path of files) {
    it(path.split('/').slice(-2).join('/'), () => {
      const t0 = performance.now();
      const doc = readDxf(new Uint8Array(readFileSync(path)));
      const ms = performance.now() - t0;
      const expected = ezdxfSummary(path);
      const actual = summarizeDocument(doc);
      const diff = compareSummaries(expected, actual);
      if (diff.length) console.log(path, `${ms.toFixed(0)}ms`, JSON.stringify(diff.slice(0, 12), null, 1));
      expect(diff).toEqual([]);
    });
  }
});
