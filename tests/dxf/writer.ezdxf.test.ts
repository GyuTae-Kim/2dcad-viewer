/**
 * 쓴 DXF를 ezdxf로 검사한다(로컬 개발 전용, ezdxf 결과는 .runtime/dxfw-cache에 캐시).
 * - ezdxf.readfile이 읽고 audit()에 오류가 없어야 한다. 고친 항목은 writer.helpers.ts의 harmfulFixes가 허용한 것만 있어야 한다.
 * - ezdxf가 본 요약이 우리 리더가 본 요약과 같아야 한다(왕복 테스트와 함께 보면 원본 ≈ 쓴 파일).
 * 대상: 모든 DXF 비교 도면 × AC1009(R12)·AC1015…AC1032, 그리고 AutoCAD 표본(samples-dxf)의 이진 DXF.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readDxf } from '../../src/io/dxf/reader';
import { writeDxf } from '../../src/io/dxf/writer';
import type { DxfVersion } from '../../src/io/dxf/tagwriter';
import { type Summary, summarizeDocument } from '../oracle/summarize';
import { compareSummaries } from '../oracle/compare';
import { type AuditResult, OUT, TARGETS, dictionaryXdicts, dxfFixtures, ezdxfAudit, yieldToRunner, harmfulFixes, hasPython, normalizeEzdxf, outName, pinVolatile } from './writer.helpers';

const files = dxfFixtures();
const VERSIONS: DxfVersion[] = ['AC1009', ...TARGETS];

interface Job {
  src: string;
  version: DxfVersion;
  binary: boolean;
  out: string;
}

const jobs: Job[] = [];
for (const src of files) {
  for (const version of VERSIONS) jobs.push({ src, version, binary: false, out: outName(src, version) });
  if (src.includes('/samples-dxf/')) {
    for (const version of ['AC1009', 'AC1015', 'AC1032'] as DxfVersion[]) jobs.push({ src, version, binary: true, out: outName(src, version, '.bin') });
  }
}

describe.skipIf(!hasPython || files.length === 0)('DXF 쓰기 → ezdxf 검사', () => {
  let results = new Map<string, AuditResult>();
  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    const docs = new Map<string, ReturnType<typeof readDxf>>();
    for (const j of jobs) {
      let doc = docs.get(j.src);
      if (!doc) {
        doc = readDxf(new Uint8Array(readFileSync(j.src)));
        pinVolatile(doc);
        docs.clear();
        docs.set(j.src, doc);
      }
      writeFileSync(j.out, writeDxf(doc, { version: j.version, binary: j.binary }).data);
      await yieldToRunner();
    }
    results = await ezdxfAudit(jobs.map((j) => j.out));
  }, 1_800_000);

  for (const j of jobs) {
    it(`${j.src.split('/').slice(-2).join('/')} → ${j.version}${j.binary ? ' 이진' : ''}`, () => {
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
  }
});
