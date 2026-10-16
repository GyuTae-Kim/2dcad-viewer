/** 그립 편집(GRIPEDIT) 흐름: 모드 키워드, Ctrl 복사·간격 스냅, 여러 핫 그립, 신축 중 값 입력, 다기능 옵션과 메뉴 고리 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ArcEntity, EllipseEntity, Entity, LineEntity, LwPolylineEntity } from '../../src/core/model';
import { lwVertices } from '../../src/core/lwpoly';
import { createLinearDimension } from '../../src/edit/dim';
import { registerModifyCommands } from '../../src/app/modify';
import { gripDimGeom, gripOptions, registerGripMenu, setCtrlHeld, textSegs } from '../../src/app/gripmenu';
import type { Pt } from '../../src/app/view';
import { type Harness, makeHarness, modelEntities } from '../cmds2/harness';
import { P, V, arc, ellipse, line, lw } from '../edit/helpers';

afterEach(() => setCtrlHeld(false));

function setup(): Harness {
  const h = makeHarness();
  registerModifyCommands(h.app);
  registerGripMenu(h.app);
  return h;
}

/** 객체를 고르고 그 그립들을 핫 그립으로(items[].point를 주면 서로 다른 점의 여러 그립) */
function hot(h: Harness, e: Entity, ids: string[], points?: Pt[]): void {
  h.st.selection.add(e.handle);
  const at = points?.[0] ?? { x: 0, y: 0 };
  const items = ids.map((id, i) => ({ handle: e.handle, id, point: points?.[i] ?? at }));
  (h.app as unknown as { hotGrip: unknown }).hotGrip = { point: at, items };
}

const ln = (h: Harness, handle: string) => h.doc.entityIndex.get(handle) as LineEntity;

describe('GRIPEDIT', () => {
  it('신축 중 숫자 = 결과 선분 길이, 미리보기에 동적 치수', async () => {
    const h = setup();
    const l = h.add(line(0, 0, 10, 0));
    hot(h, l, ['end'], [V(10, 0)]);
    await h.run('GRIPEDIT', ['4']);
    expect(ln(h, l.handle).end).toMatchObject({ x: 4, y: 0 });
    // 커서를 올린 방향으로 길이 5
    hot(h, l, ['end'], [V(4, 0)]);
    await h.run('GRIPEDIT', [{ click: [3, 4] }]);
    expect(ln(h, l.handle).end).toMatchObject({ x: 3, y: 4 });
    // 동적 치수가 미리보기 선분을 더한다(가짜 그리기는 객체 하나에 선분 하나)
    expect(h.ghostSizes[h.ghostSizes.length - 1]!).toBeGreaterThan(40);
  });

  it('모드 키워드(MO)와 다음 모드로 순환(Enter)', async () => {
    const h = setup();
    const l = h.add(line(0, 0, 10, 0));
    hot(h, l, ['end'], [V(10, 0)]);
    await h.run('GRIPEDIT', ['MO', { click: [12, 3] }]);
    const m = ln(h, l.handle);
    expect(m.start).toMatchObject({ x: 2, y: 3 });
    expect(m.end).toMatchObject({ x: 12, y: 3 });
    expect(h.printed).toContain('** 이동 **');
    hot(h, l, ['end'], [V(12, 3)]);
    await h.run('GRIPEDIT', ['', 'X']);
    expect(h.printed.filter((t) => t === '** 이동 **').length).toBe(2);
  });

  it('Ctrl을 누른 채 찍으면 복사가 이어지고, 다시 Ctrl이면 첫 간격의 배수로 스냅', async () => {
    const h = setup();
    const l = h.add(line(0, 0, 10, 0));
    hot(h, l, ['start'], [V(0, 0)]);
    setCtrlHeld(true);
    await h.run('GRIPEDIT', ['MO', { click: [0, 5] }, { click: [1, 9.2] }, 'X']);
    const lines = modelEntities(h.doc, 'LINE');
    expect(lines.length).toBe(3);
    expect(ln(h, l.handle).start).toMatchObject({ x: 0, y: 0 });
    const ys = lines.map((x) => x.start.y).sort((a, b) => a - b);
    expect(ys).toEqual([0, 5, 10]);
    expect(lines.every((x) => x.start.x === 0)).toBe(true);
    expect(h.printed).toContain('** 이동 (다중) **');
  });

  it('신축 복사(C): 원본은 두고 신축한 새 객체', async () => {
    const h = setup();
    const l = h.add(line(0, 0, 10, 0));
    hot(h, l, ['end'], [V(10, 0)]);
    await h.run('GRIPEDIT', ['C', { click: [10, 5] }, { click: [10, -5] }, 'X']);
    expect(modelEntities(h.doc, 'LINE').length).toBe(3);
    expect(ln(h, l.handle).end).toMatchObject({ x: 10, y: 0 });
  });

  it('여러 핫 그립(서로 다른 점)은 같은 변위로 신축', async () => {
    const h = setup();
    const pl = h.add(lw([[0, 0], [10, 0], [10, 10], [0, 10]]));
    hot(h, pl, ['v1', 'v2'], [V(10, 0), V(10, 10)]);
    await h.run('GRIPEDIT', [{ click: [13, 1] }]);
    const vs = lwVertices(h.doc.entityIndex.get(pl.handle) as LwPolylineEntity).map((v) => [v.x, v.y]);
    expect(vs).toEqual([[0, 0], [13, 1], [13, 11], [0, 10]]);
    // 다른 객체의 그립도 함께(선 두 개의 끝)
    const a = h.add(line(0, 20, 10, 20));
    const b = h.add(line(0, 30, 10, 30));
    h.st.selection.add(a.handle);
    h.st.selection.add(b.handle);
    (h.app as unknown as { hotGrip: unknown }).hotGrip = {
      point: V(10, 20),
      items: [
        { handle: a.handle, id: 'end', point: V(10, 20) },
        { handle: b.handle, id: 'end', point: V(10, 30) },
      ],
    };
    await h.run('GRIPEDIT', [{ click: [15, 22] }]);
    expect(ln(h, a.handle).end).toMatchObject({ x: 15, y: 22 });
    expect(ln(h, b.handle).end).toMatchObject({ x: 15, y: 32 });
  });

  it('한 객체의 같은 자리 그립은 하나만: 타원형 호가 축 끝에서 끝나면 호의 끝', async () => {
    const h = setup();
    const el = h.add(ellipse(0, 0, 4, 0, 0.5, 0, Math.PI / 2));
    hot(h, el, ['maj+', 'start'], [V(4, 0), V(4, 0)]);
    await h.run('GRIPEDIT', [{ click: [0, -3] }]);
    const r = h.doc.entityIndex.get(el.handle) as EllipseEntity;
    expect(r.majorAxis.x).toBeCloseTo(4);
    expect(r.startParam).toBeCloseTo((3 * Math.PI) / 2);
  });

  it('items[].point가 없으면 누른 그립 점', async () => {
    const h = setup();
    const l = h.add(line(0, 0, 10, 0));
    h.st.selection.add(l.handle);
    (h.app as unknown as { hotGrip: unknown }).hotGrip = { point: V(10, 0), items: [{ handle: l.handle, id: 'end' }] };
    await h.run('GRIPEDIT', [{ click: [10, 6] }]);
    expect(ln(h, l.handle).end).toMatchObject({ x: 10, y: 6 });
  });

  it('너무 짧으면 알리고 다시 묻는다', async () => {
    const h = setup();
    const a = h.add(arc(0, 0, 5, 0, 90));
    hot(h, a, ['end'], [V(0, 5)]);
    await h.run('GRIPEDIT', [{ click: [5, 0] }, 'X']);
    expect(h.printed).toContain('길이가 너무 짧습니다.');
    expect((h.doc.entityIndex.get(a.handle) as ArcEntity).endAngle).toBeCloseTo(Math.PI / 2);
  });

  it('다기능 옵션을 키워드로: 폴리선 정점 추가, 정점 제거, 호로 변환 — 명령 취소 한 단계', async () => {
    const h = setup();
    const pl = h.add(lw([[0, 0], [10, 0], [10, 10]]));
    hot(h, pl, ['v1'], [V(10, 0)]);
    await h.run('GRIPEDIT', ['AD', { click: [12, 5] }]);
    expect(h.prompts).toContain('새 정점 지정:');
    const xy = () => lwVertices(h.doc.entityIndex.get(pl.handle) as LwPolylineEntity).map((v) => [v.x, v.y]);
    expect(xy()).toEqual([[0, 0], [10, 0], [12, 5], [10, 10]]);
    h.st.session.undo();
    expect(xy()).toEqual([[0, 0], [10, 0], [10, 10]]);
    hot(h, pl, ['v1'], [V(10, 0)]);
    await h.run('GRIPEDIT', ['RE']);
    expect(xy()).toEqual([[0, 0], [10, 10]]);
    hot(h, pl, ['m0'], [V(5, 5)]);
    await h.run('GRIPEDIT', ['AR', { click: [8, 2] }]);
    expect(lwVertices(h.doc.entityIndex.get(pl.handle) as LwPolylineEntity)[0]!.bulge).not.toBe(0);
  });

  it('길이 조정 옵션은 전체 길이 숫자도 받는다', async () => {
    const h = setup();
    const l = h.add(line(0, 0, 10, 0));
    hot(h, l, ['end'], [V(10, 0)]);
    await h.run('GRIPEDIT', ['LE', '25']);
    expect(ln(h, l.handle).end.x).toBeCloseTo(25);
  });
});

describe('다기능 그립 메뉴', () => {
  it('옵션 목록', () => {
    const h = setup();
    const pl = h.add(lw([[0, 0, 0.4], [10, 0], [10, 10]]));
    const labels = (e: Entity, id: string) => gripOptions(h.app, { handle: e.handle, id, point: V(0, 0) }, e, h.st).map((o) => o.label);
    expect(labels(pl, 'v1')).toEqual(['신축', '정점 추가', '정점 제거']);
    expect(labels(pl, 'm0')).toEqual(['신축', '정점 추가', '선으로 변환']);
    expect(labels(pl, 'm1')).toEqual(['신축', '정점 추가', '호로 변환']);
    const l = h.add(line(0, 0, 10, 0));
    expect(labels(l, 'end')).toEqual(['신축', '길이 조정']);
    expect(labels(l, 'mid')).toEqual([]);
    const d = h.add(createLinearDimension(h.doc, P(0, 0), P(10, 0), P(5, 5)));
    expect(labels(d, 'textMid')).toEqual(['신축', '치수선과 함께 이동', '문자만 이동', '지시선과 함께 이동', '치수선 위', '수직 가운데', '문자 위치 재설정']);
    expect(labels(d, 'defPoint')).toEqual(['신축', '연속 치수', '기준선 치수']);
  });

  it('고리: 항목은 그 그립으로 GRIPEDIT(opt:열쇠)를, 연속 치수는 그 치수를 직전 치수로 DIMCONTINUE를 시작', () => {
    const h = setup();
    const calls: { name: string; arg?: string; hot: unknown; last: string[] }[] = [];
    const app = h.app as unknown as { run(n: string, a?: string): Promise<void>; hotGrip: unknown; lastCreated: string[] };
    app.run = async (name, arg) => {
      calls.push({ name, arg, hot: app.hotGrip, last: [...app.lastCreated] });
    };
    expect(h.app.gripMenuProviders.length).toBe(1);
    const pl = h.add(lw([[0, 0], [10, 0], [10, 10]]));
    const prov = h.app.gripMenuProviders[0]!;
    const items = prov.items({ handle: pl.handle, id: 'v1', point: V(10, 0) }, pl, h.st)!;
    expect(items.map((x) => x.label)).toEqual(['신축', '정점 추가', '정점 제거']);
    void items[1]!.run();
    expect(calls[0]).toMatchObject({ name: 'GRIPEDIT', arg: 'opt:AD', hot: { point: { x: 10, y: 0 }, items: [{ handle: pl.handle, id: 'v1', point: { x: 10, y: 0 } }] } });
    // 신축은 그 점에 겹친 다른 객체의 그립도 함께(그립을 누른 것과 같다)
    const other = h.add(line(10, 0, 20, 0));
    (h.app as unknown as { gripList: unknown }).gripList = [
      { handle: pl.handle, id: 'v1', point: V(10, 0) },
      { handle: other.handle, id: 'start', point: V(10, 0) },
      { handle: other.handle, id: 'end', point: V(20, 0) },
    ];
    void items[0]!.run();
    expect(calls[1]).toMatchObject({ name: 'GRIPEDIT', arg: undefined });
    expect((calls[1]!.hot as { items: unknown[] }).items).toEqual([
      { handle: pl.handle, id: 'v1', point: V(10, 0) },
      { handle: other.handle, id: 'start', point: V(10, 0) },
    ]);
    const d = h.add(createLinearDimension(h.doc, P(0, 0), P(10, 0), P(5, 5)));
    const before = [...app.lastCreated];
    const di = prov.items({ handle: d.handle, id: 'defPoint', point: V(10, 5) }, d, h.st)!;
    void di[1]!.run();
    expect(calls[2]).toMatchObject({ name: 'DIMCONTINUE', last: [d.handle] });
    expect(app.lastCreated).toEqual(before);
    // 신축밖에 없는 그립은 메뉴가 없다
    const l = h.add(line(0, 0, 1, 0));
    expect(prov.items({ handle: l.handle, id: 'mid', point: V(0.5, 0) }, l, h.st)).toBeNull();
  });

  it('메뉴에서 고른 옵션(arg)으로 바로 실행', async () => {
    const h = setup();
    const pl = h.add(lw([[0, 0], [10, 0], [10, 10]]));
    hot(h, pl, ['v1'], [V(10, 0)]);
    const c = (h.app as unknown as { commands: Map<string, { run(ctx: unknown, arg?: string): Promise<void> }> }).commands.get('GRIPEDIT')!;
    // 바로 실행 옵션은 입력이 필요 없다
    await c.run({ app: h.app, print: (t: string) => h.printed.push(t), group: 7, getPoint: () => Promise.reject(new Error('묻지 않아야 한다')) }, 'opt:RE');
    expect(lwVertices(h.doc.entityIndex.get(pl.handle) as LwPolylineEntity).length).toBe(2);
    expect(h.printed).toContain('** 정점 제거 **');
  });
});

describe('동적 치수 형상', () => {
  it('문자는 단선 글꼴 선분, 치수는 보조선·치수선·화살표', () => {
    const s: number[] = [];
    textSegs(s, '12.5°', V(0, 0), 1, 0);
    expect(s.length).toBeGreaterThan(40);
    const xs = s.filter((_, i) => i % 2 === 0);
    expect(Math.min(...xs)).toBeLessThan(0);
    expect(Math.max(...xs)).toBeGreaterThan(0);
    const units = { lunits: 2, luprec: 2, aunits: 0, auprec: 0 };
    const g = gripDimGeom([{ kind: 'aligned', a: V(0, 0), b: V(10, 0) }], 0.5, units);
    expect(g.segs.length % 4).toBe(0);
    expect(g.segs.length).toBeGreaterThan(30);
    expect(gripDimGeom([{ kind: 'radius', c: V(0, 0), p: V(3, 4), r: 5 }, { kind: 'arc', c: V(0, 0), r: 5, a0: 0, sw: 1 }], 0.5, units).segs.length).toBeGreaterThan(30);
  });
});
