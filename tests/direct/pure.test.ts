/**
 * 직접 조작 입력의 순수 함수: 동적 입력(dyninput.ts), 객체 스냅 재지정(osnap-override.ts), 스냅 기하(snap.ts),
 * 올가미(lasso.ts), Ctrl 단축키(keys.ts), 끌어 옮기기 판정(dragmove.ts), 바로 가기 메뉴 정리(ctxmenu.ts), 두 번 누르기 기본 명령.
 */
import { describe, expect, it } from 'vitest';
import type { Entity } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { DynInput, dynRelative } from '../../src/app/dyninput';
import { parseOverride, runPointOverride } from '../../src/app/osnap-override';
import { ALL_SNAPS, DEFAULT_SNAPS, extAnchorsOf, extSnaps, findSnap, geometricCenter, lineInter, parSnaps, polygonCentroid, tangentPoints } from '../../src/app/snap';
import { Lasso, simplify } from '../../src/app/lasso';
import { ctrlAction } from '../../src/app/keys';
import { DragGhost, pressKind } from '../../src/app/dragmove';
import type { PointResult } from '../../src/app/app';
import type { Picker } from '../../src/app/pick';
import { WORLD } from '../../src/app/ucs';
import { newDoc } from '../edit/make';
import { FakePicker } from './fakes';

const near = (a: { x: number; y: number }, b: { x: number; y: number }, eps = 1e-6) => Math.hypot(a.x - b.x, a.y - b.y) < eps;
const line = (x0: number, y0: number, x1: number, y1: number, handle = ''): Entity => ({ ...entityDefaults(), type: 'LINE', handle, start: { x: x0, y: y0, z: 0 }, end: { x: x1, y: y1, z: 0 } }) as Entity;

describe('동적 입력(dyninput)', () => {
  it('두 번째 점부터 좌표 글은 상대(@)로, #·@·*는 그대로, 좌표가 아닌 글도 그대로', () => {
    expect(dynRelative('10,5')).toBe('@10,5');
    expect(dynRelative('10,5,0')).toBe('@10,5,0');
    expect(dynRelative('10<45')).toBe('@10<45');
    expect(dynRelative('#10,5')).toBe('#10,5');
    expect(dynRelative('@10,5')).toBe('@10,5');
    expect(dynRelative('*10,5')).toBe('*10,5');
    expect(dynRelative('25')).toBe('25');
    expect(dynRelative('END')).toBe('END');
  });

  it('Tab은 지금 칸 값을 잠그고 다음 칸으로, 잠긴 거리는 커서 방향으로 묶인다', () => {
    const d = new DynInput();
    d.sync({});
    expect(d.locked).toBe(false);
    expect(d.tab('10', true)).toBe(true);
    expect(d.locks).toEqual(['10', null]);
    expect(d.focus).toBe(1);
    // 잠긴 거리 10: 커서가 (3,4)·(0,50) 어디든 기준점에서 10
    expect(near(d.constrain({ x: 0, y: 0 }, { x: 3, y: 4 }, WORLD), { x: 6, y: 8 })).toBe(true);
    expect(near(d.constrain({ x: 1, y: 1 }, { x: 1, y: 51 }, WORLD), { x: 1, y: 11 })).toBe(true);
    // 각도 칸에 90을 치고 Enter → 기준점에서 (0,10)
    expect(near(d.resolve('90', { x: 0, y: 0 }, { x: 5, y: 0 }, WORLD)!, { x: 0, y: 10 })).toBe(true);
    // 좌표 글은 칸 입력이 아니다
    expect(d.tab('3,4', true)).toBe(false);
    expect(d.resolve('3,4', { x: 0, y: 0 }, null, WORLD)).toBeNull();
    // 요청이 바뀌면 지운다
    d.sync({});
    expect(d.locked).toBe(false);
    expect(d.resolve('', { x: 0, y: 0 }, { x: 1, y: 0 }, WORLD)).toBeNull();
  });

  it('각도만 잠그면 거리는 커서까지, 첫 점(기준점 없음)은 X·Y 칸', () => {
    const d = new DynInput();
    d.sync({});
    d.tab('', true); // 빈 글: 칸만 옮긴다
    expect(d.focus).toBe(1);
    d.tab('45', true);
    const p = d.constrain({ x: 0, y: 0 }, { x: 10, y: 0 }, WORLD);
    expect(near(p, { x: 10 * Math.SQRT1_2, y: 10 * Math.SQRT1_2 })).toBe(true);
    const f = new DynInput();
    f.sync({});
    f.tab('7', false);
    expect(near(f.resolve('9', null, { x: 0, y: 0 }, WORLD)!, { x: 7, y: 9 })).toBe(true);
    expect(near(f.constrain(null, { x: 1, y: 2 }, WORLD), { x: 7, y: 2 })).toBe(true);
    // 돌린 UCS: 거리·각도는 UCS X축에서
    const u = { ox: 0, oy: 0, angle: Math.PI / 2 };
    const g = new DynInput();
    g.sync({});
    g.tab('10', true);
    expect(near(g.resolve('0', { x: 0, y: 0 }, { x: 1, y: 1 }, u)!, { x: 0, y: 10 })).toBe(true);
  });

  it('커서 옆 칸: 지금 칸은 친 글, 잠긴 칸은 자물쇠와 값, 좌표 글은 칸 하나', () => {
    const d = new DynInput();
    d.sync({});
    const fmt = (v: number) => v.toFixed(2);
    expect(d.fields({ x: 0, y: 0 }, { x: 0, y: 5 }, '', WORLD, fmt)).toEqual([
      { text: '5.00', locked: false, active: true },
      { text: '90°', locked: false, active: false },
    ]);
    d.tab('12', true);
    expect(d.fields({ x: 0, y: 0 }, { x: 0, y: 5 }, '3', WORLD, fmt)).toEqual([
      { text: '12', locked: true, active: false },
      { text: '3', locked: false, active: true },
    ]);
    expect(d.fields(null, { x: 1, y: 2 }, '1,2', WORLD, fmt)).toEqual([{ text: '1,2', locked: false, active: true }]);
  });
});

describe('객체 스냅 재지정(osnap-override)', () => {
  it('이름 앞 세 글자·쉼표 목록·NON·FROM·M2P·TT·점 필터, 아닌 글은 null', () => {
    expect(parseOverride('end')).toEqual({ kind: 'snap', modes: ['end'] });
    expect(parseOverride('_ENDP')).toEqual({ kind: 'snap', modes: ['end'] });
    expect(parseOverride('int,mid')).toEqual({ kind: 'snap', modes: ['int', 'mid'] });
    expect(parseOverride('GCEN')).toEqual({ kind: 'snap', modes: ['gcen'] });
    expect(parseOverride('par')).toEqual({ kind: 'snap', modes: ['par'] });
    expect(parseOverride('NON')).toEqual({ kind: 'snap', modes: [] });
    expect(parseOverride('from')).toEqual({ kind: 'from' });
    expect(parseOverride('MTP')).toEqual({ kind: 'm2p' });
    expect(parseOverride('tt')).toEqual({ kind: 'tt' });
    expect(parseOverride('.xy')).toEqual({ kind: 'filter', take: ['x', 'y'] });
    expect(parseOverride('.xx')).toBeNull();
    expect(parseOverride('10,5')).toBeNull();
    expect(parseOverride('ABC')).toBeNull();
    expect(parseOverride('E')).toBeNull();
  });

  /** 입력을 차례로 내주는 가짜 점 요청 */
  const io = (answers: (PointResult | { x: number; y: number })[]) => {
    const prompts: string[] = [];
    const printed: string[] = [];
    return {
      prompts,
      printed,
      ucs: WORLD,
      print: (t: string) => void printed.push(t),
      getPoint: async (prompt: string, opt?: { base?: { x: number; y: number } | null; allowText?: boolean }) => {
        prompts.push(prompt);
        const a = answers.shift()!;
        if ('x' in a) return { point: opt?.base ? { x: opt.base.x + a.x, y: opt.base.y + a.y } : a, snap: null } as PointResult;
        return a;
      },
    };
  };

  it('FROM: 기준점과 간격(기준점에서 상대), M2P: 두 점의 가운데, Enter면 그만둔다', async () => {
    const a = io([{ x: 10, y: 10 }, { x: 5, y: 0 }]);
    expect(await runPointOverride({ kind: 'from' }, a)).toEqual({ x: 15, y: 10 });
    expect(a.prompts).toEqual(['기준점:', '<간격띄우기>:']);
    const b = io([{ x: 0, y: 0 }, { x: 10, y: 4 }]);
    expect(await runPointOverride({ kind: 'm2p' }, b)).toEqual({ x: 5, y: 2 });
    expect(b.prompts).toEqual(['중간점의 첫 번째 점:', '중간점의 두 번째 점:']);
    expect(await runPointOverride({ kind: 'm2p' }, io([{ enter: true }]))).toBeNull();
  });

  it('점 필터: .X는 첫 점의 X와 둘째 점의 Y, 남은 좌표가 하나면 숫자도 받는다, 글은 다시 묻는다', async () => {
    const a = io([{ x: 1, y: 2 }, { x: 7, y: 8 }]);
    expect(await runPointOverride({ kind: 'filter', take: ['x'] }, a)).toEqual({ x: 1, y: 8 });
    expect(a.prompts).toEqual(['대상:', '(YZ 필요):']);
    const b = io([{ x: 1, y: 2 }, { text: '9' }]);
    expect(await runPointOverride({ kind: 'filter', take: ['x', 'z'] }, b)).toEqual({ x: 1, y: 9 });
    expect(b.prompts[1]).toBe('(Y 필요):');
    const c = io([{ x: 1, y: 2 }, { text: 'abc' }, { x: 3, y: 4 }]);
    expect(await runPointOverride({ kind: 'filter', take: ['y'] }, c)).toEqual({ x: 3, y: 2 });
    expect(c.printed.length).toBe(1);
  });
});

describe('스냅 기하(snap)', () => {
  it('기본 켜진 스냅은 AutoCAD OSMODE 4133(끝점·중심·교차점·연장선), 대화상자 목록은 14종', () => {
    expect(DEFAULT_SNAPS).toEqual(['end', 'cen', 'int', 'ext']);
    expect(ALL_SNAPS.length).toBe(14);
    expect(ALL_SNAPS).toContain('par');
    expect(ALL_SNAPS).toContain('gcen');
  });

  it('접점: 원 밖의 기준점에서 두 접점, 원 안이면 없음', () => {
    const t = tangentPoints({ x: 10, y: 0 }, { x: 0, y: 0 }, 5);
    expect(t.length).toBe(2);
    for (const q of t) {
      expect(Math.hypot(q.x, q.y)).toBeCloseTo(5, 9);
      // 반지름과 접선이 수직
      expect(q.x * (q.x - 10) + q.y * q.y).toBeCloseTo(0, 9);
    }
    expect(tangentPoints({ x: 1, y: 0 }, { x: 0, y: 0 }, 5)).toEqual([]);
  });

  it('연장선: 선 끝에서 바깥으로 나간 선 위, 반대쪽(선 안쪽)은 아님, 두 연장선의 교점', () => {
    const [a, b] = extAnchorsOf(line(0, 0, 10, 0));
    expect(near(a!.dir!, { x: -1, y: 0 })).toBe(true);
    expect(near(b!.dir!, { x: 1, y: 0 })).toBe(true);
    const s = extSnaps([b!], { x: 20, y: 0.5 }, 1);
    expect(s.length).toBe(1);
    expect(near(s[0]!, { x: 20, y: 0 })).toBe(true);
    expect(s[0]!.lines?.length).toBe(1);
    expect(near(s[0]!.lines![0]!.from, { x: 10, y: 0 })).toBe(true);
    expect(extSnaps([b!], { x: 5, y: 0.5 }, 1)).toEqual([]);
    const [, up] = extAnchorsOf(line(30, -10, 30, -5));
    const both = extSnaps([b!, up!], { x: 30.2, y: 0.3 }, 1);
    expect(both.some((x) => near(x, { x: 30, y: 0 }) && x.lines?.length === 2)).toBe(true);
  });

  it('호의 연장선은 원 위(호 밖), 평행은 기준점에서 획득 방향으로', () => {
    const arc = { ...entityDefaults(), type: 'ARC', handle: '', center: { x: 0, y: 0, z: 0 }, radius: 10, startAngle: 0, endAngle: Math.PI / 2 } as Entity;
    const anchors = extAnchorsOf(arc);
    expect(anchors.length).toBe(2);
    const s = extSnaps(anchors, { x: -10.3, y: 0.2 }, 1);
    expect(s.length).toBeGreaterThan(0);
    expect(Math.hypot(s[0]!.x, s[0]!.y)).toBeCloseTo(10, 9);
    // 호 위의 점은 연장선이 아니다
    expect(extSnaps(anchors, { x: 7.07, y: 7.07 }, 1)).toEqual([]);
    const p = parSnaps({ x: 0, y: 0 }, [{ x: 1, y: 0 }], { x: -8, y: 0.4 }, 1);
    expect(near(p[0]!, { x: -8, y: 0 })).toBe(true);
    expect(p[0]!.kind).toBe('par');
  });

  it('기하학적 중심: 닫힌 폴리선의 면적 중심(볼록도 포함), 닫히지 않으면 없음', () => {
    expect(near(polygonCentroid([{ x: 0, y: 0, bulge: 0 }, { x: 4, y: 0, bulge: 0 }, { x: 4, y: 2, bulge: 0 }, { x: 0, y: 2, bulge: 0 }])!, { x: 2, y: 1 })).toBe(true);
    // 반원(지름 0,0–2,0 위로): 중심 (1, 4r/3π)
    const c = polygonCentroid([{ x: 2, y: 0, bulge: 1 }, { x: 0, y: 0, bulge: 0 }])!;
    expect(c.x).toBeCloseTo(1, 3);
    expect(c.y).toBeCloseTo(4 / (3 * Math.PI), 3);
    const lw = (closed: boolean) => ({ ...entityDefaults(), type: 'LWPOLYLINE', handle: '', closed, elevation: 0, verts: [0, 0, 0, 4, 0, 0, 4, 2, 0, 0, 2, 0], widths: undefined }) as unknown as Entity;
    expect(near(geometricCenter(lw(true))!, { x: 2, y: 1 })).toBe(true);
    expect(geometricCenter(lw(false))).toBeNull();
  });

  it('가상 교차점: 두 선분을 늘린 직선의 교점, 나란하면 없음', () => {
    expect(near(lineInter([0, 0, 1, 0, 5, -3, 5, -1], 0, 4)!, { x: 5, y: 0 })).toBe(true);
    expect(lineInter([0, 0, 1, 0, 0, 1, 1, 1], 0, 4)).toBeNull();
  });

  it('findSnap: 원 테두리 위에서 중심, 기준점이 있으면 접점, 연장선·평행 획득점', () => {
    const doc = newDoc();
    const pk = new FakePicker(doc);
    const add = (e: Entity) => {
      e.handle = String(doc.entityIndex.size + 100);
      doc.blocks.get('*MODEL_SPACE')?.entities.push(e);
      doc.entityIndex.set(e.handle, e);
      return e;
    };
    add({ ...entityDefaults(), type: 'CIRCLE', handle: '', center: { x: 0, y: 0, z: 0 }, radius: 10 } as Entity);
    const ln = add(line(30, 0, 40, 0));
    const P = pk as unknown as Picker;
    const cen = findSnap(doc, P, { x: 10.5, y: 0.2 }, 1, new Set(['cen']));
    expect(cen?.kind).toBe('cen');
    expect(near(cen!, { x: 0, y: 0 })).toBe(true);
    // 접점: 기준점 (20,0)에서
    const tan = findSnap(doc, P, { x: 5, y: 8.6 }, 1, new Set(['tan']), { x: 20, y: 0 });
    expect(tan?.kind).toBe('tan');
    expect(Math.hypot(tan!.x, tan!.y)).toBeCloseTo(10, 6);
    // 연장선 획득점(선의 왼쪽 끝)에서 왼쪽으로
    const anchors = extAnchorsOf(ln);
    const ext = findSnap(doc, P, { x: 25, y: 0.3 }, 1, new Set(['ext']), null, { ext: anchors });
    expect(ext?.kind).toBe('ext');
    expect(near(ext!, { x: 25, y: 0 })).toBe(true);
    expect(findSnap(doc, P, { x: 25, y: 0.3 }, 1, new Set(['ext']))).toBeNull();
    const par = findSnap(doc, P, { x: 5, y: 20.4 }, 1, new Set(['par']), { x: 0, y: 20 }, { par: [{ x: 1, y: 0 }] });
    expect(par?.kind).toBe('par');
    expect(near(par!, { x: 5, y: 20 })).toBe(true);
  });
});

describe('올가미·단축키·끌기 판정', () => {
  it('처음 가로 방향으로 윈도우(오른쪽)·걸침(왼쪽), 스페이스바로 걸침→윈도우→울타리', () => {
    const r = new Lasso({ x: 0, y: 0 });
    r.add({ x: 10, y: 0 });
    expect(r.mode).toBe('window');
    const l = new Lasso({ x: 0, y: 0 });
    l.add({ x: -10, y: 1 });
    expect(l.mode).toBe('crossing');
    expect(l.label).toBe('걸침 올가미');
    expect(l.cycle()).toBe('window');
    expect(l.cycle()).toBe('fence');
    expect(l.cycle()).toBe('crossing');
    // 바꾼 뒤에는 방향으로 다시 정하지 않는다
    l.add({ x: 30, y: 1 });
    expect(l.mode).toBe('crossing');
  });

  it('올가미 고르기: 윈도우는 완전히 안, 걸침은 걸친 것까지, 울타리는 자취와 만나는 것', () => {
    const doc = newDoc();
    const pk = new FakePicker(doc);
    for (const [h, e] of [
      ['A', line(1, 1, 3, 1)],
      ['B', line(5, 1, 15, 1)],
    ] as const) {
      e.handle = h;
      doc.blocks.get('*MODEL_SPACE')?.entities.push(e);
      doc.entityIndex.set(h, e);
    }
    const lasso = (mode: 'window' | 'crossing' | 'fence') => {
      const l = new Lasso({ x: 0, y: 0 });
      for (const p of [
        { x: 8, y: 0 },
        { x: 8, y: 3 },
        { x: 0, y: 3 },
      ])
        l.add(p);
      while (l.mode !== mode) l.cycle();
      return l.select(pk, (p) => p);
    };
    expect(lasso('window')).toEqual(['A']);
    expect(lasso('crossing').sort()).toEqual(['A', 'B']);
    expect(lasso('fence')).toEqual(['B']);
    expect(simplify([{ x: 0, y: 0 }, { x: 1, y: 0.01 }, { x: 2, y: 0 }, { x: 2, y: 5 }], 0.5)).toEqual([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 5 }]);
  });

  it('Ctrl 단축키 표(Shift·Alt가 붙으면 아님, 한글 자판은 키 자리로)', () => {
    const k = (key: string, o: Partial<{ code: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }> = {}) => ctrlAction({ key, code: o.code, ctrlKey: o.ctrlKey ?? true, metaKey: !!o.metaKey, shiftKey: !!o.shiftKey, altKey: !!o.altKey });
    expect(k('g')).toEqual({ toggle: 'grid' });
    expect(k('b')).toEqual({ toggle: 'snap' });
    expect(k('l')).toEqual({ toggle: 'ortho' });
    expect(k('f')).toEqual({ toggle: 'osnap' });
    expect(k('u')).toEqual({ toggle: 'polar' });
    expect(k('h')).toEqual({ toggle: 'pickstyle' });
    expect(k('k')).toEqual({ run: 'HYPERLINK' });
    expect(k('0')).toEqual({ run: 'CLEANSCREENON' });
    expect(k('8')).toEqual({ run: 'QUICKCALC' });
    expect(k('j')).toEqual({ enter: true });
    expect(k('m')).toEqual({ enter: true });
    expect(k('\\')).toEqual({ cancel: true });
    expect(k('ㅎ', { code: 'KeyG' })).toEqual({ toggle: 'grid' });
    expect(k('g', { metaKey: true, ctrlKey: false })).toEqual({ toggle: 'grid' });
    expect(k('g', { shiftKey: true })).toBeNull();
    expect(k('z')).toBeNull();
    expect(k('g', { ctrlKey: false })).toBeNull();
  });

  it('누른 곳: 그립 > 선택한 객체(끌어 옮기기) > 그 밖(창), 미리보기는 옮기기만', () => {
    const sel = new Set(['A']);
    expect(pressKind({ onGrip: true, hit: 'A', selected: sel, busy: false })).toBe('grip');
    expect(pressKind({ onGrip: false, hit: 'A', selected: sel, busy: false })).toBe('move');
    expect(pressKind({ onGrip: false, hit: 'B', selected: sel, busy: false })).toBe('window');
    expect(pressKind({ onGrip: false, hit: null, selected: sel, busy: false })).toBe('window');
    expect(pressKind({ onGrip: false, hit: 'A', selected: sel, busy: true })).toBe('window');
    const g = new DragGhost([{ segs: [0, 0, 1, 1], tris: [0, 0, 1, 0, 0, 1] }]);
    expect(g.at(2, 3)).toEqual([{ segs: [2, 3, 3, 4], tris: [2, 3, 3, 3, 2, 4] }]);
  });
});
