/**
 * DXF 쓰기 왕복: readDxf(writeDxf(readDxf(파일), 버전))의 요약이 쓰기가 정한 문서의 요약과 같은지 본다.
 * 기준과 의도된 차이는 writer.helpers.ts 머리말에 있다. 비교 도면은 로컬에만 있다(없으면 건너뛴다).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { CadDocument } from '../../src/core/model';
import { readDxf } from '../../src/io/dxf/reader';
import { writeDxf } from '../../src/io/dxf/writer';
import { summarizeDocument } from '../oracle/summarize';
import { compareSummaries } from '../oracle/compare';
import { DATA_LOSS_WARNINGS, TARGETS, VERSION_WARNINGS, checkStructure, dxfFixtures, normalizeRoundTrip, plannedSummary } from './writer.helpers';

const files = dxfFixtures();

describe.skipIf(files.length === 0)('DXF 쓰기 왕복(요약)', () => {
  for (const path of files) {
    describe(path.split('/').slice(-2).join('/'), () => {
      let doc: CadDocument;
      beforeAll(() => {
        doc = readDxf(new Uint8Array(readFileSync(path)));
      });
      for (const version of TARGETS) {
        for (const binary of version === 'AC1032' || version === 'AC1015' ? [false, true] : [false]) {
          it(`${version}${binary ? ' 이진' : ''}`, () => {
            const { summary: expected, ctx } = plannedSummary(doc, version);
            const res = writeDxf(doc, { version, binary });
            const back = readDxf(res.data);
            expect(back.version).toBe(version);
            expect(!!back.binary).toBe(binary);
            const actual = summarizeDocument(back);
            normalizeRoundTrip(expected, actual, version);
            const diff = compareSummaries(expected, actual);
            if (diff.length) console.log(basename(path), version, JSON.stringify(diff.slice(0, 8)));
            expect(diff).toEqual([]);
            // 최신 버전(R2018)으로 쓸 때는 버전 변환이 없어야 한다(원본 버전에 없는 객체를 담은 파일도 있어 다른 버전은 보지 않는다).
            const codes = ctx.warnings.map((w) => w.code);
            if (version === 'AC1032') expect(codes.filter((c) => VERSION_WARNINGS.has(c))).toEqual([]);
            // 쓰기 경고는 문서를 미리 살펴본 경고와 같은 종류다.
            for (const c of codes) if (c.startsWith('entity.')) expect(VERSION_WARNINGS.has(c) || DATA_LOSS_WARNINGS.has(c) || c === 'entity.lineweight_fixed').toBe(true);
            if (!binary) {
              // R2007 이전은 파일 전체가 ASCII다.
              if (Number(version.slice(2)) < 1021) expect(res.data.every((b) => b < 0x80)).toBe(true);
              // 핸들·소유자·참조
              const st = checkStructure(res.data);
              expect(st.duplicates).toEqual([]);
              expect(st.dangling).toEqual([]);
              expect(st.seedOk).toBe(true);
              expect(st.balanced).toBe(true);
            }
          });
        }
      }
    });
  }
});
