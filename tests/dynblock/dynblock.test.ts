import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AttribEntity, CadDocument, CircleEntity, DictionaryObject, GenericObject, InsertEntity, LineEntity, LwPolylineEntity, TextEntity, XRecordObject } from '../../src/core/model';
import { applyOps, inverseTransaction } from '../../src/edit/session';
import { readDxf } from '../../src/io/dxf/reader';
import { writeDxf } from '../../src/io/dxf/writer';
import {
  MSG_SAME,
  applyDynGrip,
  dynGrips,
  dynProperties,
  dynResetOps,
  dynSetOps,
  isDynamicReference,
  previewDynGrip,
  readDefinition,
  readReference,
} from '../../src/edit/dynblock';
import { actionsOf } from '../../src/edit/dynblock/definition';
import { dynFixture, loadDyn, withFullRaw } from './fixture';
import { FIXTURES } from '../dim/compare';

function handles(start = 0x9000): () => string {
  let n = start;
  return () => (n++).toString(16).toUpperCase();
}

function setup() {
  const f = dynFixture();
  const doc = loadDyn(f.text);
  const nh = handles();
  const ins = (k: string) => doc.entityIndex.get(f.h[k]!) as InsertEntity;
  return { f, doc, nh, ins };
}

function apply(doc: CadDocument, ops: ReturnType<typeof dynSetOps>['ops']) {
  expect(ops.length).toBeGreaterThan(0);
  applyOps(doc, ops);
}

/** 참조가 지금 가리키는 블록의 ETag 색인 i 객체 */
function at<T>(doc: CadDocument, ins: InsertEntity, i: number): T {
  const b = doc.blocks.get(ins.block.toUpperCase())!;
  const e = b.entities.find((x) => x.xdata?.some((d) => d.app === 'AcDbBlockRepETag' && d.items.some((it) => it.code === 1071 && Number(it.value) === i)));
  return e as T;
}

const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

describe('정의 해석', () => {
  it('매개변수·동작·그립·조회 표를 읽는다', () => {
    const { doc } = setup();
    const def = readDefinition(doc, 'DYN-TEST')!;
    expect(def.undecoded).toEqual([]);
    expect(def.params.map((p) => [p.id, p.kind, p.label])).toEqual([
      [1, 'linear', '폭'],
      [20, 'visibility', '모양'],
      [30, 'flip', '반전'],
      [40, 'lookup', '크기'],
      [60, 'rotation', '각도'],
    ]);
    const lin = def.params[0]!;
    expect(lin.kind === 'linear' && lin.values.list).toEqual([5, 15, 20]);
    expect(lin.grips).toEqual([2, 5]);
    const vis = def.params[1]!;
    expect(vis.kind === 'visibility' && vis.states.map((s) => [s.name, s.entities.length])).toEqual([
      ['A', 1],
      ['B', 1],
      ['Both', 2],
    ]);
    // 선형 매개변수의 동작은 그래프 순서(신축 → 이동)
    expect(actionsOf(def, 1).map((a) => a.id)).toEqual([10, 50]);
    const look = def.actions.find((a) => a.kind === 'lookup');
    expect(look?.kind === 'lookup' && look.rows).toEqual([
      ['5', 'A', 'Small'],
      ['10', 'A', 'Medium'],
      ['20', 'B', 'Large'],
    ]);
    expect(look?.kind === 'lookup' && look.columns.map((c) => [c.node, c.prop, c.lookup])).toEqual([
      [1, 'UpdatedDistance', false],
      [20, 'VisibilityState', false],
      [40, 'lookupString', true],
    ]);
    const st = def.actions.find((a) => a.id === 10);
    expect(st?.kind === 'stretch' && st.bindings.map((b) => b.points)).toEqual([[1], [1], [0, 1]]);
    expect(def.grips.map((g) => [g.id, g.x?.prop, g.y?.prop])).toContainEqual([5, 'UpdatedEndX', 'UpdatedEndY']);
  });

  it('리더가 본문 안 1000번대 코드까지 원본 태그로 남겨 바로 해석한다', () => {
    const f = dynFixture();
    const doc = readDxf(new TextEncoder().encode(f.text));
    const def = readDefinition(doc, 'DYN-TEST')!;
    expect(def.undecoded).toEqual([]);
    expect(def.params.length).toBeGreaterThan(0);
  });

  it('원본 태그가 끊긴 정의는 해석하지 못한 것으로 두고 고치지 않는다', () => {
    const f = dynFixture();
    const doc = readDxf(new TextEncoder().encode(f.text));
    // 예전 리더처럼 본문의 첫 1000번대 코드에서 자른다
    for (const o of doc.objects.values()) {
      const raw = (o as GenericObject).raw;
      if (!raw || !/^BLOCK/i.test(o.type)) continue;
      const k = raw.findIndex((t) => t.code >= 1000);
      if (k >= 0) raw.length = k;
    }
    const def = readDefinition(doc, 'DYN-TEST')!;
    expect(def.undecoded.length).toBeGreaterThan(0);
    const ins = doc.entityIndex.get(f.h.insA!) as InsertEntity;
    expect(isDynamicReference(doc, ins)).toBe(true);
    const r = dynSetOps(doc, ins, { key: '모양', value: 'B' }, handles());
    expect(r.ops).toEqual([]);
    expect(r.message).toContain('읽을 수 없는 자료');
  });
});

describe('참조 값', () => {
  it('정의를 직접 가리키는 참조는 정의의 값, 표현 블록 참조는 캐시와 보이는 객체', () => {
    const { doc, ins } = setup();
    const a = readReference(doc, ins('insA'))!;
    expect(a.direct).toBe(true);
    expect(a.values.get(20)?.state).toBe('A');
    const b = readReference(doc, ins('insB'))!;
    expect(b.direct).toBe(false);
    expect(b.values.get(1)?.points?.[1]).toEqual({ x: 20, y: 0, z: 0 });
    expect(b.values.get(20)?.state).toBe('B');
    expect(b.values.get(40)?.value).toBe('Large');
    expect(isDynamicReference(doc, ins('insC'))).toBe(true);
  });

  it('특성 행: 목록 값에 그려진 값을 더하고, 조회 값은 일치하는 행', () => {
    const { doc, ins } = setup();
    const rows = dynProperties(doc, ins('insA'))!;
    const by = (k: string) => rows.find((r) => r.label === k)!;
    expect(by('폭').value).toBe(10);
    expect(by('폭').options?.map((o) => o.value)).toEqual(['5', '10', '15', '20']);
    expect(by('모양').value).toBe('A');
    expect(by('반전').options?.map((o) => o.label)).toEqual(['반전되지 않음', '반전됨']);
    expect(by('크기').value).toBe('Medium');
    expect(by('크기').options?.map((o) => o.value)).toEqual(['Small', 'Medium', 'Large']);
    near(by('각도').value as number, 0);
    const xy = dynProperties(doc, ins('insC'))!;
    expect(xy.map((r) => [r.key, r.label, r.value])).toEqual([
      ['1:x', '가로', 4],
      ['1:y', '세로', 3],
    ]);
  });
});

describe('가시성', () => {
  it('상태를 바꾸면 새 *U 블록, 보이지 않음, AutoCAD 형식의 새 캐시', () => {
    const { doc, ins, nh } = setup();
    const r = dynSetOps(doc, ins('insA'), { key: '모양', value: 'B' }, nh);
    apply(doc, r.ops);
    const a = ins('insA');
    expect(a.block).toBe(r.block);
    expect(a.block).toMatch(/^\*U\d+$/);
    const blk = doc.blocks.get(a.block.toUpperCase())!;
    expect(blk.flags).toBe(3);
    expect(blk.entities.length).toBe(8);
    expect(at<CircleEntity>(doc, a, 4).invisible).toBe(true);
    expect(at<CircleEntity>(doc, a, 5).invisible).toBeFalsy();
    // ETag 1005 = 새 핸들, 속성 정의는 0
    const c5 = at<CircleEntity>(doc, a, 5);
    expect(c5.xdata?.find((x) => x.app === 'AcDbBlockRepETag')?.items).toEqual([
      { code: 1070, value: 1 },
      { code: 1071, value: 5 },
      { code: 1005, value: c5.handle },
    ]);
    const rec = doc.blockRecords.get(a.block.toUpperCase())!;
    expect(rec.xdata?.[0]).toEqual({ app: 'AcDbBlockRepBTag', items: [{ code: 1070, value: 1 }, { code: 1005, value: readDefinition(doc, 'DYN-TEST')!.recordHandle }] });
    // 새 캐시: 모든 매개변수·동작 노드, 머리는 같은 도면의 다른 참조에서
    const ref = readReference(doc, a)!;
    expect(ref.cache?.repData).toBeTruthy();
    expect([...ref.cache!.records.keys()].sort((x, y) => x - y)).toEqual([1, 10, 20, 30, 32, 40, 50, 60, 61]);
    const visRec = doc.objects.get(ref.cache!.records.get(20)!) as XRecordObject;
    expect(visRec.data.slice(0, 4).map((t) => Number(t.value))).toEqual([135625452, 184556386, 25, 104]);
    expect(visRec.data.at(-1)).toEqual({ code: 1, value: 'B' });
    expect(ref.values.get(20)?.state).toBe('B');
    // 폭 10·상태 B는 조회 표에 없다 → 일치하지 않는 이름
    expect(ref.values.get(40)?.value).toBe('사용자');
    expect(readReference(doc, a)!.values.get(1)?.points?.[1]).toEqual({ x: 10, y: 0, z: 0 });
  });

  it('상태가 숨긴 속성 정의의 참조 속성은 보이지 않음(60), 다시 보이면 되돌린다', () => {
    const f = dynFixture({ attInVis: true });
    const doc = loadDyn(f.text);
    const nh = handles();
    const ins = () => doc.entityIndex.get(f.h.insA!) as InsertEntity;
    apply(doc, dynSetOps(doc, ins(), { key: '모양', value: 'B' }, nh).ops);
    expect(ins().attribs[0]!.invisible).toBe(true);
    expect(at<TextEntity>(doc, ins(), 6).invisible).toBe(true);
    apply(doc, dynSetOps(doc, ins(), { key: '모양', value: 'Both' }, nh).ops);
    expect(ins().attribs[0]!.invisible).toBeFalsy();
  });

  it('같은 값이면 변경 없음', () => {
    const { doc, ins, nh } = setup();
    const r = dynSetOps(doc, ins('insA'), { key: '모양', value: 'A' }, nh);
    expect(r.ops).toEqual([]);
    expect(r.message).toBe(MSG_SAME);
  });
});

describe('선형 + 신축·이동', () => {
  it('값 목록의 가까운 값으로 맞추고 묶인 점만 옮기며, 이동 동작은 배수만큼', () => {
    const { doc, ins, nh } = setup();
    const r = dynSetOps(doc, ins('insA'), { key: '폭', value: 17 }, nh);
    apply(doc, r.ops);
    const a = ins('insA');
    expect(at<LineEntity>(doc, a, 0).end.x).toBe(15);
    expect(at<LineEntity>(doc, a, 0).start.x).toBe(0);
    expect(at<LineEntity>(doc, a, 1).start.x).toBe(15);
    expect(at<LineEntity>(doc, a, 1).end.x).toBe(15);
    expect(at<LineEntity>(doc, a, 2).end).toEqual({ x: 15, y: 5, z: 0 });
    expect(at<LineEntity>(doc, a, 3).end).toEqual({ x: 0, y: 5, z: 0 });
    expect(at<CircleEntity>(doc, a, 5).center.x).toBe(13);
    // 속성 정의와 참조의 속성이 0.5배(2.5) 따라간다
    near(at<TextEntity>(doc, a, 6).insert.x, 7.5);
    near(a.attribs[0]!.insert.x, 7.5);
    expect(a.attribs[0]!.text).toBe('A');
    const ref = readReference(doc, a)!;
    expect(ref.values.get(1)?.points?.[1]).toEqual({ x: 15, y: 0, z: 0 });
    // 이동 동작의 선택 노드(조회 매개변수 점)도 옮겨진다
    near(ref.values.get(40)!.points![0]!.x, 7.5);
    const g = dynGrips(doc, a);
    expect(g.find((x) => x.id === 'dyn:5')?.point).toEqual({ x: 15, y: 0 });
    expect(g.find((x) => x.id === 'dyn:42')?.point.x).toBeCloseTo(7.5, 9);
  });

  it('표현 블록 참조는 있는 캐시 레코드만 고치고(머리 그대로) 아무도 쓰지 않는 이전 *U를 지운다', () => {
    const { doc, ins, nh } = setup();
    const before = readReference(doc, ins('insB'))!;
    const linRec = before.cache!.records.get(1)!;
    const r = dynSetOps(doc, ins('insB'), { key: '폭', value: 5 }, nh);
    apply(doc, r.ops);
    expect(doc.blocks.has('*U5')).toBe(false);
    expect(doc.blockRecords.has('*U5')).toBe(false);
    const x = doc.objects.get(linRec) as XRecordObject;
    expect(x.data.slice(0, 4).map((t) => Number(t.value))).toEqual([18597260, 25303744, 25, 104]);
    expect(x.data.slice(4).map((t) => Number(t.value))).toEqual([0, 0, 0, 5, 0, 0, 0, 0, -1]);
    const b = ins('insB');
    expect(at<LineEntity>(doc, b, 0).end.x).toBe(5);
    expect(at<CircleEntity>(doc, b, 5).center.x).toBe(3);
    // 그립 기록은 버전 태그만
    const hist = doc.objects.get(before.cache!.history!) as XRecordObject;
    expect(hist.data).toEqual([{ code: 1070, value: '3' }]);
  });

  it('그립 끌기: 끝 그립을 도면 점으로(값 목록에 맞춘다), 미리보기는 도면 좌표', () => {
    const { doc, ins, nh } = setup();
    const a = ins('insA');
    const pv = previewDynGrip(doc, a, 'dyn:5', { x: 13, y: 3 });
    expect(pv.some((e) => e.type === 'LINE' && (e as LineEntity).end.x === 15 && (e as LineEntity).end.y === 0)).toBe(true);
    const r = applyDynGrip(doc, a, 'dyn:5', { x: 13, y: 3 }, nh);
    apply(doc, r.ops);
    expect(readReference(doc, ins('insA'))!.values.get(1)?.points?.[1]?.x).toBe(15);
  });

  it('묶음이 없는 신축은 틀 안의 신축점만 옮긴다', () => {
    const f = dynFixture({ noBindings: true });
    const doc = loadDyn(f.text);
    apply(doc, dynSetOps(doc, doc.entityIndex.get(f.h.insA!) as InsertEntity, { key: '폭', value: 20 }, handles()).ops);
    const a = doc.entityIndex.get(f.h.insA!) as InsertEntity;
    expect(at<LineEntity>(doc, a, 0).end.x).toBe(20);
    expect(at<LineEntity>(doc, a, 0).start.x).toBe(0);
    expect(at<LineEntity>(doc, a, 1).start.x).toBe(20);
    // 틀 밖의 동그라미는 그대로
    expect(at<CircleEntity>(doc, a, 5).center.x).toBe(8);
  });

  it('캐시 없이 복사된 표현 블록 참조는 같은 블록을 쓰는 참조의 값으로 평가한다', () => {
    const { doc, ins, nh } = setup();
    const b = ins('insB');
    const copy = { ...structuredClone(b), handle: 'C001', xdict: undefined, attribs: [] } as InsertEntity;
    applyOps(doc, [{ kind: 'add', block: '*MODEL_SPACE', entity: copy }]);
    const ref = readReference(doc, copy)!;
    expect(ref.values.get(1)?.points?.[1]?.x).toBe(20);
    expect(ref.values.get(40)?.value).toBe('Large');
    const r = dynSetOps(doc, copy, { key: '폭', value: 15 }, nh);
    apply(doc, r.ops);
    const c2 = doc.entityIndex.get('C001') as InsertEntity;
    expect(at<LineEntity>(doc, c2, 0).end.x).toBe(15);
    // 원래 참조는 그대로이고 *U5도 남는다
    expect(ins('insB').block).toBe('*U5');
    expect(doc.blocks.has('*U5')).toBe(true);
  });

  it('명령 취소: 반대 작업으로 원래대로', () => {
    const { doc, ins, nh } = setup();
    const before = JSON.stringify(ins('insB'));
    const r = dynSetOps(doc, ins('insB'), { key: '폭', value: 15 }, nh);
    apply(doc, r.ops);
    applyOps(doc, inverseTransaction({ label: 'x', ops: r.ops }).ops);
    expect(JSON.stringify(ins('insB'))).toBe(before);
    expect(doc.blocks.has('*U5')).toBe(true);
    expect(readReference(doc, ins('insB'))!.values.get(1)?.points?.[1]?.x).toBe(20);
  });
});

describe('조회', () => {
  it('행을 고르면 거리·가시성을 정확히 적용하고 조회 값을 기록한다', () => {
    const { doc, ins, nh } = setup();
    const r = dynSetOps(doc, ins('insB'), { key: '크기', value: 'Small' }, nh);
    apply(doc, r.ops);
    const b = ins('insB');
    const ref = readReference(doc, b)!;
    expect(ref.values.get(40)?.value).toBe('Small');
    expect(ref.values.get(20)?.state).toBe('A');
    expect(ref.values.get(1)?.points?.[1]?.x).toBe(5);
    expect(at<CircleEntity>(doc, b, 4).invisible).toBeFalsy();
    expect(at<CircleEntity>(doc, b, 5).invisible).toBe(true);
    // 숨은 객체도 신축된다
    expect(at<CircleEntity>(doc, b, 5).center.x).toBe(3);
  });

  it('표에 없는 이름은 오류, 일치하지 않는 이름은 변경 없음', () => {
    const { doc, ins, nh } = setup();
    expect(dynSetOps(doc, ins('insA'), { key: '크기', value: 'Huge' }, nh).message).toContain('표에 없습니다');
    expect(dynSetOps(doc, ins('insA'), { key: '크기', value: '사용자' }, nh).ops).toEqual([]);
  });
});

describe('뒤집기·회전', () => {
  it('뒤집기 선에 대해 대칭하고(문자는 읽을 수 있게) 매개변수 점도 대칭, 뒤집힌 뒤 거리 변경은 그 방향으로', () => {
    const { doc, ins, nh } = setup();
    let r = dynSetOps(doc, ins('insA'), { key: '반전', value: true }, nh);
    apply(doc, r.ops);
    let a = ins('insA');
    expect(at<LineEntity>(doc, a, 0).end.x).toBe(-10);
    const att = at<TextEntity>(doc, a, 6);
    expect(att.generation & 2).toBe(0);
    let ref = readReference(doc, a)!;
    // 뒤집힌 상태도 캐시에 남는다(다음 편집과 다시 열기가 그 상태에서 평가한다)
    expect(ref.values.get(30)?.flipped).toBe(true);
    expect(ref.values.get(1)?.points?.[1]?.x).toBe(-10);
    expect(a.attribs[0]!.insert.x).toBeLessThan(0);
    r = dynSetOps(doc, a, { key: '폭', value: 20 }, nh);
    apply(doc, r.ops);
    a = ins('insA');
    ref = readReference(doc, a)!;
    expect(at<LineEntity>(doc, a, 0).end.x).toBe(-20);
    const g = dynGrips(doc, a).find((x) => x.id === 'dyn:32')!;
    expect(g.mode).toBe('toggle');
  });

  it('회전 매개변수 각도 → 회전 동작이 바늘을 돌린다', () => {
    const { doc, ins, nh } = setup();
    const r = dynSetOps(doc, ins('insA'), { key: '각도', value: Math.PI / 2 }, nh);
    apply(doc, r.ops);
    const n = at<LineEntity>(doc, ins('insA'), 7);
    near(n.end.x, 2);
    near(n.end.y, 4);
    const ref = readReference(doc, ins('insA'))!;
    near(ref.values.get(60)!.points![1]!.y, 4);
  });
});

describe('XY', () => {
  it('축마다 값 집합(X 목록)에 맞추고 X만·Y만 신축', () => {
    const { doc, ins, nh } = setup();
    let r = dynSetOps(doc, ins('insC'), { key: '1:x', value: 7 }, nh);
    apply(doc, r.ops);
    let p = at<LwPolylineEntity>(doc, ins('insC'), 0);
    expect(p.vertices.map((v) => [v.x, v.y])).toEqual([
      [0, 0],
      [6, 0],
      [6, 3],
      [0, 3],
    ]);
    r = dynSetOps(doc, ins('insC'), { key: '세로', value: 5 }, nh);
    apply(doc, r.ops);
    p = at<LwPolylineEntity>(doc, ins('insC'), 0);
    expect(p.vertices.map((v) => [v.x, v.y])).toEqual([
      [0, 0],
      [6, 0],
      [6, 5],
      [0, 5],
    ]);
  });

  it('모서리 그립(첫 점 X, 둘째 점 Y)을 끈다', () => {
    const { doc, ins, nh } = setup();
    const c = ins('insC');
    const g = dynGrips(doc, c).find((x) => x.id === 'dyn:5')!;
    expect(g.point).toEqual({ x: 0, y: 53 });
    const r = applyDynGrip(doc, c, 'dyn:5', { x: -2, y: 54 }, nh);
    apply(doc, r.ops);
    const p = at<LwPolylineEntity>(doc, ins('insC'), 0);
    expect(p.vertices.map((v) => [v.x, v.y])).toEqual([
      [-2, 0],
      [4, 0],
      [4, 4],
      [-2, 4],
    ]);
  });
});

describe('그립', () => {
  it('매개변수 그립 위치·종류, 지금 상태에서 숨은 매개변수의 그립은 뺀다', () => {
    const { doc, ins } = setup();
    const a = dynGrips(doc, ins('insA'));
    expect(a.map((g) => [g.id, g.kind, g.mode, g.point.x, g.point.y])).toEqual([
      ['dyn:2', 'linear', 'drag', 0, 0],
      ['dyn:5', 'linear', 'drag', 10, 0],
      ['dyn:21', 'visibility', 'menu', 5, -1],
      ['dyn:32', 'flip', 'toggle', 0, 6],
      ['dyn:42', 'lookup', 'menu', 5, 8],
      ['dyn:62', 'rotation', 'drag', 3.5, 2.5],
    ]);
    expect(a[1]!.direction).toEqual({ x: 1, y: 0 });
    // B는 상태 B: 회전 매개변수가 보이지 않는다
    const b = dynGrips(doc, ins('insB'));
    expect(b.some((g) => g.kind === 'rotation')).toBe(false);
    expect(b.find((g) => g.id === 'dyn:5')?.point).toEqual({ x: 120, y: 0 });
  });
});

describe('RESETBLOCK', () => {
  it('정의를 직접 가리키고 표현 자료를 지우며 속성을 정의 자리로', () => {
    const { doc, ins, nh } = setup();
    const before = readReference(doc, ins('insB'))!;
    const r = dynResetOps(doc, ins('insB'), nh);
    apply(doc, r.ops);
    const b = ins('insB');
    expect(b.block).toBe('DYN-TEST');
    expect(b.xdict).toBeUndefined();
    expect(doc.objects.has(before.cache!.xdict)).toBe(false);
    expect(doc.objects.has(before.cache!.records.get(1)!)).toBe(false);
    expect(doc.blocks.has('*U5')).toBe(false);
    expect((b.attribs[0] as AttribEntity).insert.x).toBe(105);
    expect((b.attribs[0] as AttribEntity).text).toBe('B');
    expect(dynResetOps(doc, ins('insA'), nh).ops).toEqual([]);
  });
});

describe('DXF 저장', () => {
  it('바뀐 참조의 *U·캐시가 저장되고 다시 읽으면 같은 값, 정의 노드는 원본 태그 그대로', () => {
    const { doc, ins, nh } = setup();
    const def = readDefinition(doc, 'DYN-TEST')!;
    const norm = (o: unknown) => JSON.stringify((o as { raw: { code: number; value: string | number }[] }).raw.map((t) => [t.code, Number.isFinite(Number(t.value)) && String(t.value).trim() !== '' ? Number(t.value) : t.value]));
    const rawBefore = norm(doc.objects.get(def.params[0]!.handle));
    apply(doc, dynSetOps(doc, ins('insA'), [{ key: '폭', value: 20 }, { key: '모양', value: 'Both' }], nh).ops);
    const text = new TextDecoder().decode(writeDxf(doc).data);
    const doc2 = withFullRaw(readDxf(new TextEncoder().encode(text)), text);
    expect(norm(doc2.objects.get(def.params[0]!.handle))).toBe(rawBefore);
    const f = dynFixture();
    const a2 = doc2.entityIndex.get(f.h.insA!) as InsertEntity;
    const ref = readReference(doc2, a2)!;
    expect(ref.direct).toBe(false);
    expect(ref.values.get(1)?.points?.[1]?.x).toBe(20);
    expect(ref.values.get(20)?.state).toBe('Both');
    expect(ref.values.get(40)?.value).toBe('사용자');
    const rec2 = doc2.blockRecords.get(a2.block.toUpperCase())!;
    expect(rec2.xdata?.find((x) => x.app === 'AcDbBlockRepBTag')?.items.map((i) => String(i.value))).toEqual(['1', def.recordHandle]);
    expect(doc2.blocks.get(a2.block.toUpperCase())!.flags & 1).toBe(1);
    const xd = doc2.objects.get(a2.xdict!) as DictionaryObject;
    expect([...xd.entries.keys()]).toEqual(['AcDbBlockRepresentation']);
    // 다시 읽은 도면에서 이어서 고칠 수 있다
    const r = dynSetOps(doc2, a2, { key: '크기', value: 'Large' }, handles(0xa000));
    applyOps(doc2, r.ops);
    expect(readReference(doc2, doc2.entityIndex.get(f.h.insA!) as InsertEntity)!.values.get(20)?.state).toBe('B');
  });
});

const SAMPLE = `${FIXTURES}/samples-dxf/sample_AC1032_ascii.dxf`;

describe.skipIf(!existsSync(SAMPLE))('AutoCAD 표본(ACadSharp sample_AC1032_ascii.dxf, 읽기만)', () => {
  it('선형 + 축척 + 가시성 정의와 *U 참조를 읽고 고친다', () => {
    const text = readFileSync(SAMPLE, 'latin1');
    const doc = withFullRaw(readDxf(new TextEncoder().encode(text)), text);
    const def = readDefinition(doc, 'my-dynamic-block')!;
    expect(def.undecoded).toEqual([]);
    expect(def.params.map((p) => p.kind)).toEqual(['linear', 'visibility']);
    expect(def.actions.map((a) => a.kind)).toEqual(['scale']);
    const ins = doc.entityIndex.get('ABA') as InsertEntity;
    const ref = readReference(doc, ins)!;
    expect(ref.values.get(23)?.state).toBe('visibility_state_default');
    const d0 = Math.hypot(ref.values.get(1)!.points![1]!.x - ref.values.get(1)!.points![0]!.x, ref.values.get(1)!.points![1]!.y - ref.values.get(1)!.points![0]!.y);
    near(d0, 1.000200067033317 + 0.9995998459159514);
    const props = dynProperties(doc, ins)!;
    expect(props.map((p) => p.label)).toEqual(['dynamic-diameter', 'custom_visibility']);
    const r = dynSetOps(doc, ins, { key: 'dynamic-diameter', value: 4 }, handles(0x20000));
    applyOps(doc, r.ops);
    const ins2 = doc.entityIndex.get('ABA') as InsertEntity;
    const c = doc.blocks.get(ins2.block.toUpperCase())!.entities[0] as CircleEntity;
    // 축척 동작: 기준점(선형 첫 점)에 대해 4 / 2.0006배
    expect(c.radius).toBeCloseTo((0.9998999564746343 * 4) / d0, 9);
    const r2 = dynSetOps(doc, ins2, { key: 'custom_visibility', value: 'visibility_state_hide_all' }, handles(0x21000));
    applyOps(doc, r2.ops);
    const ins3 = doc.entityIndex.get('ABA') as InsertEntity;
    expect(doc.blocks.get(ins3.block.toUpperCase())!.entities[0]!.invisible).toBe(true);
    // 캐시: 선형 레코드의 머리·법선 점 배치는 그대로, 축척 동작 기준점 기록
    const ref3 = readReference(doc, ins3)!;
    const lin = doc.objects.get(ref3.cache!.records.get(1)!) as XRecordObject;
    expect(lin.data.length).toBe(13);
    expect(ref3.values.get(23)?.state).toBe('visibility_state_hide_all');
  });
});

const SAMPLE_DIR = `${FIXTURES}/samples-dxf`;

describe.skipIf(!existsSync(SAMPLE_DIR))('AutoCAD 표본의 다른 DXF 버전(R2000–R2013, 읽기만)', () => {
  for (const v of ['AC1015', 'AC1018', 'AC1021', 'AC1024', 'AC1027']) {
    it(`${v}: 정의(R2010 전은 *U 이름 + TrueName)와 표현 블록 참조를 읽고 고친다`, () => {
      const text = readFileSync(`${SAMPLE_DIR}/sample_${v}_ascii.dxf`, 'latin1');
      const doc = withFullRaw(readDxf(new TextEncoder().encode(text)), text);
      const ins = doc.entityIndex.get('ABA') as InsertEntity;
      expect(isDynamicReference(doc, ins)).toBe(true);
      const props = dynProperties(doc, ins)!;
      expect(props.map((p) => p.label)).toEqual(['dynamic-diameter', 'custom_visibility']);
      expect(props[1]!.value).toBe('visibility_state_default');
      const r = dynSetOps(doc, ins, { key: 'custom_visibility', value: 'visibility_state_hide_all' }, handles(0x30000));
      expect(r.ops.length).toBeGreaterThan(0);
      applyOps(doc, r.ops);
      expect(readReference(doc, doc.entityIndex.get('ABA') as InsertEntity)!.values.get(23)?.state).toBe('visibility_state_hide_all');
    });
  }
});
