import { describe, expect, it } from 'vitest';
import type { MTextEntity, TextEntity } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { justifyText, mtextPoint, scaleBasePoint, textFrame } from '../../src/edit/geom/textjust';
import { metrics, mtextLocalBox } from '../../src/edit/geom/xtext';
import { transformEntity } from '../../src/edit/geom/transform';
import { affScale } from '../../src/edit/geom/math';
import { P, V, near, newDoc } from '../edit/helpers';

const doc = newDoc();

function text(over: Partial<TextEntity> = {}): TextEntity {
  return {
    type: 'TEXT',
    ...entityDefaults(),
    handle: 'T1',
    insert: P(10, 20),
    height: 2.5,
    text: 'ABCD',
    rotation: 0,
    widthFactor: 1,
    oblique: 0,
    style: 'Standard',
    generation: 0,
    halign: 0,
    valign: 0,
    ...over,
  };
}

/** 그리기와 같은 배치의 상자 */
function box(e: TextEntity) {
  return metrics().layoutText({ ...e, style: undefined });
}

function sameBox(a: TextEntity, b: TextEntity, tol = 1e-9) {
  const x = box(a);
  const y = box(b);
  expect(Math.abs(x.minX - y.minX)).toBeLessThan(tol);
  expect(Math.abs(x.minY - y.minY)).toBeLessThan(tol);
  expect(Math.abs(x.maxX - y.maxX)).toBeLessThan(tol);
  expect(Math.abs(x.maxY - y.maxY)).toBeLessThan(tol);
}

describe('JUSTIFYTEXT', () => {
  it('왼쪽 → 중간 중심·맨 위 오른쪽·중간: 문자 자리는 그대로', () => {
    const t = text();
    for (const k of ['MC', 'TR', 'BL', 'M', 'C', 'R']) {
      const o = justifyText(t, k, doc) as TextEntity;
      expect(o).toBeTruthy();
      sameBox(t, o);
      // 되돌려도 같다
      const back = justifyText(o, 'L', doc) as TextEntity;
      sameBox(t, back);
      near(back.insert, t.insert, 1e-9);
      expect(back.alignPoint).toBeUndefined();
    }
  });
  it('회전한 문자도 그대로', () => {
    const t = text({ rotation: 0.7, widthFactor: 0.8, oblique: 0.2 });
    const o = justifyText(t, 'TC', doc) as TextEntity;
    sameBox(t, o);
    expect(o.halign).toBe(1);
    expect(o.valign).toBe(3);
  });
  it('정렬(A)로 바꾸면 지금 폭의 두 점, 다시 왼쪽으로', () => {
    const t = text({ rotation: 0.3 });
    const a = justifyText(t, 'A', doc) as TextEntity;
    expect(a.halign).toBe(3);
    sameBox(t, a, 1e-6);
    const f = textFrame(a, doc);
    expect(f.h).toBeCloseTo(2.5);
    const l = justifyText(a, 'L', doc) as TextEntity;
    sameBox(t, l, 1e-6);
  });
  it('같은 자리맞추기면 null', () => {
    expect(justifyText(text(), 'L', doc)).toBeNull();
  });
  it('MTEXT 부착점을 바꿔도 상자는 그대로', () => {
    const m: MTextEntity = {
      type: 'MTEXT',
      ...entityDefaults(),
      handle: 'M1',
      insert: P(0, 0),
      height: 2,
      width: 0,
      attachment: 1,
      drawingDirection: 1,
      text: 'Hello\\PWorld',
      style: 'Standard',
      rotation: 0,
      lineSpacingStyle: 1,
      lineSpacingFactor: 1,
      backgroundFlags: 0,
      backgroundScale: 1.5,
    };
    const b1 = mtextLocalBox(m, doc);
    const o = justifyText(m, 'BR', doc) as MTextEntity;
    expect(o.attachment).toBe(9);
    const b2 = mtextLocalBox(o, doc);
    expect(o.insert.x + b2.minX).toBeCloseTo(m.insert.x + b1.minX, 9);
    expect(o.insert.y + b2.minY).toBeCloseTo(m.insert.y + b1.minY, 9);
    expect(o.insert.x + b2.maxX).toBeCloseTo(m.insert.x + b1.maxX, 9);
    // 맨 아래 오른쪽 점 = 새 삽입점
    const p = mtextPoint(m, 9, doc);
    near(p, o.insert, 1e-9);
  });
});

describe('SCALETEXT', () => {
  it('기준점(중간 중심)을 두고 축척하면 그 점은 그대로', () => {
    const t = text({ rotation: 0.4 });
    const p = scaleBasePoint(t, 'MC', doc)!;
    const r = transformEntity(t, affScale(2, 2, p), doc);
    const o = r.replace![0] as TextEntity;
    expect(o.height).toBeCloseTo(5);
    const q = scaleBasePoint(o, 'MC', doc)!;
    near(q, p, 1e-9);
  });
  it('기존(E): 지금 자리맞추기 점', () => {
    const t = justifyText(text(), 'TR', doc) as TextEntity;
    near(scaleBasePoint(t, 'E', doc)!, V(t.alignPoint!.x, t.alignPoint!.y));
    near(scaleBasePoint(text(), 'E', doc)!, V(10, 20));
  });
});
