/**
 * ezdxf 오라클: 이 앱이 쓴 DXF의 도면층 상태(LAYER 표 확장 사전 → ACAD_LAYERSTATES → XRECORD)를 ezdxf가 같은 태그로 읽고,
 * 감사에 오류가 없다. 파이썬(tests/oracle/ezdxf.ts의 PYTHON)이 없으면 건너뛴다.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CadDocument } from '../../src/core/model';
import { writeDxf } from '../../src/io/dxf/writer';
import { LayerStateWriter, captureLayerState, listLayerStates } from '../../src/edit/layerstate/store';
import { PYTHON, hasPython } from '../oracle/ezdxf';
import { addLayer, addLinetype, commit, fixture, newDoc, readFixture } from './helpers';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '../..');
const OUT = join(ROOT, '.runtime/layerstate/oracle');

interface Oracle {
  has_xdict: boolean;
  states: Record<string, [number, string | number][]>;
  audit_errors: number;
  audit_fixes: number;
  audit_messages: string[];
  layers: Record<string, string>;
}

function oracle(doc: CadDocument, name: string, version: string): Oracle {
  mkdirSync(OUT, { recursive: true });
  const dxf = join(OUT, `${name}.dxf`);
  const json = join(OUT, `${name}.json`);
  writeFileSync(dxf, writeDxf(doc, { version: version as never }).data);
  try {
    execFileSync(PYTHON, ['-I', join(HERE, 'ezdxf_layerstates.py'), dxf, json], { stdio: 'pipe' });
    return JSON.parse(readFileSync(json, 'utf8')) as Oracle;
  } finally {
    rmSync(dxf, { force: true });
    rmSync(json, { force: true });
  }
}

/** ezdxf 태그의 도면층 핸들을 이름으로 바꾼 꼴 */
function named(o: Oracle, tags: [number, string | number][]): string[] {
  return tags.map(([c, v]) => {
    if (c === 330) return `330=${o.layers[String(v)] ?? '?'}`;
    if (c === 331) return '331';
    return `${c}=${typeof v === 'string' ? v.trim() : v}`;
  });
}

describe.skipIf(!hasPython)('ezdxf 오라클', () => {
  for (const ver of ['AC1032', 'AC1015']) {
    it(`새 도면의 상태(${ver})`, () => {
      const t = newDoc();
      addLinetype(t, 'DASHED');
      addLayer(t, 'WALL', { color: { aci: 1 }, linetype: 'DASHED', lineweight: 35 });
      addLayer(t, 'GLASS', { color: { aci: 150, rgb: 0x1192ee }, transparency: 76, plot: false });
      addLayer(t, 'OFF', { off: true, locked: true, flags: 2 });
      const w = new LayerStateWriter(t.doc, t.nh);
      w.put(captureLayerState(t.doc, { name: 'PLAN', description: 'desc', paperSpace: true }));
      w.put(captureLayerState(t.doc, { name: 'ONLY_ON', mask: 1 }));
      commit(t, w.finish());
      const o = oracle(t.doc, `new_${ver}`, ver);
      expect(o.audit_errors, o.audit_messages.join('\n')).toBe(0);
      expect(o.has_xdict).toBe(true);
      expect(Object.keys(o.states).sort()).toEqual(['ONLY_ON', 'PLAN']);
      const plan = o.states.PLAN!;
      // 280 복제 플래그 뒤 91·301·290·302
      const body = plan[0]![0] === 280 ? plan.slice(1) : plan;
      expect(body.slice(0, 4)).toEqual([
        [91, 2047],
        [301, 'desc'],
        [290, 1],
        [302, '0'],
      ]);
      const names = named(o, body);
      expect(names).toContain('330=GLASS');
      const gi = names.indexOf('330=GLASS');
      expect(names.slice(gi, gi + 8)).toEqual(['330=GLASS', '90=0', '62=150', '370=-3', '331', '1=Color_150', '440=33554508', '92=-1039035666']);
    });
  }

  it.skipIf(!fixture('samples-dxf/sample_AC1032_ascii.dxf'))('AutoCAD 표본을 다시 써도 숨은 상태의 태그가 같고, 새 상태를 더해도 감사 오류가 없다', () => {
    const doc = readFixture(fixture('samples-dxf/sample_AC1032_ascii.dxf')!);
    const before = oracle(doc, 'sample_plain', 'AC1032');
    const s = listLayerStates(doc, { hidden: true })[0]!;
    expect(Object.keys(before.states)).toEqual([s.key]);
    // 새 상태
    let n = 0x9000;
    const nh = () => (n++).toString(16).toUpperCase();
    const w = new LayerStateWriter(doc, nh);
    w.put(captureLayerState(doc, { name: '새 상태' }));
    const sess = { ops: w.finish() };
    for (const op of sess.ops) if (op.kind === 'object') (op.after ? doc.objects.set(op.key, op.after) : doc.objects.delete(op.key));
    const after = oracle(doc, 'sample_added', 'AC1032');
    expect(after.audit_errors, after.audit_messages.join('\n')).toBe(before.audit_errors);
    expect(Object.keys(after.states).sort()).toEqual([s.key, '새 상태'].sort());
    expect(named(after, after.states[s.key]!)).toEqual(named(before, before.states[s.key]!));
    expect(after.states['새 상태']!.filter(([c]) => c === 330).length).toBe(doc.layers.size);
  });
});
