import { describe, expect, it } from 'vitest';
import { compareDrawings } from '../../src/edit/compare/match';
import { DEFAULT_OPTIONS, PROP_LAYER } from '../../src/edit/compare/signature';
import { Doc, circle, hatch, insert, line, text } from './make';

const opt = DEFAULT_OPTIONS;

function sample(): Doc {
  const d = new Doc();
  d.add(line(0, 0, 10, 0));
  d.add(line(0, 0, 0, 10));
  d.add(circle(5, 5, 2));
  d.add(text(1, 1, '도면'));
  return d;
}

describe('두 도면 맞추기', () => {
  it('같은 도면은 모두 차이 없음(핸들로 맞춘다)', () => {
    const a = sample();
    const r = compareDrawings(a.doc, a.doc, opt);
    expect(r.onlyCurrent).toEqual([]);
    expect(r.onlyCompare).toEqual([]);
    expect(r.common).toBe(4);
    expect(r.byHandle).toBe(4);
    expect(r.sameLineage).toBe(true);
  });

  it('옮기고 지우고 더한 객체', () => {
    const a = sample();
    const b = a.clone();
    const moved = b.model[0]!;
    if (moved.type === 'LINE') moved.end = { x: 12, y: 0, z: 0 };
    b.model.splice(2, 1); // 원 지움
    const added = b.add(line(20, 20, 30, 30));
    const r = compareDrawings(a.doc, b.doc, opt);
    expect(new Set(r.onlyCurrent)).toEqual(new Set([a.model[0]!.handle, a.model[2]!.handle]));
    expect(new Set(r.onlyCompare)).toEqual(new Set([moved.handle, added.handle]));
    expect(r.common).toBe(2);
    // 같은 계보라 바뀐 선은 바뀐 쌍
    expect(r.modified).toEqual([[moved.handle, moved.handle]]);
  });

  it('지우고 다시 그린 같은 객체는 차이 없음', () => {
    const a = sample();
    const b = a.clone();
    const old = b.model.shift()!;
    b.add({ ...structuredClone(old), handle: '' });
    const r = compareDrawings(a.doc, b.doc, opt);
    expect(r.onlyCurrent).toEqual([]);
    expect(r.onlyCompare).toEqual([]);
    expect(r.common).toBe(4);
  });

  it('핸들이 우연히 같은 다른 도면은 같은 계보로 보지 않는다', () => {
    const a = new Doc();
    const b = new Doc();
    for (let i = 0; i < 10; i++) {
      a.add(line(i, 0, i, 10));
      b.add(line(i + 100, 0, i + 100, 10));
    }
    const r = compareDrawings(a.doc, b.doc, opt);
    expect(r.sameLineage).toBe(false);
    expect(r.onlyCurrent.length).toBe(10);
    expect(r.onlyCompare.length).toBe(10);
    expect(r.modified).toEqual([]);
  });

  it('허용 오차 경계', () => {
    const a = new Doc();
    const b = new Doc(0x900);
    a.add(circle(0, 0, 1));
    a.add(circle(10, 0, 1));
    b.add(circle(5e-7, 0, 1)); // 10^-6 안
    b.add(circle(10 + 5e-6, 0, 1)); // 밖
    const r = compareDrawings(a.doc, b.doc, opt);
    expect(r.common).toBe(1);
    expect(r.onlyCurrent.length).toBe(1);
    const r3 = compareDrawings(a.doc, b.doc, { ...opt, tolerance: 4 });
    expect(r3.common).toBe(2);
  });

  it('겹친 같은 객체는 하나씩 짝을 짓는다', () => {
    const a = new Doc();
    const b = new Doc(0x900);
    a.add(line(0, 0, 1, 1));
    a.add(line(0, 0, 1, 1));
    b.add(line(1, 1, 0, 0));
    const r = compareDrawings(a.doc, b.doc, opt);
    expect(r.common).toBe(1);
    expect(r.onlyCurrent.length).toBe(1);
    expect(r.onlyCompare.length).toBe(0);
  });

  it('문자·해치 필터와 특성 비트', () => {
    const a = new Doc();
    const b = new Doc(0x900);
    a.add(text(0, 0, 'A'));
    b.add(text(0, 0, 'B'));
    a.add(hatch(0, 0, 5, 5));
    b.add(hatch(0, 0, 5, 6));
    a.add(line(0, 0, 3, 3, 'A'));
    b.add(line(0, 0, 3, 3, 'B'));
    const r = compareDrawings(a.doc, b.doc, opt);
    // 문자는 비교, 해치는 기본으로 빼고, 도면층은 보지 않는다
    expect(r.onlyCurrent.length).toBe(1);
    expect(r.filtered).toEqual({ current: 1, compare: 1 });
    const r2 = compareDrawings(a.doc, b.doc, { ...opt, text: false, hatch: true, props: PROP_LAYER });
    expect(r2.onlyCurrent.length).toBe(2); // 해치와 선
    expect(r2.filtered).toEqual({ current: 1, compare: 1 });
  });

  it('블록 정의 내용이 다르면 블록 참조도 다르다', () => {
    const a = new Doc();
    const b = new Doc(0x900);
    a.block('PART', [line(0, 0, 1, 0)]);
    b.block('PART', [line(0, 0, 2, 0)]);
    a.block('SAME', [circle(0, 0, 1)]);
    b.block('SAME', [circle(0, 0, 1)]);
    a.add(insert('PART', 5, 5));
    b.add(insert('PART', 5, 5));
    a.add(insert('SAME', 9, 9));
    b.add(insert('SAME', 9, 9));
    const r = compareDrawings(a.doc, b.doc, opt);
    expect(r.onlyCurrent.length).toBe(1);
    expect(r.onlyCompare.length).toBe(1);
    expect(r.common).toBe(1);
  });

  it('익명 블록은 이름이 달라도 내용이 같으면 같다, 중첩 블록과 자기 참조도 견딘다', () => {
    const a = new Doc();
    const b = new Doc(0x900);
    a.block('INNER', [line(0, 0, 1, 1)]);
    b.block('INNER', [line(0, 0, 1, 1)]);
    a.block('*U3', [insert('INNER', 0, 0), circle(0, 0, 2)]);
    b.block('*U7', [insert('INNER', 0, 0), circle(0, 0, 2)]);
    a.add(insert('*U3', 1, 1));
    b.add(insert('*U7', 1, 1));
    // 자기 참조
    a.block('LOOP', [insert('LOOP', 0, 0)]);
    b.block('LOOP', [insert('LOOP', 0, 0)]);
    a.add(insert('LOOP', 3, 3));
    b.add(insert('LOOP', 3, 3));
    const r = compareDrawings(a.doc, b.doc, opt);
    expect(r.onlyCurrent).toEqual([]);
    expect(r.onlyCompare).toEqual([]);
    expect(r.common).toBe(2);
  });
});
