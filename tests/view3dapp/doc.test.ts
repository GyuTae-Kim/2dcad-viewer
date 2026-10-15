import { describe, expect, it } from 'vitest';
import {
  createDoc,
  docLabel,
  lineMoveList,
  moveEndPoint,
  moveSegments,
  productAt,
  productKeyOf,
  sceneCounts,
  skpMaterials,
  stepProducts,
  stepSchemaLabel,
  subtreeMeshIds,
  toolGroup,
  toolItems,
  unitLabel,
} from '../../src/app/view3d/doc';
import { ncPayload } from '../../src/app/view3d/protocol';
import { loadNcFile } from '../../src/formats/nc/index';
import type { Scene3d } from '../../src/viewer3d/types';

const GCODE = ['G21 G90 G17', '(T1 D=6 END MILL)', 'T1 M6', 'G0 X0 Y0 Z5', 'G1 Z-1 F100', 'G1 X10', 'G2 X20 Y0 I5 J0', 'T2 M6', 'G0 Z5', 'G81 X5 Y5 Z-3 R1 F50', 'X15', 'G80', 'M30'].join('\n');

function ncDoc() {
  const { parsed, scene } = loadNcFile('t.nc', GCODE, { gcode: { initialPosition: [0, 0, 0] } });
  if (parsed.kind === 'mpr') throw new Error('x');
  const nc = ncPayload(parsed.program);
  return createDoc('t.nc', GCODE.length, { format: 'nc', scene, nc, ms: 3 });
}

describe('NC 문서 도움', () => {
  it('줄 → 이동, 이동 → 선분(호는 나눈 선분)', () => {
    const d = ncDoc();
    const nc = d.nc!;
    const arcLine = 6; // G2
    const moves = lineMoveList(nc, arcLine);
    expect(moves.length).toBe(1);
    const seg = moveSegments(d.scene, moves);
    expect(seg.length / 6).toBeGreaterThan(4);
    // 호 선분의 끝은 (20,0,-1)
    expect([seg[seg.length - 3], seg[seg.length - 2], seg[seg.length - 1]]).toEqual([20, 0, -1]);
    expect(moveEndPoint(nc, moves[0]!)).toEqual([20, 0, -1]);
    // 이동이 없는 줄
    expect(lineMoveList(nc, 1)).toEqual([]);
    expect(lineMoveList(nc, -1)).toEqual([]);
    expect(lineMoveList(nc, 9999)).toEqual([]);
    // 상한
    expect(lineMoveList(nc, arcLine, 0)).toEqual([]);
  });

  it('공구 → 묶음·항목', () => {
    const d = ncDoc();
    expect(toolGroup(d.scene, 1)).toBe('T1');
    expect(toolItems(d.scene, 1)).toEqual(['nc-cut-1']);
    expect(toolItems(d.scene, 2)).toEqual(['nc-drill-2']);
    expect(toolGroup(d.scene, 99)).toBeNull();
  });

  it('형식 설명·단위·개수', () => {
    const d = ncDoc();
    expect(docLabel(d)).toMatch(/^G-code · /);
    expect(unitLabel('mm')).toBe('mm');
    expect(unitLabel('inch')).toBe('in');
    expect(unitLabel('unknown')).toBe('');
    const c = sceneCounts(d.scene);
    expect(c.segments).toBeGreaterThan(5);
    expect(c.points).toBe(2);
  });

  it('새 문서의 보기 상태는 비어 있다', () => {
    const d = ncDoc();
    expect(d.camera).toBeNull();
    expect(d.playSec).toBeNull();
    expect(d.selLine).toBe(-1);
    expect(d.hiddenGroups.size).toBe(0);
    expect(ncDoc().id).toBeGreaterThan(d.id);
  });
});

describe('STEP 제품 나무·SKP 재질', () => {
  const scene: Scene3d = {
    name: 's',
    units: 'mm',
    meshes: [
      { id: 'm1', name: '판 · 기본', positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2, 0, 1, 2]), color: [1, 0, 0, 1] },
      { id: 'm2', name: '판 · 벽', positions: new Float32Array(9), color: [1, 0, 0, 1] },
      { id: 'm3', name: '유리 · 벽', positions: new Float32Array(18), color: [0, 0, 1, 0.4] },
    ],
    lines: [],
    meta: {
      format: 'STEP',
      schema: ['AP214'],
      products: [
        {
          name: '조립',
          productId: 'A',
          meshIds: [],
          children: [
            { name: '판', productId: 'P', instance: 'NAUO1', meshIds: ['m1'], children: [] },
            { name: '덮개', productId: 'C', meshIds: ['m2'], children: [{ name: '창', productId: 'W', meshIds: ['m3'], children: [] }] },
          ],
        },
        'garbage',
      ],
    },
  };

  it('meta.products를 읽고(잘못된 마디는 버린다) 경로 열쇠로 찾는다', () => {
    const roots = stepProducts(scene);
    expect(roots.length).toBe(1);
    expect(roots[0]!.children[0]!.instance).toBe('NAUO1');
    expect(subtreeMeshIds(roots[0]!)).toEqual(['m1', 'm2', 'm3']);
    expect(productKeyOf(roots, 'm3')).toBe('0/1/0');
    expect(productKeyOf(roots, 'none')).toBeNull();
    expect(productAt(roots, '0/1')!.name).toBe('덮개');
    expect(productAt(roots, '0/9')).toBeNull();
    expect(stepProducts({ ...scene, meta: {} })).toEqual([]);
  });

  it('STEP 설명에 스키마', () => {
    const d = createDoc('a.stp', 10, { format: 'step', scene, ms: 1 });
    expect(docLabel(d)).toBe('STEP AP214');
    const d2 = createDoc('b.stp', 10, { format: 'step', scene: { ...scene, meta: { schema: ['AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'] } }, ms: 1 });
    expect(docLabel(d2)).toBe('STEP AP214');
    expect(stepSchemaLabel('CONFIG_CONTROL_DESIGN')).toBe('AP203');
    expect(stepSchemaLabel('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }')).toBe('AP242');
    expect(stepSchemaLabel('STRUCTURAL_FRAME_SCHEMA {x}')).toBe('STRUCTURAL_FRAME_SCHEMA');
  });

  it('SKP 재질: 그물 이름 앞부분으로 묶고 삼각형 수로 줄 세운다', () => {
    const m = skpMaterials(scene);
    expect(m.map((x) => [x.name, x.triangles])).toEqual([
      ['판', 3],
      ['유리', 2],
    ]);
  });
});
