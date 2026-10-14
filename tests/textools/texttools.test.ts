/** TXT2MTXT·TEXTALIGN·ATTIPEDIT 순수 계산 */
import { describe, expect, it } from 'vitest';
import type { AttribEntity, CadDocument, Entity, InsertEntity, MTextEntity, TextEntity } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { textToMTextString, textsToMText } from '../../src/edit/textools/txt2mtxt';
import { anchorOf, justKeyOf, planTextAlign, textCorners } from '../../src/edit/textools/textalign';
import { attributeAt, attributeValue, withAttributeValue } from '../../src/edit/textools/attipedit';
import { textFrame } from '../../src/edit/geom/textjust';

const doc: CadDocument = createNewDocument('metric');
let hn = 0x100;

function text(s: string, x: number, y: number, over: Partial<TextEntity> = {}): TextEntity {
  return {
    ...entityDefaults(),
    type: 'TEXT',
    handle: (hn++).toString(16).toUpperCase(),
    insert: { x, y, z: 0 },
    height: 2.5,
    text: s,
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

describe('TXT2MTXT', () => {
  it('위 → 아래 순서로 한 여러 줄 문자에 결합하고 첫 줄의 특성·왼쪽 위를 쓴다', () => {
    const a = text('둘째 줄', 0, 0, { layer: 'B' });
    const b = text('첫째 줄', 0, 5, { layer: 'A', color: { aci: 2 } });
    const c = text('셋째 줄', 0, -5);
    const r = textsToMText([a, b, c], doc)!;
    expect(r.remove).toEqual([b.handle, a.handle, c.handle]);
    const m = r.add[0]!;
    expect(m.text).toBe('첫째 줄\\P둘째 줄\\P셋째 줄');
    expect(m.layer).toBe('A');
    expect(m.color.aci).toBe(2);
    expect(m.height).toBe(2.5);
    expect(m.attachment).toBe(1);
    expect(m.insert.x).toBeCloseTo(0, 9);
    expect(m.insert.y).toBeCloseTo(7.5, 9);
    expect(m.width).toBe(0);
    // 줄 간격 5 = 1.667 × 2.5 × 계수
    expect(m.lineSpacingStyle).toBe(2);
    expect(m.lineSpacingFactor).toBeCloseTo(5 / (1.667 * 2.5), 6);
  });

  it('선택 순서, 자동 줄바꿈(한 문단 + 폭), 결합하지 않기', () => {
    const a = text('A', 0, 0);
    const b = text('B', 0, 5);
    const sel = textsToMText([a, b], doc, { combine: true, order: 'selection', wordWrap: false })!;
    expect(sel.add[0]!.text).toBe('A\\PB');
    const ww = textsToMText([a, b], doc, { combine: true, order: 'position', wordWrap: true })!;
    expect(ww.add[0]!.text).toBe('B A');
    expect(ww.add[0]!.width).toBeGreaterThan(0);
    const each = textsToMText([a, b], doc, { combine: false, order: 'position', wordWrap: false })!;
    expect(each.add).toHaveLength(2);
    expect(each.remove).toEqual([a.handle, b.handle]);
    expect(each.add[0]!.insert.y).toBeCloseTo(2.5, 9);
  });

  it('같은 줄의 문자는 빈칸으로 잇고, 높이가 다른 줄은 \\H로, 가운데 맞춤은 가운데 위 부착점', () => {
    const a = text('왼쪽', 0, 0);
    const b = text('오른쪽', 30, 0);
    const c = text('작은 줄', 0, -4, { height: 1.25 });
    const r = textsToMText([b, c, a], doc)!;
    expect(r.add[0]!.text).toBe('왼쪽 오른쪽\\P{\\H1.25;작은 줄}');
    const ca = text('제목', 10, 0, { halign: 1, alignPoint: { x: 10, y: 0, z: 0 } });
    const cb = text('부제', 10, -4, { halign: 1, alignPoint: { x: 10, y: -4, z: 0 } });
    const m = textsToMText([ca, cb], doc)!.add[0]!;
    expect(m.attachment).toBe(2);
    expect(m.insert.x).toBeCloseTo(10, 9);
  });

  it('%%d·%%u 같은 문자 코드를 여러 줄 문자 서식으로', () => {
    expect(textToMTextString('45%%d %%uA%%u {x}\\')).toBe('45° \\LA\\l \\{x\\}\\\\');
  });

  it('회전한 문자는 그 방향으로 위 → 아래, 여러 줄 문자도 회전', () => {
    const rot = Math.PI / 2;
    // 90° 회전: 글자 "위"는 -X 쪽이므로 X가 작은 문자가 첫 줄
    const a = text('2', 5, 0, { rotation: rot });
    const b = text('1', 0, 0, { rotation: rot });
    const m = textsToMText([a, b], doc)!.add[0]!;
    expect(m.text).toBe('1\\P2');
    expect(m.rotation).toBeCloseTo(rot, 12);
    expect(m.insert.x).toBeCloseTo(-2.5, 9);
  });
});

describe('TEXTALIGN', () => {
  it('자리맞추기 키', () => {
    expect(justKeyOf(text('a', 0, 0))).toBe('L');
    expect(justKeyOf(text('a', 0, 0, { halign: 2, valign: 3 }))).toBe('TR');
    expect(justKeyOf({ ...(text('a', 0, 0) as Entity), type: 'MTEXT', attachment: 5 } as MTextEntity)).toBe('MC');
  });

  it('현재 수직: 기준 문자 아래로 수직선을 그으면 Y는 그대로, 왼쪽 끝이 기준선 X에 맞는다', () => {
    const ref = text('기준', 10, 20);
    const a = text('가', 13, 15);
    const b = text('나', 7.5, 9);
    const from = anchorOf(ref, 'L', doc)!;
    const plan = planTextAlign({ texts: [a, b], reference: ref, key: 'L', from, to: { x: 10, y: 0 }, mode: 'V' }, doc);
    expect(plan).toEqual([
      { handle: a.handle, dx: -3, dy: 0 },
      { handle: b.handle, dx: 2.5, dy: 0 },
    ]);
  });

  it('현재 수평: X는 그대로 두고 기울어진 선까지 수직으로', () => {
    const ref = text('기준', 0, 0);
    const a = text('가', 10, 3);
    const plan = planTextAlign({ texts: [a], reference: ref, key: 'L', from: { x: 0, y: 0 }, to: { x: 10, y: 10 }, mode: 'H' }, doc);
    expect(plan[0]!.dx).toBeCloseTo(0, 12);
    expect(plan[0]!.dy).toBeCloseTo(7, 12);
  });

  it('분산: 두 점 사이에 같은 간격, 지금 선 방향 순서', () => {
    const a = text('a', 0, 30);
    const b = text('b', 0, 1);
    const c = text('c', 0, 12);
    const plan = planTextAlign({ texts: [a, b, c], key: 'L', from: { x: 0, y: 0 }, to: { x: 0, y: 20 }, mode: 'D' }, doc);
    const ys = new Map(plan.map((p) => [p.handle, p.dy]));
    expect(ys.get(b.handle)).toBeCloseTo(-1, 12);
    expect(ys.get(c.handle)).toBeCloseTo(-2, 12);
    expect(ys.get(a.handle)).toBeCloseTo(-10, 12);
  });

  it('간격 설정: 문자 범위 사이 간격이 그 값', () => {
    const ref = text('R', 0, 0);
    const a = text('A', 0, -3);
    const b = text('B', 0, -20);
    const from = anchorOf(ref, 'L', doc)!;
    const plan = planTextAlign({ texts: [a, b], reference: ref, key: 'L', from, to: { x: 0, y: -10 }, mode: 'S', spacing: 1 }, doc);
    const moved = (t: TextEntity) => {
      const p = plan.find((x) => x.handle === t.handle)!;
      return { ...t, insert: { x: t.insert.x + p.dx, y: t.insert.y + p.dy, z: 0 } };
    };
    const ys = (t: TextEntity) => textCorners(t, doc).map((q) => q.y);
    const rBot = Math.min(...ys(ref));
    const aTop = Math.max(...ys(moved(a)));
    const aBot = Math.min(...ys(moved(a)));
    const bTop = Math.max(...ys(moved(b)));
    expect(rBot - aTop).toBeCloseTo(1, 9);
    expect(aBot - bTop).toBeCloseTo(1, 9);
  });

  it('선 방향을 정할 수 없으면 아무것도 옮기지 않는다', () => {
    expect(planTextAlign({ texts: [text('a', 1, 1)], key: 'L', from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, mode: 'V' }, doc)).toEqual([]);
  });
});

describe('ATTIPEDIT', () => {
  const att = (tag: string, s: string, y: number, over: Partial<AttribEntity> = {}): AttribEntity => ({ ...text(s, 0, y), type: 'ATTRIB', tag, attFlags: 0, ...over });
  const ins = (): InsertEntity => ({
    ...entityDefaults(),
    type: 'INSERT',
    handle: 'B1',
    block: 'TITLE',
    insert: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    rotation: 0,
    columnCount: 1,
    rowCount: 1,
    columnSpacing: 0,
    rowSpacing: 0,
    attribs: [att('NAME', '홍길동', 0, { handle: 'A1' }), att('DATE', '2026-10-15', -5, { handle: 'A2' }), att('HIDDEN', 'x', -10, { handle: 'A3', attFlags: 1 })],
  });

  it('누른 자리의 속성(틀 안, 아니면 허용 거리 안에서 가장 가까운 것)', () => {
    const b = ins();
    const f = textFrame(b.attribs[1]!, doc);
    expect(attributeAt(b, { x: 1, y: -4 }, doc, 0.1)?.tag).toBe('DATE');
    expect(attributeAt(b, { x: 1, y: 1 }, doc, 0.1)?.tag).toBe('NAME');
    expect(attributeAt(b, { x: f.W * 2.5 + 0.5, y: -4 }, doc, 1)?.tag).toBe('DATE');
    expect(attributeAt(b, { x: 100, y: 100 }, doc, 1)).toBeNull();
    // 숨긴 속성은 고르지 않는다
    expect(attributeAt(b, { x: 0.3, y: -9 }, doc, 0.1)).toBeNull();
  });

  it('값 하나만 바꾸고, 여러 줄 속성은 \\P 줄바꿈', () => {
    const b = ins();
    const n = withAttributeValue(b, 'A2', '2027-01-01')!;
    expect(n.attribs[1]!.text).toBe('2027-01-01');
    expect(n.attribs[0]).toBe(b.attribs[0]);
    expect(b.attribs[1]!.text).toBe('2026-10-15');
    expect(withAttributeValue(b, 'A2', '2026-10-15')).toBeNull();
    const m: MTextEntity = { ...entityDefaults(), type: 'MTEXT', handle: '', insert: { x: 0, y: 0, z: 0 }, height: 2.5, width: 0, attachment: 1, drawingDirection: 1, text: '첫 줄\\P둘째', style: 'Standard', rotation: 0, lineSpacingStyle: 1, lineSpacingFactor: 1, backgroundFlags: 0, backgroundScale: 1.5 };
    b.attribs[0] = { ...b.attribs[0]!, mtext: m };
    expect(attributeValue(b.attribs[0]!)).toBe('첫 줄\n둘째');
    const n2 = withAttributeValue(b, 'A1', '하나\n둘\n셋')!;
    expect(n2.attribs[0]!.mtext!.text).toBe('하나\\P둘\\P셋');
    expect(n2.attribs[0]!.text).toBe('하나 둘 셋');
  });
});
