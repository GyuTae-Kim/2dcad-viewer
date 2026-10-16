import { describe, expect, it } from 'vitest';
import type { HatchEntity, HatchPath, LwPolylineEntity } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults } from '../../src/core/model';
import { PATTERNS, boundaryFromEntities, createHatch, reactorLinks } from '../../src/edit/hatch';
import { hasPatternOrigin, hatchBoundaryEntities, hatchOrigin, hatchWithBoundary, relinkReactors, withHatchOrigin } from '../../src/edit/editcmds2/hatch';
import { circle, line, put, setup } from '../util2/helpers';
import { lwVertices, packBulge } from '../../src/core/lwpoly';

const square = (x0: number, y0: number, s: number): HatchPath => ({
  flags: 3,
  polyline: {
    closed: true,
    verts: packBulge([
      { x: x0, y: y0, bulge: 0 },
      { x: x0 + s, y: y0, bulge: 0 },
      { x: x0 + s, y: y0 + s, bulge: 0 },
      { x: x0, y: y0 + s, bulge: 0 },
    ]),
  },
});

const near = (a: { x: number; y: number }, b: { x: number; y: number }, eps = 1e-9) => Math.hypot(a.x - b.x, a.y - b.y) < eps;

describe('HATCHGENERATEBOUNDARY: 해치 둘레의 경계', () => {
  it('폴리선 경로 → 닫힌 LWPOLYLINE(현재 특성), 원 경로 → 볼록도 있는 닫힌 폴리선', () => {
    const { doc } = setup();
    const ring: HatchPath = { flags: 1, edges: [{ type: 'arc', center: { x: 20, y: 0 }, radius: 3, startAngle: 0, endAngle: Math.PI * 2, ccw: true }] };
    const h = createHatch(doc, [square(0, 0, 10), ring], { pattern: 'ANSI31', layer: '해치' });
    const props = { ...entityDefaults(), layer: '경계', color: { aci: 1 } };
    const out = hatchBoundaryEntities(h, props);
    expect(out).toHaveLength(2);
    const [a, b] = out as LwPolylineEntity[];
    expect(a!.type).toBe('LWPOLYLINE');
    expect(a!.closed).toBe(true);
    expect(a!.layer).toBe('경계');
    expect(a!.color.aci).toBe(1);
    expect(lwVertices(a!).map((v) => [v.x, v.y])).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]);
    // 한 바퀴 원 모서리는 반원 둘(볼록도 1)로
    expect(b!.type).toBe('LWPOLYLINE');
    expect(b!.closed).toBe(true);
    expect(lwVertices(b!).map((v) => [+v.x.toFixed(9), +v.y.toFixed(9), +Math.abs(v.bulge).toFixed(9)])).toEqual([
      [23, 0, 1],
      [17, 0, 1],
    ]);
    // 해치 자체는 연관되지 않은 그대로(원본 핸들 없음)
    expect(out.every((e) => !e.handle)).toBe(true);
    // 시계 방향 한 바퀴 타원 → 닫힌 스플라인
    const el: HatchPath = { flags: 1, edges: [{ type: 'ellipse', center: { x: 0, y: 0 }, majorAxis: { x: 4, y: 0 }, ratio: 0.5, startAngle: 0, endAngle: Math.PI * 2, ccw: false }] };
    const e2 = hatchBoundaryEntities(createHatch(doc, [el], { pattern: 'SOLID' }), props);
    expect(e2.map((e) => e.type)).toEqual(['SPLINE']);
  });
});

describe('HATCHSETORIGIN: 무늬 원점', () => {
  it('사전 무늬마다 만든 원점을 되짚고, 새 원점으로 옮기면 그 원점으로 만든 무늬와 같다', () => {
    const { doc } = setup();
    for (const def of PATTERNS) {
      if (!def.lines.length) continue;
      const opt = { pattern: def.name, scale: 2, angle: Math.PI / 6 };
      const h = createHatch(doc, [square(0, 0, 10)], { ...opt, origin: { x: 3, y: 4 } });
      expect(hasPatternOrigin(h)).toBe(true);
      const o = hatchOrigin(h)!;
      expect(near(o, { x: 3, y: 4 }, 1e-6), `${def.name} 원점 ${o.x},${o.y}`).toBe(true);
      const moved = withHatchOrigin(h, { x: 10, y: -2 })!;
      const want = createHatch(doc, [square(0, 0, 10)], { ...opt, origin: { x: 10, y: -2 } });
      moved.patternLines.forEach((l, i) => {
        expect(near(l.base, want.patternLines[i]!.base, 1e-6)).toBe(true);
        expect(l.angle).toBeCloseTo(want.patternLines[i]!.angle, 12);
      });
    }
  });

  it('이중 사용자 무늬·미터법(25.4배) 무늬도 원점을 되짚는다', () => {
    const { doc } = setup();
    const u = createHatch(doc, [square(0, 0, 10)], { pattern: '_USER', userSpacing: 1.5, double: true, angle: 0.3, origin: { x: -1, y: 2 } });
    expect(near(hatchOrigin(u)!, { x: -1, y: 2 })).toBe(true);
    const m = createHatch(doc, [square(0, 0, 10)], { pattern: 'ANSI32', scale: 0.5, metric: true, origin: { x: 7, y: 7 } });
    expect(near(hatchOrigin(m)!, { x: 7, y: 7 }, 1e-6)).toBe(true);
  });

  it('단색·그라데이션은 원점이 없다', () => {
    const { doc } = setup();
    const s = createHatch(doc, [square(0, 0, 10)], { pattern: 'SOLID' });
    expect(hasPatternOrigin(s)).toBe(false);
    expect(withHatchOrigin(s, { x: 1, y: 1 })).toBeNull();
  });
});

describe('HATCHSETBOUNDARY: 경계 다시 정하기', () => {
  it('무늬·원점을 지키고 새 경계 객체에 연관하며, 반응자를 옮긴다', () => {
    const { doc, s, h: nh } = setup();
    const a = line(nh(), 0, 0, 10, 0);
    const b = line(nh(), 10, 0, 10, 10);
    const c = line(nh(), 10, 10, 0, 10);
    const d = line(nh(), 0, 10, 0, 0);
    const ring = circle(nh(), 50, 50, 5);
    put(doc, a, b, c, d, ring);
    const paths = boundaryFromEntities(doc, [a, b, c, d]);
    const h0 = createHatch(doc, paths, { pattern: 'ANSI31', scale: 1, origin: { x: 2, y: 1 } });
    h0.handle = nh();
    s.commit({ label: 'HATCH', ops: [{ kind: 'add', block: MODEL_SPACE, entity: h0 }] });
    const links = reactorLinks(doc, h0);
    s.commit({ label: 'HATCH', ops: links.map((l) => ({ kind: 'modify' as const, block: MODEL_SPACE, before: l.before, after: l.after })) });
    expect(doc.entityIndex.get(a.handle)!.reactors).toEqual([h0.handle]);

    const n = hatchWithBoundary(doc, h0, [ring], true) as HatchEntity;
    expect(typeof n).toBe('object');
    expect(n.handle).toBe(h0.handle);
    expect(n.patternName).toBe('ANSI31');
    expect(n.associative).toBe(true);
    expect(n.paths.flatMap((p) => p.sources ?? [])).toEqual([ring.handle]);
    expect(near(hatchOrigin(n)!, { x: 2, y: 1 }, 1e-9)).toBe(true);
    const rel = relinkReactors(doc, h0, n);
    expect(rel.map((r) => r.before.handle).sort()).toEqual([a.handle, b.handle, c.handle, d.handle, ring.handle].sort());
    expect(rel.find((r) => r.before.handle === ring.handle)!.after.reactors).toEqual([h0.handle]);
    expect(rel.find((r) => r.before.handle === a.handle)!.after.reactors).toBeUndefined();

    // 연관이 아니면 원본을 지운다
    const free = hatchWithBoundary(doc, h0, [ring], false) as HatchEntity;
    expect(free.associative).toBe(false);
    expect(free.paths.every((p) => !p.sources)).toBe(true);
    // 닫히지 않는 객체
    expect(hatchWithBoundary(doc, h0, [a], true)).toMatch(/닫힌 경계/);
  });
});
