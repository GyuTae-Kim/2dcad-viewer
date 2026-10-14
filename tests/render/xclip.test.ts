/** XCLIP 자르기 경계 만들기·켜고 끄기·지우기와 블록 참조를 따라가는 경계 */
import { describe, expect, it } from 'vitest';
import type { InsertEntity } from '../../src/core/model';
import { MODEL_SPACE } from '../../src/core/model';
import { applyOps } from '../../src/edit/session';
import { enableXclipOps, removeXclipOps, setXclipOps, xclipBoundaryWorld, xclipParts } from '../../src/edit/xclip';
import { buildSpace } from '../../src/render/build';
import { TextEngine } from '../../src/text/layout';
import { add, defineBlock, insert, line, newDoc } from '../hatch/helpers';

let n = 0xc00;
const H = () => (n++).toString(16).toUpperCase();
const round = (ps: { x: number; y: number }[] | null) => ps?.map((p) => [Math.round(p.x * 1e6) / 1e6, Math.round(p.y * 1e6) / 1e6]);

function setup(rot = 0) {
  const doc = newDoc();
  defineBlock(doc, 'B', [line(0, 0, 100, 0), line(0, 0, 0, 100)]);
  const [ins] = add(doc, insert('B', 10, 20, 2, 2, rot)) as InsertEntity[];
  return { doc, ins: ins! };
}

describe('XCLIP', () => {
  it('회전·축척한 블록 참조에도 자른 자리의 WCS 경계를 그대로 되돌린다', () => {
    const { doc, ins } = setup(Math.PI / 6);
    const pts = [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 80 },
    ];
    applyOps(doc, setXclipOps(doc, ins, MODEL_SPACE, pts, H));
    const e = doc.entityIndex.get(ins.handle) as InsertEntity;
    expect(round(xclipBoundaryWorld(doc, e))).toEqual(round(pts));
    // 블록 참조를 옮기면 경계도 같이
    const moved = { ...e, insert: { ...e.insert, x: e.insert.x + 5 } };
    expect(round(xclipBoundaryWorld(doc, moved))).toEqual(round(pts.map((p) => ({ x: p.x + 5, y: p.y }))));
  });

  it('자르면 경계 밖 선이 줄고, 끄면 다시 다 그린다. 지우기·명령 취소', () => {
    const { doc, ins } = setup();
    const segs = () => buildSpace(doc, MODEL_SPACE, { text: new TextEngine(null) }).list.chunks.reduce((a, c) => a + c.segCount, 0);
    const full = segs();
    const tx = { label: 'X', ops: setXclipOps(doc, ins, MODEL_SPACE, [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }], H) };
    applyOps(doc, tx.ops);
    const e = () => doc.entityIndex.get(ins.handle) as InsertEntity;
    expect(xclipParts(doc, e()).filter).not.toBeNull();
    const clipped = segs();
    expect(clipped).toBeGreaterThan(full); // 경계 틀 4개가 더해지고 잘린 선은 짧아진다
    applyOps(doc, enableXclipOps(doc, e(), false));
    expect(segs()).toBe(full);
    applyOps(doc, enableXclipOps(doc, e(), true));
    applyOps(doc, removeXclipOps(doc, e()));
    expect(xclipParts(doc, e()).filter).toBeNull();
    expect(segs()).toBe(full);
  });
});
