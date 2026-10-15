import { describe, expect, it } from 'vitest';
import type { Entity, LineEntity } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults, tableKey } from '../../src/core/model';
import { missingAppOps, regAppOp, validAppName } from '../../src/edit/editcmds2/appid';
import { stretch } from '../../src/edit/geom/stretch';
import { pointInPolygon } from '../../src/edit/geom/selpoly';
import { rectPolygon, stretchSelection } from '../../src/app/editcmds2-stretch';
import { makeHarness } from '../cmds2/harness';
import { makeLispApp } from '../lisp/app';
import { setup } from '../util2/helpers';

describe('APPID 등록의 명령 취소', () => {
  it('regAppOp: 편집 세션 작업으로 넣고 되돌린다', () => {
    const { doc, s, h } = setup();
    expect(validAppName('MY APP')).toBe(true);
    expect(validAppName('a*b')).toBe(false);
    expect(validAppName('')).toBe(false);
    const op = regAppOp(doc, 'MyApp', h())!;
    s.commit({ label: 'REGAPP', ops: [op] });
    expect(doc.appIds.get('MYAPP')?.name).toBe('MyApp');
    expect(regAppOp(doc, 'myapp', h())).toBeNull();
    s.undo();
    expect(doc.appIds.has('MYAPP')).toBe(false);
    s.redo();
    expect(doc.appIds.has('MYAPP')).toBe(true);
    // 확장 데이터가 쓰는 앱 중 없는 것만, 한 번씩
    const more = missingAppOps(doc, ['MyApp', 'NEW', 'new', 'bad*'], h);
    expect(more.map((o) => (o as { key: string }).key)).toEqual(['NEW']);
  });

  it('(regapp "앱")은 명령 취소(U)로 되돌아가고 다시 하기로 돌아온다', async () => {
    const h = makeLispApp();
    await h.lisp('(regapp "OPENCAD_T")');
    expect(h.errors()).toEqual([]);
    expect(h.doc.appIds.has(tableKey('OPENCAD_T'))).toBe(true);
    h.st.session.undo();
    expect(h.doc.appIds.has(tableKey('OPENCAD_T'))).toBe(false);
    await h.lisp('(tblsearch "APPID" "OPENCAD_T")');
    expect(h.printed[h.printed.length - 1]?.text).toBe('nil');
    h.st.session.redo();
    expect(h.doc.appIds.get(tableKey('OPENCAD_T'))?.name).toBe('OPENCAD_T');
  });
});

const ln = (x0: number, y0: number, x1: number, y1: number): LineEntity => ({ ...entityDefaults(), type: 'LINE', handle: '', start: { x: x0, y: y0, z: 0 }, end: { x: x1, y: y1, z: 0 } });

/** 시험 하네스의 고르기에 창·폴리곤 선택을 붙인다(선의 끝점으로 판단) */
function withPolygonPicker(h: ReturnType<typeof makeHarness>): void {
  const pk = h.app.picker() as unknown as Record<string, unknown>;
  const ends = (e: Entity) => (e.type === 'LINE' ? [e.start, e.end] : []);
  const pick = (test: (p: { x: number; y: number }) => boolean, crossing: boolean) =>
    h.doc.blocks
      .get(MODEL_SPACE)!
      .entities.filter((e) => {
        const ps = ends(e);
        return ps.length && (crossing ? ps.some(test) : ps.every(test));
      })
      .map((e) => e.handle);
  pk.selectPolygon = (poly: { x: number; y: number }[], crossing: boolean) => pick((p) => pointInPolygon(p.x, p.y, poly), crossing);
  pk.select = (r: [number, number, number, number], crossing: boolean) => pick((p) => p.x >= r[0] && p.x <= r[2] && p.y >= r[1] && p.y <= r[3], crossing);
  pk.selectFence = () => [];
}

describe('STRETCH 걸침 폴리곤(CP)', () => {
  it('CP로 고른 다각형이 신축 영역이 되고, 그 안의 끝점만 옮긴다', async () => {
    const h = makeHarness();
    withPolygonPicker(h);
    const a = h.add(ln(0, 0, 10, 0));
    const b = h.add(ln(0, 10, 10, 10));
    const c = h.add(ln(100, 100, 110, 100));
    let got: Awaited<ReturnType<typeof stretchSelection>> = null;
    h.app.register({ name: 'T', title: 't', run: async (ctx) => void (got = await stretchSelection(h.app, ctx)) });
    // 오른쪽 끝(10,0)·(10,10)만 덮는 삼각형 모양 다각형
    await h.run('T', ['CP', '8,-2', '14,-2', '14,14', '8,14', '', '']);
    expect(h.prompts.slice(0, 3)).toEqual(['객체 선택:', '첫 번째 폴리곤 점:', '선의 끝점 지정 또는 [명령 취소(U)]:']);
    expect(h.printed[0]).toBe('신축할 객체를 걸침 윈도우 또는 걸침 폴리곤으로 선택...');
    expect(got!.handles.sort()).toEqual([a.handle, b.handle].sort());
    expect(got!.poly).toHaveLength(4);
    const res = stretch([a, b], got!.poly, { x: 5, y: 0 }, h.doc);
    const after = (res.replace ?? []) as LineEntity[];
    expect(after.map((l) => [l.start.x, l.end.x])).toEqual([
      [0, 15],
      [0, 15],
    ]);
    void c;
  });

  it('빈 곳을 찍으면 걸침 윈도우, 찍기만 하면 신축하지 않는다', async () => {
    const h = makeHarness();
    withPolygonPicker(h);
    const a = h.add(ln(0, 0, 10, 0));
    let got: Awaited<ReturnType<typeof stretchSelection>> = null;
    h.app.register({ name: 'T', title: 't', run: async (ctx) => void (got = await stretchSelection(h.app, ctx)) });
    await h.run('T', ['8,-1', '12,1', '']);
    expect(got!.handles).toEqual([a.handle]);
    expect(got!.poly).toEqual(rectPolygon([8, -1, 12, 1]));
    // 객체 위를 찍기만 하면 영역이 없다
    await h.run('T', ['5,0', '']);
    expect(got).toBeNull();
    expect(h.printed.some((t) => t.includes('걸침 윈도우 또는 걸침 폴리곤으로 객체를 선택해야'))).toBe(true);
  });
});
