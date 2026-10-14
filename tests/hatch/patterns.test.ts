/** 무늬 목록·무늬 줄 계산 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { HatchEntity, HatchPatternLine } from '../../src/core/model';
import { PATTERNS, findPattern, patternLines, userPatternLines } from '../../src/edit/hatch';
import { patternSegments, userPattern } from '../../src/render/hatch';
import { readCadFile } from '../../src/io/index';
import { deg } from './helpers';
import { join } from 'node:path';
import { ROOT } from '../dxf/writer.helpers';

const close = (a: number, b: number, tol = 1e-9) => expect(Math.abs(a - b), `${a} ≈ ${b}`).toBeLessThan(tol);

function sameLines(a: HatchPatternLine[], b: HatchPatternLine[], tol = 1e-9): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    const da = Math.abs(Math.atan2(Math.sin(x.angle - y.angle), Math.cos(x.angle - y.angle)));
    expect(da).toBeLessThan(tol);
    close(x.offset.x, y.offset.x, tol);
    close(x.offset.y, y.offset.y, tol);
    expect(x.dashes.length).toBe(y.dashes.length);
    x.dashes.forEach((d, k) => close(d, y.dashes[k]!, tol));
  }
}

/** 정사각형 [0, s]²을 무늬로 채운 선분 */
function fill(lines: HatchPatternLine[], s: number, x0 = 0, y0 = 0): number[] {
  const loop = [x0, y0, x0 + s, y0, x0 + s, y0 + s, x0, y0 + s];
  const segs = patternSegments(lines, [loop], 200000);
  expect(segs).not.toBeNull();
  return segs!;
}

describe('무늬 목록', () => {
  it('요청한 이름이 모두 있고 값이 유효하다', () => {
    const need = [
      'SOLID', 'ANSI31', 'ANSI32', 'ANSI33', 'ANSI34', 'ANSI35', 'ANSI36', 'ANSI37', 'ANSI38', 'ISO02W100', 'ISO03W100', 'ISO04W100', 'ISO10W100',
      'AR-CONC', 'AR-SAND', 'AR-BRSTD', 'AR-HBONE', 'AR-PARQ1', 'BRICK', 'CROSS', 'DASH', 'DOTS', 'EARTH', 'GRASS', 'GRAVEL', 'HEX', 'HONEY',
      'LINE', 'NET', 'NET3', 'SQUARE', 'STARS', 'STEEL', 'TRIANG', 'ZIGZAG', 'ANGLE', 'BOX', 'CLAY', 'CORK', 'INSUL', 'MUDST', 'PLAST', 'SACNCR', 'SWAMP',
    ];
    for (const n of need) expect(findPattern(n), n).toBeTruthy();
    const names = PATTERNS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    for (const p of PATTERNS) {
      expect(p.description.length).toBeGreaterThan(0);
      expect(['ansi', 'iso', 'other']).toContain(p.kind);
      if (p.name === 'SOLID') {
        expect(p.lines).toEqual([]);
        continue;
      }
      expect(p.lines.length, p.name).toBeGreaterThan(0);
      for (const l of p.lines) {
        for (const v of [l.angle, l.x, l.y, l.dx, l.dy, ...l.dashes]) expect(Number.isFinite(v), p.name).toBe(true);
        // 이웃 선 간격이 0이면 무늬가 그려지지 않는다
        expect(Math.abs(l.dy), p.name).toBeGreaterThan(1e-6);
        if (l.dashes.length) expect(l.dashes.some((d) => d < 0), p.name).toBe(true);
      }
    }
    expect(findPattern('ansi31')?.name).toBe('ANSI31');
    expect(findPattern('SOLID,_O')?.name).toBe('SOLID');
    expect(findPattern('NOPE')).toBeUndefined();
  });

  it('모든 무늬가 렌더러로 그려진다', () => {
    for (const p of PATTERNS) {
      if (!p.lines.length) continue;
      const k = p.kind === 'iso' ? 1 : 1;
      const lines = patternLines(p, k, 0);
      const period = Math.max(...lines.map((l) => Math.abs(-Math.sin(l.angle) * l.offset.x + Math.cos(l.angle) * l.offset.y)), ...p.lines.flatMap((l) => l.dashes.map(Math.abs)));
      const segs = fill(lines, period * 12);
      expect(segs.length, p.name).toBeGreaterThan(8);
    }
  });
});

describe('무늬 줄 계산(DXF 규약)', () => {
  it('ANSI31: 45°, 이동 = R(45°)·(0, 0.125)', () => {
    const l = patternLines(findPattern('ANSI31')!, 1, 0);
    expect(l.length).toBe(1);
    close(l[0]!.angle, Math.PI / 4);
    close(l[0]!.offset.x, -0.125 * Math.SQRT1_2);
    close(l[0]!.offset.y, 0.125 * Math.SQRT1_2);
    expect(l[0]!.dashes).toEqual([]);
  });

  it('축척·각도: 각도는 더하고 이동·대시는 축척배', () => {
    const def = findPattern('ANSI33')!;
    const l = patternLines(def, 2, deg(30));
    const a = deg(75);
    close(l[0]!.angle, a);
    close(l[0]!.offset.x, -Math.sin(a) * 0.5);
    close(l[0]!.offset.y, Math.cos(a) * 0.5);
    // 두 번째 줄: 원점이 해치 각도만큼 돈다
    const d = def.lines[1]!;
    close(l[1]!.base.x, (d.x * Math.cos(deg(30)) - d.y * Math.sin(deg(30))) * 2);
    close(l[1]!.base.y, (d.x * Math.sin(deg(30)) + d.y * Math.cos(deg(30))) * 2);
    expect(l[1]!.dashes).toEqual(d.dashes.map((x) => x * 2));
    // 원점(HPORIGIN)은 그대로 더한다
    const o = patternLines(def, 1, 0, false, { origin: { x: 3, y: -2 } });
    close(o[0]!.base.x, 3);
    close(o[0]!.base.y, -2);
  });

  it('미터법은 인치 무늬를 25.4배, ISO 무늬는 그대로(펜 폭 = 축척)', () => {
    const m = patternLines(findPattern('ANSI31')!, 1, 0, false, { metric: true });
    close(Math.hypot(m[0]!.offset.x, m[0]!.offset.y), 3.175);
    const iso = patternLines(findPattern('ISO02W100')!, 0.5, 0, false, { metric: true });
    expect(iso[0]!.dashes).toEqual([6, -1.5]);
    close(iso[0]!.offset.y, 2.5);
  });

  it('이중: 90° 돌린 줄을 더한다', () => {
    const l = patternLines(findPattern('LINE')!, 1, deg(10), true);
    expect(l.length).toBe(2);
    close(l[1]!.angle - l[0]!.angle, Math.PI / 2);
  });

  it('사용자 정의 무늬는 렌더러의 대체 계산과 같다', () => {
    for (const dbl of [false, true]) {
      const h = { patternAngle: deg(45), patternScale: 0.75, patternDouble: dbl } as HatchEntity;
      sameLines(userPatternLines(0.75, deg(45), dbl), userPattern(h));
    }
  });

  it('격자 무늬 조각이 제 모양으로 그려진다(육각 타일: 안쪽 변 길이 일정, 꼭짓점마다 세 변)', () => {
    const segs = fill(patternLines(findPattern('HEX')!, 1, 0), 2);
    const key = (x: number, y: number) => `${Math.round(x * 1e6)},${Math.round(y * 1e6)}`;
    const degree = new Map<string, number>();
    let inner = 0;
    for (let i = 0; i < segs.length; i += 4) {
      const [x0, y0, x1, y1] = [segs[i]!, segs[i + 1]!, segs[i + 2]!, segs[i + 3]!];
      const inside = [x0, y0, x1, y1].every((v) => v > 0.3 && v < 1.7);
      if (!inside) continue;
      inner++;
      close(Math.hypot(x1 - x0, y1 - y0), 0.125, 1e-9);
      for (const k of [key(x0, y0), key(x1, y1)]) degree.set(k, (degree.get(k) ?? 0) + 1);
    }
    expect(inner).toBeGreaterThan(50);
    // 안쪽 영역 한가운데 꼭짓점들은 세 변이 만난다
    const full = [...degree.entries()].filter(([k]) => {
      const [x, y] = k.split(',').map((v) => Number(v) / 1e6);
      return x! > 0.6 && x! < 1.4 && y! > 0.6 && y! < 1.4;
    });
    expect(full.length).toBeGreaterThan(10);
    for (const [, d] of full) expect(d).toBe(3);
  });

  it('벽돌: 가로 줄눈은 0.25 간격, 세로 줄눈은 한 켜 높이', () => {
    const segs = fill(patternLines(findPattern('BRICK')!, 1, 0), 2);
    for (let i = 0; i < segs.length; i += 4) {
      const [x0, y0, x1, y1] = [segs[i]!, segs[i + 1]!, segs[i + 2]!, segs[i + 3]!];
      if (Math.abs(y1 - y0) < 1e-12) close(y0 / 0.25, Math.round(y0 / 0.25), 1e-9);
      else {
        close(x0, x1);
        expect(Math.abs(y1 - y0)).toBeLessThanOrEqual(0.25 + 1e-9);
      }
    }
  });
});

// 예제 도면의 단순 평행선 무늬(ANSI31·사용자 정의)와 비교
const ORACLE = join(ROOT, '.runtime/oracle-dxf');
const SAMPLES = ['sample_AC1032.dxf', 'sample_AC1018.dxf', 'Structural_-_Imperial.dxf', 'Structural_-_Metric.dxf'].map((f) => `${ORACLE}/${f}`);
const haveSamples = SAMPLES.every((f) => existsSync(f));

describe('예제 도면과 비교', () => {
  it.skipIf(!haveSamples)('ANSI31·_USER 해치의 무늬 줄이 같은 축척·각도의 계산 값과 같다', () => {
    let checked = 0;
    for (const f of SAMPLES) {
      const doc = readCadFile(new Uint8Array(readFileSync(f)), f);
      const metric = Number(doc.header.get('$MEASUREMENT') ?? 0) === 1;
      for (const e of doc.entityIndex.values()) {
        if (e.type !== 'HATCH') continue;
        const name = e.patternName.toUpperCase();
        let mine: HatchPatternLine[] | null = null;
        if (name === 'ANSI31') mine = patternLines(findPattern('ANSI31')!, e.patternScale, e.patternAngle, false, { metric });
        else if (name === '_USER') mine = userPatternLines(e.patternScale, e.patternAngle, e.patternDouble);
        if (!mine) continue;
        sameLines(mine, e.patternLines, 1e-6);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });
});
