/**
 * ezdxf 오라클: 이 앱이 쓴 DXF의 도면층 필터를 ezdxf가 같은 태그로 읽는다 —
 * LAYER 표 확장 사전 → ACLYDICTIONARY → AcLyLayerFilter·AcLyLayerGroup XRECORD, 중첩은 XRECORD 확장 사전 → ACLYDICTIONARY(사전 사슬의
 * 주인이 맞다), AutoCAD 형식으로 쓸 수 없는 필터는 OPENCAD_LAYERFILTERS, 도면층 상태 사전과 나란히 있고, 감사에 오류가 없다.
 * 파이썬(tests/oracle/ezdxf.ts의 PYTHON)이 없으면 건너뛴다.
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
const OUT = join(resolve(HERE, '../..'), '.runtime/lyformat/oracle');

interface Rec {
  key: string;
  handle: string;
  owner: string;
  tags: [number, string | number][];
  xdict_owner?: string;
  nested_owner?: string;
}

interface Oracle {
  xdict_keys: string[];
  xdict_handle?: string;
  acly_owner?: string;
  acly: Record<string, Rec>;
  app: Record<string, Rec>;
  nested_dicts: string[];
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
      w.put({ name: 'G3', kind: 'group', parent: 'G', rows: [], layers: ['WALL'] });
      w.put({ name: '투명', kind: 'property', parent: 'P', rows: [{ TRANSPARENCY: '50' }], layers: [] });
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
      expect(o.audit_fixes, o.audit_messages.join('\n')).toBe(0);
      expect(o.xdict_keys).toEqual(['ACAD_LAYERSTATES', 'ACLYDICTIONARY', 'OPENCAD_LAYERFILTERS']);
      expect(o.acly_owner).toBe(o.xdict_handle);
      expect(Object.keys(o.acly).sort()).toEqual(['G', 'G/G2', 'G/G3', 'P']);
      const body = (r: Rec) => r.tags.filter(([c]) => c !== 280).map(([c, v]) => [c, typeof v === 'string' ? v.trim() : v]);
      expect(body(o.acly.P!)).toEqual([
        [1, 'AcLyLayerFilter'],
        [90, 1],
        [300, 'P'],
        [301, '(NAME=="W*" AND COLOR=="1") OR OFF=="True"'],
      ]);
      expect(o.acly.P!.key).toMatch(/^\*A\d+$/);
      const g = body(o.acly.G!);
      expect(g.slice(0, 3)).toEqual([
        [1, 'AcLyLayerGroup'],
        [90, 1],
        [300, 'G'],
      ]);
      expect(g.filter(([c]) => c === 330).map(([, v]) => decodeCadEscapes(o.layers[String(v)] ?? ''))).toEqual(['배관', 'WALL']);
      // 사전 사슬: 중첩 XRECORD의 주인 = 중첩 사전, 중첩 사전의 주인 = 부모 XRECORD의 확장 사전, 확장 사전의 주인 = 부모 XRECORD
      expect(o.acly.G!.xdict_owner).toBe(o.acly.G!.handle);
      expect(o.nested_dicts).toContain(o.acly['G/G2']!.owner);
      expect(o.acly['G/G2']!.owner).toBe(o.acly['G/G3']!.owner);
      expect(body(o.acly['G/G2']!)).toEqual([
        [1, 'AcLyLayerFilter'],
        [90, 1],
        [300, 'G2'],
        [301, 'LOCKED=="True"'],
      ]);
      // AutoCAD 형식으로 쓸 수 없는 필터: 이 앱 기록, 부모는 AutoCAD 레코드 핸들(340)
      // R2000 DXF는 한글을 \U+ 꼴로 적는다
      expect(Object.keys(o.app).map(decodeCadEscapes)).toEqual(['투명']);
      expect(body(Object.values(o.app)[0]!)).toContainEqual([340, o.acly.P!.handle]);
    });
  }
});
