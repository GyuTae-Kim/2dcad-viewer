/**
 * 표본 도면(AutoCAD 예제·서식, 읽기만)으로: 모든 정의를 새 도면에 가져와 DXF·DWG로 다시 읽기,
 * 서식 하나를 표준 파일로 다른 서식 검사·수정. 표본이 없으면 건너뛴다(CAD_FIXTURES).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCadFile } from '../../src/io/index';
import { writeDxf } from '../../src/io/dxf/writer';
import { writeDwg } from '../../src/io/dwg/writer/index';
import { DEF_KINDS, DefinitionCopier, hasDefinition, listDefinitions } from '../../src/edit/layertools/clone';
import { type StdSource, checkStandards, fixPropsOps, replacePlan } from '../../src/edit/layertools/standards';
import { EditSession } from '../../src/edit/session';
import { commit, duplicateHandles, newDoc } from './helpers';

const FIXTURES = process.env.CAD_FIXTURES ?? '/Users/sean/code/prisme-service/.runtime/cad2d-handoff/dwgref';
const pick = (rel: string) => {
  const p = join(FIXTURES, rel);
  return existsSync(p) ? p : null;
};
const SOURCES = [
  'samples/sample_AC1032.dwg',
  'samples/sample_AC1018.dwg',
  'samples-dxf/sample_AC1032_ascii.dxf',
  'templates/acadiso.dwg',
  'all-samples/Mechanical - Metric.dwg',
  'all-samples/Multileader Tools.dwg',
  'all-samples/Architectural Title Block.dwg',
].map(pick).filter((p): p is string => !!p);
const read = (p: string) => readCadFile(new Uint8Array(readFileSync(p)), p);

describe.skipIf(!SOURCES.length)('표본 도면의 정의를 모두 가져오기', () => {
  for (const file of SOURCES) {
    it(file.replace(FIXTURES, ''), { timeout: 60000 }, () => {
      const src = read(file);
      const d = newDoc();
      const cp = new DefinitionCopier(src, d.doc, d.nh);
      const added: [string, string][] = [];
      for (const kind of DEF_KINDS)
        for (const n of listDefinitions(src, kind)) {
          const r = cp.copy(kind, n);
          expect(r, `${kind} ${n}`).not.toBe('missing');
          if (r === 'added') added.push([kind, n]);
        }
      commit(d, cp.finish());
      expect(added.length).toBeGreaterThan(0);
      if (process.env.LT_DEBUG) console.log(file, DEF_KINDS.map((k) => `${k}:${added.filter((a) => a[0] === k).length}`).join(' '), cp.skipped);
      expect(duplicateHandles(d.doc)).toEqual([]);
      for (const [fmt, data] of [
        ['dxf', writeDxf(d.doc, { version: 'AC1032' as never }).data],
        ['dwg', writeDwg(d.doc, { version: 'AC1032' }).data],
      ] as const) {
        const back = readCadFile(data, `rt.${fmt}`);
        const lost = added.filter(([k, n]) => !hasDefinition(back, k as never, n));
        expect(lost, fmt).toEqual([]);
      }
    });
  }
});

const ACAD = pick('templates/acad.dwg');
const ISO = pick('templates/acadiso.dwg');

describe.skipIf(!ACAD || !ISO)('서식을 표준 파일로 검사·수정', () => {
  it('acadiso를 표준으로 acad를 검사하고 고치면 문제가 남지 않는다', { timeout: 60000 }, () => {
    const doc = read(ACAD!);
    const std: StdSource = { name: 'acadiso.dws', doc: read(ISO!) };
    const session = new EditSession(doc, () => {});
    const nh = () => session.newHandle();
    const first = checkStandards(doc, [std]);
    expect(first.length).toBeGreaterThan(0);
    for (const p of first) {
      if (p.type === 'props') session.commit({ label: 'T', ops: fixPropsOps(doc, p, [std], nh) });
      else {
        const plan = replacePlan(doc, p, p.candidates[Math.max(0, p.recommended)]!, [std], nh);
        if (!plan) continue;
        session.commit({ label: 'T', ops: [...plan.pre, ...plan.entities.map((x) => ({ kind: 'modify' as const, block: x.block, before: x.before, after: x.after })), ...plan.post] });
      }
    }
    const left = checkStandards(doc, [std]);
    expect(left.map((p) => p.id)).toEqual([]);
    // 고친 도면을 다시 읽어도 같다
    const back = readCadFile(writeDxf(doc, { version: 'AC1032' as never }).data, 'rt.dxf');
    expect(checkStandards(back, [std]).filter((p) => p.type === 'name').map((p) => p.id)).toEqual([]);
  });
});
