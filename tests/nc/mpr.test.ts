import { describe, expect, it } from 'vitest';
import { parseMpr, type MprBoxOp, type MprContourOp, type MprDrillOp } from '../../src/formats/nc/mpr';
import { mprToScene } from '../../src/formats/nc/scene';

// 손으로 만든 woodWOP 4.x 파일(판 600×400×19)
const MPR = `[H
VERSION="4.0 Alpha"
INCH="0"
VIEW="NOMIRROR"
_BSX=600.000000
_BSY=400.000000
_BSZ=19.000000

[001
L="600"
KM="Laenge"
B="400"
KM="Breite"
D="19"
KM="Dicke"
RAND="L/10-10"
KM="Rand"
LOCH="IF L>500 THEN 8 ELSE 5"
KM="Lochdurchmesser"

]1
$E0
KP
X=RAND
Y=RAND
Z=D
KO=00

$E1
KL
X=L-RAND
Y=RAND

$E2
KA
X=L-RAND+20
Y=RAND+20
DS=1
R=20

$E3
KL
X=L-RAND+20
Y=B-RAND

$E4
KA
X=L-RAND
Y=B-RAND+20
DS=0
R=20
.I=570.000000
.J=370.000000

]2
$E0
KP
X=100
Y=200
Z=0

$E1
KA
X=140
Y=200
DS=1
R=20

$E2
KA
X=100
Y=200
DS=0
I=120
J=200

<100 \\WerkStck\\
LA="L"
BR="B"
DI="D"

<101 \\Kommentar\\
KM="Testteil"
KM="zweite Zeile"

<102 \\BohrVert\\
XA="RAND"
YA="RAND"
BM="LS"
TI="12"
DU="LOCH"
AN="3"
AB="32"
WI="90"
MNM="Reihe"

<102 \\BohrVert\\
XA="300"
YA="200"
TI="25"
DU="35"
MNM="Topfband durch"

<102 \\BohrVert\\
XA="10"
YA="10"
TI="5"
DU="5"
??="L<100"

<102 \\BohrVert\\
XA="200"
YA="300"
TI="10"
DU="5"
AN="2"
AB="32"
MI="1"

<103 \\BohrHoriz\\
XA="0"
YA="100"
ZA="D/2"
DU="8"
TI="30"
BM="XP"

<103 \\BohrHoriz\\
XA="600"
YA="100"
ZA="9.5"
DU="8"
TI="30"
BM="XP"

<103 \\BohrHoriz\\
XA="100"
YA="400"
ZA="9.5"
DU="8"
TI="22"
BM="YM"
AN="2"
AB="32"

<105 \\Konturfraesen\\
EA="1:0"
EE="1:4"
RK="WRKL"
TNO="101"
F_="5"
ZA="5"

<105 \\Konturfraesen\\
EA="2:0"
EE="2:2"
RK="NOWRK"
TNO="102"
ZA="@2"

<105 \\Konturfraesen\\
EA="1:3"
EE="1:1"
TNO="101"
ZA="@0"

<109 \\Nuten\\
XA="0"
YA="200"
XE="L"
YE="200"
NB="4"
TI="8"

<109 \\Nuten\\
XA="0"
YA="300"
XE="L"
YE="300"
NB="4"
TI="8"
RK="WRKL"

<112 \\Tasche\\
XA="300"
YA="200"
LA="100"
BR="50"
TI="10"
WI="0"

<139 \\Komponente\\
IN="abc.mpr"
!
`;

const r1 = (v: number): number => Math.round(v * 1000) / 1000;

describe('MPR 해석', () => {
  const part = parseMpr(MPR, { name: 'test.mpr' });
  const ops = part.operations;
  const line = (prefix: string, nth = 0): number => {
    let k = 0;
    const ls = MPR.split('\n');
    for (let i = 0; i < ls.length; i++) if (ls[i]!.startsWith(prefix) && k++ === nth) return i;
    return -1;
  };

  it('머리·변수 식·공작물', () => {
    expect(part.version).toBe('4.0 Alpha');
    expect(part.units).toBe('mm');
    expect(part.variables.map((v) => [v.name, v.value, v.comment])).toEqual([
      ['L', 600, 'Laenge'],
      ['B', 400, 'Breite'],
      ['D', 19, 'Dicke'],
      ['RAND', 50, 'Rand'],
      ['LOCH', 8, 'Lochdurchmesser'],
    ]);
    expect(part.workpiece).toEqual({ length: 600, width: 400, thickness: 19, line: line('<100') });
    expect(part.name).toBe('test.mpr');
  });

  it('윤곽: KP·KL·KA(DS=1 반시계, DS=0 시계, R·I/J·.I/.J)', () => {
    const c1 = part.contours[0]!;
    expect(c1.id).toBe(1);
    expect(c1.elements.map((e) => [e.type, e.x, e.y, e.z])).toEqual([
      ['KP', 50, 50, 19],
      ['KL', 550, 50, 19],
      ['KA', 570, 70, 19],
      ['KL', 570, 350, 19],
      ['KA', 550, 370, 19],
    ]);
    const a = c1.elements[2]!;
    expect(a.dir).toBe('ccw');
    expect([r1(a.arc!.cx), r1(a.arc!.cy), r1((a.arc!.sweep * 180) / Math.PI)]).toEqual([550, 70, 90]);
    const b = c1.elements[4]!;
    expect(b.dir).toBe('cw');
    expect([r1(b.arc!.cx), r1(b.arc!.cy), r1((b.arc!.sweep * 180) / Math.PI)]).toEqual([570, 370, -90]);
    const c2 = part.contours[1]!;
    expect(c2.elements[1]!.arc).toMatchObject({ cx: 120, cy: 200 });
    expect(r1((c2.elements[1]!.arc!.sweep * 180) / Math.PI)).toBe(180);
    expect(r1((c2.elements[2]!.arc!.sweep * 180) / Math.PI)).toBe(-180);
    expect(c1.elements[2]!.line).toBe(line('$E2'));
  });

  it('수직 구멍: 줄·간격·각도·관통·가운데 맞춤', () => {
    const d = ops.filter((o) => o.kind === 'drillV') as MprDrillOp[];
    expect(d.length).toBe(4);
    expect(d[0]!.label).toBe('Reihe');
    expect(d[0]!.diameter).toBe(8);
    expect(d[0]!.holes.map((h) => h.start.map(r1))).toEqual([
      [50, 50, 19],
      [50, 82, 19],
      [50, 114, 19],
    ]);
    expect(d[0]!.holes[0]!.dir).toEqual([0, 0, -1]);
    expect(d[0]!.holes[0]!.depth).toBe(12);
    expect(d[0]!.line).toBe(line('<102'));
    expect(d[1]!.through).toBe(true);
    expect(d[1]!.holes[0]!.depth).toBe(19);
    expect(d[2]!.enabled).toBe(false);
    expect(d[3]!.holes.map((h) => h.start[0])).toEqual([184, 216]);
  });

  it('수평 구멍: 방향(BM)·판 밖이면 뒤집기·줄', () => {
    const h = ops.filter((o) => o.kind === 'drillH') as MprDrillOp[];
    expect(h[0]!.holes[0]).toEqual({ start: [0, 100, 9.5], dir: [1, 0, 0], depth: 30 });
    expect(h[1]!.holes[0]!.dir).toEqual([-1, 0, 0]);
    expect(part.warnings.some((w) => w.includes('BohrHoriz 방향'))).toBe(true);
    expect(h[2]!.holes.map((x) => x.start)).toEqual([
      [100, 400, 9.5],
      [132, 400, 9.5],
    ]);
    expect(h[2]!.holes[0]!.dir).toEqual([0, -1, 0]);
  });

  it('윤곽 가공: 요소 범위·깊이(ZA 수 = 윗면에서, @ = 윤곽 Z에서)·보정·거꾸로', () => {
    const k = ops.filter((o) => o.kind === 'contour') as MprContourOp[];
    expect(k[0]!.contour).toBe(1);
    expect(k[0]!.comp).toBe('left');
    expect(k[0]!.tool).toBe(101);
    expect(k[0]!.feed).toBe(5);
    expect(k[0]!.path!.map((p) => [p.x, p.y, p.z])).toEqual([
      [50, 50, 14],
      [550, 50, 14],
      [570, 70, 14],
      [570, 350, 14],
      [550, 370, 14],
    ]);
    expect(k[0]!.path![2]!.arc).toBeDefined();
    expect(k[1]!.path!.map((p) => p.z)).toEqual([-2, -2, -2]);
    expect(k[1]!.comp).toBe('none');
    // 3 → 1 거꾸로: 호(요소 2)는 끝점이 요소 1 쪽으로, 각은 반대
    const rev = k[2]!.path!;
    expect(rev.map((p) => [p.x, p.y])).toEqual([
      [570, 350],
      [570, 70],
      [550, 50],
    ]);
    expect(rev[1]!.arc).toBeUndefined();
    expect(r1((rev[2]!.arc!.sweep * 180) / Math.PI)).toBe(-90);
  });

  it('홈·포켓 상자', () => {
    const g = ops.filter((o) => o.kind === 'groove') as MprBoxOp[];
    expect(g[0]!.box).toEqual({ origin: [0, 198, 11], u: [600, 0, 0], v: [-0, 4, 0], w: [0, 0, 8] });
    expect(g[1]!.box!.origin).toEqual([0, 300, 11]);
    const t = ops.find((o) => o.kind === 'pocket') as MprBoxOp;
    expect(t.box!.origin.map(r1)).toEqual([250, 175, 9]);
    expect(t.box!.u.map(r1)).toEqual([100, 0, 0]);
    expect(t.box!.v.map(r1)).toEqual([-0, 50, 0]);
  });

  it('주석·모르는 매크로·통계', () => {
    expect(ops[0]!.kind).toBe('comment');
    expect(ops[0]!.label).toBe('Testteil zweite Zeile');
    const other = ops.find((o) => o.kind === 'other')!;
    expect(other.macro).toBe('Komponente');
    expect(other.macroId).toBe(139);
    expect(part.warnings.some((w) => w.includes('Komponente'))).toBe(true);
    expect(part.stats).toEqual({ holes: 3 + 1 + 2 + 1 + 1 + 2, drillOps: 6, contourOps: 3, grooves: 2, pockets: 1, disabled: 1, other: 1 });
  });

  it('인치 머리·WerkStck 없으면 _BS 값·끝 표시 없음 경고', () => {
    const p = parseMpr(`[H\nVERSION="4.0 Alpha"\nINCH="1"\n_BSX=10\n_BSY=8\n_BSZ=0.75\n`);
    expect(p.units).toBe('inch');
    expect(p.workpiece).toEqual({ length: 10, width: 8, thickness: 0.75, line: -1 });
    expect(p.warnings.some((w) => w.includes('!'))).toBe(true);
  });

  it('계산할 수 없는 식은 경고', () => {
    const p = parseMpr(`[H\nVERSION="4.0"\n[001\nA="B*2"\nKM="x"\n<100 \\WerkStck\\\nLA="100"\nBR="50"\nDI="10"\n!\n`);
    expect(p.variables[0]!.value).toBeUndefined();
    expect(p.warnings.some((w) => w.includes('변수 A'))).toBe(true);
  });

  it('windows-1252 바이트(움라우트)', () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('[H\nVERSION="4.0"\n[001\nL="1"\nKM="L'), 0xe4, ...new TextEncoder().encode('nge"\n!\n')]);
    const p = parseMpr(bytes);
    expect(p.variables[0]!.comment).toBe('Länge');
  });
});

describe('MPR 장면', () => {
  const part = parseMpr(MPR);
  const s = mprToScene(part);
  it('판·구멍 원기둥·홈·포켓 그물, 윤곽 가공 선', () => {
    const ids = s.meshes.map((m) => m.id);
    expect(ids[0]).toBe('mpr-board');
    expect(s.meshes[0]!.group).toBe('공작물');
    expect(s.meshes[0]!.color[3]).toBeLessThan(1);
    // 켜진 구멍 가공 6개 + 홈 2 + 포켓 1
    expect(s.meshes.filter((m) => m.group === '수직 구멍').length).toBe(3);
    expect(s.meshes.filter((m) => m.group === '수평 구멍').length).toBe(3);
    expect(s.meshes.filter((m) => m.group === '홈').length).toBe(2);
    expect(s.meshes.filter((m) => m.group === '포켓').length).toBe(1);
    // 꺼진 가공(op 3)은 없다
    expect(ids).not.toContain('mpr-op-3');
    const contourLines = s.lines.filter((l) => l.group === '윤곽 가공');
    expect(contourLines.length).toBe(3);
    // 모든 선분 id = 가공 번호
    for (const l of contourLines) expect(new Set(l.segmentIds)).toEqual(new Set([Number(l.id.slice(7))]));
    // 첫 윤곽: 직선 2 + 호 2(각 90도/5도 = 18) + 깊이선 1
    expect(contourLines[0]!.positions.length / 6).toBe(2 + 18 + 18 + 1);
    expect(s.points![0]!.positions.length / 3).toBe(3 + 1 + 2 + 1 + 1 + 2);
    expect(s.bounds!.min).toEqual([0, 0, -2]);
    expect(s.bounds!.max[0]).toBe(600);
    const meta = s.meta as { kind: string; operations: { kind: string }[]; workpiece: unknown };
    expect(meta.kind).toBe('mpr');
    expect(meta.operations.length).toBe(part.operations.length);
    expect(meta.workpiece).toEqual(part.workpiece);
  });
  it('원기둥 그물 크기·법선', () => {
    const m = s.meshes.find((x) => x.id === 'mpr-op-2')!; // 지름 35 관통
    const pos = m.positions;
    let minZ = Infinity;
    let maxR = 0;
    for (let i = 0; i < pos.length; i += 3) {
      minZ = Math.min(minZ, pos[i + 2]!);
      maxR = Math.max(maxR, Math.hypot(pos[i]! - 300, pos[i + 1]! - 200));
    }
    expect(minZ).toBeCloseTo(0);
    expect(maxR).toBeCloseTo(17.5, 4);
    expect(m.normals!.length).toBe(pos.length);
    expect(m.indices!.length % 3).toBe(0);
  });
  it('꺼진 가공도 그리기 선택', () => {
    const s2 = mprToScene(part, { disabled: true });
    expect(s2.meshes.find((m) => m.id === 'mpr-op-3')!.group).toBe('꺼진 가공');
  });
});
