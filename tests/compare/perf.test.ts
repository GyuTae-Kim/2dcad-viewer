import { describe, expect, it } from 'vitest';
import { compareDrawings } from '../../src/edit/compare/match';
import { DEFAULT_OPTIONS, PROP_LAYER } from '../../src/edit/compare/signature';
import { changeSets, compareMargin, diagonal, type Box } from '../../src/edit/compare/sets';
import { bigDoc, line } from './make';
import type { Entity } from '../../src/core/model';

const N = 50000;
const LIMIT = 2000;

function time<T>(f: () => T): { v: T; ms: number } {
  const t0 = performance.now();
  const v = f();
  return { v, ms: performance.now() - t0 };
}

describe('큰 도면(5만 객체) 비교 시간', () => {
  const a = bigDoc(N);

  it('같은 계보: 500개 이동·500개 삭제·500개 추가·500개 도면층 변경', () => {
    const b = a.clone();
    const m = b.model;
    // 이동(선만)
    let moved = 0;
    for (let i = 0; i < m.length && moved < 500; i += 7) {
      const e = m[i]!;
      if (e.type === 'LINE') {
        e.start = { ...e.start, x: e.start.x + 1 };
        e.end = { ...e.end, x: e.end.x + 1 };
        moved++;
      }
    }
    // 도면층 변경(원)
    let relayer = 0;
    for (let i = 1; i < m.length && relayer < 500; i += 6) {
      const e = m[i]!;
      if (e.type === 'CIRCLE') {
        e.layer = 'B';
        relayer++;
      }
    }
    // 삭제
    m.splice(25000, 500);
    // 추가
    for (let i = 0; i < 500; i++) b.add(line(-100 - i, -100, -50 - i, -60));
    const r = time(() => compareDrawings(a.doc, b.doc, DEFAULT_OPTIONS));
    expect(r.ms).toBeLessThan(LIMIT);
    expect(r.v.sameLineage).toBe(true);
    // 이동 500(양쪽) + 삭제 500 + 추가 500
    expect(r.v.onlyCompare.length).toBe(1000);
    expect(r.v.onlyCurrent.length).toBe(1000);
    expect(r.v.modified.length).toBe(500);
    // 도면층까지 보면 500개가 더
    const r2 = time(() => compareDrawings(a.doc, b.doc, { ...DEFAULT_OPTIONS, props: PROP_LAYER }));
    expect(r2.ms).toBeLessThan(LIMIT);
    expect(r2.v.onlyCompare.length).toBe(1500);
    // 변경 세트
    const boxes: (Box | null)[] = r2.v.onlyCompare.map((h) => {
      const e = b.doc.entityIndex.get(h) as Entity | undefined;
      if (e?.type === 'LINE') return { minX: Math.min(e.start.x, e.end.x), minY: Math.min(e.start.y, e.end.y), maxX: Math.max(e.start.x, e.end.x), maxY: Math.max(e.start.y, e.end.y) };
      if (e?.type === 'CIRCLE') return { minX: e.center.x - e.radius, minY: e.center.y - e.radius, maxX: e.center.x + e.radius, maxY: e.center.y + e.radius };
      return null;
    });
    const ext = { minX: -700, minY: -100, maxX: 4500, maxY: 4500 };
    const s = time(() => changeSets(boxes, ext, compareMargin(diagonal(ext), 5)));
    expect(s.ms).toBeLessThan(300);
    expect(s.v.length).toBeGreaterThanOrEqual(1);
    expect(s.v.reduce((n, x) => n + x.items.length, 0)).toBe(boxes.filter((x) => x).length);
  });

  it('같은 도면', () => {
    const r = time(() => compareDrawings(a.doc, a.doc, DEFAULT_OPTIONS));
    expect(r.ms).toBeLessThan(LIMIT);
    expect(r.v.common).toBe(N);
  });

  it('지우고 다시 그린(핸들이 모두 다른) 같은 도면', () => {
    const b = bigDoc(N, 0x900000);
    const r = time(() => compareDrawings(a.doc, b.doc, DEFAULT_OPTIONS));
    expect(r.ms).toBeLessThan(LIMIT);
    expect(r.v.sameLineage).toBe(false);
    expect(r.v.common).toBe(N);
  });

  it('공통점 없는 두 도면', () => {
    const b = bigDoc(N, 0x900000);
    for (const e of b.model) {
      if (e.type === 'LINE') e.start = { ...e.start, y: e.start.y + 0.5 };
      else if (e.type === 'CIRCLE' || e.type === 'ARC') e.center = { ...e.center, y: e.center.y + 0.5 };
      else if (e.type === 'LWPOLYLINE') e.vertices = e.vertices.map((v) => ({ ...v, y: v.y + 0.5 }));
      else if (e.type === 'TEXT' || e.type === 'INSERT') e.insert = { ...e.insert, y: e.insert.y + 0.5 };
    }
    const r = time(() => compareDrawings(a.doc, b.doc, DEFAULT_OPTIONS));
    expect(r.ms).toBeLessThan(LIMIT);
    expect(r.v.common).toBe(0);
    expect(r.v.onlyCurrent.length).toBe(N);
  });
});
