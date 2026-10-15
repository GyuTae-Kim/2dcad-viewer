import { describe, expect, it } from 'vitest';
import { parseGcode } from '../../src/formats/nc/gcode';
import {
  FLAG_COMP_LEFT,
  FLAG_COMP_RIGHT,
  FLAG_MACHINE,
  MOVE_ARC,
  MOVE_DRILL,
  MOVE_FEED,
  MOVE_RAPID,
  moveEnd,
  moveStart,
  type NcProgram,
} from '../../src/formats/nc/model';
import { sourceLine } from '../../src/formats/nc/text';

/** 이동 끝점 목록(소수 3자리) */
function ends(p: NcProgram): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < p.moves.count; i++) out.push(moveEnd(p.moves, i).map((v) => Math.round(v * 1000) / 1000));
  return out;
}
const kinds = (p: NcProgram): number[] => Array.from(p.moves.kind);
const lines = (p: NcProgram): number[] => Array.from(p.moves.line);
const deg = (r: number): number => Math.round((r * 180) / Math.PI * 1000) / 1000;
/** 시작 위치를 알려 준 채로 해석 */
const run = (text: string, opts = {}): NcProgram => parseGcode(text, { initialPosition: [0, 0, 0], ...opts });

describe('블록 읽기', () => {
  it('N 번호·주석·대소문자·공백 없는 꼴', () => {
    const p = run(`%
O0100 (PART A)
N10 g90 g21 (comment G1 X99)
N20 G01X10Y5F100 ; 끝 주석 X50
n30 x 20 y -5.5
%`);
    expect(p.name).toBe('PART A');
    expect(ends(p)).toEqual([
      [10, 5, 0],
      [20, -5.5, 0],
    ]);
    expect(kinds(p)).toEqual([MOVE_FEED, MOVE_FEED]);
    expect(lines(p)).toEqual([3, 4]);
    expect(sourceLine(p.source, 3)).toContain('G01X10Y5F100');
    expect(p.warnings).toEqual([]);
  });

  it('% 두 번째에서 끝, M30 뒤는 실행하지 않음', () => {
    const p = run(`%
G1 X1 F100
M30
G1 X2
%
G1 X3`);
    expect(ends(p)).toEqual([[1, 0, 0]]);
  });

  it('블록 건너뛰기 / — 기본은 실행, 선택하면 건너뜀', () => {
    const text = `G1 X1 F100
/G1 X2
G1 X3`;
    expect(ends(run(text)).map((e) => e[0])).toEqual([1, 2, 3]);
    expect(ends(run(text, { blockDelete: true })).map((e) => e[0])).toEqual([1, 3]);
  });

  it('CRLF·CR 줄바꿈과 : 프로그램 번호', () => {
    const p = run(':1234\r\nG1 X1 F10\r\nG1 Y1\r\n');
    expect(ends(p)).toEqual([
      [1, 0, 0],
      [1, 1, 0],
    ]);
    const q = run('G1 X1 F10\rG1 Y1\r');
    expect(q.moves.count).toBe(2);
  });

  it('괄호가 든 주석·번호 붙은 블록 건너뛰기(/3)·단위 코드 없음 경고', () => {
    const p = run(`($Message("hello (x)") )
G1 X1 F100 (a (b) c)
/3 G1 X2
G1 X3`);
    expect(ends(p).map((e) => e[0])).toEqual([1, 2, 3]);
    expect(p.warnings).toEqual(['단위 코드(G20/G21)가 없어 mm로 봄']);
    expect(ends(run(`G1 X1 F100\n/3 G1 X2\nG1 X3`, { blockDelete: true })).map((e) => e[0])).toEqual([1, 3]);
  });

  it('공구 주석 여러 꼴', async () => {
    const { toolInfoFromComment } = await import('../../src/formats/nc/model');
    expect(toolInfoFromComment('T13 : 3.0', 'mm')).toEqual({ diameter: 3 });
    expect(toolInfoFromComment('T47 LTR. M [.295"] DRILL', 'inch')).toEqual({ diameter: 0.295, name: 'LTR. M [.295"] DRILL' });
    expect(toolInfoFromComment('TOOL 2 - 1/4" END MILL', 'mm')).toMatchObject({ diameter: 6.35 });
    expect(toolInfoFromComment('6mm FLAT ENDMILL', 'inch').diameter).toBeCloseTo(6 / 25.4);
    expect(toolInfoFromComment('T1 D=10. CR=0.5 - ZMIN=-12. - BULLNOSE', 'mm')).toEqual({ diameter: 10, name: 'BULLNOSE' });
  });

  it('읽을 수 없는 블록은 경고하고 넘어감', () => {
    const p = run(`G1 X1 F100
G1 X[1+
G1 X2`);
    expect(ends(p).map((e) => e[0])).toEqual([1, 2]);
    expect(p.warnings.some((w) => w.startsWith('2번 줄'))).toBe(true);
  });
});

describe('모달 상태', () => {
  it('G0/G1 모달·이송 F·급속', () => {
    const p = run(`G0 X10 Y10
Z-1
G1 Z-2 F200
X20
G0 Z5`);
    expect(kinds(p)).toEqual([MOVE_RAPID, MOVE_RAPID, MOVE_FEED, MOVE_FEED, MOVE_RAPID]);
    expect(Array.from(p.moves.feed)).toEqual([0, 0, 200, 200, 200]);
  });

  it('처음 위치를 모르면 첫 좌표부터 긋는다', () => {
    const p = parseGcode(`G0 X10 Y10
G0 Z5
G1 Z-1 F100`);
    expect(p.moves.count).toBe(1);
    expect(moveStart(p.moves, 0)).toEqual([10, 10, 5]);
    expect(moveEnd(p.moves, 0)).toEqual([10, 10, -1]);
  });

  it('G91 증분·G90 절대', () => {
    const p = run(`G91 G1 X10 F100
X10 Y5
G90 X0`);
    expect(ends(p)).toEqual([
      [10, 0, 0],
      [20, 5, 0],
      [0, 5, 0],
    ]);
  });

  it('단위: 처음 G20이면 inch, 중간 G21 값은 inch로 바꾼다', () => {
    const p = run(`G20 G1 X1 F10
G21 X50.8 F254`);
    expect(p.units).toBe('inch');
    expect(ends(p)).toEqual([
      [1, 0, 0],
      [2, 0, 0],
    ]);
    expect(p.moves.feed[1]).toBeCloseTo(10);
    const q = run(`G1 X10 F100`);
    expect(q.units).toBe('mm');
    const r = run(`G1 X1 F10`, { units: 'inch' });
    expect(r.units).toBe('inch');
  });

  it('공구 교환 T·M6, 주축 S·M3/M4/M5, 공구 주석', () => {
    const p = run(`(T1 D=6. CR=0. - FLAT END MILL)
(T2 D=3.175 - BALL)
T1 M6
S1000 M3
G1 X1 F100
T2
G1 X2
M6
M4 S500
G1 X3
M5
G1 X4`);
    expect(Array.from(p.moves.tool)).toEqual([1, 1, 2, 2]);
    expect(Array.from(p.moves.spindle)).toEqual([1000, 1000, -500, 0]);
    expect(p.tools.map((t) => [t.number, t.diameter, t.name])).toEqual([
      [1, 6, 'FLAT END MILL'],
      [2, 3.175, 'BALL'],
    ]);
    expect(p.stats.toolChanges).toBe(2);
  });

  it('M6가 없는 프로그램은 T만으로 공구가 바뀐다', () => {
    const p = run(`T3
G1 X1 F10
T4
G1 X2`);
    expect(Array.from(p.moves.tool)).toEqual([3, 4]);
  });

  it('반경 보정 G41/G42/G40은 상태만 기록(경로는 그대로)', () => {
    const p = run(`G1 G41 D1 X10 F100
G42 X20
G40 X30`);
    expect(ends(p).map((e) => e[0])).toEqual([10, 20, 30]);
    expect(Array.from(p.moves.flags).map((f) => f & 3)).toEqual([FLAG_COMP_LEFT, FLAG_COMP_RIGHT, 0]);
  });

  it('작업 좌표계: G10 L2로 정한 값은 반영, 모르면 경고', () => {
    const p = run(`G10 L2 P2 X100 Y0 Z0
G54 G1 X1 F100
G55 X1
G56 X1`);
    expect(ends(p).map((e) => e[0])).toEqual([1, 101, 1]);
    expect(Array.from(p.moves.wcs)).toEqual([0, 1, 2]);
    expect(p.warnings.some((w) => w.includes('G56'))).toBe(true);
  });

  it('G92 좌표 이동과 G53 기계 좌표', () => {
    const p = run(`G1 X10 F100
G92 X0
G1 X5
G92.1
G1 X5
G53 G0 Z50`);
    expect(ends(p).map((e) => e[0])).toEqual([10, 15, 5, 5]);
    expect(p.moves.flags[3]! & FLAG_MACHINE).toBe(FLAG_MACHINE);
  });

  it('G28은 중간점까지, 기준점을 주면 거기까지', () => {
    const p = run(`G1 X10 Z-1 F100
G91 G28 Z5
G90`);
    expect(ends(p)).toEqual([
      [10, 0, -1],
      [10, 0, 4],
    ]);
    expect(p.warnings.some((w) => w.includes('G28'))).toBe(true);
    const q = run(`G1 X10 F100
G28 X10`, { homePosition: [0, 0, 100] });
    expect(ends(q)).toEqual([
      [10, 0, 0],
      [0, 0, 0],
    ]);
  });

  it('G4 휴지: Fanuc P는 ms, LinuxCNC P는 초', () => {
    expect(run(`G1 X1 F60\nG4 P2000`, { dialect: 'fanuc' }).stats.dwellTime).toBeCloseTo(2);
    expect(run(`G1 X1 F60\nG4 P2.5`, { dialect: 'fanuc' }).stats.dwellTime).toBeCloseTo(2.5);
    expect(run(`G1 X1 F60\nG4 P2`, { dialect: 'linuxcnc' }).stats.dwellTime).toBeCloseTo(2);
    expect(run(`G1 X1 F60\nG4 X1.5`, { dialect: 'fanuc' }).stats.dwellTime).toBeCloseTo(1.5);
  });

  it('통계: 길이·시간(급속 속도 옵션)', () => {
    const p = run(`G0 X100
G1 Y60 F600`, { rapidFeed: 6000 });
    expect(p.stats.rapidLength).toBeCloseTo(100);
    expect(p.stats.feedLength).toBeCloseTo(60);
    expect(p.stats.rapidTime).toBeCloseTo(1);
    expect(p.stats.feedTime).toBeCloseTo(6);
    expect(p.stats.time).toBeCloseTo(7);
    expect(p.moves.time[0]).toBeCloseTo(1);
    expect(p.bounds).toEqual({ min: [0, 0, 0], max: [100, 60, 0] });
    expect(p.feedBounds).toEqual({ min: [100, 0, 0], max: [100, 60, 0] });
  });
});

describe('원호', () => {
  it('IJK 시계·반시계 사분원', () => {
    const p = run(`G1 X10 F100
G3 X0 Y10 I-10 J0
G2 X10 Y0 I0 J-10`);
    expect(kinds(p)).toEqual([MOVE_FEED, MOVE_ARC, MOVE_ARC]);
    expect(Array.from(p.arcs.sweep).map(deg)).toEqual([90, -90]);
    expect(Array.from(p.arcs.center)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(p.moves.arc[1]).toBe(0);
    expect(p.moves.arc[0]).toBe(-1);
    // 사분원 길이
    expect(p.stats.feedLength).toBeCloseTo(10 + Math.PI * 10);
  });

  it('R 반지름: 양수는 짧은 호, 음수는 긴 호', () => {
    const p = run(`G1 X10 F100
G2 X0 Y10 R10
G0 X10 Y0
G2 X0 Y10 R-10`);
    const sw = Array.from(p.arcs.sweep).map(deg);
    expect(sw).toEqual([-90, -270]);
    // 짧은 호(시계, R+): 중심 (10,10), 긴 호(R-): 중심 (0,0)
    expect(Array.from(p.arcs.center).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([10, 10, 0, 0, 0, 0]);
  });

  it('R 중심 위치', () => {
    const p = run(`G1 X10 F100
G3 X0 Y10 R10`);
    expect(Array.from(p.arcs.center.slice(0, 2)).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 0]);
    expect(deg(p.arcs.sweep[0]!)).toBe(90);
  });

  it('완전한 원(시작 = 끝)', () => {
    const p = run(`G1 X10 F100
G2 X10 Y0 I-10 J0`);
    expect(deg(p.arcs.sweep[0]!)).toBe(-360);
    expect(p.bounds!.min[1]).toBeCloseTo(-10);
    expect(p.bounds!.max[1]).toBeCloseTo(10);
    expect(p.bounds!.min[0]).toBeCloseTo(-10);
  });

  it('나선: 원호 중에 Z가 바뀜, LinuxCNC P 바퀴 수', () => {
    const p = run(`G1 X10 F100
G3 X10 Y0 Z-6 I-10 J0 P3`, { dialect: 'linuxcnc' });
    expect(deg(p.arcs.sweep[0]!)).toBe(1080);
    expect(moveEnd(p.moves, 1)).toEqual([10, 0, -6]);
    expect(p.stats.feedLength).toBeCloseTo(10 + Math.hypot(2 * Math.PI * 10 * 3, 6));
  });

  it('평면 G18(ZX)·G19(YZ)', () => {
    // G18: 법선 +Y. G3(반시계)는 Z→X 방향으로 돈다
    const p = run(`G1 X10 F100
G18 G3 X0 Z10 I-10 K0`);
    expect(p.arcs.plane[0]).toBe(1);
    // Z축이 첫 축: 시작 (z=0, x=10) 각 90°, 끝 (z=10, x=0) 각 0° → 반시계면 -90 + 360 = 270
    expect(deg(p.arcs.sweep[0]!)).toBe(270);
    const q = run(`G1 Y10 F100
G19 G2 Y0 Z10 J-10 K0`);
    expect(q.arcs.plane[0]).toBe(2);
    // YZ: 시작 (y=10, z=0) 각 0°, 끝 (0,10) 각 90°, 시계 → -270
    expect(deg(q.arcs.sweep[0]!)).toBe(-270);
  });

  it('G90.1 호 중심 절대', () => {
    const p = run(`G1 X20 Y10 F100
G90.1 G3 X10 Y20 I10 J10`);
    expect(Array.from(p.arcs.center.slice(0, 2))).toEqual([10, 10]);
    expect(deg(p.arcs.sweep[0]!)).toBe(90);
    const q = run(`G1 X20 Y10 F100
G3 X10 Y20 I10 J10`, { arcCenterAbsolute: true });
    expect(Array.from(q.arcs.center.slice(0, 2))).toEqual([10, 10]);
  });

  it('반지름이 맞지 않는 호는 경고', () => {
    const p = run(`G1 X10 F100
G3 X0 Y12 I-10 J0`);
    expect(p.warnings.some((w) => w.includes('반지름'))).toBe(true);
  });
});

describe('고정 사이클', () => {
  it('G81 + G98(처음 높이로) / G99(R로)', () => {
    const p = run(`G0 Z10
G98 G81 X10 Y10 Z-5 R2 F100
X20
G80
G99 G81 X30 Y30 Z-5 R2
X40
G80`);
    expect(p.holes.count).toBe(4);
    expect(Array.from(p.holes.top)).toEqual([10, 10, 2, 20, 10, 2, 30, 30, 2, 40, 30, 2]);
    expect(Array.from(p.holes.bottom.filter((_, i) => i % 3 === 2))).toEqual([-5, -5, -5, -5]);
    expect(Array.from(p.holes.cycle)).toEqual([81, 81, 81, 81]);
    // 첫 구멍: 급속 XY → 급속 R → 드릴 → 급속 처음 높이(10)
    expect(ends(p).slice(1, 5)).toEqual([
      [10, 10, 10],
      [10, 10, 2],
      [10, 10, -5],
      [10, 10, 10],
    ]);
    expect(kinds(p).slice(1, 5)).toEqual([MOVE_RAPID, MOVE_RAPID, MOVE_DRILL, MOVE_RAPID]);
    // G99 구멍은 R(2)로 돌아온다
    const last = ends(p).at(-1)!;
    expect(last).toEqual([40, 30, 2]);
    expect(p.moves.line[p.holes.move[1]!]).toBe(2);
  });

  it('G83 펙: Q씩 내려가고 R로 물러났다 다시 들어감', () => {
    const p = run(`G0 Z5
G99 G83 X0 Y0 Z-10 R1 Q4 F100`);
    const z = ends(p).map((e) => e[2]);
    // R(1) → -3 → R → -2.5(틈 0.5) → -7 → R → -6.5 → -10 → R
    expect(z).toEqual([5, 1, -3, 1, -2.5, -7, 1, -6.5, -10, 1]);
    expect(kinds(p).filter((k) => k === MOVE_DRILL).length).toBe(3);
  });

  it('G73: 조금씩 물러나며 내려감', () => {
    const p = run(`G0 Z5
G98 G73 X0 Y0 Z-6 R1 Q3 F100`);
    const z = ends(p).map((e) => e[2]);
    expect(z).toEqual([5, 1, -2, -1.5, -5, -4.5, -6, 5]);
  });

  it('G85: 내려갈 때와 나올 때 모두 이송, G82 휴지', () => {
    const p = run(`G0 Z5
G99 G85 X0 Y0 Z-4 R1 F100
G80
G99 G82 X5 Z-4 R1 P500`, { dialect: 'fanuc' });
    expect(kinds(p).slice(1, 4)).toEqual([MOVE_RAPID, MOVE_DRILL, MOVE_FEED]);
    expect(p.stats.dwellTime).toBeCloseTo(0.5);
  });

  it('G91 증분 사이클과 L 반복', () => {
    const p = run(`G0 X0 Y0 Z10
G91 G99 G81 X10 Z-5 R-8 L3 F100
G90 G80`);
    // R은 처음 높이(10)에서 -8 → 2, 바닥은 R에서 -5 → -3
    expect(Array.from(p.holes.top)).toEqual([10, 0, 2, 20, 0, 2, 30, 0, 2]);
    expect(Array.from(p.holes.bottom)).toEqual([10, 0, -3, 20, 0, -3, 30, 0, -3]);
  });

  it('사이클 Z·R은 모달, G0/G1이 사이클을 끝냄', () => {
    const p = run(`G0 Z5
G81 X1 Y1 Z-2 R1 F50
X2 Y2
G0 X10 Y10
G1 X11 F100`);
    expect(p.holes.count).toBe(2);
    expect(ends(p).at(-1)).toEqual([11, 10, 5]);
  });
});

describe('화면 패널 도움', () => {
  it('줄 → 이동(부프로그램은 한 줄이 여러 이동), 누적 시간, 시각 → 이동', async () => {
    const { ncLineMoves, ncTimeline, ncMoveAtTime, FLAG_COOLANT } = await import('../../src/formats/nc/model');
    const p = run(`G1 X10 F600 M8
M98 P2 L2
M9
G1 X0
M30
O2
G91 Y1
G90
M99`);
    const { offsets, moves } = ncLineMoves(p);
    const of = (l: number): number[] => Array.from(moves.slice(offsets[l]!, offsets[l + 1]!));
    expect(of(0)).toEqual([0]);
    expect(of(6)).toEqual([1, 2]);
    expect(of(3)).toEqual([3]);
    expect(of(1)).toEqual([]);
    const tl = ncTimeline(p);
    expect(tl[0]).toBeCloseTo(1);
    expect(tl[1]).toBeCloseTo(1.1);
    expect(ncMoveAtTime(tl, 0.5)).toBe(0);
    expect(ncMoveAtTime(tl, 1.05)).toBe(1);
    expect(ncMoveAtTime(tl, 99)).toBe(3);
    expect(Array.from(p.moves.flags).map((f) => (f & FLAG_COOLANT ? 1 : 0))).toEqual([1, 1, 1, 0]);
  });

  it('GRBL $ 명령은 조용히 넘긴다', () => {
    const p = run(`$H
$X
G21 G90
G1 X1 F100`, { dialect: 'grbl' });
    expect(p.moves.count).toBe(1);
    expect(p.warnings).toEqual([]);
  });
});

describe('Fanuc 고속 모드 코드', () => {
  it('G05.1 Q1·G08 P1·G187은 이동 모드를 바꾸지 않는다', () => {
    const p = run(`G21 G0 X0 Y0
G05.1 Q1
G08 P1
G187 P1
X10`, { dialect: 'fanuc' });
    expect(Array.from(p.moves.kind)).toEqual([MOVE_RAPID]);
    expect(p.warnings).toEqual([]);
  });
});
