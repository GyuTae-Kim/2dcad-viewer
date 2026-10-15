/**
 * 명령 흐름(가짜 App, tests/cmds2/harness): ARRAYPATH 연관(AS) = 예, ARRAYEDIT 옵션(직사각형·원형·경로), 소스(S) → ARRAYCLOSE,
 * 대체(REP)·재설정(RES), 배열 그립 계산, Ctrl+클릭 항목 지우기, 경로 따라가기.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { InsertEntity, LineEntity } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults, tableKey } from '../../src/core/model';
import { registerArrayPathCommand } from '../../src/app/arraypath';
import { erasePickedItem, pickArrayItem, registerAssocArrayCommands, setArrayAssociativity } from '../../src/app/assocarray';
import { arrayGripPoints, gripState } from '../../src/app/assocarray-grips';
import { type BuildEnv, createArrayOps, followPathOps } from '../../src/edit/assocarray/build';
import { readArray } from '../../src/edit/assocarray/read';
import type { ArrayParams, PathParams, PolarParams, RectParams } from '../../src/edit/assocarray/types';
import { allocBlockName } from '../../src/edit/geom/types';
import { type Affine, affTranslate } from '../../src/edit/geom/math';
import { gripPoints } from '../../src/edit/geom/grips';
import { type Harness, makeHarness, modelEntities } from '../cmds2/harness';
import type { Entity } from '../../src/core/model';
import { circle as circle0, line as line0 } from '../edit/make';

// 시험 도구(make.ts)의 핸들은 문서의 핸들과 겹칠 수 있다 → 핸들 없이 넣어 세션이 새로 매기게 한다
const circle = (x: number, y: number, r: number): Entity => ({ ...circle0(x, y, r), handle: '' });
const line = (x0: number, y0: number, x1: number, y1: number): Entity => ({ ...line0(x0, y0, x1, y1), handle: '' });

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);
const common = { base: { x: 0, y: 0 }, rows: 1, rowSpacing: 3, rowElevation: 0, levels: 1, levelSpacing: 1 };

function env(h: Harness): BuildEnv {
  return { doc: h.doc, newHandle: () => h.st.session.newHandle(), newBlockName: () => allocBlockName(h.doc, '*U') };
}

/** 모형 공간의 원(반지름 0.5) 하나로 배열을 만든다 */
function makeArray(h: Harness, params: ArrayParams, center: { x: number; y: number }, normalize: Affine, insert = { x: 0, y: 0, z: 0 }): InsertEntity {
  const c = h.add(circle(center.x, center.y, 0.5));
  const { handle: _h, ...props } = { ...entityDefaults(), handle: '' };
  void _h;
  const r = createArrayOps(env(h), { params, sources: [c], normalize, insert, rotation: 0, props, space: MODEL_SPACE });
  if ('error' in r) throw new Error(r.error);
  h.st.session.commit({ label: 'T', ops: r.ops });
  return h.doc.entityIndex.get(r.insert.handle) as InsertEntity;
}

function rect(h: Harness): InsertEntity {
  return makeArray(h, { kind: 'rect', ...common, origin: { x: 0, y: 0 }, columns: 3, columnSpacing: 4, rows: 2, rowSpacing: 3, axesAngle: Math.PI / 2 }, { x: 0, y: 0 }, affTranslate(0, 0));
}

function polar(h: Harness): InsertEntity {
  return makeArray(h, { kind: 'polar', ...common, center: { x: 0, y: 0 }, items: 6, itemAngle: Math.PI / 3, fillAngle: 2 * Math.PI, startAngle: 0, radius: 10, rotateItems: true }, { x: 10, y: 0 }, affTranslate(-10, 0));
}

const params = (h: Harness, ins: InsertEntity) => readArray(h.doc, h.doc.entityIndex.get(ins.handle))!.state.params;

afterEach(() => setArrayAssociativity(true));

describe('ARRAYPATH 연관 = 예', () => {
  it('기본(ARRAYASSOCIATIVITY 1)이면 경로 연관 배열 하나를 만든다', async () => {
    const h = makeHarness();
    registerArrayPathCommand(h.app);
    setArrayAssociativity(true);
    const src = h.add(line(-0.5, 0, 0.5, 0));
    const path = h.add(line(0, 0, 20, 0));
    await h.run('ARRAYPATH', [{ sel: [src.handle] }, { pick: path.handle, at: [1, 0] }, 'M', 'D', 'I', '5', '']);
    expect(h.printed).toContain('유형 = 경로  연관 = 예');
    const ms = h.doc.blocks.get(MODEL_SPACE)!.entities;
    expect(ms.map((e) => e.type).sort()).toEqual(['INSERT', 'LINE']);
    const info = readArray(h.doc, ms.find((e) => e.type === 'INSERT'))!;
    expect(info.state.params.kind).toBe('path');
    expect(info.items.size).toBe(5);
    expect((info.state.params as PathParams).path).toBe(path.handle);
    expect(h.printed.some((t) => t.includes('연관 배열(경로)을 만들었습니다'))).toBe(true);
  });

  it('연관(AS)에서 아니오를 고르면 따로 떨어진 객체로 만들고 ARRAYASSOCIATIVITY도 0', async () => {
    const h = makeHarness();
    registerArrayPathCommand(h.app);
    setArrayAssociativity(true);
    const src = h.add(line(-0.5, 0, 0.5, 0));
    const path = h.add(line(0, 0, 20, 0));
    await h.run('ARRAYPATH', [{ sel: [src.handle] }, { pick: path.handle, at: [1, 0] }, 'AS', 'N', 'M', 'D', 'I', '3', '']);
    expect(modelEntities(h.doc, 'LINE').length).toBe(4);
    expect(modelEntities(h.doc, 'INSERT').length).toBe(0);
  });
});

describe('ARRAYEDIT', () => {
  it('직사각형: 프롬프트, 열(COL)·행(R)·레벨(L)', async () => {
    const h = makeHarness();
    registerAssocArrayCommands(h.app);
    const ins = rect(h);
    await h.run('ARRAYEDIT', [{ pick: ins.handle, at: [0, 0] }, 'COL', '5', '2', 'R', '3', '', '', 'L', '2', '7', 'X']);
    expect(h.prompts).toContain('배열 선택:');
    expect(h.prompts).toContain('옵션 입력 [소스(S)/대체(REP)/기준점(B)/행(R)/열(COL)/레벨(L)/재설정(RES)/종료(X)] <종료>:');
    expect(h.prompts).toContain('열 수 입력 또는 [표현식(E)] <3>:');
    expect(h.prompts).toContain('행 사이의 거리 지정 또는 [전체(T)/표현식(E)] <3.0000>:');
    expect(h.prompts).toContain('행 사이의 증분 고도 지정 또는 [표현식(E)] <0.0000>:');
    const p = params(h, ins) as RectParams;
    expect([p.columns, p.columnSpacing, p.rows, p.rowSpacing, p.levels, p.levelSpacing]).toEqual([5, 2, 3, 3, 2, 7]);
    expect(readArray(h.doc, h.doc.entityIndex.get(ins.handle))!.items.size).toBe(30);
    // 명령 하나 = 명령 취소 한 번
    h.st.session.undo();
    expect((params(h, ins) as RectParams).columns).toBe(3);
  });

  it('원형: 항목(I)·채울 각도(F)·사이 각도(A)·항목 회전(ROT)·행(ROW)', async () => {
    const h = makeHarness();
    registerAssocArrayCommands(h.app);
    const ins = polar(h);
    await h.run('ARRAYEDIT', [{ pick: ins.handle, at: [10, 0] }, 'I', '8', 'F', '180', 'A', '20', 'ROT', 'N', 'ROW', '2', '4', '', '']);
    expect(h.prompts).toContain('옵션 입력 [소스(S)/대체(REP)/기준점(B)/항목(I)/사이 각도(A)/채울 각도(F)/행(ROW)/레벨(L)/항목 회전(ROT)/재설정(RES)/종료(X)] <종료>:');
    expect(h.prompts).toContain('채울 각도 지정(+=ccw, -=cw) 또는 [표현식(EX)] <360>:');
    expect(h.prompts).toContain('배열된 항목을 회전하시겠습니까? [예(Y)/아니오(N)] <예>:');
    const p = params(h, ins) as PolarParams;
    expect(p.items).toBe(8);
    close(p.itemAngle, (20 * Math.PI) / 180);
    close(p.fillAngle, (140 * Math.PI) / 180);
    expect(p.rotateItems).toBe(false);
    expect([p.rows, p.rowSpacing]).toEqual([2, 4]);
  });

  it('경로: 방법(M)·항목(I)·항목 정렬(A)', async () => {
    const h = makeHarness();
    registerAssocArrayCommands(h.app);
    const path = h.add(line(0, 0, 10, 0)) as LineEntity;
    const ins = makeArray(h, { kind: 'path', ...common, method: 'divide', items: 3, spacing: 5, align: true, zDir: true, reverse: false, path: path.handle, tangentRef: 0 }, { x: 0, y: 0 }, affTranslate(0, 0));
    await h.run('ARRAYEDIT', [{ pick: ins.handle, at: [0, 0] }, 'M', 'M', 'I', '3', '', 'A', 'N', 'X']);
    expect(h.prompts).toContain('옵션 입력 [소스(S)/대체(REP)/방법(M)/기준점(B)/항목(I)/행(R)/레벨(L)/항목 정렬(A)/Z 방향(Z)/재설정(RES)/종료(X)] <종료>:');
    expect(h.printed).toContain('최대 항목 수 = 4');
    const p = params(h, ins) as PathParams;
    expect([p.method, p.spacing, p.items, p.align]).toEqual(['measure', 3, 4, false]);
  });

  it('소스(S) → 원본 편집 상태 → ARRAYCLOSE 저장(새로 그린 객체도 원본에 들어간다)', async () => {
    const h = makeHarness();
    registerAssocArrayCommands(h.app);
    const ins = rect(h);
    await h.run('ARRAYEDIT', [{ pick: ins.handle, at: [0, 0] }, 'S', { click: [4, 3] }]);
    expect(h.prompts).toContain('배열에서 항목 선택:');
    // 원본 사본이 항목(1,1) 자리에
    const temps = modelEntities(h.doc, 'CIRCLE');
    expect(temps.length).toBe(1);
    expect([temps[0]!.center.x, temps[0]!.center.y]).toEqual([4, 3]);
    h.add(circle(4.2, 3, 0.1));
    await h.run('ARRAYCLOSE', ['']);
    expect(h.prompts).toContain('배열 편집 상태에 대한 변경 내용을 저장하시겠습니까? [저장(S)/취소(D)] <저장>:');
    expect(modelEntities(h.doc, 'CIRCLE').length).toBe(0);
    const info = readArray(h.doc, h.doc.entityIndex.get(ins.handle))!;
    const src = h.doc.blocks.get(tableKey(info.state.source))!;
    expect(src.entities.length).toBe(2);
    // 새 원은 원본 블록 좌표(항목 (1,1) 기준)로
    const small = src.entities.find((e) => e.type === 'CIRCLE' && e.radius === 0.1)!;
    expect(small.type === 'CIRCLE' && [+small.center.x.toFixed(9), +small.center.y.toFixed(9)]).toEqual([0.2, 0]);
    // 다시 ARRAYCLOSE: 편집 상태가 아니다
    await h.run('ARRAYCLOSE', []);
    expect(h.printed.some((t) => t.includes('배열 편집 상태가 아닙니다'))).toBe(true);
  });

  it('소스(S) → ARRAYCLOSE 취소면 원본이 그대로', async () => {
    const h = makeHarness();
    registerAssocArrayCommands(h.app);
    const ins = rect(h);
    await h.run('ARRAYEDIT', [{ pick: ins.handle, at: [0, 0] }, 'S', { click: [0, 0] }]);
    await h.run('ARRAYCLOSE', ['D']);
    expect(modelEntities(h.doc, 'CIRCLE').length).toBe(0);
    const info = readArray(h.doc, h.doc.entityIndex.get(ins.handle))!;
    expect(h.doc.blocks.get(tableKey(info.state.source))!.entities.length).toBe(1);
  });

  it('대체(REP) 항목 하나 → 재설정(RES)', async () => {
    const h = makeHarness();
    registerAssocArrayCommands(h.app);
    const ins = rect(h);
    const rep = h.add(line(20, 20, 21, 20));
    await h.run('ARRAYEDIT', [{ pick: ins.handle, at: [0, 0] }, 'REP', { sel: [rep.handle] }, '', { click: [8, 0] }, '', 'X']);
    expect(h.prompts).toContain('대체 객체 선택:');
    expect(h.prompts).toContain('대체 객체의 기준점 선택 또는 [키 점(K)] <중심>:');
    expect(h.prompts).toContain('배열에서 대체할 항목 선택 또는 [원본 객체(S)]:');
    let info = readArray(h.doc, h.doc.entityIndex.get(ins.handle))!;
    expect([...info.state.replaced.keys()]).toEqual(['2,0,0']);
    // 대체 객체는 도면에 남는다
    expect(h.doc.entityIndex.has(rep.handle)).toBe(true);
    await h.run('ARRAYEDIT', [{ pick: ins.handle, at: [0, 0] }, 'RES', 'X']);
    info = readArray(h.doc, h.doc.entityIndex.get(ins.handle))!;
    expect(info.state.replaced.size).toBe(0);
  });

  it('연관 배열이 아닌 객체는 다시 묻는다', async () => {
    const h = makeHarness();
    registerAssocArrayCommands(h.app);
    const l = h.add(line(0, 0, 1, 0));
    await h.run('ARRAYEDIT', [{ pick: l.handle, at: [0, 0] }, '']);
    expect(h.printed).toContain('선택한 객체는 연관 배열이 아닙니다.');
  });
});

describe('배열 그립', () => {
  it('직사각형: 열 간격·열 수·행 간격·행 수·구석 그립과 끌기', () => {
    const h = makeHarness();
    registerAssocArrayCommands(h.app);
    const ins = rect(h);
    const g = arrayGripPoints(h.doc, ins);
    expect(g.map((x) => x.id).sort()).toEqual(['arr:cols', 'arr:colsp', 'arr:corner', 'arr:rows', 'arr:rowsp']);
    expect(g.find((x) => x.id === 'arr:colsp')!.point).toEqual({ x: 4, y: 0 });
    // 블록 참조 그립 목록에도 들어간다
    expect(gripPoints(ins, h.doc).some((x) => x.id === 'arr:colsp')).toBe(true);
    const info = readArray(h.doc, ins)!;
    expect((gripState(h.doc, info, 'arr:colsp', { x: 6, y: 1 })!.params as RectParams).columnSpacing).toBe(6);
    expect((gripState(h.doc, info, 'arr:cols', { x: 16.5, y: 0 })!.params as RectParams).columns).toBe(5);
    const c = gripState(h.doc, info, 'arr:corner', { x: 12, y: 9 })!.params as RectParams;
    expect([c.columns, c.rows]).toEqual([4, 4]);
  });

  it('원형: 반지름·항목 사이의 각도', () => {
    const h = makeHarness();
    registerAssocArrayCommands(h.app);
    const ins = polar(h);
    const info = readArray(h.doc, ins)!;
    const ids = arrayGripPoints(h.doc, ins).map((x) => x.id);
    expect(ids).toContain('arr:radius');
    expect(ids).toContain('arr:angle');
    expect((gripState(h.doc, info, 'arr:radius', { x: 12, y: 0 })!.params as PolarParams).radius).toBe(12);
    const a = gripState(h.doc, info, 'arr:angle', { x: 10 * Math.SQRT1_2, y: 10 * Math.SQRT1_2 })!.params as PolarParams;
    close(a.itemAngle, Math.PI / 4);
    close(a.fillAngle, (5 * Math.PI) / 4);
    // 채울 각도가 360°를 넘으면 바꾸지 않는다(6개 × 90°)
    expect(gripState(h.doc, info, 'arr:angle', { x: 0, y: 10 })).toBeNull();
  });
});

describe('Ctrl+클릭 항목 지우기', () => {
  it('항목을 골라 Delete로 그 항목만 지운다', () => {
    const h = makeHarness();
    registerAssocArrayCommands(h.app);
    (h.app.view.overlay as unknown as { selection: unknown[] }).selection = [];
    const ins = rect(h);
    expect(pickArrayItem(h.app, ins.handle, { x: 8, y: 3 })).toBe(true);
    expect(h.printed.some((t) => t.includes('열 3, 행 2'))).toBe(true);
    expect(erasePickedItem(h.app)).toBe(true);
    const info = readArray(h.doc, h.doc.entityIndex.get(ins.handle))!;
    expect([...info.state.removed]).toEqual(['2,1,0']);
    expect(info.items.size).toBe(5);
    // 빈 곳은 항목이 아니다
    expect(pickArrayItem(h.app, ins.handle, { x: 50, y: 50 })).toBe(false);
  });
});

describe('경로 따라가기', () => {
  it('경로 곡선을 고치면 같은 묶음에서 배열이 새 경로로', () => {
    const h = makeHarness();
    const path = h.add(line(0, 0, 10, 0)) as LineEntity;
    const ins = makeArray(h, { kind: 'path', ...common, method: 'divide', items: 3, spacing: 5, align: true, zDir: true, reverse: false, path: path.handle, tangentRef: 0 }, { x: 0, y: 0 }, affTranslate(0, 0));
    const longer = { ...path, end: { x: 0, y: 20, z: 0 } } as LineEntity;
    h.st.session.commit({ label: 'GRIP', ops: [{ kind: 'modify', block: MODEL_SPACE, before: path, after: longer }], group: 5 });
    const ops = followPathOps(env(h), new Set([path.handle]));
    expect(ops.length).toBeGreaterThan(0);
    h.st.session.commit({ label: 'GRIP', ops, group: 5 });
    const info = readArray(h.doc, h.doc.entityIndex.get(ins.handle))!;
    expect(info.stale).toBeUndefined();
    // 다시 고칠 것이 없다
    expect(followPathOps(env(h), new Set([path.handle])).length).toBe(0);
    // 같은 묶음: 한 번 취소하면 경로와 배열이 함께 돌아간다
    h.st.session.undo();
    expect((h.doc.entityIndex.get(path.handle) as LineEntity).end.x).toBe(10);
    expect(readArray(h.doc, h.doc.entityIndex.get(ins.handle))!.stale).toBeUndefined();
  });
});
