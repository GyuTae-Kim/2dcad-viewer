/**
 * ezdxf 교차 확인(로컬 개발 전용, 파이썬과 ezdxf가 있을 때만).
 * ezdxf가 그린 치수 블록은 AutoCAD 결과가 아니라 또 다른 근사이므로 문자와 무관한 부분만 견준다:
 * 화살촉 끝, 정의점, 보조선(정의점에서 시작하는 선), 치수 호.
 * 알려진 차이(비교하지 않음): 두 선 각도의 사분면 선택, 지름 치수의 정의점(AutoCAD 예제는 15·10, ezdxf는 15·중심),
 * ezdxf는 정렬 문자를 뒤집지 않고 문자 폭을 다르게 잰다.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Entity } from '../../src/core/model';
import { generateDimensionGeometry } from '../../src/edit/dim';
import { readCadFile } from '../../src/io/index';
import { PYTHON, hasPython } from '../oracle/ezdxf';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

type Pt = { x: number; y: number };
const near = (a: Pt, b: Pt, tol: number) => Math.hypot(a.x - b.x, a.y - b.y) <= tol;

function tips(es: Entity[]): Pt[] {
  const out: Pt[] = [];
  for (const e of es) {
    if (e.type === 'SOLID') out.push(e.points[2]);
    else if (e.type === 'INSERT') out.push(e.insert);
  }
  return out;
}

function sameSet(a: Pt[], b: Pt[], tol: number): boolean {
  return a.length === b.length && a.every((p) => b.some((q) => near(p, q, tol))) && b.every((p) => a.some((q) => near(p, q, tol)));
}

describe.skipIf(!hasPython)('ezdxf 교차 확인', () => {
  it('문자와 무관한 기하가 같다', () => {
    const dir = join(ROOT, '.runtime/dim');
    mkdirSync(dir, { recursive: true });
    const out = join(dir, 'ezdxf_dims.dxf');
    try {
      execFileSync(PYTHON, ['-I', join(ROOT, 'tests/dim/ezdxf_dims.py'), out], { stdio: 'pipe', timeout: 120_000 });
    } catch {
      return; // ezdxf 없음
    }
    const doc = readCadFile(new Uint8Array(readFileSync(out)), out);
    let checked = 0;
    const bad: string[] = [];
    for (const d of doc.blocks.get('*MODEL_SPACE')!.entities) {
      if (d.type !== 'DIMENSION') continue;
      const kind = d.dimType & 7;
      if (kind === 2) continue;
      const ref = doc.blocks.get(d.block.toUpperCase())!.entities;
      const got = generateDimensionGeometry(doc, d).entities;
      const tol = 1e-6;
      const label = `${d.handle} 종류 ${kind} ${d.dimStyle}`;
      if (!sameSet(tips(ref), tips(got), tol)) bad.push(`${label}: 화살촉`);
      const pr = ref.filter((e) => e.type === 'POINT').map((e) => (e as { position: Pt }).position);
      const pg = got.filter((e) => e.type === 'POINT').map((e) => (e as { position: Pt }).position);
      if (kind !== 3 && !sameSet(pr, pg, tol)) bad.push(`${label}: 정의점`);
      // 정의점(DIMEXO 거리)에서 시작하는 선 = 보조선·세로좌표 지시선 첫 토막
      const exo = 0.625;
      const starts = pr.filter((q) => ref.some((e) => e.type === 'LINE' && Math.abs(Math.hypot(e.start.x - q.x, e.start.y - q.y) - exo) < 1e-6));
      for (const e of ref) {
        if (e.type !== 'LINE' || !starts.some((q) => Math.abs(Math.hypot(e.start.x - q.x, e.start.y - q.y) - exo) < 1e-6)) continue;
        // ezdxf는 꺾임 없는 세로좌표 지시선도 세 토막으로 그린다: 시작점만 본다
        const full = kind !== 6;
        const ok = got.some((g) => g.type === 'LINE' && near(g.start, e.start, tol) && (!full || near(g.end, e.end, tol)));
        if (!ok) bad.push(`${label}: 보조선 ${e.start.x},${e.start.y}`);
      }
      for (const e of ref) {
        if (e.type !== 'ARC') continue;
        if (!got.some((g) => g.type === 'ARC' && near(g.center, e.center, tol) && Math.abs(g.radius - e.radius) < tol)) bad.push(`${label}: 호`);
      }
      checked++;
    }
    console.log(`[치수] ezdxf 교차 확인 ${checked - new Set(bad.map((b) => b.split(':')[0])).size}/${checked}`);
    expect(bad).toEqual([]);
    expect(checked).toBeGreaterThan(20);
  });
});
