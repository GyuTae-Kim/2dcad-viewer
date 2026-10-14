/** 잘못된 입력·손상된 파일에서도 정해진 오류로 끝나는지 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CadReadError } from '../../src/core/errors';
import { dwgVersion, isDwg, readDwg } from '../../src/io/dwg';
import { FIXTURES } from '../oracle/ezdxf';

const code = (f: () => unknown): string => {
  try {
    f();
    return 'ok';
  } catch (e) {
    if (e instanceof CadReadError) return e.code;
    throw e;
  }
};

describe('DWG 입력 판별', () => {
  it('빈 파일·DWG 아님·지원하지 않는 버전', () => {
    expect(code(() => readDwg(new Uint8Array(0)))).toBe('file.empty');
    expect(code(() => readDwg(new TextEncoder().encode('  0\nSECTION\n')))).toBe('file.unrecognized');
    const r12 = new Uint8Array(256);
    r12.set(new TextEncoder().encode('AC1009'));
    expect(isDwg(r12)).toBe(true);
    expect(dwgVersion(r12)).toBe('AC1009');
    expect(code(() => readDwg(r12))).toBe('dwg.unsupported_version');
  });

  it('머리만 있는 파일은 손상으로 끝난다', () => {
    for (const v of ['AC1012', 'AC1015', 'AC1018', 'AC1021', 'AC1032']) {
      const d = new Uint8Array(0x600);
      d.set(new TextEncoder().encode(v));
      expect(code(() => readDwg(d))).toBe('dwg.corrupt');
    }
  });
});

const sample = (v: string) => join(FIXTURES, 'samples', `sample_${v}.dwg`);
const VERSIONS = ['AC1014', 'AC1015', 'AC1018', 'AC1021', 'AC1024', 'AC1027', 'AC1032'];

describe.skipIf(!existsSync(sample('AC1015')))('손상된 DWG', () => {
  /** 결정적 의사 난수 */
  const rand = (seed: number) => () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 0x100000000);

  for (const v of VERSIONS) {
    it(`${v}: 잘린 파일`, () => {
      const data = new Uint8Array(readFileSync(sample(v)));
      for (const frac of [0.1, 0.5, 0.9]) {
        const c = code(() => readDwg(data.slice(0, Math.floor(data.length * frac))));
        expect(['ok', 'dwg.corrupt']).toContain(c);
      }
    });

    it(`${v}: 바이트 뒤섞기`, () => {
      const data = new Uint8Array(readFileSync(sample(v)));
      const next = rand(v.charCodeAt(5) * 7919);
      for (let round = 0; round < 6; round++) {
        const d = data.slice();
        for (let k = 0; k < 200; k++) {
          const i = 0x100 + Math.floor(next() * (d.length - 0x100));
          d[i] ^= 1 + Math.floor(next() * 255);
        }
        // 어떤 경우에도 CadReadError 밖의 예외로 끝나지 않는다
        const c = code(() => {
          const doc = readDwg(d);
          expect(doc.blocks.size).toBeGreaterThan(0);
        });
        expect(['ok', 'dwg.corrupt', 'dwg.encrypted']).toContain(c);
      }
    });
  }

  it('진행률과 도형 수 제한', () => {
    const data = new Uint8Array(readFileSync(sample('AC1018')));
    const seen: number[] = [];
    const doc = readDwg(data, { onProgress: (f) => seen.push(f), maxEntities: 50 });
    expect(seen.length).toBeGreaterThan(2);
    expect(seen[seen.length - 1]).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(doc.warnings.some((w) => w.code === 'dwg.entity_limit')).toBe(true);
    expect(doc.entityIndex.size).toBeLessThanOrEqual(80);
  });
});
