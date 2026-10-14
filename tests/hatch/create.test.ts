/** HATCH 만들기, 렌더러로 그리기, 연관(반응자) 도우미, 예제 도면 재현, 성능 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BlockDef, Entity, HatchEntity } from '../../src/core/model';
import { MODEL_SPACE } from '../../src/core/model';
import {
  associatedHatches,
  boundaryFromEntities,
  createHatch,
  detectBoundary,
  dissociate,
  estimatePatternLines,
  findPattern,
  reactorLinks,
  reactorUnlinks,
} from '../../src/edit/hatch';
import { buildSpace } from '../../src/render/build';
import { hatchLoops, patternSegments, triangulateLoops } from '../../src/render/hatch';
import { TextEngine } from '../../src/text/layout';
import { readCadFile } from '../../src/io/index';
import { add, arc, circle, deg, insideHatch, line, newDoc, rect, spline } from './helpers';

const near = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b), `${a} ≈ ${b}`).toBeLessThan(tol);

function triArea(t: number[]): number {
  let a = 0;
  for (let i = 0; i + 5 < t.length; i += 6) a += Math.abs((t[i + 2]! - t[i]!) * (t[i + 5]! - t[i + 1]!) - (t[i + 4]! - t[i]!) * (t[i + 3]! - t[i + 1]!)) / 2;
  return a;
}

/** 모형 공간에 넣고 장면을 만든다: 그리기 실패가 없어야 한다 */
function renders(doc: ReturnType<typeof newDoc>, list: Entity[]): void {
  const ms = doc.blocks.get(MODEL_SPACE)!;
  const saved = ms.entities;
  ms.entities = list.map((e, i) => ({ ...e, handle: e.handle || `R${i}` }));
  try {
    const s = buildSpace(doc, '*Model_Space', { text: new TextEngine(null), tolerance: 0.01 });
    expect(s.warnings.find((w) => w.code === 'entity.failed'), JSON.stringify(s.warnings)).toBeUndefined();
    expect(s.warnings.find((w) => w.code === 'hatch.pattern_truncated'), JSON.stringify(s.warnings)).toBeUndefined();
    expect(s.list.entities.length).toBe(list.length);
  } finally {
    ms.entities = saved;
  }
}

describe('createHatch', () => {
  const setup = () => {
    const doc = newDoc();
    const list = add(doc, rect(0, 0, 10, 10), circle(5, 5, 2));
    const got = detectBoundary(doc, list, { x: 1, y: 1 })!;
    return { doc, list, got };
  };

  it('SOLID: 채우기 삼각형 넓이 = 영역 넓이(섬 제외)', () => {
    const { doc, got } = setup();
    const h = createHatch(doc, got.paths, { pattern: 'SOLID', seedPoints: [{ x: 1, y: 1 }] });
    expect(h).toMatchObject({ type: 'HATCH', handle: '', patternName: 'SOLID', solid: true, patternType: 1, associative: true, hatchStyle: 0, layer: '0' });
    expect(h.patternLines).toEqual([]);
    expect(h.paths[0]!.sources).toEqual(got.paths[0]!.sources);
    near(triArea(triangulateLoops(hatchLoops(h, 1e-3))), 100 - 4 * Math.PI, 0.01);
    // 원본과 경로를 공유하지 않는다
    expect(h.paths[0]).not.toBe(got.paths[0]);
  });

  it('미리 정의 무늬: 무늬 선이 섬을 피해 그려진다', () => {
    const { doc, got } = setup();
    const h = createHatch(doc, got.paths, { pattern: 'ansi31', scale: 2, angle: deg(15) });
    expect(h.patternName).toBe('ANSI31');
    expect(h.patternScale).toBe(2);
    expect(h.patternAngle).toBeCloseTo(deg(15), 12);
    near(h.patternLines[0]!.angle, deg(60), 1e-12);
    const segs = patternSegments(h.patternLines, hatchLoops(h, 1e-3))!;
    expect(segs.length).toBeGreaterThan(20);
    for (let i = 0; i < segs.length; i += 4) {
      const mx = (segs[i]! + segs[i + 2]!) / 2;
      const my = (segs[i + 1]! + segs[i + 3]!) / 2;
      expect(insideHatch(h.paths, { x: mx, y: my })).toBe(true);
    }
    expect(estimatePatternLines(h)).toBeGreaterThan(5);
    expect(estimatePatternLines(h)).toBeLessThan(200);
  });

  it('사용자 정의·ISO 펜 폭·미터법·원점', () => {
    const { doc, got } = setup();
    const u = createHatch(doc, got.paths, { pattern: '_USER', userSpacing: 0.5, angle: deg(30), double: true });
    expect(u).toMatchObject({ patternName: '_USER', patternType: 0, patternScale: 0.5, patternDouble: true });
    expect(u.patternLines.length).toBe(2);
    const iso = createHatch(doc, got.paths, { pattern: 'ISO03W100', isoPenWidth: 0.5 });
    expect(iso.patternScale).toBe(0.5);
    expect(iso.patternLines[0]!.dashes).toEqual([6, -9]);
    doc.header.set('$MEASUREMENT', 1);
    const m = createHatch(doc, got.paths, { pattern: 'ANSI31', origin: { x: 1, y: 2 } });
    near(Math.hypot(m.patternLines[0]!.offset.x, m.patternLines[0]!.offset.y), 3.175, 1e-12);
    expect(m.patternLines[0]!.base).toEqual({ x: 1, y: 2 });
    expect(m.patternScale).toBe(1);
  });

  it('연관 끄기·도면층·그라데이션·모르는 무늬', () => {
    const { doc, got } = setup();
    doc.header.set('$CLAYER', 'HATCH');
    const h = createHatch(doc, got.paths, { pattern: 'SOLID', associative: false });
    expect(h.associative).toBe(false);
    expect(h.paths.every((p) => !p.sources)).toBe(true);
    expect(h.layer).toBe('HATCH');
    expect(h.seedPoints.length).toBe(1);
    expect(insideHatch(h.paths, h.seedPoints[0]!)).toBe(true);
    const g = createHatch(doc, got.paths, {
      pattern: 'SOLID',
      layer: 'G',
      gradient: { enabled: true, name: 'CYLINDER', color1: { aci: 5 }, color2: { aci: 2 }, singleColor: false, tint: 0, angle: 0, shift: 0 },
    });
    expect(g).toMatchObject({ patternName: 'CYLINDER', solid: true, layer: 'G' });
    expect(g.gradient?.name).toBe('CYLINDER');
    expect(() => createHatch(doc, got.paths, { pattern: 'NO_SUCH' })).toThrow();
  });

  it('여러 무늬·경계 종류를 장면 빌더로 그려도 실패가 없다', () => {
    const doc = newDoc();
    const s = spline([
      [0, 20],
      [3, 28],
      [10, 28],
      [13, 20],
    ]);
    const list = add(doc, rect(0, 0, 10, 10), circle(5, 5, 2), circle(20, 5, 4), line(16, 5, 24, 5), s, line(0, 21, 13, 21), arc(30, 0, 5, 0, 180), line(25, 0, 35, 0));
    const regions = [
      detectBoundary(doc, list, { x: 1, y: 1 })!,
      detectBoundary(doc, list, { x: 20, y: 7 })!,
      detectBoundary(doc, list, { x: 6, y: 24 })!,
      detectBoundary(doc, list, { x: 30, y: 2 })!,
    ];
    expect(regions.every(Boolean)).toBe(true);
    const names = ['SOLID', 'ANSI37', 'AR-CONC', 'HEX', 'ISO10W100', 'GRAVEL', 'NET3', 'AR-HBONE'];
    const hatches: Entity[] = [];
    names.forEach((n, i) => {
      const r = regions[i % regions.length]!;
      const def = findPattern(n)!;
      const scale = n.startsWith('AR-') ? 0.05 : def.kind === 'iso' ? 0.05 : 1;
      hatches.push(createHatch(doc, r.paths, { pattern: n, scale, angle: deg(i * 10) }));
    });
    hatches.push(createHatch(doc, boundaryFromEntities(doc, [list[0]!, list[1]!]), { pattern: 'ANSI31' }));
    for (const h of hatches) {
      const hh = h as HatchEntity;
      if (hh.solid) expect(triangulateLoops(hatchLoops(hh, 1e-3)).length).toBeGreaterThan(0);
      else expect(patternSegments(hh.patternLines, hatchLoops(hh, 1e-3))!.length).toBeGreaterThan(0);
    }
    renders(doc, [...list, ...hatches]);
  });
});

describe('연관 해치 반응자', () => {
  it('넣은 뒤 경계 객체 reactors에 해치 핸들을 더하고, 객체에서 해치를 찾는다', () => {
    const doc = newDoc();
    const list = add(doc, rect(0, 0, 10, 10), circle(5, 5, 2));
    const got = detectBoundary(doc, list, { x: 1, y: 1 })!;
    const h = { ...createHatch(doc, got.paths, { pattern: 'SOLID' }), handle: 'AB' } as HatchEntity;
    expect(reactorLinks(doc, { ...h, handle: '' })).toEqual([]);
    add(doc, h);
    const links = reactorLinks(doc, h);
    expect(links.length).toBe(2);
    for (const { before, after } of links) {
      expect(before.reactors).toBeUndefined();
      expect(after.reactors).toEqual(['AB']);
      doc.entityIndex.set(after.handle, after);
    }
    expect(reactorLinks(doc, h)).toEqual([]);
    expect(associatedHatches(doc, doc.entityIndex.get(list[1]!.handle)!).map((x) => x.handle)).toEqual(['AB']);
    const un = reactorUnlinks(doc, h);
    expect(un.length).toBe(2);
    expect(un[0]!.after.reactors).toBeUndefined();
    expect(dissociate(h)).toMatchObject({ associative: false });
    expect(dissociate(h).paths.every((p) => !p.sources)).toBe(true);
  });
});

// 예제 도면: 점 선택으로 만든 해치(파생 경로 + 씨앗점)를 씨앗점으로 다시 찾으면 같은 넓이
const ORACLE = '/Users/sean/code/2dcad-viewer/.runtime/oracle-dxf/sample_AC1032.dxf';

describe('예제 도면 재현', () => {
  it.skipIf(!existsSync(ORACLE))('씨앗점으로 찾은 경계 넓이·경계 객체가 AutoCAD 해치와 같다', () => {
    const doc = readCadFile(new Uint8Array(readFileSync(ORACLE)), ORACLE);
    const ms = doc.blocks.get(MODEL_SPACE) as BlockDef;
    const cands = ms.entities.filter((e) => e.type !== 'HATCH');
    let checked = 0;
    for (const e of ms.entities) {
      if (e.type !== 'HATCH' || !e.paths.some((p) => p.flags & 4) || !e.seedPoints.length) continue;
      const want = triArea(triangulateLoops(hatchLoops(e, 1e-4)));
      const r = detectBoundary(doc, cands, e.seedPoints[0]!, { islands: e.hatchStyle === 1 ? 'outer' : e.hatchStyle === 2 ? 'ignore' : 'normal' })!;
      expect(r).toBeTruthy();
      near(triArea(triangulateLoops(hatchLoops({ ...e, paths: r.paths }, 1e-4))), want, want * 1e-6);
      const src = [...new Set(e.paths.flatMap((p) => p.sources ?? []))];
      if (src.length) expect(r.boundaryHandles.sort()).toEqual(src.sort());
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });
});

describe('성능', () => {
  it('후보 수천 개에서 클릭 한 번', () => {
    const doc = newDoc();
    const list: Entity[] = [];
    const S = 5000;
    const rooms = 20;
    const L = rooms * S;
    for (let i = 0; i <= rooms; i++) list.push(line(-100, i * S, L + 100, i * S), line(i * S, -100, i * S, L + 100));
    let seed = 11;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let k = 0; k < 3000; k++) {
      const x = rnd() * (L - 1200) + 300;
      const y = rnd() * (L - 1200) + 300;
      list.push(rect(x, y, x + 300 + rnd() * 500, y + 300 + rnd() * 500));
    }
    for (let k = 0; k < 1500; k++) list.push(circle(rnd() * L, rnd() * L, 50 + rnd() * 300));
    const t0 = performance.now();
    const r = detectBoundary(doc, list, { x: 7 * S + 1, y: 9 * S + 1 });
    const ms = performance.now() - t0;
    expect(r).toBeTruthy();
    // 방 하나(가구·원 섬 제외) 넓이는 방 넓이보다 작고 0보다 크다
    const a = triArea(triangulateLoops(hatchLoops({ hatchStyle: 0, paths: r!.paths } as HatchEntity, 1)));
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(S * S);
    expect(ms).toBeLessThan(1500); // 측정값은 보통 수십 ms(테스트 환경 부하 여유)
  });
});
