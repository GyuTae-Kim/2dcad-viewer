/** EXPORTLAYOUT: 배치를 새 도면의 모형으로(종이 객체는 그 자리, 뷰포트는 잘린 블록 참조) */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { InsertEntity, ViewportEntity } from '../../src/core/model';
import { MODEL_SPACE, tableKey } from '../../src/core/model';
import { exportLayoutDocument } from '../../src/edit/exportlayout';
import { xclipBoundaryWorld } from '../../src/edit/xclip';
import { readCadFile } from '../../src/io';

describe('EXPORTLAYOUT', () => {
  it('예제 도면의 A3 배치를 모형으로 내보낸다', () => {
    const src = readCadFile(new Uint8Array(readFileSync('public/samples/opencad-sample.dxf')), 'opencad-sample.dxf');
    const lay = src.layouts.find((l) => l.name === 'A3 도면')!;
    const paper = src.blocks.get(tableKey(lay.blockName))!;
    const vps = paper.entities.filter((e): e is ViewportEntity => e.type === 'VIEWPORT' && e.id !== 1);
    const paperCount = paper.entities.filter((e) => e.type !== 'VIEWPORT').length;
    const modelCount = src.blocks.get(MODEL_SPACE)!.entities.length;
    const out = exportLayoutDocument(
      src,
      tableKey(lay.blockName),
      vps.map((vp) => ({ vp, k: vp.height / vp.viewHeight, twist: 0, refX: vp.viewTarget.x + vp.viewCenter.x, refY: vp.viewTarget.y + vp.viewCenter.y, frozen: new Set<string>() })),
    );
    // 원본은 그대로
    expect(src.blocks.get(MODEL_SPACE)!.entities.length).toBe(modelCount);
    const ms = out.blocks.get(MODEL_SPACE)!;
    const inserts = ms.entities.filter((e): e is InsertEntity => e.type === 'INSERT' && e.block.startsWith('_LAYOUT_MODEL'));
    expect(inserts).toHaveLength(vps.length);
    expect(ms.entities.length).toBe(paperCount + vps.length);
    expect(out.blocks.get(tableKey('_LAYOUT_MODEL'))!.entities.length).toBe(modelCount);
    // 뷰포트 중심에 뷰 중심이 온다
    const vp = vps[0]!;
    const k = vp.height / vp.viewHeight;
    const ins = inserts[0]!;
    expect(ins.insert.x + k * (vp.viewTarget.x + vp.viewCenter.x)).toBeCloseTo(vp.center.x, 9);
    // 자르기 경계는 뷰포트 사각형
    const b = xclipBoundaryWorld(out, ins)!;
    expect(Math.min(...b.map((p) => p.x))).toBeCloseTo(vp.center.x - vp.width / 2, 9);
    expect(Math.max(...b.map((p) => p.y))).toBeCloseTo(vp.center.y + vp.height / 2, 9);
    // 종이 공간에는 전체 뷰포트만
    expect(out.blocks.get(tableKey(lay.blockName))!.entities.every((e) => e.type === 'VIEWPORT')).toBe(true);
  });
});
