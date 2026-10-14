/**
 * AutoCAD가 만든 치수 블록과 비교(예제 도면은 저장소에 없다: CAD_FIXTURES).
 * 같은 도면을 R12~R2018 DWG·DXF로 저장한 sample_* 파일의 치수 11개 × 버전.
 * - R2000 이상: 기하(블록 크기 대비 1e-3)·문자·높이·색·선종류·선가중치가 모두 맞아야 한다.
 * - R14 DWG: R2000 치수 변수(DIMDSEP·DIMLWD·DIMLTYPE)와 측정값(42)이 파일에 없어 참고로만 센다.
 * - R12 DXF: 치수 스타일 이름(3)이 없어 ISO-25 값을 알 수 없으므로 참고로만 센다.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readCadFile } from '../../src/io/index';
import { type DimResult, compareDimension, dimFixtures, summarize } from './compare';

const files = dimFixtures();
const main: DimResult[] = [];
const old: DimResult[] = [];

describe.skipIf(!files.length)('치수 블록 ↔ AutoCAD', () => {
  for (const path of files) {
    const name = path.split('/').pop()!;
    it(name, () => {
      const doc = readCadFile(new Uint8Array(readFileSync(path)), path);
      const isOld = doc.version < 'AC1015';
      const fails: string[] = [];
      for (const b of doc.blocks.values())
        for (const e of b.entities) {
          if (e.type !== 'DIMENSION' || !doc.blocks.get(e.block.toUpperCase())?.entities.length) continue;
          const r = compareDimension(doc, e, name);
          (isOld ? old : main).push(r);
          if (!r.ok) fails.push(`${r.handle} ${r.kind}: ${r.issues.join('; ')}`);
        }
      if (!isOld) expect(fails).toEqual([]);
    });
  }
  afterAll(() => {
    const worst = Math.max(0, ...main.map((r) => r.rel));
    console.log(`[치수] R2000 이상 일치율(종류: 맞음/전체)\n${summarize(main)}\n최대 상대 오차 ${worst.toExponential(2)}`);
    if (old.length) console.log(`[치수] R12·R14 참고\n${summarize(old)}`);
  });
});
