/** 외부 참조 비교(XCOMPARE): 두 버전의 변경 분류, 호스트 자리로의 변환, 구름 상자, 요약, 호스트 흐리게 */
import { describe, expect, it } from 'vitest';
import type { LineEntity } from '../../src/core/model';
import { DEFAULT_OPTIONS, changeSets } from '../../src/edit/compare';
import { applyAffine, diffXrefVersions, fadeStyles, placeBox, placedDiffBoxes, placementMatrix, xcompareSummary, xrefBlockKeys, xrefChanged, xrefInserts } from '../../src/edit/viewtools/xcompare';
import { XCOMPARE_VARS, compareVar, COMPARE_VARS } from '../../src/edit/compare/settings';
import { Doc, P, circle, deg, insert, line, text } from '../compare/make';

/** 참조 파일 이전 버전(선 3, 원 1, 문자 1) */
function prevVersion(): Doc {
  const d = new Doc();
  d.add(line(0, 0, 10, 0));
  d.add(line(0, 5, 10, 5));
  d.add(line(0, 10, 10, 10));
  d.add(circle(20, 20, 3));
  d.add(text(0, 30, 'A'));
  return d;
}

describe('두 버전의 변경 분류', () => {
  it('같은 계보: 바뀐 것·새로 생긴 것·지운 것', () => {
    const prev = prevVersion();
    const cur = prev.clone();
    const m = cur.model;
    // 두 번째 선을 옮김(바뀜), 원을 지움, 새 선
    (m[1] as LineEntity).end = P(12, 5);
    const removed = m.splice(3, 1)[0]!;
    cur.doc.entityIndex.delete(removed.handle);
    const added = cur.add(line(50, 50, 60, 60));
    const d = diffXrefVersions(prev.doc, cur.doc, DEFAULT_OPTIONS);
    expect(d.sameLineage).toBe(true);
    expect(d.modified).toEqual([[m[1]!.handle, m[1]!.handle]]);
    expect(d.added).toEqual([added.handle]);
    expect(d.removed).toEqual([removed.handle]);
    expect(new Set(d.onlyNew)).toEqual(new Set([m[1]!.handle, added.handle]));
    expect(new Set(d.onlyOld)).toEqual(new Set([m[1]!.handle, removed.handle]));
    // 차이 없음: 지금 버전의 나머지(선 둘, 문자)
    expect(d.commonNew.length).toBe(3);
    expect(d.same).toBe(3);
    expect(xrefChanged(d)).toBe(true);
  });

  it('바뀌지 않았으면 알리지 않는다, 문자 필터는 차이 없음 쪽', () => {
    const prev = prevVersion();
    const cur = prev.clone();
    (cur.model[4] as { text: string }).text = 'B';
    const d = diffXrefVersions(prev.doc, cur.doc, { ...DEFAULT_OPTIONS, text: false });
    expect(xrefChanged(d)).toBe(false);
    expect(d.filtered).toBe(2);
    expect(d.commonNew.length).toBe(5);
    const d2 = diffXrefVersions(prev.doc, cur.doc, DEFAULT_OPTIONS);
    expect(d2.onlyNew.length).toBe(1);
    expect(d2.onlyOld.length).toBe(1);
  });

  it('계보가 다른 파일: 기하로 맞춘다(다시 그린 같은 선은 차이 없음)', () => {
    const prev = prevVersion();
    const cur = new Doc(0x5000);
    cur.add(line(0, 0, 10, 0));
    cur.add(line(0, 10, 10, 10));
    cur.add(circle(20, 20, 3));
    cur.add(text(0, 30, 'A'));
    const d = diffXrefVersions(prev.doc, cur.doc, DEFAULT_OPTIONS);
    expect(d.sameLineage).toBe(false);
    expect(d.onlyNew).toEqual([]);
    expect(d.onlyOld.length).toBe(1);
    expect(d.removed.length).toBe(1);
  });

  it('요약 문구(한국어판)', () => {
    expect(xcompareSummary({ onlyNew: ['a', 'b'], onlyOld: ['c'] }, 2)).toBe('현재 외부 참조에서만 2개, 현재 외부 참조에 없음 1개, 변경 세트 2개.');
  });
});

describe('호스트 자리로의 변환', () => {
  it('블록 참조 행렬: 기준점·축척·회전·−Z 돌출', () => {
    const m = placementMatrix({ x: 1, y: 0 }, { insert: P(100, 50), scale: P(2, 2, 1), rotation: deg(90) });
    const p = applyAffine(m, 3, 0); // 기준점에서 +2 → 축척 4 → 90° → (0, 4)
    expect(p.x).toBeCloseTo(100, 9);
    expect(p.y).toBeCloseTo(54, 9);
    const mir = placementMatrix({ x: 0, y: 0 }, { insert: P(10, 0), scale: P(1, 1, 1), rotation: 0, extrusion: P(0, 0, -1) });
    const q = applyAffine(mir, 2, 3);
    expect(q.x).toBeCloseTo(-12, 9);
    expect(q.y).toBeCloseTo(3, 9);
  });

  it('상자 변환과 자리마다의 차이 상자', () => {
    const b = placeBox({ minX: 0, minY: 0, maxX: 10, maxY: 2 }, placementMatrix({ x: 0, y: 0 }, { insert: P(5, 5), scale: P(1, 1, 1), rotation: deg(90) }));
    expect(b.minX).toBeCloseTo(3, 9);
    expect(b.maxX).toBeCloseTo(5, 9);
    expect(b.minY).toBeCloseTo(5, 9);
    expect(b.maxY).toBeCloseTo(15, 9);

    const prev = prevVersion();
    const cur = prev.clone();
    const added = cur.add(line(50, 50, 60, 60));
    const d = diffXrefVersions(prev.doc, cur.doc, DEFAULT_OPTIONS);
    const places = [placementMatrix({ x: 0, y: 0 }, { insert: P(0, 0), scale: P(1, 1, 1), rotation: 0 }), placementMatrix({ x: 0, y: 0 }, { insert: P(1000, 0), scale: P(1, 1, 1), rotation: 0 })];
    const boxes = placedDiffBoxes(d, cur.doc, prev.doc, places);
    expect(d.onlyNew).toEqual([added.handle]);
    expect(boxes).toEqual([
      { minX: 50, minY: 50, maxX: 60, maxY: 60 },
      { minX: 1050, minY: 50, maxX: 1060, maxY: 60 },
    ]);
    // 두 자리의 변경은 서로 다른 변경 세트
    const sets = changeSets(boxes, { minX: 0, minY: 0, maxX: 1060, maxY: 60 }, 5);
    expect(sets.length).toBe(2);
  });

  it('호스트의 외부 참조 블록과 그 참조(모형 공간 최상위)', () => {
    const host = new Doc(0x9000);
    host.block('XR1', []);
    host.doc.blocks.get('XR1')!.flags = 4;
    host.block('PART', [line(0, 0, 1, 1)]);
    host.add(insert('XR1', 0, 0));
    host.add(insert('xr1', 10, 0));
    host.add(insert('PART', 0, 0));
    expect(xrefBlockKeys(host.doc)).toEqual(['XR1']);
    expect(xrefInserts(host.doc, 'XR1').length).toBe(2);
  });
});

describe('변수와 흐리게', () => {
  it('XCOMPAREENABLE·XCOMPARECOLORMODE(초기 1)는 비교 변수와 같은 모양, COMPARE 목록은 그대로', () => {
    expect(XCOMPARE_VARS.map((v) => [v.name, v.kind === 'int' ? v.def : null])).toEqual([
      ['XCOMPAREENABLE', 1],
      ['XCOMPARECOLORMODE', 1],
    ]);
    expect(compareVar('xcomparecolormode')?.name).toBe('XCOMPARECOLORMODE');
    expect(COMPARE_VARS.length).toBe(14);
  });

  it('호스트 객체는 회색조로, 배경 쪽으로 섞는다(보임·선가중치는 그대로)', () => {
    const d = new Float32Array([1, 0, 0, 1, 0.25, 1, 0, 0]);
    const out = fadeStyles(d, 0x000000, 0.5, true);
    expect(out).not.toBe(d);
    const y = 0.299;
    expect(out[0]).toBeCloseTo(y * 0.5, 6);
    expect(out[1]).toBeCloseTo(y * 0.5, 6);
    expect(out[2]).toBeCloseTo(y * 0.5, 6);
    expect(out[4]).toBeCloseTo(0.25, 6);
    expect(out[5]).toBe(1);
    expect(d[0]).toBe(1);
    const keep = fadeStyles(d, 0xffffff, 0, false);
    expect([...keep.slice(0, 3)]).toEqual([1, 0, 0]);
  });
});
