/** 원호 정렬 문자: 글자 배치, 변환, 연관, 분해 */
import { describe, expect, it } from 'vitest';
import type { ArcEntity, ArcTextEntity, Entity, TextEntity } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults } from '../../src/core/model';
import { arcTextDefaults, arcTextError, arcTextParts, baseRadius, charAdvance, layoutArcText } from '../../src/text/arctext';
import { explodeArcText, fitsArc, followArcTexts, newArcText, xformArcText } from '../../src/edit/textools/arctext';
import type { EditOp } from '../../src/edit/session';
import { affMirror, affRotate, affScale, affTranslate } from '../../src/edit/geom/math';

const D = Math.PI / 180;

function arc(over: Partial<ArcEntity> = {}): ArcEntity {
  return { ...entityDefaults(), type: 'ARC', handle: 'A1', center: { x: 0, y: 0, z: 0 }, radius: 10, startAngle: 0, endAngle: Math.PI, ...over };
}

function at(over: Partial<ArcTextEntity> = {}): ArcTextEntity {
  return {
    ...entityDefaults(),
    ...arcTextDefaults(),
    handle: 'T1',
    text: 'AAA',
    center: { x: 0, y: 0, z: 0 },
    radius: 10,
    startAngle: 0,
    endAngle: Math.PI,
    style: 'Standard',
    height: 1,
    alignment: 4,
    ...over,
  };
}

const close = (a: number, b: number, tol = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(tol);

describe('원호 정렬 문자 글자 배치', () => {
  it('볼록·바깥쪽·중심: 가운데 글자가 호 꼭대기에 똑바로, 왼쪽에서 오른쪽으로 읽는다', () => {
    const lay = layoutArcText(at())!;
    expect(lay.baseRadius).toBe(10);
    expect(lay.glyphs.map((g) => g.ch)).toEqual(['A', 'A', 'A']);
    const [g0, g1, g2] = lay.glyphs;
    close(g1!.angle, Math.PI / 2);
    close(g1!.rotation, 0);
    close(g1!.x, 0);
    close(g1!.y, 10);
    expect(g0!.x).toBeLessThan(0);
    expect(g2!.x).toBeGreaterThan(0);
    // 자리 폭 = 단선 글꼴 전진 폭 × 높이
    close(g0!.width, charAdvance(65));
    close(g1!.angle - g2!.angle, g1!.width / 10);
  });

  it('기준선 반지름: 볼록·안쪽은 R+간격+높이, 오목·바깥쪽은 R−간격−높이, 오목·안쪽은 R−간격', () => {
    const b = { radius: 10, offset: 0.5, height: 2 };
    expect(baseRadius({ ...b, position: 1, direction: 1 })).toBe(10.5);
    expect(baseRadius({ ...b, position: 1, direction: 2 })).toBe(12.5);
    expect(baseRadius({ ...b, position: 2, direction: 1 })).toBe(7.5);
    expect(baseRadius({ ...b, position: 2, direction: 2 })).toBe(9.5);
  });

  it('안쪽 방향은 시작 각도에서 반시계로 읽고 글자 머리가 중심을 향한다', () => {
    // 아래쪽 반원(180°→360°), 오목·안쪽: 아래 반원 안쪽에서 왼쪽 → 오른쪽으로 읽힌다
    const lay = layoutArcText(at({ startAngle: Math.PI, endAngle: 2 * Math.PI, position: 2, direction: 2, alignment: 2, text: 'AB' }))!;
    const [a, b] = lay.glyphs;
    expect(a!.ch).toBe('A');
    expect(a!.x).toBeLessThan(b!.x);
    close(a!.angle, Math.PI + (a!.width / 2) / 10);
    // 머리(글자 Y축 = 회전 + 90°)가 중심 쪽
    const up = a!.rotation + Math.PI / 2;
    const toCenter = Math.atan2(-a!.y, -a!.x);
    close(Math.cos(up - toCenter), 1);
  });

  it('왼쪽·오른쪽·맞춤 정렬과 간격띄우기, 문자 간격, 반전', () => {
    const rb = 10;
    const L = rb * Math.PI;
    const left = layoutArcText(at({ alignment: 2, leftOffset: 1, charSpacing: 0.5 }))!;
    const w = left.glyphs.map((g) => g.width);
    close(left.glyphs[0]!.angle, Math.PI - (1 + w[0]! / 2) / rb);
    close(left.glyphs[1]!.angle, Math.PI - (1 + w[0]! + 0.5 + w[1]! / 2) / rb);
    const right = layoutArcText(at({ alignment: 3, rightOffset: 2 }))!;
    const last = right.glyphs[2]!;
    close(last.angle, Math.PI - (L - 2 - last.width / 2) / rb);
    const fit = layoutArcText(at({ alignment: 1, leftOffset: 1, rightOffset: 1 }))!;
    close(fit.glyphs[0]!.angle, Math.PI - (1 + w[0]! / 2) / rb);
    close(fit.glyphs[2]!.angle, Math.PI - (L - 1 - w[2]! / 2) / rb);
    // 글자 범위 = 왼쪽 간격띄우기부터 오른쪽 간격띄우기까지
    close(fit.span.sweep, (L - 2) / rb);
    const rev = layoutArcText(at({ text: 'ABC', reversed: true }))!;
    expect(rev.glyphs.map((g) => g.ch).join('')).toBe('CBA');
  });

  it('밑줄은 기준선에서 높이 × 0.2 아래(바깥쪽이면 안쪽 반지름)', () => {
    const lay = layoutArcText(at({ underline: true, height: 2 }))!;
    close(lay.underline!.radius, 10 - 0.4);
    close(lay.underline!.startAngle, lay.span.from);
    const parts = arcTextParts(at({ underline: true, text: 'A B' }));
    // 빈칸은 쓰지 않고, 밑줄 호 하나
    expect(parts.filter((p) => p.type === 'TEXT').map((p) => (p as TextEntity).text)).toEqual(['A', 'B']);
    expect(parts.filter((p) => p.type === 'ARC')).toHaveLength(1);
  });

  it('조각은 가운데 맞춤 TEXT(정렬점 = 기준선 가운데)이고 원래 객체의 특성을 지닌다', () => {
    const e = at({ layer: 'TXT', color: { aci: 3 }, italic: true });
    const parts = arcTextParts(e) as TextEntity[];
    const lay = layoutArcText(e)!;
    expect(parts).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(parts[i]!.halign).toBe(1);
      expect(parts[i]!.valign).toBe(0);
      close(parts[i]!.alignPoint!.x, lay.glyphs[i]!.x);
      close(parts[i]!.rotation, lay.glyphs[i]!.rotation);
      expect(parts[i]!.layer).toBe('TXT');
      expect(parts[i]!.color.aci).toBe(3);
      expect(parts[i]!.oblique).toBeGreaterThan(0);
    }
    const local = arcTextParts({ ...e, center: { x: 100, y: 50, z: 0 } }, { local: true }) as TextEntity[];
    expect(local[0]!.layer).toBe('0');
    expect(local[0]!.color.aci).toBe(0);
    close(local[1]!.alignPoint!.x, 0);
    close(local[1]!.alignPoint!.y, 10);
  });

  it('쓸 수 없는 정의는 까닭을 알린다', () => {
    expect(arcTextError(at())).toBeNull();
    expect(arcTextError(at({ text: '  ' }))).toMatch(/문자/);
    expect(arcTextError(at({ position: 2, direction: 1, offset: 9.5, height: 1 }))).toMatch(/안쪽/);
    expect(arcTextError(at({ leftOffset: 20, rightOffset: 20 }))).toMatch(/간격띄우기/);
    expect(arcTextError(at({ widthFactor: 0 }))).toMatch(/폭 비율/);
    expect(arcTextError(at({ text: 'X'.repeat(300) }))).toMatch(/256/);
  });
});

describe('원호 정렬 문자 편집', () => {
  it('호에서 만들면 호의 중심·반지름·각도와 핸들을 가진다', () => {
    const e = newArcText(arc({ center: { x: 5, y: 6, z: 0 } }), { text: '가나다', style: 'Standard', height: 2.5 }, { layer: 'L', color: { aci: 1 }, linetype: 'ByLayer', lineweight: -1, ltscale: 1, transparency: -1 });
    expect(e.center).toEqual({ x: 5, y: 6, z: 0 });
    expect(e.arc).toBe('A1');
    expect(e.alignment).toBe(1);
    expect(e.position).toBe(1);
    expect(e.direction).toBe(1);
    expect(arcTextError(e)).toBeNull();
    // 한글은 폭 1.0
    expect(layoutArcText(e)!.glyphs[0]!.width).toBeCloseTo(2.5, 9);
  });

  it('이동·회전·축척은 원호를 옮기고, 대칭은 읽을 수 있게 다시 놓으며, 고르지 않은 축척은 거절한다', () => {
    const e = at({ alignment: 2, leftOffset: 1 });
    const mv = xformArcText(e, affTranslate(3, 4)).replace![0] as ArcTextEntity;
    expect(mv.center).toEqual({ x: 3, y: 4, z: 0 });
    const rt = xformArcText(e, affRotate(Math.PI / 2)).replace![0] as ArcTextEntity;
    close(rt.startAngle, Math.PI / 2);
    close(rt.endAngle, 1.5 * Math.PI);
    const sc = xformArcText(e, affScale(2)).replace![0] as ArcTextEntity;
    expect(sc.radius).toBe(20);
    expect(sc.height).toBe(2);
    expect(sc.leftOffset).toBe(2);
    // y축 대칭: 위 반원은 위 반원 그대로, 왼쪽 정렬 → 오른쪽 정렬, 글자 자리는 거울상
    const mr = xformArcText(e, affMirror({ x: 0, y: 0 }, { x: 0, y: 1 })).replace![0] as ArcTextEntity;
    close(mr.startAngle, 0);
    close(mr.endAngle, Math.PI);
    expect(mr.alignment).toBe(3);
    expect(mr.rightOffset).toBe(1);
    const g0 = layoutArcText(e)!.glyphs;
    const g1 = layoutArcText(mr)!.glyphs;
    close(g1[2]!.x, -g0[0]!.x, 1e-9);
    close(g1[2]!.y, g0[0]!.y, 1e-9);
    // 거울상이어도 글자는 똑바로(읽는 방향 왼쪽 → 오른쪽)
    expect(g1[0]!.x).toBeLessThan(g1[2]!.x);
    expect(xformArcText(e, affScale(2, 1)).message).toMatch(/고르지 않게/);
  });

  it('분해하면 한 줄 문자와 밑줄 호', () => {
    const r = explodeArcText(at({ underline: true }));
    expect(r.remove).toEqual(['T1']);
    expect(r.add!.map((x) => x.type)).toEqual(['TEXT', 'TEXT', 'TEXT', 'ARC']);
    expect(r.add!.every((x) => x.handle === '')).toBe(true);
  });
});

describe('원호 정렬 문자 연관(호 따라가기)', () => {
  const setup = () => {
    const a = arc();
    const t = { ...at(), arc: 'A1' };
    const index = new Map<string, Entity>([
      ['A1', a],
      ['T1', t],
    ]);
    return { a, t, index, owner: () => MODEL_SPACE };
  };

  it('호를 옮기면 문자가 새 호에 다시 놓인다', () => {
    const { a, t, index, owner } = setup();
    const a2 = { ...a, center: { x: 5, y: 0, z: 0 }, radius: 12 };
    const ops: EditOp[] = [{ kind: 'modify', block: MODEL_SPACE, before: a, after: a2 }];
    const out = followArcTexts(index, ops, owner);
    expect(out).toHaveLength(2);
    const m = out[1] as Extract<EditOp, { kind: 'modify' }>;
    expect(m.before).toBe(t);
    const nt = m.after as ArcTextEntity;
    expect(nt.center.x).toBe(5);
    expect(nt.radius).toBe(12);
    expect(nt.arc).toBe('A1');
    expect(fitsArc(nt, a2)).toBe(true);
  });

  it('호와 문자를 같은 행렬로 옮기면 그대로, 문자만 옮기면 연관이 끊긴다', () => {
    const { a, t, index, owner } = setup();
    const m = affRotate(0.3, { x: 1, y: 2 });
    const a2 = { ...a, center: { x: 0, y: 0, z: 0 } };
    // 호도 같은 행렬로
    const rc = xformArcText(t, m).replace![0] as ArcTextEntity;
    Object.assign(a2, { center: rc.center, startAngle: rc.startAngle, endAngle: rc.endAngle });
    const both: EditOp[] = [
      { kind: 'modify', block: MODEL_SPACE, before: a, after: a2 },
      { kind: 'modify', block: MODEL_SPACE, before: t, after: rc },
    ];
    expect(followArcTexts(index, both, owner)).toBe(both);
    const only: EditOp[] = [{ kind: 'modify', block: MODEL_SPACE, before: t, after: xformArcText(t, affTranslate(1, 0)).replace![0]! }];
    const out = followArcTexts(index, only, owner);
    expect((out[0] as Extract<EditOp, { kind: 'modify' }>).after).not.toHaveProperty('arc');
  });

  it('문자가 새 호에 들어가지 않으면 연관만 끊고, 호를 지우면 핸들을 남긴다', () => {
    const { a, index, owner } = setup();
    const tiny = { ...a, radius: 0.2, endAngle: 0.1 };
    const out = followArcTexts(index, [{ kind: 'modify', block: MODEL_SPACE, before: a, after: tiny }], owner);
    const after = (out[1] as Extract<EditOp, { kind: 'modify' }>).after as ArcTextEntity;
    expect(after.arc).toBeUndefined();
    expect(after.radius).toBe(10);
    const del: EditOp[] = [{ kind: 'remove', block: MODEL_SPACE, entity: a, index: 0 }];
    expect(followArcTexts(index, del, owner)).toBe(del);
  });

  it('호와 함께 복사한 문자는 복사된 호를 따르고, 문자만 복사하면 연관이 없다', () => {
    const { a, t, index, owner } = setup();
    const ca = { ...a, handle: 'A2', center: { x: 30, y: 0, z: 0 } };
    const ct = { ...xformArcText(t, affTranslate(30, 0)).replace![0]!, handle: 'T2' } as ArcTextEntity;
    const out = followArcTexts(
      index,
      [
        { kind: 'add', block: MODEL_SPACE, entity: ca },
        { kind: 'add', block: MODEL_SPACE, entity: ct },
      ],
      owner,
    );
    expect(((out[1] as Extract<EditOp, { kind: 'add' }>).entity as ArcTextEntity).arc).toBe('A2');
    const solo = followArcTexts(index, [{ kind: 'add', block: MODEL_SPACE, entity: ct }], owner);
    expect(((solo[0] as Extract<EditOp, { kind: 'add' }>).entity as ArcTextEntity).arc).toBeUndefined();
  });

  it('호·문자와 무관한 편집은 그대로 둔다', () => {
    const { index, owner } = setup();
    const ln: Entity = { ...entityDefaults(), type: 'LINE', handle: 'L1', start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 } };
    const ops: EditOp[] = [{ kind: 'add', block: MODEL_SPACE, entity: ln }];
    expect(followArcTexts(index, ops, owner)).toBe(ops);
    void D;
  });
});

describe('원호 정렬 문자 연관 — 편집 세션', () => {
  it('호를 고치는 커밋에 따라간 문자가 들어가고, 명령 취소 한 번에 함께 돌아온다', async () => {
    const { createNewDocument } = await import('../../src/core/newdoc');
    const { EditSession } = await import('../../src/edit/session');
    const { followArcTextsOnCommit } = await import('../../src/edit/textools/arctext');
    const doc = createNewDocument('metric');
    const s = new EditSession(doc, () => {});
    followArcTextsOnCommit(s);
    followArcTextsOnCommit(s);
    const a = { ...arc(), handle: s.newHandle() };
    const t = { ...at(), handle: s.newHandle(), arc: a.handle };
    s.commit({ label: 'ADD', ops: [{ kind: 'add', block: MODEL_SPACE, entity: a }, { kind: 'add', block: MODEL_SPACE, entity: t }] });
    const moved = { ...a, center: { x: 7, y: 8, z: 0 } };
    s.commit({ label: 'GRIP', ops: [{ kind: 'modify', block: MODEL_SPACE, before: a, after: moved }] });
    const nt = doc.entityIndex.get(t.handle) as ArcTextEntity;
    expect(nt.center).toEqual({ x: 7, y: 8, z: 0 });
    expect(nt.arc).toBe(a.handle);
    s.undo();
    expect((doc.entityIndex.get(t.handle) as ArcTextEntity).center).toEqual({ x: 0, y: 0, z: 0 });
    s.redo();
    expect((doc.entityIndex.get(t.handle) as ArcTextEntity).center.x).toBe(7);
  });
});

describe('원호 정렬 문자 — 공용 편집 경로(MOVE·EXPLODE·범위)', () => {
  it('transformEntity·explodeEntity·entityBounds가 원호 정렬 문자를 다룬다', async () => {
    const { createNewDocument } = await import('../../src/core/newdoc');
    const { transformEntity, explodeEntity } = await import('../../src/edit/geom');
    const { entityBounds } = await import('../../src/edit/geom/query');
    const doc = createNewDocument('metric');
    const t = at();
    const r = transformEntity(t, affTranslate(5, 0), doc);
    expect((r.replace![0] as ArcTextEntity).center.x).toBe(5);
    expect(transformEntity(t, affScale(1, 2), doc).message).toBeTruthy();
    expect(explodeEntity(t, doc).add!.every((e) => e.type === 'TEXT')).toBe(true);
    const b = entityBounds(t, doc)!;
    expect(b.maxY).toBeGreaterThan(10.5);
    expect(b.minY).toBeGreaterThan(5);
    expect(b.minX).toBeLessThan(0);
    expect(b.maxX).toBeGreaterThan(0);
  });
});
