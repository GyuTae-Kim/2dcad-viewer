import { describe, expect, it } from 'vitest';
import { collectTransfers, errorText, ncPayload, sceneHasGeometry, type View3dResponse, type View3dResult } from '../../src/app/view3d/protocol';
import { NC_SAMPLE_NAME, ncSampleProgram } from '../../src/app/view3d/sample';
import { loadNcFile } from '../../src/formats/nc/index';
import { sourceLine } from '../../src/formats/nc/text';
import { skpToScene } from '../../src/formats/skp/index';
import type { Scene3d } from '../../src/viewer3d/types';
import { IDENTITY13, edge, entities, face, instance, modelDat, skpFile, vertex } from '../skp/build';

function sampleResult(): View3dResult {
  const bytes = new TextEncoder().encode(ncSampleProgram());
  const { parsed, scene } = loadNcFile(NC_SAMPLE_NAME, bytes);
  if (parsed.kind === 'mpr') throw new Error('MPR이 아니어야 한다');
  return { format: 'nc', scene, nc: ncPayload(parsed.program), ms: 1 };
}

describe('합성 NC 예제', () => {
  it('세 공구·윤곽·나선·드릴이 경고 없이 읽힌다', () => {
    const r = sampleResult();
    const nc = r.nc!;
    expect(nc.kind).toBe('gcode');
    expect(nc.dialect).toBe('fanuc');
    expect(nc.units).toBe('mm');
    expect(nc.tools.map((t) => t.number)).toEqual([1, 2, 3]);
    expect(nc.tools.map((t) => t.diameter)).toEqual([10, 6, 8]);
    expect(nc.stats.holeCount).toBe(6);
    expect(nc.stats.arcCount).toBeGreaterThan(10);
    expect(nc.moves.count).toBeGreaterThan(40);
    expect(r.scene.warnings ?? []).toEqual([]);
    expect(sceneHasGeometry(r.scene)).toBe(true);
    // 시간표는 이동 수만큼, 오름차순
    expect(nc.timeline.length).toBe(nc.moves.count);
    for (let i = 1; i < nc.timeline.length; i++) expect(nc.timeline[i]!).toBeGreaterThanOrEqual(nc.timeline[i - 1]!);
    // 줄 → 이동 CSR: 모든 이동이 한 번씩
    expect(nc.lineMoves.offsets.length).toBe(nc.source.lineCount + 1);
    expect(nc.lineMoves.offsets[nc.source.lineCount]).toBe(nc.moves.count);
    expect(sourceLine(nc.source, 1)).toContain('O1001');
  });
});

describe('워커 메시지 직렬화', () => {
  it('이전 목록: 같은 버퍼는 한 번만(meta.moveLine = moves.line)', () => {
    const r = sampleResult();
    expect(r.scene.meta?.moveLine).toBe(r.nc!.moves.line);
    const t = collectTransfers(r);
    expect(new Set(t).size).toBe(t.length);
    expect(t).toContain(r.nc!.moves.line.buffer);
    expect(t).toContain(r.nc!.source.bytes.buffer);
    for (const l of r.scene.lines) expect(t).toContain(l.positions.buffer);
  });

  it('structuredClone(이전)으로 넘겨도 장면·NC 자료가 그대로이고 원본 버퍼는 비워진다', () => {
    const r = sampleResult();
    const lines = r.scene.lines.map((l) => ({ id: l.id, n: l.positions.length, first: l.positions[0] }));
    const count = r.nc!.moves.count;
    const lineOf = r.nc!.moves.line[count - 1];
    const msg: View3dResponse = { id: 7, type: 'done', result: r };
    const transfer = collectTransfers(msg);
    const got = structuredClone(msg, { transfer }) as Extract<View3dResponse, { type: 'done' }>;
    expect(got.result.scene.lines.map((l) => ({ id: l.id, n: l.positions.length, first: l.positions[0] }))).toEqual(lines);
    expect(got.result.nc!.moves.count).toBe(count);
    expect(got.result.nc!.moves.line[count - 1]).toBe(lineOf);
    // 한 메시지 안의 같은 배열은 받는 쪽에서도 같은 객체
    expect(got.result.scene.meta?.moveLine).toBe(got.result.nc!.moves.line);
    expect(sourceLine(got.result.nc!.source, 1)).toContain('O1001');
    // 보낸 쪽 버퍼는 이전되어 비었다
    expect(r.scene.lines[0]!.positions.length).toBe(0);
  });

  it('SketchUp 장면(공유 버퍼·Map 없는 meta)도 넘길 수 있다', () => {
    const root = entities(undefined, {
      vertices: [vertex(1, 0, 0, 0), vertex(2, 10, 0, 0), vertex(3, 10, 10, 0), vertex(4, 0, 10, 0)],
      edges: [edge(5, 1, 2), edge(6, 2, 3), edge(7, 3, 4), edge(8, 4, 1)],
      faces: [
        face(9, [0, 0, 1, 0], [
          [
            [5, false],
            [6, false],
            [7, false],
            [8, false],
          ],
        ]),
      ],
      components: [instance(20, 50, IDENTITY13)],
    });
    const def = entities(50, {
      vertices: [vertex(101, 0, 0, 5), vertex(102, 3, 0, 5), vertex(103, 0, 3, 5)],
      edges: [edge(201, 101, 102), edge(202, 102, 103), edge(203, 103, 101)],
      faces: [
        face(301, [0, 0, 1, -5], [
          [
            [201, false],
            [202, false],
            [203, false],
          ],
        ]),
      ],
    });
    const scene = skpToScene(skpFile(modelDat({ materials: [], layers: [[1, 'Layer0']], definitions: [{ name: '세모', entities: def }], root })), { name: 't.skp' });
    expect(sceneHasGeometry(scene)).toBe(true);
    const res: View3dResult = { format: 'skp', scene, ms: 0 };
    const t = collectTransfers(res);
    expect(new Set(t).size).toBe(t.length);
    const got = structuredClone(res, { transfer: t });
    expect(got.scene.meshes.length).toBe(scene.meshes.length);
    expect(got.scene.meshes[0]!.positions.length).toBeGreaterThan(0);
  });

  it('여러 그물이 같은 형식 배열을 나눠 써도(STEP 인스턴스) 한 번만 넣는다', () => {
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const scene: Scene3d = {
      name: 's',
      units: 'mm',
      meshes: [
        { id: 'a', positions: pos, color: [1, 1, 1, 1] },
        { id: 'b', positions: pos, color: [1, 1, 1, 1], matrix: new Float64Array(16) },
      ],
      lines: [],
      meta: { products: [{ name: 'p', meshIds: ['a', 'b'], children: [] }], map: new Map([['k', new Uint8Array(3)]]) },
    };
    const t = collectTransfers(scene);
    expect(t.length).toBe(3);
    const got = structuredClone(scene, { transfer: t });
    expect(got.meshes[0]!.positions).toBe(got.meshes[1]!.positions);
  });

  it('빈 장면·오류 글', () => {
    expect(sceneHasGeometry({ name: 'e', units: 'mm', meshes: [], lines: [] })).toBe(false);
    expect(sceneHasGeometry({ name: 'e', units: 'mm', meshes: [], lines: [], points: [{ id: 'p', positions: new Float32Array([1, 2, 3]) }] })).toBe(true);
    expect(errorText(new Error('나쁨'))).toBe('나쁨');
    expect(errorText('글')).toBe('글');
    expect(collectTransfers({ a: 1, b: 'x', c: null, d: [undefined] })).toEqual([]);
  });
});
