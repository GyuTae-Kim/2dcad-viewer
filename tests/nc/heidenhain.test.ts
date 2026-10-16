import { describe, expect, it } from 'vitest';
import { parseHeidenhain } from '../../src/formats/nc/heidenhain';
import { MOVE_ARC, MOVE_DRILL, MOVE_FEED, MOVE_RAPID, moveEnd, type NcProgram } from '../../src/formats/nc/model';

const ends = (p: NcProgram): number[][] => {
  const out: number[][] = [];
  for (let i = 0; i < p.moves.count; i++) out.push(moveEnd(p.moves, i).map((v) => Math.round(v * 1000) / 1000));
  return out;
};
const deg = (r: number): number => Math.round(((r * 180) / Math.PI) * 1000) / 1000;

const PGM = `0 BEGIN PGM TEIL MM
1 BLK FORM 0.1 Z X+0 Y+0 Z-20
2 BLK FORM 0.2 X+100 Y+80 Z+0
3 TOOL DEF 5 L+0 R+4
4 TOOL CALL 5 Z S3000 F500
5 L Z+50 R0 FMAX M3
6 L X-10 Y-10 R0 FMAX
7 L Z-5 R0 F200
8 L X+0 Y+0 RL
9 L Y+50
10 CC X+20 Y+50
11 C X+40 Y+50 DR-
12 CR X+60 Y+50 R+10 DR+
13 CT X+80 Y+30
14 L IX+10 F AUTO
15 L Z+50 R0 FMAX
16 CYCL DEF 200 DRILLING ~
   Q200=+2 ;SET-UP CLEARANCE ~
   Q201=-15 ;DEPTH ~
   Q206=+150 ;FEED RATE FOR PLNGNG ~
   Q202=+5 ;PLUNGING DEPTH ~
   Q210=+0 ;DWELL TIME AT TOP ~
   Q203=+0 ;SURFACE COORDINATE ~
   Q204=+50 ;2ND SET-UP CLEARANCE ~
   Q211=+0 ;DWELL TIME AT DEPTH
17 L X+10 Y+10 R0 FMAX M99
18 L X+20 FMAX M99
19 CALL LBL 1
20 L Z+100 FMAX M30
21 LBL 1
22 CC X+50 Y+40
23 L X+60 Y+40 FMAX
24 L Z-2 F100
25 CP IPA+720 IZ-4 DR+
26 LP PR+5 PA+90 F100
27 L Z+50 FMAX
28 LBL 0
29 END PGM TEIL MM
`;

describe('Heidenhain 평문', () => {
  const p = parseHeidenhain(PGM);
  it('머리·공작물·공구', () => {
    expect(p.name).toBe('TEIL');
    expect(p.units).toBe('mm');
    expect(p.format).toBe('heidenhain');
    expect(p.dialect).toBe('heidenhain');
    expect(p.stock).toEqual({ min: [0, 0, -20], max: [100, 80, 0] });
    expect(p.tools.map((t) => [t.number, t.diameter])).toEqual([[5, 8]]);
    expect(p.warnings).toEqual([]);
  });
  it('L·FMAX(블록마다)·C·CR·CT·증분', () => {
    // 처음 두 급속은 시작 위치를 몰라 긋지 않는다
    const e = ends(p);
    expect(e.slice(0, 8)).toEqual([
      [-10, -10, -5],
      [0, 0, -5],
      [0, 50, -5],
      [40, 50, -5],
      [60, 50, -5],
      [80, 30, -5],
      [90, 30, -5],
      [90, 30, 50],
    ]);
    expect(Array.from(p.moves.kind.slice(0, 8))).toEqual([MOVE_FEED, MOVE_FEED, MOVE_FEED, MOVE_ARC, MOVE_ARC, MOVE_ARC, MOVE_FEED, MOVE_RAPID]);
    // C DR-: (0,50) → (40,50) 중심 (20,50) 시계 반원
    expect(deg(p.arcs.sweep[0]!)).toBe(-180);
    // CR R+10 DR+: 반원 반시계
    expect(deg(p.arcs.sweep[1]!)).toBe(180);
    // CT: 앞 호의 끝 접선(+Y)에 이어지는 호 — 중심 (80,50), 시계 270도
    expect(Array.from(p.arcs.center.slice(6, 8))).toEqual([80, 50]);
    expect(deg(p.arcs.sweep[2]!)).toBe(-270);
    // F AUTO = TOOL CALL F500
    expect(p.moves.feed[6]).toBe(500);
    expect(p.moves.feed[0]).toBe(200);
    // RL·R0 반경 보정 상태
    expect(p.moves.flags[1]! & 3).toBe(1);
    expect(p.moves.flags[0]! & 3).toBe(0);
  });
  it('CYCL DEF 200 + M99: 윗면부터 펙, 두 번째 안전 높이로', () => {
    expect(p.holes.count).toBe(2);
    expect(Array.from(p.holes.top)).toEqual([10, 10, 2, 20, 10, 2]);
    expect(Array.from(p.holes.bottom)).toEqual([10, 10, -15, 20, 10, -15]);
    const i0 = p.holes.move[0]!;
    const z = ends(p)
      .slice(i0 - 1, i0 + 8)
      .map((v) => v[2]);
    // R(2) → -5 → R → -4.5 → -10 → R → -9.5 → -15 → 50
    expect(z).toEqual([2, -5, 2, -4.5, -10, 2, -9.5, -15, 50]);
    expect(p.moves.kind[i0]).toBe(MOVE_DRILL);
    expect(p.moves.feed[i0]).toBe(150);
  });
  it('CALL LBL 부프로그램·CP 나선·LP 극좌표', () => {
    const n = p.moves.count;
    const e = ends(p);
    // 마지막 이동은 LBL 0에서 돌아온 뒤 20번 블록(Z+100)
    expect(e[n - 1]).toEqual([50, 45, 100]);
    expect(p.moves.line[n - 1]).toBe(28);
    // CP IPA+720 IZ-4: 두 바퀴 나선
    const cpArc = p.arcs.count - 1;
    expect(deg(p.arcs.sweep[cpArc]!)).toBe(720);
    // LP PR+5 PA+90 → 극 (50,40)에서 (50,45)
    expect(e[n - 3]).toEqual([50, 45, -6]);
  });
  it('구간 반복(CALL LBL REP)과 Q 변수·FN', () => {
    const q = parseHeidenhain(`0 BEGIN PGM R MM
1 TOOL CALL 1 Z S1000
2 Q1 = 0
3 L X+0 Y+0 Z+0 R0 FMAX
4 LBL 1
5 FN 1: Q1 = +Q1 + +10
6 L X+Q1 F100
7 CALL LBL 1 REP 2
8 FN 0: Q2 = +3
9 Q3 = Q2 * 2 + SQRT(16)
10 L Y+Q3
11 L Y-Q2
12 END PGM R MM`);
    expect(ends(q).map((v) => [v[0], v[1]])).toEqual([
      [10, 0],
      [20, 0],
      [30, 0],
      [30, 10],
      [30, -3],
    ]);
  });
  it('INCH 단위·모르는 블록 경고·RND 근사', () => {
    const q = parseHeidenhain(`0 BEGIN PGM X INCH
1 L X+1 Y+0 R0 FMAX
2 L X+2 F10
3 RND R0.1
4 L Y+1
5 PLANE SPATIAL SPA+0 SPB+45 SPC+0
6 END PGM X INCH`);
    expect(q.units).toBe('inch');
    expect(q.moves.count).toBe(2);
    expect(q.warnings.some((w) => w.includes('RND'))).toBe(true);
    expect(q.warnings.some((w) => w.includes('PLANE'))).toBe(true);
  });

  it('점 패턴 사이클 220(원)·221(격자), 이어 쓰기 줄 끝 주석, 번호만 있는 줄·좌표로 시작하는 블록', () => {
    const q = parseHeidenhain(`0 BEGIN PGM P MM
1
2 TOOL CALL 1 Z S2000 F100
3 CYCL DEF 200 BOHREN ~
    Q200=+2 ;SICHERHEITS-ABST. ~
    Q201=-5 ;TIEFE ~
    Q206=+100 ;VORSCHUB ~
    Q202=+5 ;ZUSTELL-TIEFE ~
    QS500="TEXT" ;GRAVIERTEXT ~
    Q203=+0 ;KOOR. OBERFLAECHE ~
    Q204=+20 ;2. SICHERHEITS-ABST.
4 CYCL DEF 221 MUSTER LINIEN ~
    Q225=+10 ;STARTPUNKT 1. ACHSE ~
    Q226=+5 ;STARTPUNKT 2. ACHSE ~
    Q237=+30 ;ABSTAND 1. ACHSE ~
    Q238=+20 ;ABSTAND 2. ACHSE ~
    Q242=+2 ;ANZAHL SPALTEN ~
    Q243=+2 ;ANZAHL ZEILEN ~
    Q224=+0 ;DREHLAGE
5 CYCL DEF 220 MUSTER KREIS ~
    Q216=+50 ;MITTE 1. ACHSE ~
    Q217=+50 ;MITTE 2. ACHSE ~
    Q244=+40 ;TEILKREIS-DURCHM. ~
    Q245=+0 ;STARTWINKEL ~
    Q246=+360 ;ENDWINKEL ~
    Q247=+0 ;WINKELSCHRITT ~
    Q241=+4 ;ANZAHL BEARBEITUNGEN
6 X+0 Y+0 FMAX
7 END PGM P MM`);
    expect(q.warnings).toEqual([]);
    const tops = [];
    for (let i = 0; i < q.holes.count; i++) tops.push([q.holes.top[i * 3]!, q.holes.top[i * 3 + 1]!].map((v) => Math.round(v * 1000) / 1000));
    expect(tops).toEqual([
      [10, 5],
      [40, 5],
      [10, 25],
      [40, 25],
      [70, 50],
      [50, 70],
      [30, 50],
      [50, 30],
    ]);
    expect(Array.from(q.holes.bottom.filter((_, i) => i % 3 === 2))).toEqual(Array(8).fill(-5));
    // 좌표로 시작하는 블록도 직선(마지막 이동)
    expect(moveEnd(q.moves, q.moves.count - 1).map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 0, 20]);
  });
});
