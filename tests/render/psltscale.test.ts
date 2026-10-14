/** PSLTSCALE용 선종류 배율(ltFactor)과 무늬 표시(dashed) */
import { describe, expect, it } from 'vitest';
import type { CadDocument, Entity, Linetype } from '../../src/core/model';
import { buildSpace } from '../../src/render/build';
import { TextEngine } from '../../src/text/layout';
import { add, line, newDoc } from '../hatch/helpers';

function dashedDoc(): { doc: CadDocument; e: Entity } {
  const doc = newDoc();
  const lt: Linetype = {
    name: 'DASHED',
    handle: 'A0',
    flags: 0,
    description: '__ __',
    patternLength: 15,
    elements: [
      { length: 10, flags: 0, scale: 1, rotation: 0, offset: { x: 0, y: 0 } },
      { length: -5, flags: 0, scale: 1, rotation: 0, offset: { x: 0, y: 0 } },
    ],
  };
  doc.linetypes.set('DASHED', lt);
  const [e] = add(doc, { ...line(0, 0, 300, 0), linetype: 'DASHED' });
  return { doc, e: e! };
}

const segCount = (doc: CadDocument, ltFactor?: number) => {
  const s = buildSpace(doc, '*Model_Space', { text: new TextEngine(null), ltFactor });
  return { n: s.list.chunks.reduce((a, c) => a + c.segCount, 0), dashed: s.list.dashed };
};

describe('PSLTSCALE 선종류 배율', () => {
  it('무늬 선이 있으면 dashed가 참이고, 배율만큼 무늬가 길어진다', () => {
    const { doc } = dashedDoc();
    const a = segCount(doc);
    const b = segCount(doc, 2);
    expect(a.dashed).toBe(true);
    expect(a.n).toBe(20); // 300 / 15
    expect(b.n).toBe(10); // 300 / 30
  });

  it('$LTSCALE과 곱해진다', () => {
    const { doc } = dashedDoc();
    doc.header.set('$LTSCALE', 2);
    expect(segCount(doc, 0.5).n).toBe(20);
  });

  it('실선뿐이면 dashed가 없다', () => {
    const doc = newDoc();
    add(doc, line(0, 0, 300, 0));
    const r = segCount(doc, 5);
    expect(r.dashed).toBeUndefined();
    expect(r.n).toBe(1);
  });
});
