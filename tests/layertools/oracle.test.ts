/**
 * ezdxf 오라클: 이 앱이 쓴 DXF의 표준 파일 연결(루트 사전 AcStStandard → "0"·"1" XRECORD)과 LAYTRANS 매핑 도면(도면층 확장 자료
 * ACLAYTRANS)을 ezdxf가 같은 값으로 읽고, 감사에 오류·고침이 없다. 파이썬(tests/oracle/ezdxf.ts의 PYTHON)이 없으면 건너뛴다.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CadDocument } from '../../src/core/model';
import { decodeCadEscapes } from '../../src/core/codepage';
import { writeDxf } from '../../src/io/dxf/writer';
import { standardsLinkOps } from '../../src/edit/layertools/standards';
import { layTransMappingDocument } from '../../src/edit/layertools/translate';
import { PYTHON, hasPython } from '../oracle/ezdxf';
import { addLayer, addLinetype, commit, layer, newDoc } from './helpers';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OUT = join(resolve(HERE, '../..'), '.runtime/lyformat/oracle');

interface Oracle {
  root: string;
  acst: [string, string, [number, string | number][]][];
  acst_owner: string | null;
  laytrans: Record<string, string[]>;
  appids: string[];
  audit_errors: number;
  audit_fixes: number;
  audit_messages: string[];
}

function oracle(doc: CadDocument, name: string, ver: string): Oracle {
  mkdirSync(OUT, { recursive: true });
  const dxf = join(OUT, `${name}_${ver}.dxf`);
  const json = join(OUT, `${name}_${ver}.json`);
  writeFileSync(dxf, writeDxf(doc, { version: ver as never }).data);
  try {
    execFileSync(PYTHON, ['-I', join(HERE, 'ezdxf_lyrecords.py'), dxf, json], { stdio: 'pipe' });
    return JSON.parse(readFileSync(json, 'utf8')) as Oracle;
  } finally {
    rmSync(dxf, { force: true });
    rmSync(json, { force: true });
  }
}

describe.skipIf(!hasPython)('ezdxf 오라클', () => {
  for (const ver of ['AC1032', 'AC1015']) {
    it(`표준 파일 연결 AcStStandard(${ver})`, () => {
      const t = newDoc();
      commit(t, standardsLinkOps(t.doc, ['C:\\Std\\사내 표준.dws', 'b.dws'], t.nh)!);
      const o = oracle(t.doc, 'acst', ver);
      expect(o.audit_errors, o.audit_messages.join('\n')).toBe(0);
      expect(o.audit_fixes, o.audit_messages.join('\n')).toBe(0);
      expect(o.acst_owner).toBe(o.root);
      expect(o.acst.map(([k]) => k)).toEqual(['0', '1']);
      expect(o.acst.map(([, , tags]) => tags.filter(([c]) => c !== 280).map(([c, v]) => [c, decodeCadEscapes(String(v))]))).toEqual([[[1, 'C:\\Std\\사내 표준.dws']], [[1, 'b.dws']]]);
    });

    it(`LAYTRANS 매핑 도면 ACLAYTRANS(${ver})`, () => {
      const std = newDoc();
      addLinetype(std, 'HIDDEN2', [3, -1.5]);
      const wall = addLayer(std, 'A-WALL', { color: { aci: 1 }, linetype: 'HIDDEN2' });
      const doc = layTransMappingDocument(
        [
          { layer: wall, source: std.doc, from: ['WALLS', '벽'] },
          { layer: layer('0'), source: null, from: ['0'] },
        ],
        newDoc().doc,
      );
      const o = oracle(doc, 'laytrans', ver);
      expect(o.audit_errors, o.audit_messages.join('\n')).toBe(0);
      expect(o.audit_fixes, o.audit_messages.join('\n')).toBe(0);
      expect(Object.fromEntries(Object.entries(o.laytrans).map(([k, v]) => [k, v.map(decodeCadEscapes)]))).toEqual({ '0': ['0'], 'A-WALL': ['WALLS', '벽'] });
      expect(o.appids.map((a) => a.toUpperCase())).toContain('ACLAYTRANS');
    });
  }
});
