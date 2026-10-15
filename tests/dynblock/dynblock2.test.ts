/**
 * 동적 블록 2: 배열 동작 평가, 정렬 매개변수 그립, 구속 기반 정의(손으로 만든 최소 자료 fixture2.ts).
 * 규칙(사본 수·순서·ETag, 140·141의 뜻, BEDIT 미리보기 사본, 구속 매개변수 ↔ 치수 종속)은 공개 도면의 AutoCAD 표현 블록과
 * 대조해 정했다(src/io/dwg/NOTES.md "동적 블록 객체"). 공개 도면 자체는 시험에 넣지 않는다.
 */
import { describe, expect, it } from 'vitest';
import type { CadDocument, CircleEntity, Entity, InsertEntity, LineEntity } from '../../src/core/model';
import { applyOps, inverseTransaction } from '../../src/edit/session';
import { readDxf } from '../../src/io/dxf/reader';
import { writeDxf } from '../../src/io/dxf/writer';
import { DynEval, alignTargetOn, applyDynGrip, arrayCount, dynGrips, dynProperties, dynSetOps, previewDynGrip, readDefinition, readReference } from '../../src/edit/dynblock';
import { workItems } from '../../src/edit/dynblock/reference';
import type { OtherAction } from '../../src/edit/dynblock/types';
import { withFullRaw } from './fixture';
import { dynFixture2, loadFixture2 } from './fixture2';

function handles(start = 0x9000): () => string {
  let n = start;
  return () => (n++).toString(16).toUpperCase();
}

function setup() {
  const { doc, h } = loadFixture2();
  const ins = (k: string) => doc.entityIndex.get(h[k]!) as InsertEntity;
  return { doc, h, ins, nh: handles() };
}

function apply(doc: CadDocument, ops: ReturnType<typeof dynSetOps>['ops']) {
  expect(ops.length).toBeGreaterThan(0);
  applyOps(doc, ops);
}

const etagOf = (e: Entity) => {
  const it = e.xdata?.find((x) => x.app === 'AcDbBlockRepETag')?.items;
  return { index: Number(it?.find((i) => i.code === 1071)?.value), handle: String(it?.find((i) => i.code === 1005)?.value) };
};
const r6 = (n: number) => Math.round(n * 1e6) / 1e6 + 0;
/** 블록 객체 요약: 종류 ETag 좌표 */
const shape = (doc: CadDocument, ins: InsertEntity) =>
  doc.blocks.get(ins.block.toUpperCase())!.entities.map((e) => {
    const k = etagOf(e).index;
    if (e.type === 'CIRCLE') return `C${k} ${r6((e as CircleEntity).center.x)},${r6((e as CircleEntity).center.y)}`;
    const l = e as LineEntity;
    return `L${k} ${r6(l.start.x)},${r6(l.start.y)}`;
  });

describe('배열 동작', () => {
  it('정의: 141 = 열 간격(X·선형 방향), 140 = 행 간격(Y). BEDIT 미리보기 사본은 사본으로 가려진다', () => {
    const { doc } = setup();
    const def = readDefinition(doc, 'ARR-TEST')!;
    expect(def.undecoded).toEqual([]);
    const arrays = def.actions.filter((a): a is OtherAction => a.kind === 'array');
    expect(arrays.map((a) => [a.id, a.columnSpacing, a.rowSpacing])).toEqual([
      [10, 5, 1],
      [30, 3, 2],
    ]);
    const items = workItems(def, doc.blocks.get('ARR-TEST')!, true);
    expect(items.map((it) => !!it.copy)).toEqual([false, false, true, true, true, true]);
  });

  it('개수 = 거리를 간격으로 나눈 몫(1 이상)', () => {
    expect(arrayCount(306, 51)).toBe(6);
    expect(arrayCount(23, 5)).toBe(4);
    expect(arrayCount(100.5926984975917, 25)).toBe(4);
    expect(arrayCount(-104.303888075734, 20)).toBe(5);
    expect(arrayCount(4.99, 5)).toBe(1);
    expect(arrayCount(10, 0)).toBe(1);
  });

  it('선형 길이 23 → 원 사본 3개, XY 기본 2×2 → 선 사본 3개(행 바깥·열 안쪽). 사본은 원본 ETag 색인, 1005는 제 핸들', () => {
    const { doc, ins, nh } = setup();
    expect(dynProperties(doc, ins('insR'))!.map((p) => [p.key, p.value])).toEqual([
      ['1', 10],
      ['20:x', 6],
      ['20:y', 4],
    ]);
    apply(doc, dynSetOps(doc, ins('insR'), { key: '길이', value: 23 }, nh).ops);
    const r = ins('insR');
    expect(r.block).toMatch(/^\*U/);
    // BEDIT 미리보기 사본(ETag 2~5)은 없고, 원본 뒤에 배열 동작 차례로 사본
    expect(shape(doc, r)).toEqual(['C0 0,0', 'L1 0,-0.5', 'C0 5,0', 'C0 10,0', 'C0 15,0', 'L1 3,-0.5', 'L1 0,1.5', 'L1 3,1.5']);
    const ents = doc.blocks.get(r.block.toUpperCase())!.entities;
    for (const e of ents) expect(etagOf(e).handle).toBe(e.handle);
    expect(new Set(ents.map((e) => e.handle)).size).toBe(ents.length);
    // 다시 읽은 표현 블록: 같은 색인의 뒤 객체는 사본
    const ref = readReference(doc, r)!;
    expect(workItems(ref.def, ref.block, false).map((it) => !!it.copy)).toEqual([false, false, true, true, true, true, true, true]);
    expect(dynProperties(doc, r)!.map((p) => p.value)).toEqual([23, 6, 4]);
  });

  it('이어서 고치면 사본을 다시 만든다(쌓이지 않는다). 되돌리기 한 단계', () => {
    const { doc, ins, nh } = setup();
    apply(doc, dynSetOps(doc, ins('insR'), { key: '길이', value: 23 }, nh).ops);
    const r1 = dynSetOps(doc, ins('insR'), { key: '가로', value: 10 }, nh);
    apply(doc, r1.ops);
    // 가로 10 / 3 → 열 3, 세로 4 / 2 → 행 2: 선 사본 5
    expect(shape(doc, ins('insR'))).toEqual(['C0 0,0', 'L1 0,-0.5', 'C0 5,0', 'C0 10,0', 'C0 15,0', 'L1 3,-0.5', 'L1 6,-0.5', 'L1 0,1.5', 'L1 3,1.5', 'L1 6,1.5']);
    apply(doc, dynSetOps(doc, ins('insR'), { key: '길이', value: 4 }, nh).ops);
    expect(shape(doc, ins('insR'))).toEqual(['C0 0,0', 'L1 0,-0.5', 'L1 3,-0.5', 'L1 6,-0.5', 'L1 0,1.5', 'L1 3,1.5', 'L1 6,1.5']);
    applyOps(doc, inverseTransaction({ label: 'x', ops: dynSetOps(doc, ins('insR'), { key: '길이', value: 12 }, nh).ops }).ops);
    expect(shape(doc, ins('insR')).length).toBe(7);
  });

  it('XY 기준점을 끌면 원본이 기준점을 따라가고 사본은 끝점 쪽으로', () => {
    const { doc, ins, nh } = setup();
    // 기준점 그립(dyn:24)을 (0, -5)로: Y 거리 9 → 행 4, X 6 → 열 2
    const r = applyDynGrip(doc, ins('insR'), 'dyn:24', { x: 0, y: -5 }, nh);
    expect(r.message).toBeUndefined();
    apply(doc, r.ops);
    expect(dynProperties(doc, ins('insR'))!.map((x) => x.value)).toEqual([10, 6, 9]);
    const ref = readReference(doc, ins('insR'))!;
    expect(ref.values.get(20)!.points!.slice(0, 2).map((q) => [q.x, q.y])).toEqual([
      [0, -5],
      [6, 4],
    ]);
    // 원본 선은 (0, -5)만큼 내려가고 사본은 위로 2씩(행 바깥·열 안쪽)
    expect(shape(doc, ins('insR')).filter((s) => s.startsWith('L'))).toEqual(['L1 0,-5.5', 'L1 3,-5.5', 'L1 0,-3.5', 'L1 3,-3.5', 'L1 0,-1.5', 'L1 3,-1.5', 'L1 0,0.5', 'L1 3,0.5']);
  });

  it('미리보기에도 사본이 보인다', () => {
    const { doc, ins } = setup();
    const g = dynGrips(doc, ins('insR')).find((x) => x.param === 1)!;
    const list = previewDynGrip(doc, ins('insR'), g.id, { x: 21, y: 0 });
    expect(list.filter((e) => e.type === 'CIRCLE').map((e) => (e as CircleEntity).center.x)).toEqual([0, 5, 10, 15]);
  });

  it('DXF로 저장하고 다시 읽어도 사본·값이 같고 이어서 고칠 수 있다', () => {
    const { doc, ins, nh, h } = setup();
    apply(doc, dynSetOps(doc, ins('insR'), [{ key: '길이', value: 17 }, { key: '세로', value: 6 }], nh).ops);
    const want = shape(doc, ins('insR'));
    const text = new TextDecoder().decode(writeDxf(doc).data);
    const d2 = withFullRaw(readDxf(new TextEncoder().encode(text)), text);
    const r2 = d2.entityIndex.get(h.insR!) as InsertEntity;
    expect(shape(d2, r2)).toEqual(want);
    expect(dynProperties(d2, r2)!.map((p) => p.value)).toEqual([17, 6, 6]);
    apply(d2, dynSetOps(d2, r2, { key: '길이', value: 9 }, handles(0xa000)).ops);
    expect(shape(d2, d2.entityIndex.get(h.insR!) as InsertEntity).filter((s) => s.startsWith('C'))).toEqual(['C0 0,0']);
  });

  it('직접 평가(DynEval): 사본은 finish 전에는 그대로, finish가 지금 값으로 다시 만든다', () => {
    const { doc, ins } = setup();
    const ev = new DynEval(doc, readReference(doc, ins('insR'))!);
    expect(ev.copies.length).toBe(4);
    ev.setLinear(ev.def.params[0] as never, 15, { exact: true });
    ev.finish();
    expect(ev.copies.filter((c) => c.entity.type === 'CIRCLE').map((c) => (c.entity as CircleEntity).center.x)).toEqual([5, 10]);
  });

  it('fixture는 결정적이다', () => {
    expect(dynFixture2().text).toBe(dynFixture2().text);
  });
});

describe('정렬 매개변수', () => {
  it('그립은 끌기, 방향은 정렬 방향', () => {
    const { doc, ins } = setup();
    const g = dynGrips(doc, ins('insG'));
    expect(g.map((x) => [x.id, x.kind, x.mode, x.point, x.direction])).toEqual([['dyn:2', 'alignment', 'drag', { x: 100, y: 100 }, { x: 1, y: 0 }]]);
  });

  it('곡선 위 가장 가까운 점과 접선', () => {
    const { doc, h } = setup();
    const s = doc.entityIndex.get(h.lineS!)!;
    const t = alignTargetOn(s, { x: 60, y: 100 })!;
    expect(t.point.x).toBeCloseTo(55, 9);
    expect(t.point.y).toBeCloseTo(105, 9);
    expect(t.angle).toBeCloseTo(Math.PI / 4, 12);
    const arc = { type: 'ARC', handle: 'A0', layer: '0', center: { x: 0, y: 0, z: 0 }, radius: 10, startAngle: 0, endAngle: Math.PI } as unknown as Entity;
    const ta = alignTargetOn(arc, { x: 0, y: 20 })!;
    expect(ta.point.y).toBeCloseTo(10, 9);
    expect(Math.abs(Math.cos(ta.angle))).toBeCloseTo(1, 9);
    expect(alignTargetOn({ type: 'POINT', handle: 'P0', position: { x: 0, y: 0, z: 0 } } as unknown as Entity, { x: 1, y: 1 })).toBeNull();
  });

  it('곡선 가까이 끌면 참조를 그 점으로 옮기고 접선 방향으로 돌린다(블록·캐시는 그대로)', () => {
    const { doc, ins, h, nh } = setup();
    const s = doc.entityIndex.get(h.lineS!)!;
    const before = ins('insG');
    const align = alignTargetOn(s, { x: 60, y: 100 });
    const r = applyDynGrip(doc, before, 'dyn:2', { x: 60, y: 100 }, nh, { align });
    expect(r.ops.map((o) => o.kind)).toEqual(['modify']);
    apply(doc, r.ops);
    const g = ins('insG');
    expect(g.block).toBe('ALIGN-TEST');
    expect(g.rotation).toBeCloseTo(Math.PI / 4, 12);
    expect(g.insert.x).toBeCloseTo(55, 9);
    expect(g.insert.y).toBeCloseTo(105, 9);
    // 두 접선 방향 중 지금 방향에 가까운 쪽: 170°로 돌려 둔 참조는 225°
    applyOps(doc, [{ kind: 'modify', block: '*MODEL_SPACE', before: g, after: { ...g, rotation: (170 * Math.PI) / 180 } }]);
    apply(doc, applyDynGrip(doc, ins('insG'), 'dyn:2', { x: 60, y: 100 }, nh, { align }).ops);
    expect(ins('insG').rotation).toBeCloseTo((225 * Math.PI) / 180, 12);
    // 곡선이 없으면 옮기기만
    apply(doc, applyDynGrip(doc, ins('insG'), 'dyn:2', { x: 0, y: 0 }, nh).ops);
    expect(ins('insG').rotation).toBeCloseTo((225 * Math.PI) / 180, 12);
    expect(ins('insG').insert.x).toBeCloseTo(0, 9);
  });

  it('미리보기: 돌린 모양', () => {
    const { doc, ins, h } = setup();
    const align = alignTargetOn(doc.entityIndex.get(h.lineS!)!, { x: 60, y: 100 });
    const [l] = previewDynGrip(doc, ins('insG'), 'dyn:2', { x: 60, y: 100 }, { align }) as LineEntity[];
    expect(l!.start.x).toBeCloseTo(55, 9);
    expect(l!.end.x).toBeCloseTo(55 + 4 / Math.SQRT2, 9);
    expect(l!.end.y).toBeCloseTo(105 + 4 / Math.SQRT2, 9);
  });
});

describe('구속 기반 정의', () => {
  const lines = (doc: CadDocument, ins: InsertEntity) => doc.blocks.get(ins.block.toUpperCase())!.entities.map((e) => [r6((e as LineEntity).start.x), r6((e as LineEntity).start.y), r6((e as LineEntity).end.x), r6((e as LineEntity).end.y)]);

  it('대리 노드와 구속 매개변수를 읽고(구속 그룹의 치수 종속을 찾았다) 고칠 수 있다', () => {
    const { doc, h, ins } = setup();
    const def = readDefinition(doc, 'CON-TEST')!;
    expect(def.undecoded).toEqual([]);
    expect(def.constrained).toBe(true);
    const w = def.params.find((p) => p.label === 'W')!;
    expect(w.kind === 'linear' && w.constraint).toEqual({ dependency: h.dimDep });
    expect(dynProperties(doc, ins('insK'))!.map((p) => [p.label, p.value, p.editor, p.options?.map((o) => o.value)])).toEqual([
      ['W', 10, 'select', ['5', '10', '15', '20']],
      ['반전', false, 'select', ['0', '1']],
    ]);
  });

  it('W를 바꾸면 블록의 구속을 풀어 형상이 따라온다(값 목록에 맞춤), 다시 읽으면 형상에서 값', () => {
    const { doc, ins, nh } = setup();
    apply(doc, dynSetOps(doc, ins('insK'), { key: 'W', value: 13 }, nh).ops);
    expect(lines(doc, ins('insK'))).toEqual([
      [0, 0, 15, 0],
      [15, 0, 15, 5],
    ]);
    const p = dynProperties(doc, ins('insK'))!;
    expect(p[0]!.value).toBeCloseTo(15, 6);
  });

  it('뒤집기 동작 뒤에도 구속을 지키고(같은 크기, 뒤집힌 쪽), 이어서 W를 바꿀 수 있다', () => {
    const { doc, ins, nh } = setup();
    apply(doc, dynSetOps(doc, ins('insK'), { key: '반전', value: true }, nh).ops);
    expect(lines(doc, ins('insK'))).toEqual([
      [0, 0, -10, 0],
      [-10, 0, -10, 5],
    ]);
    apply(doc, dynSetOps(doc, ins('insK'), { key: 'W', value: 20 }, nh).ops);
    expect(lines(doc, ins('insK'))).toEqual([
      [0, 0, -20, 0],
      [-20, 0, -20, 5],
    ]);
    expect(dynProperties(doc, ins('insK'))!.map((p) => [p.label, Math.round(Number(p.value) * 1e6) / 1e6])).toEqual([
      ['W', 20],
      ['반전', 1],
    ]);
  });

  it('DXF로 저장하고 다시 읽어도 정의(망·대리 노드)와 값이 남는다', () => {
    const { doc, ins, nh, h } = setup();
    apply(doc, dynSetOps(doc, ins('insK'), { key: 'W', value: 5 }, nh).ops);
    const text = new TextDecoder().decode(writeDxf(doc).data);
    const d2 = withFullRaw(readDxf(new TextEncoder().encode(text)), text);
    const def = readDefinition(d2, 'CON-TEST')!;
    expect(def.undecoded).toEqual([]);
    const k = d2.entityIndex.get(h.insK!) as InsertEntity;
    expect(dynProperties(d2, k)![0]!.value).toBeCloseTo(5, 6);
    apply(d2, dynSetOps(d2, k, { key: 'W', value: 20 }, handles(0xb000)).ops);
    expect(lines(d2, d2.entityIndex.get(h.insK!) as InsertEntity)).toEqual([
      [0, 0, 20, 0],
      [20, 0, 20, 5],
    ]);
  });

  it('구속 그룹이 없거나 읽을 수 없으면 예전처럼 고치지 않는다', () => {
    const { doc, h, ins, nh } = setup();
    // 망 사전에서 망을 빼면 구속 매개변수·대리 노드를 풀 수 없다
    const xd = doc.objects.get(h.xdK!) as { entries: Map<string, string> };
    xd.entries.delete('ACAD_ASSOCNETWORK');
    const def = readDefinition(doc, 'CON-TEST')!;
    expect(def.undecoded).toEqual(['ACDB_DYNAMICBLOCKPROXYNODE', '구속 매개변수 BLOCKHORIZONTALCONSTRAINTPARAMETER']);
    const r = dynSetOps(doc, ins('insK'), { key: 'W', value: 5 }, nh);
    expect(r.ops).toEqual([]);
  });
});
