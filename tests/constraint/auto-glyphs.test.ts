import { describe, expect, it } from 'vitest';
import { MODEL_SPACE } from '../../src/core/model';
import { AUTO_DEFAULTS, autoConstrain } from '../../src/edit/constraint/auto';
import { constraintGlyphs, dimLabel, glyphAt, setConstraintDisplay } from '../../src/edit/constraint/glyphs';
import { prepareDim, prepareGeo } from '../../src/edit/constraint/make';
import { addConstraints } from '../../src/edit/constraint/system';
import { unitSettings } from '../../src/core/units';
import type { DimConstraint } from '../../src/edit/constraint/types';
import { L, apply, circle, line, put, setup, store } from './helpers';

describe('자동 구속', () => {
  it('거의 닫힌 사각형: 일치 4, 수평·수직·평행·같음은 독립인 것만', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 100, 0.01);
    const b = line(h(), 100.02, 0, 100, 50);
    const c = line(h(), 100, 50, 0, 50);
    const d = line(h(), 0, 50, 0.01, 0.02);
    put(doc, a, b, c, d);
    const cands = autoConstrain(doc, store(doc), [a.handle, b.handle, c.handle, d.handle]);
    const count = (t: string) => cands.filter((x) => x.type === t).length;
    expect(count('COINCIDENT')).toBe(4);
    // 사각형: 4점 일치 + 직교·평행·수평 등으로 형상 자유도(8 = 16 − 8)에서 이동 2·크기 2를 빼면 4가 남는다
    const geoCount = cands.length - 4;
    expect(geoCount).toBe(4);
    const r = addConstraints(doc, store(doc), cands, { noCheck: true });
    expect(r.ok).toBe(true);
    apply(doc, s, r);
    const A = L(doc, a.handle);
    expect(A.end.y - A.start.y).toBeCloseTo(0, 8);
    expect(L(doc, b.handle).start.x).toBeCloseTo(A.end.x, 8);
    // 다시 돌리면 더할 것이 없다
    expect(autoConstrain(doc, store(doc), [a.handle, b.handle, c.handle, d.handle])).toHaveLength(0);
  });

  it('공차 밖은 건너뛰고, 접선은 공유 점이 있어야 한다', () => {
    const { doc, h } = setup();
    const k = circle(h(), 0, 0, 10);
    const t1 = line(h(), -20, 10.01, 20, 10.01);
    const t2 = line(h(), 30, -10, 60, -10);
    const far = line(h(), 0, 30, 50, 33);
    put(doc, k, t1, t2, far);
    const cands = autoConstrain(doc, store(doc), [k.handle, t1.handle, t2.handle, far.handle], { ...AUTO_DEFAULTS, types: ['TANGENT', 'HORIZONTAL'] });
    expect(cands.filter((c) => c.type === 'TANGENT').map((c) => c.refs[0]!.h)).toEqual([t1.handle]);
    expect(cands.filter((c) => c.type === 'HORIZONTAL').map((c) => c.refs[0]!.h).sort()).toEqual([t1.handle, t2.handle].sort());
  });
});

describe('구속 표시 도형', () => {
  it('막대·일치 표식·치수 구속 문자', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 100, 0);
    const b = line(h(), 100, 0, 100, 60);
    put(doc, a, b);
    const g = (type: 'HORIZONTAL' | 'PERPENDICULAR' | 'COINCIDENT', refs: [string, string][]) => prepareGeo(doc, { id: 0, kind: 'geo', type, refs: refs.map(([hh, part]) => ({ h: hh, part })) });
    let r = addConstraints(doc, store(doc), [g('HORIZONTAL', [[a.handle, '']]), g('PERPENDICULAR', [[a.handle, ''], [b.handle, '']]), g('COINCIDENT', [[a.handle, 'E'], [b.handle, 'S']])]);
    apply(doc, s, r);
    const d: DimConstraint = prepareDim(doc, { id: 0, kind: 'dim', type: 'DIST', refs: [{ h: a.handle, part: 'S' }, { h: a.handle, part: 'E' }], name: 'd1', expr: '100', value: 100, reference: false, offset: 0 }, { x: 50, y: -20 });
    r = addConstraints(doc, store(doc), [d]);
    apply(doc, s, r);
    const px = 0.5;
    const gl = constraintGlyphs(doc, MODEL_SPACE, px);
    // 선 a: 수평·직교, 선 b: 직교 → 막대 둘, 아이콘 셋
    expect(gl.bars).toHaveLength(2);
    expect(gl.bars.map((x) => x.items.length).sort()).toEqual([1, 2]);
    expect(gl.coincident).toHaveLength(1);
    expect(gl.coincident[0]!.p.x).toBeCloseTo(100, 9);
    expect(gl.texts.map((t) => t.text)).toEqual(['d1=100.0000']);
    // 글은 치수선 바깥(측정점 반대쪽)
    expect(gl.texts[0]!.y).toBeLessThan(-20);
    expect(gl.texts[0]!.align).toBe('center');
    expect(gl.texts[0]!.lock).toBe(true);
    expect(gl.arrows.length).toBe(12);
    expect(gl.locks.length).toBeGreaterThan(0);
    // 막대 아이콘 찾기
    const bar = gl.bars.find((x) => x.items.length === 2)!;
    const it0 = bar.items[0]!;
    expect(glyphAt(gl, { x: (it0.x0 + it0.x1) / 2, y: (it0.y0 + it0.y1) / 2 })?.id).toBe(it0.id);
    // 화면 크기 고정: 픽셀 크기를 두 배로 하면 막대도 두 배
    const gl2 = constraintGlyphs(doc, MODEL_SPACE, px * 2);
    const w = (x: { x0: number; x1: number }) => x.x1 - x.x0;
    expect(w(gl2.bars[0]!)).toBeCloseTo(w(gl.bars[0]!) * 2, 9);
    // 숨기기
    setConstraintDisplay(doc, { bars: false, dims: false });
    const gl3 = constraintGlyphs(doc, MODEL_SPACE, px);
    expect(gl3.bars).toHaveLength(0);
    expect(gl3.texts).toHaveLength(0);
    // 다른 공간에는 없다
    expect(constraintGlyphs(doc, '*PAPER_SPACE', px, { bars: true, dims: true }).bars).toHaveLength(0);
  });

  it('치수 구속 글: 식·참조', () => {
    const u = unitSettings(setup().doc);
    const base: DimConstraint = { id: 1, kind: 'dim', type: 'DIST', refs: [], name: 'd1', expr: 'width*2', value: 50, reference: false, offset: 0 };
    expect(dimLabel(base, u)).toBe('d1=width*2');
    expect(dimLabel({ ...base, expr: '50' }, u)).toBe('d1=50.0000');
    expect(dimLabel({ ...base, reference: true }, u)).toBe('(d1=50.0000)');
    expect(dimLabel({ ...base, type: 'ANGLE', expr: '30', value: 30 }, u)).toBe('d1=30°');
  });
});
