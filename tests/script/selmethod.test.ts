import { describe, expect, it } from 'vitest';
import type { Entity } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { registerDrawCommands } from '../../src/app/draw';
import { fenceHits, pointInPolygon, polygonHits, polygonWouldCross } from '../../src/edit/geom/selpoly';
import { makeScriptApp, type ScriptApp } from './app';

const line = (x0: number, y0: number, x1: number, y1: number) => ({ ...entityDefaults(), type: 'LINE', handle: '', start: { x: x0, y: y0, z: 0 }, end: { x: x1, y: y1, z: 0 } }) as Entity;

/** 선분 형상(화면 형상 흉내) */
function scene(lines: [number, number, number, number][]) {
  const boxes = lines.map(([a, b, c, d], i) => ({ handle: `L${i}`, minX: Math.min(a, c), minY: Math.min(b, d), maxX: Math.max(a, c), maxY: Math.max(b, d) }));
  const geom = (h: string) => ({ segs: [...lines[Number(h.slice(1))]!] });
  return { boxes, geom };
}

const SQUARE = [
  { x: 0, y: 0 },
  { x: 50, y: 0 },
  { x: 50, y: 50 },
  { x: 0, y: 50 },
];
/** L자 오목 다각형 */
const ELL = [
  { x: 0, y: 0 },
  { x: 40, y: 0 },
  { x: 40, y: 20 },
  { x: 20, y: 20 },
  { x: 20, y: 40 },
  { x: 0, y: 40 },
];

describe('선택 기하(WP·CP·F)', () => {
  const { boxes, geom } = scene([
    [10, 10, 20, 10], // L0: 안
    [10, 30, 60, 30], // L1: 변을 가로지름
    [100, 100, 110, 100], // L2: 밖
    [-10, -10, 70, 70], // L3: 다각형을 관통(끝점은 모두 밖)
  ]);

  it('윈도우 폴리곤은 완전히 안, 걸침 폴리곤은 안이거나 변과 만나는 객체', () => {
    expect(polygonHits(boxes, geom, SQUARE, false)).toEqual(['L0']);
    expect(polygonHits(boxes, geom, SQUARE, true)).toEqual(['L0', 'L1', 'L3']);
    expect(polygonHits(boxes, geom, SQUARE.slice(0, 2), true)).toEqual([]);
  });

  it('오목 다각형: 두 끝점이 안이어도 홈을 지나가면 윈도우 폴리곤에서 빠진다', () => {
    const s = scene([
      [15, 35, 35, 15], // 홈(20<x,20<y)을 지난다
      [5, 25, 30, 5], // 홈을 지나지 않는다
    ]);
    expect(polygonHits(s.boxes, s.geom, ELL, false)).toEqual(['L1']);
    expect(polygonHits(s.boxes, s.geom, ELL, true)).toEqual(['L0', 'L1']);
    expect(pointInPolygon(30, 30, ELL)).toBe(false);
    expect(pointInPolygon(10, 30, ELL)).toBe(true);
  });

  it('울타리는 꺾은선과 만나는 객체', () => {
    expect(fenceHits(boxes, geom, [{ x: 15, y: 0 }, { x: 15, y: 40 }])).toEqual(['L0', 'L1', 'L3']);
    expect(fenceHits(boxes, geom, [{ x: 15, y: 0 }, { x: 15, y: 5 }, { x: 105, y: 5 }, { x: 105, y: 120 }])).toEqual(['L2']);
    expect(fenceHits(boxes, geom, [{ x: 15, y: 0 }])).toEqual([]);
  });

  it('새 점이 폴리곤 변을 교차시키면 알아챈다', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(polygonWouldCross(pts, { x: 0, y: 10 })).toBe(false);
    // 나비 모양
    expect(polygonWouldCross([pts[0]!, pts[1]!, { x: 0, y: 10 }], { x: 10, y: 10 })).toBe(true);
  });
});

function setup(): ScriptApp {
  const h = makeScriptApp();
  registerDrawCommands(h.app);
  h.add(line(10, 10, 20, 10));
  h.add(line(10, 30, 60, 30));
  h.add(line(100, 100, 110, 100));
  return h;
}

const lines = (h: ScriptApp) => h.model('LINE').map((l) => [l.start.x, l.start.y]);

describe('스크립트의 WP·CP·F 선택', () => {
  it('WP: 다각형 안의 선만 지운다(빈 줄로 점 입력을 마친다)', async () => {
    const h = setup();
    expect(await h.script('ERASE\nWP\n0,0\n50,0\n50,50\n0,50\n\n\n')).toBe('idle');
    expect(h.errors()).toEqual([]);
    expect(lines(h)).toEqual([
      [10, 30],
      [100, 100],
    ]);
    expect(h.out()).toContain('첫 번째 폴리곤 점: 0,0');
    expect(h.out()).toContain('선의 끝점 지정 또는 [명령 취소(U)]: 50,0');
    expect(h.out()).toContain('1개를 찾음');
  });

  it('CP(U로 마지막 점 지우기)와 F', async () => {
    const h = setup();
    expect(await h.script('ERASE CP 0,0 50,0 99,99 U 50,50 0,50\n\n\n')).toBe('idle');
    expect(h.errors()).toEqual([]);
    expect(lines(h)).toEqual([[100, 100]]);
    const g = setup();
    expect(await g.script('ERASE F 105,90 105,120\n\n\n')).toBe('idle');
    expect(lines(g)).toEqual([
      [10, 10],
      [10, 30],
    ]);
  });

  it('교차하는 폴리곤 점은 줄 번호와 함께 멈춘다', async () => {
    const h = setup();
    expect(await h.script('ERASE WP 0,0 50,0 0,50 50,50\n\n')).toBe('paused');
    expect(h.errors().join('\n')).toContain('폴리곤의 변은 서로 교차할 수 없습니다');
  });
});

describe('명령의 객체 선택 프롬프트에서 WP·CP·F(App 대화)', () => {
  it('키워드로 고르고 점을 차례로 받는다', async () => {
    const h = setup();
    void h.app.run('ERASE');
    const type = (t: string) => h.app.submitInput(t);
    await Promise.resolve();
    type('WP');
    await Promise.resolve();
    expect(h.prompts[h.prompts.length - 1]).toBe('첫 번째 폴리곤 점:');
    for (const p of ['0,0', '50,0', '50,50', '0,50']) {
      type(p);
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(h.prompts[h.prompts.length - 1]).toBe('선의 끝점 지정 또는 [명령 취소(U)]:');
    type('');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(h.out()).toContain('1개를 찾음');
    type('F');
    for (let i = 0; i < 3; i++) await Promise.resolve();
    type('105,90');
    for (let i = 0; i < 3; i++) await Promise.resolve();
    expect(h.prompts[h.prompts.length - 1]).toBe('다음 울타리 점 지정 또는 [명령 취소(U)]:');
    type('105,120');
    for (let i = 0; i < 3; i++) await Promise.resolve();
    type('');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    type('');
    await new Promise((r) => setTimeout(r, 0));
    expect(lines(h)).toEqual([[10, 30]]);
  });
});
