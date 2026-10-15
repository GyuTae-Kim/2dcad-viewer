/**
 * ezdxf 오라클: 이 앱이 쓴 DXF의 도면층 필터(LAYER 표 확장 사전 → OPENCAD_LAYERFILTERS → XRECORD)를 ezdxf가 같은 태그로 읽고,
 * 도면층 상태 사전과 나란히 있으며, 감사에 오류가 없다. 파이썬(tests/oracle/ezdxf.ts의 PYTHON)이 없으면 건너뛴다.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeCadEscapes } from '../../src/core/codepage';
import { writeDxf } from '../../src/io/dxf/writer';
import { LayerFilterWriter } from '../../src/edit/layerfilter/store';
import { LayerStateWriter, captureLayerState } from '../../src/edit/layerstate/store';
import { PYTHON, hasPython } from '../oracle/ezdxf';
import { addLayer, commit, newDoc } from '../layerstate/helpers';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OUT = join(resolve(HERE, '../..'), '.runtime/layerfilter/oracle');

interface Oracle {
  xdict_keys: string[];
  filters: Record<string, { handle: string; owner: string; tags: [number, string | number][] }>;
  layers: Record<string, string>;
  audit_errors: number;
  audit_fixes: number;
  audit_messages: string[];
}

describe.skipIf(!hasPython)('ezdxf 오라클', () => {
  for (const ver of ['AC1032', 'AC1015']) {
    it(`필터 레코드(${ver})`, () => {
      const t = newDoc();
      addLayer(t, 'WALL', { color: { aci: 1 } });
      addLayer(t, '배관', { color: { aci: 5 } });
      const sw = new LayerStateWriter(t.doc, t.nh);
      sw.put(captureLayerState(t.doc, { name: 'PLAN' }));
      commit(t, sw.finish());
      const w = new LayerFilterWriter(t.doc, t.nh);
      w.put({ name: 'P', kind: 'property', parent: null, rows: [{ NAME: 'W*', COLOR: '1' }, { ON: 'OFF' }], layers: [] });
      w.put({ name: 'G', kind: 'group', parent: null, rows: [], layers: ['배관', 'WALL'] });
      w.put({ name: 'G2', kind: 'property', parent: 'G', rows: [{ LOCKED: 'LOCKED' }], layers: [] });
      commit(t, w.finish());
      mkdirSync(OUT, { recursive: true });
      const dxf = join(OUT, `f_${ver}.dxf`);
      const json = join(OUT, `f_${ver}.json`);
      writeFileSync(dxf, writeDxf(t.doc, { version: ver as never }).data);
      let o: Oracle;
      try {
        execFileSync(PYTHON, ['-I', join(HERE, 'ezdxf_layerfilters.py'), dxf, json], { stdio: 'pipe' });
        o = JSON.parse(readFileSync(json, 'utf8')) as Oracle;
      } finally {
        rmSync(dxf, { force: true });
        rmSync(json, { force: true });
      }
      expect(o.audit_errors, o.audit_messages.join('\n')).toBe(0);
      expect(o.xdict_keys).toEqual(['ACAD_LAYERSTATES', 'OPENCAD_LAYERFILTERS']);
      expect(Object.keys(o.filters)).toEqual(['P', 'G', 'G2']);
      const body = (n: string) => o.filters[n]!.tags.filter(([c]) => c !== 280).map(([c, v]) => [c, typeof v === 'string' ? v.trim() : v]);
      expect(body('P')).toEqual([
        [1, 'OPENCAD_LAYERFILTER'],
        [70, 1],
        [90, 1],
        [300, 'P'],
        [92, 0],
        [301, 'NAME'],
        [302, 'W*'],
        [301, 'COLOR'],
        [302, '1'],
        [92, 1],
        [301, 'ON'],
        [302, 'OFF'],
      ]);
      const g = body('G');
      expect(g.filter(([c]) => c === 330).map(([, v]) => decodeCadEscapes(o.layers[String(v)] ?? ''))).toEqual(['배관', 'WALL']);
      expect(body('G2')).toContainEqual([340, o.filters.G!.handle]);
    });
  }
});
