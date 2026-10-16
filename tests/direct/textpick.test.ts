import { describe, expect, it } from 'vitest';
import { Picker } from '../../src/app/pick';
import type { CadDocument, Entity } from '../../src/core/model';
import { TextEngine } from '../../src/text/layout';
import { newDoc } from '../edit/make';
import { MODEL_SPACE } from '../../src/core/model';

function docWith(e: Entity): CadDocument {
  const doc = newDoc();
  doc.blocks.get(MODEL_SPACE)!.entities.push(e);
  doc.entityIndex.set(e.handle, e);
  return doc;
}

describe('문자 고르기', () => {
  it('글자 획 사이·윤곽 글꼴이 없을 때도 문자 범위 상자 안을 누르면 고른다', () => {
    const mt = { type: 'MTEXT', handle: 'T1', layer: '0', insert: { x: 0, y: 10, z: 0 }, height: 2.5, width: 40, attachment: 1, text: '주기\\P재질 SS275' } as unknown as Entity;
    const doc = docWith(mt);
    const pk = new Picker(doc, [{ handle: 'T1', minX: 0, minY: 4, maxX: 30, maxY: 10 }], new TextEngine(null), MODEL_SPACE);
    expect(pk.pick(15, 7, 0.1)).toBe('T1');
    expect(pk.pick(35, 7, 0.1)).toBeNull();
  });
});
