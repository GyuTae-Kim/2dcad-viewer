/** 연관 배열 항목 자리 계산과 이 앱 기록(확장 자료) 왕복 */
import { describe, expect, it } from 'vitest';
import { arrayItems, decompose, isFullCircle, polarStep, polarWithAngle, polarWithFill, polarWithItems } from '../../src/edit/assocarray/layout';
import { decodeRecord, encodeRecord } from '../../src/edit/assocarray/record';
import type { PathParams, PolarParams, RectParams } from '../../src/edit/assocarray/types';
import { affApply, affMul, affRotate } from '../../src/edit/geom/math';
import { addBlock, bench, lineE } from './fixture';

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);
const common = { base: { x: 0, y: 0 }, rows: 1, rowSpacing: 1, rowElevation: 0, levels: 1, levelSpacing: 1 };

describe('항목 자리', () => {
  it('직사각형: 열·행·레벨, 축 각도, 첫 항목 자리와 기준점', () => {
    const p: RectParams = { kind: 'rect', ...common, origin: { x: 5, y: 1 }, base: { x: 1, y: 0 }, columns: 3, columnSpacing: 10, rows: 2, rowSpacing: 4, levels: 2, levelSpacing: 7, rowElevation: 0.5, axesAngle: Math.PI / 2 };
    const it = arrayItems(p);
    expect(it.length).toBe(12);
    // 순서: 항목 번호(열), 행, 레벨
    expect(it.slice(0, 4).map((x) => x.key)).toEqual(['0,0,0', '0,0,1', '0,1,0', '0,1,1']);
    const k = it.find((x) => x.key === '2,1,1')!;
    // 원본 기준점(1,0) → (5 + 20, 1 + 4)
    const q = affApply(k.matrix, { x: 1, y: 0 });
    close(q.x, 25);
    close(q.y, 5);
    close(k.z, 0.5 + 7);
    // 축 각도 60°: 행이 기울어진다
    const sk = arrayItems({ ...p, axesAngle: Math.PI / 3, base: { x: 0, y: 0 }, levels: 1 }).find((x) => x.key === '0,1,0')!;
    close(sk.matrix[4], 5 + 4 * Math.cos(Math.PI / 3));
    close(sk.matrix[5], 1 + 4 * Math.sin(Math.PI / 3));
  });

  it('원형: 시작 각도·반지름, 항목 회전, 행은 바깥으로', () => {
    const p: PolarParams = { kind: 'polar', ...common, center: { x: 10, y: 0 }, items: 4, itemAngle: Math.PI / 2, fillAngle: 2 * Math.PI, startAngle: 0, radius: 5, rotateItems: true, rows: 2, rowSpacing: 3 };
    const it = arrayItems(p);
    expect(it.length).toBe(8);
    const a = it.find((x) => x.key === '1,0,0')!;
    close(a.matrix[4], 10);
    close(a.matrix[5], 5);
    // 90° 회전
    close(a.matrix[0], 0);
    close(a.matrix[1], 1);
    const b = it.find((x) => x.key === '2,1,0')!;
    close(b.matrix[4], 10 - 8);
    close(b.matrix[5], 0);
    // 회전하지 않으면 이동만
    const nr = arrayItems({ ...p, rotateItems: false }).find((x) => x.key === '1,0,0')!;
    close(nr.matrix[0], 1);
    close(nr.matrix[1], 0);
  });

  it('원형 도우미: 항목 수·채울 각도·사이 각도', () => {
    expect(isFullCircle(2 * Math.PI)).toBe(true);
    close(polarStep(2 * Math.PI, 6), Math.PI / 3);
    close(polarStep(Math.PI, 3), Math.PI / 2);
    const p: PolarParams = { kind: 'polar', ...common, center: { x: 0, y: 0 }, items: 6, itemAngle: Math.PI / 3, fillAngle: 2 * Math.PI, startAngle: 0, radius: 1, rotateItems: true };
    close(polarWithItems(p, 8).itemAngle, Math.PI / 4);
    close(polarWithFill(p, Math.PI).itemAngle, Math.PI / 5);
    const q = polarWithAngle(p, Math.PI / 6);
    close(q.fillAngle, (5 * Math.PI) / 6);
    // 한 바퀴가 되면 360°
    close(polarWithAngle({ ...p, items: 4 }, Math.PI / 2).fillAngle, 2 * Math.PI);
    close(polarWithFill(p, -Math.PI).itemAngle, -Math.PI / 5);
  });

  it('경로: 경로 접선 정렬(접선 기준 방향 빼기)과 배열 블록 좌표', () => {
    const path = { pieces: [{ k: 'line' as const, a: { x: 0, y: 0 }, b: { x: 0, y: 12 } }], closed: false, z: 0 };
    const p: PathParams = { kind: 'path', ...common, method: 'divide', items: 4, spacing: 1, align: true, zDir: true, reverse: false, path: null };
    const it = arrayItems(p, path, null);
    expect(it.map((x) => x.key)).toEqual(['0,0,0', '1,0,0', '2,0,0', '3,0,0']);
    close(it[3]!.matrix[5], 12);
    // 접선 +Y → 90° 회전(원본 블록의 +X가 접선)
    close(it[1]!.matrix[0], 0);
    close(it[1]!.matrix[1], 1);
    // 기준 방향 90°면 돌지 않는다
    expect(Math.abs(arrayItems({ ...p, tangentRef: Math.PI / 2 }, path, null)[2]!.matrix[1])).toBeLessThan(1e-12);
    // 배열 블록 좌표로(도면 → 블록: 원점 기준 −90° 회전)
    const toBlock = affRotate(-Math.PI / 2);
    const b = arrayItems(p, path, toBlock)[3]!;
    const w = affApply(affMul(affRotate(Math.PI / 2), b.matrix), { x: 0, y: 0 });
    close(w.x, 0);
    close(w.y, 12);
  });

  it('행렬 분해: 회전·대칭', () => {
    const r = decompose([0, 1, -1, 0, 3, 4]);
    close(r.rotation, Math.PI / 2);
    close(r.sx, 1);
    close(r.sy, 1);
    const m = decompose([-1, 0, 0, 1, 0, 0]);
    close(m.sx, -1);
    close(m.sy, 1);
    close(Math.cos(m.rotation), 1);
  });
});

describe('이 앱 기록(OPENCAD_ARRAY)', () => {
  it('매개변수·지운 항목·대체 블록을 블록 레코드 핸들로 왕복한다', () => {
    const b = bench();
    const src = addBlock(b, '*U90', [lineE(0, 0, 1, 0)]);
    const rep = addBlock(b, '*U91', [lineE(0, 0, 0, 1)]);
    const p: PolarParams = { kind: 'polar', ...common, center: { x: 1, y: 2 }, items: 7, itemAngle: 0.3, fillAngle: 1.8, startAngle: 0.25, radius: 9, rotateItems: false, rows: 2, rowSpacing: 1.5 };
    const x = encodeRecord(b.doc, { params: p, source: src.name, removed: new Set(['1,0,0', '3,1,0']), replaced: new Map([['2,0,0', rep.name]]) });
    expect(x.app).toBe('OPENCAD_ARRAY');
    expect(x.items.filter((i) => i.code === 1000).every((i) => String(i.value).length <= 250)).toBe(true);
    const back = decodeRecord(b.doc, x)!;
    expect(back.source).toBe(src.name);
    expect(back.params).toEqual(p);
    expect([...back.removed].sort()).toEqual(['1,0,0', '3,1,0']);
    expect(back.replaced.get('2,0,0')).toBe(rep.name);
    // 원본 블록이 없으면 null
    b.doc.blockRecords.delete('*U90');
    b.doc.blocks.delete('*U90');
    expect(decodeRecord(b.doc, x)).toBeNull();
  });

  it('경로 매개변수(경로 핸들, 곡선 캐시, 접선 기준)', () => {
    const b = bench();
    const src = addBlock(b, '*U80', [lineE(0, 0, 1, 0)]);
    const p: PathParams = {
      kind: 'path',
      ...common,
      method: 'measure',
      items: 5,
      spacing: 2.5,
      align: false,
      zDir: true,
      reverse: true,
      path: 'ABC',
      tangentRef: 0.5,
      fallback: [
        { k: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } },
        { k: 'nurbs', degree: 2, knots: [0, 0, 0, 1, 1, 1], ctrl: [{ x: 1, y: 0 }, { x: 2, y: 1 }, { x: 3, y: 0 }] },
      ],
    };
    const back = decodeRecord(b.doc, encodeRecord(b.doc, { params: p, source: src.name, removed: new Set(), replaced: new Map() }))!;
    expect(back.params).toEqual(p);
  });
});
