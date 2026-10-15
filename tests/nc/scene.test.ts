import { describe, expect, it } from 'vitest';
import { detectNcFormat, loadNcFile, parseNcFile } from '../../src/formats/nc';
import { parseGcode } from '../../src/formats/nc/gcode';
import { MOVE_ARC } from '../../src/formats/nc/model';
import { TOOL_COLORS } from '../../src/formats/nc/mesh';
import { ncToScene } from '../../src/formats/nc/scene';
import { guessEncoding, makeSource, sourceLine, splitLines } from '../../src/formats/nc/text';

const PROG = `G21 G90 G17
(T1 D=6 FLAT)
(T2 D=5 DRILL)
T1 M6 S1000 M3
G0 X0 Y0 Z5
G1 Z-1 F100
G1 X10
G3 X10 Y0 I-5 J0
G0 Z5
T2 M6
G81 X20 Y20 Z-5 R1 F50
G80
M30`;

describe('NC 장면', () => {
  const p = parseGcode(PROG, { initialPosition: [0, 0, 10] });
  const s = ncToScene(p);
  const byId = (id: string) => s.lines.find((l) => l.id === id)!;

  it('급속은 점선 한 묶음, segmentIds = 이동 번호', () => {
    expect(p.moves.count).toBe(9);
    const r = byId('nc-rapid');
    expect(r.dashed).toBe(true);
    expect(Array.from(r.segmentIds!)).toEqual([0, 4, 5, 6, 8]);
    expect(r.positions.length).toBe(5 * 6);
    expect(Array.from(r.positions.slice(0, 6))).toEqual([0, 0, 10, 0, 0, 5]);
  });

  it('이송·호는 공구별 묶음(색), 호는 5도로 나눔', () => {
    const c = byId('nc-cut-1');
    expect(p.moves.kind[3]).toBe(MOVE_ARC);
    expect(c.positions.length / 6).toBe(2 + 72);
    const ids = Array.from(c.segmentIds!);
    expect(ids.slice(0, 3)).toEqual([1, 2, 3]);
    expect(ids.filter((i) => i === 3).length).toBe(72);
    expect(c.color).toEqual(TOOL_COLORS[0]);
    expect(c.group).toBe('T1');
    // 호 선분은 끝과 끝이 이어지고 원 위에 있다
    for (let k = 2; k < 74; k++) {
      const o = k * 6;
      expect(Math.hypot(c.positions[o]! - 5, c.positions[o + 1]!)).toBeCloseTo(5, 4);
      if (k > 2) expect(c.positions[o]).toBe(c.positions[o - 3]);
    }
  });

  it('드릴은 굵은 선 + 구멍 점(pointIds = 이동 번호)', () => {
    const d = byId('nc-drill-2');
    expect(Array.from(d.segmentIds!)).toEqual([7]);
    expect(Array.from(d.positions)).toEqual([20, 20, 1, 20, 20, -5]);
    expect(d.color).toEqual(TOOL_COLORS[1]);
    const h = s.points![0]!;
    expect(Array.from(h.positions)).toEqual([20, 20, 1]);
    expect(Array.from(h.pointIds!)).toEqual([7]);
  });

  it('범위·meta', () => {
    expect(s.bounds).toEqual({ min: [0, -5, -5], max: [20, 20, 10] });
    expect(s.units).toBe('mm');
    const meta = s.meta as Record<string, unknown> & { tools: { number: number; diameter: number; name: string; color: unknown }[]; moveLine: Uint32Array };
    expect(meta.kind).toBe('nc');
    expect(meta.moveLine).toBe(p.moves.line);
    expect(meta.tools.map((t) => [t.number, t.diameter, t.name])).toEqual([
      [1, 6, 'FLAT'],
      [2, 5, 'DRILL'],
    ]);
    expect(meta.tools[1]!.color).toEqual(TOOL_COLORS[1]);
    expect(s.meshes).toEqual([]);
  });

  it('선택: 급속 빼기·이송 속도 색·각도·공작물', () => {
    const s2 = ncToScene(p, { rapids: false, colorBy: 'feed', arcAngle: Math.PI / 2, stock: 'auto' });
    expect(s2.lines.find((l) => l.id === 'nc-rapid')).toBeUndefined();
    const c = s2.lines.find((l) => l.id === 'nc-cut-1')!;
    expect(c.positions.length / 6).toBe(2 + 4);
    expect(c.colors!.length).toBe(6 * 8);
    expect(s2.meshes[0]!.id).toBe('nc-stock');
    expect(s2.meshes[0]!.group).toBe('공작물');
    expect(s2.meshes[0]!.color[3]).toBeLessThan(1);
    const s3 = ncToScene(p, { stock: { min: [-10, -10, -10], max: [30, 30, 0] } });
    expect(s3.bounds!.min).toEqual([-10, -10, -10]);
  });

  it('선분 예산을 넘으면 호를 크게 나눈다', () => {
    const s4 = ncToScene(p, { segmentBudget: 10 });
    const c = s4.lines.find((l) => l.id === 'nc-cut-1')!;
    expect(c.positions.length / 6).toBe(2 + 8);
  });

  it('Heidenhain BLK FORM은 공작물 상자로', () => {
    const { parsed, scene } = loadNcFile('a.h', '0 BEGIN PGM A MM\n1 BLK FORM 0.1 Z X+0 Y+0 Z-10\n2 BLK FORM 0.2 X+50 Y+40 Z+0\n3 L X+1 Y+1 Z+5 R0 FMAX\n4 L Z-1 F100\n5 END PGM A MM\n');
    expect(parsed.kind).toBe('heidenhain');
    expect(scene.meshes[0]!.id).toBe('nc-stock');
    expect(scene.bounds).toEqual({ min: [0, 0, -10], max: [50, 40, 5] });
  });
});

describe('원본 글·형식 판별', () => {
  it('줄 나누기: LF·CRLF·CR·BOM·끝 줄바꿈 없음', () => {
    const t = (s: string): string[] => {
      const src = makeSource(s);
      return Array.from({ length: src.lineCount }, (_, i) => sourceLine(src, i));
    };
    expect(t('a\nb\n')).toEqual(['a', 'b']);
    expect(t('a\r\nb')).toEqual(['a', 'b']);
    expect(t('a\rb\r')).toEqual(['a', 'b']);
    expect(t('﻿G0 X1\n\nG1')).toEqual(['G0 X1', '', 'G1']);
    expect(t('')).toEqual([]);
    expect(Array.from(splitLines(new TextEncoder().encode('x\ny')))).toEqual([0, 2, 3]);
  });
  it('인코딩 추정', () => {
    expect(guessEncoding(new TextEncoder().encode('(Fräser Ø6)'))).toBe('utf-8');
    expect(guessEncoding(new Uint8Array([0x28, 0xe4, 0x29]))).toBe('windows-1252');
    const src = makeSource(new Uint8Array([0x28, 0xd8, 0x36, 0x29]));
    expect(sourceLine(src, 0)).toBe('(Ø6)');
  });
  it('형식 판별: 내용 우선, 다음 확장자', () => {
    expect(detectNcFormat('x.txt', '[H\nVERSION="4.0 Alpha"\n')).toBe('mpr');
    expect(detectNcFormat('x.nc', '0 BEGIN PGM A MM\n1 L X+0 R0 FMAX\n')).toBe('heidenhain');
    expect(detectNcFormat('x.ngc', 'G0 X1')).toBe('gcode');
    expect(detectNcFormat('x.h', 'whatever')).toBe('heidenhain');
    expect(detectNcFormat('x.dat', 'G0 X1 Y1\nG1 Z-1 F100\nG1 X5\nM30')).toBe('gcode');
    expect(detectNcFormat('x.dat', 'hello world')).toBeNull();
  });
  it('parseNcFile은 형식에 맞는 해석기로', () => {
    const a = parseNcFile('dir/part.nc', new TextEncoder().encode('G0 X0 Y0 Z1\nG1 Z-1 F100'));
    expect(a.kind).toBe('gcode');
    if (a.kind !== 'mpr') expect(a.program.name).toBe('part.nc');
    const b = parseNcFile('p.mpr', '[H\nVERSION="4.0"\n<100 \\WerkStck\\\nLA="10"\nBR="5"\nDI="1"\n!\n');
    expect(b.kind).toBe('mpr');
    if (b.kind === 'mpr') expect(b.part.workpiece!.length).toBe(10);
  });
});
