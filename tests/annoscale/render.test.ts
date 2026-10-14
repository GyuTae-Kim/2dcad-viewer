/** 장면 빌더의 주석 축척 표현: 모형 CANNOSCALE, 뷰포트 축척 지정, ANNOALLVISIBLE, 가상 치수 블록 */
import { describe, expect, it } from 'vitest';
import type { CadDocument, Entity } from '../../src/core/model';
import { MODEL_SPACE } from '../../src/core/model';
import { buildSpace } from '../../src/render/build';
import { TextEngine } from '../../src/text/layout';
import { addScales, allVisibleOps, dictVarOps, makeAnnotative } from '../../src/edit/annoscale';
import { createDimension } from './dimfix';
import { addModel, commit, envOf, newDoc, text } from './helpers';

const engine = new TextEngine(null);

function box(doc: CadDocument, handle: string, opt: { annoScale?: string | null; annoAllVisible?: boolean } = {}) {
  const s = buildSpace(doc, MODEL_SPACE, { text: engine, ...opt });
  return { b: s.list.entities.find((x) => x.handle === handle), annotative: s.annotative };
}

function annotated(scales: string[]) {
  const { doc, session } = newDoc();
  let t: Entity = addModel(doc, session, text(0, 0, 2.5));
  const r = makeAnnotative(envOf(doc, session), t, scales[0]!);
  commit(session, [...r.ops, { kind: 'modify', block: MODEL_SPACE, before: t, after: r.entity }]);
  t = doc.entityIndex.get(t.handle)!;
  if (scales.length > 1) {
    const a = addScales(envOf(doc, session), t, scales.slice(1));
    commit(session, [...a.ops, ...(a.entity !== t ? [{ kind: 'modify' as const, block: MODEL_SPACE, before: t, after: a.entity }] : [])]);
  }
  return { doc, session, h: t.handle };
}

describe('주석 축척 표현 그리기', () => {
  it('모형 공간은 CANNOSCALE의 표현을 그린다', () => {
    const { doc, session, h } = annotated(['1:1', '1:10']);
    const a = box(doc, h);
    expect(a.annotative).toBe(1);
    const h1 = a.b!.maxY - a.b!.minY;
    commit(session, dictVarOps(doc, 'CANNOSCALE', '1:10', () => session.newHandle()));
    const b = box(doc, h);
    const h10 = b.b!.maxY - b.b!.minY;
    expect(h10 / h1).toBeCloseTo(10, 0);
  });

  it('축척을 지정하면(배치 뷰포트) 그 표현, 지원하지 않는 축척은 ANNOALLVISIBLE대로', () => {
    const { doc, h } = annotated(['1:1', '1:10']);
    const one = box(doc, h, { annoScale: '1:1' }).b!;
    const ten = box(doc, h, { annoScale: '1:10' }).b!;
    expect((ten.maxY - ten.minY) / (one.maxY - one.minY)).toBeCloseTo(10, 0);
    expect(box(doc, h, { annoScale: '1:5', annoAllVisible: true }).b).toBeTruthy();
    expect(box(doc, h, { annoScale: '1:5', annoAllVisible: false }).b).toBeUndefined();
    expect(box(doc, h, { annoScale: null }).annotative).toBe(0);
  });

  it('모형 탭의 ANNOALLVISIBLE 0이면 CANNOSCALE을 지원하지 않는 객체를 그리지 않는다', () => {
    const { doc, session, h } = annotated(['1:2']);
    commit(session, dictVarOps(doc, 'CANNOSCALE', '1:5', () => session.newHandle()));
    expect(box(doc, h).b).toBeTruthy();
    commit(session, allVisibleOps(doc, MODEL_SPACE, false));
    expect(box(doc, h).b).toBeUndefined();
  });

  it('치수의 다른 축척 그림은 가상 블록으로 그린다', () => {
    const { doc, session } = newDoc();
    let d: Entity = addModel(doc, session, createDimension(doc, session));
    const r = makeAnnotative(envOf(doc, session), d, '1:1');
    commit(session, [...r.ops, { kind: 'modify', block: MODEL_SPACE, before: d, after: r.entity }]);
    d = doc.entityIndex.get(d.handle)!;
    const a = addScales(envOf(doc, session), d, ['1:4']);
    commit(session, [...a.ops, { kind: 'modify', block: MODEL_SPACE, before: d, after: a.entity }]);
    const one = box(doc, d.handle, { annoScale: '1:1' }).b!;
    const four = box(doc, d.handle, { annoScale: '1:4' }).b!;
    // 문자·화살표가 커져 범위의 높이가 커진다
    expect(four.maxY - four.minY).toBeGreaterThan(one.maxY - one.minY + 5);
  });
});
