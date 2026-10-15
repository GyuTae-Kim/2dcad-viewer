/** Express Tools 문자 도구(TCASE·TCOUNT·TORIENT·TEXTFIT·TEXTMASK·TCIRCLE·TXTEXP) 순수 계산 */
import { describe, expect, it } from 'vitest';
import type { AttribEntity, CadDocument, CircleEntity, DimensionEntity, ImageEntity, InsertEntity, LwPolylineEntity, MTextEntity, TextEntity } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { TextEngine } from '../../src/text/layout';
import { strokeFace } from '../../src/text/fonts';
import { caseDimText, caseEntity, caseMText, caseText } from '../../src/edit/express/tcase';
import { countNumber, parseStartIncrement, placeNumber, planCount, sortForCount } from '../../src/edit/express/tcount';
import { normalizeAngle, orientEntity, readableAngle } from '../../src/edit/express/torient';
import { fitBaseline, fitText } from '../../src/edit/express/textfit';
import { TEXTMASK_APP, makeMask, maskPolygon, readMaskLink, withMaskLink } from '../../src/edit/express/textmask';
import { circleRadius, encloseText, largestBox } from '../../src/edit/express/tcircle';
import { textAngle, textBox } from '../../src/edit/express/textbox';
import { explodeTextGeometry } from '../../src/edit/express/txtexp';

const doc: CadDocument = createNewDocument('metric');
let hn = 0x200;
const nh = () => (hn++).toString(16).toUpperCase();
const D = Math.PI / 180;

function text(s: string, x: number, y: number, over: Partial<TextEntity> = {}): TextEntity {
  return {
    ...entityDefaults(),
    type: 'TEXT',
    handle: nh(),
    insert: { x, y, z: 0 },
    height: 2.5,
    text: s,
    rotation: 0,
    widthFactor: 1,
    oblique: 0,
    style: 'Standard',
    generation: 0,
    halign: 0,
    valign: 0,
    ...over,
  };
}

function mtext(s: string, x: number, y: number, over: Partial<MTextEntity> = {}): MTextEntity {
  return {
    ...entityDefaults(),
    type: 'MTEXT',
    handle: nh(),
    insert: { x, y, z: 0 },
    height: 2.5,
    width: 0,
    attachment: 1,
    drawingDirection: 1,
    text: s,
    style: 'Standard',
    rotation: 0,
    lineSpacingStyle: 1,
    lineSpacingFactor: 1,
    backgroundFlags: 0,
    backgroundScale: 1.5,
    ...over,
  };
}

describe('TCASE', () => {
  it('대문자·소문자·전환', () => {
    expect(caseText('Hello World', 'upper')).toBe('HELLO WORLD');
    expect(caseText('Hello World', 'lower')).toBe('hello world');
    expect(caseText('Hello World', 'toggle')).toBe('hELLO wORLD');
  });
  it('문장 대소문자: 처음·마침표 뒤 공백 다음만 대문자, 3.14 같은 마침표는 문장 끝이 아니다', () => {
    expect(caseText('hELLO WORLD. this IS pi 3.14 ok! yes?no', 'sentence')).toBe('Hello world. This is pi 3.14 ok! Yes?no');
    expect(caseText('(note) TEXT', 'sentence')).toBe('(Note) text');
  });
  it('제목: 단어 첫 글자만 대문자(작은따옴표는 단어 안)', () => {
    expect(caseText("the QUICK brown-fox don't", 'title')).toBe("The Quick Brown-Fox Don't");
  });
  it('TEXT의 %% 코드·\\U+ 코드·필드는 그대로', () => {
    expect(caseText('%%c50 dia %%d %%p0.1', 'upper')).toBe('%%c50 DIA %%d %%p0.1');
    expect(caseText('%%uund%%u x', 'upper')).toBe('%%uUND%%u X');
    expect(caseText('a\\U+00e9b', 'upper')).toBe('A\\U+00e9B');
    expect(caseText('date %<\\AcVar Date \\f "M/d/yyyy">% now', 'upper')).toBe('DATE %<\\AcVar Date \\f "M/d/yyyy">% NOW');
  });
  it('MTEXT 서식 코드·묶음·줄바꿈·탈출 글자 보존', () => {
    const src = '{\\fArial|b1|i0|c0|p34;hello \\C1;world}\\Pnext line. second\\~one \\\\x \\{y\\}';
    expect(caseMText(src, 'upper')).toBe('{\\fArial|b1|i0|c0|p34;HELLO \\C1;WORLD}\\PNEXT LINE. SECOND\\~ONE \\\\X \\{Y\\}');
    expect(caseMText('{\\H2.5x;abc}\\pxqc;def', 'upper')).toBe('{\\H2.5x;ABC}\\pxqc;DEF');
    // 문단이 바뀌면 새 문장
    expect(caseMText('FIRST LINE\\PSECOND LINE', 'sentence')).toBe('First line\\PSecond line');
    // 밑줄 켜고 끄기(\L \l)는 경계가 아니다
    expect(caseMText('a\\Lbc\\l d', 'title')).toBe('A\\Lbc\\l D');
  });
  it('MTEXT 스택은 위·아래 글자만 바꾸고 구분 기호는 그대로', () => {
    expect(caseMText('x\\Sab^cd;y', 'upper')).toBe('X\\SAB^CD;Y');
    expect(caseMText('\\S1/2;', 'upper')).toBe('\\S1/2;');
  });
  it('치수 문자 재지정: <> 자리 그대로, 빈 문자는 그대로', () => {
    expect(caseDimText('<> typ', 'upper')).toBe('<> TYP');
    expect(caseDimText('', 'upper')).toBe('');
  });
  it('객체: 블록 참조의 속성과 치수, 바뀌지 않으면 null', () => {
    const att: AttribEntity = { ...text('value a', 0, 0), type: 'ATTRIB', tag: 'T1', attFlags: 0 };
    const ins: InsertEntity = { ...entityDefaults(), type: 'INSERT', handle: nh(), block: 'B', insert: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotation: 0, columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0, attribs: [att] };
    const r = caseEntity(ins, 'upper') as InsertEntity;
    expect(r.attribs[0]!.text).toBe('VALUE A');
    expect(ins.attribs[0]!.text).toBe('value a');
    expect(caseEntity(text('ABC', 0, 0), 'upper')).toBeNull();
    const dim = { ...entityDefaults(), type: 'DIMENSION', handle: nh(), text: 'r<>' } as unknown as DimensionEntity;
    expect((caseEntity(dim, 'upper') as DimensionEntity).text).toBe('R<>');
  });
});

describe('TCOUNT', () => {
  const items = [
    { handle: 'A', p: { x: 10, y: 0 } },
    { handle: 'B', p: { x: 0, y: 5 } },
    { handle: 'C', p: { x: 5, y: 10 } },
    { handle: 'D', p: { x: 0, y: 0 } },
  ];
  it('정렬: X는 왼쪽부터(같으면 위부터), Y는 위부터(같으면 왼쪽부터), 선택 순서는 그대로', () => {
    expect(sortForCount(items, 'X')).toEqual(['B', 'D', 'C', 'A']);
    expect(sortForCount(items, 'Y')).toEqual(['C', 'B', 'D', 'A']);
    expect(sortForCount(items, 'S')).toEqual(['A', 'B', 'C', 'D']);
  });
  it('시작·증분 읽기와 번호(소수 자리 유지)', () => {
    expect(parseStartIncrement('1,1')).toEqual({ start: 1, inc: 1, decimals: 0 });
    expect(parseStartIncrement('10, -2')).toEqual({ start: 10, inc: -2, decimals: 0 });
    expect(parseStartIncrement('5')).toEqual({ start: 5, inc: 1, decimals: 0 });
    expect(parseStartIncrement('1.5,0.25')).toEqual({ start: 1.5, inc: 0.25, decimals: 2 });
    expect(parseStartIncrement('a,b')).toBeNull();
    expect(countNumber(1, 1, 0)).toBe('1');
    expect(countNumber(10, -2, 3)).toBe('4');
    expect(countNumber(1.5, 0.25, 2, 2)).toBe('2.00');
  });
  it('넣는 자리: 덮어쓰기·접두어·접미어·찾아 바꾸기, MTEXT 접두어는 맨 앞 서식 뒤', () => {
    expect(placeNumber('ROOM', false, '3', 'O')).toBe('3');
    expect(placeNumber('ROOM', false, '3', 'P')).toBe('3 ROOM');
    expect(placeNumber('ROOM', false, '3', 'S')).toBe('ROOM 3');
    expect(placeNumber('ROOM-#', false, '3', 'F', '#')).toBe('ROOM-3');
    expect(placeNumber('ROOM', false, '3', 'F', '#')).toBeNull();
    expect(placeNumber('{\\fArial;ROOM}', true, '7', 'P')).toBe('{\\fArial;7 ROOM}');
  });
  it('계획: Y 정렬로 위에서부터 번호, 찾지 못한 문자는 번호를 쓰지 않는다', () => {
    const a = text('A-#', 0, 0);
    const b = text('B-#', 0, 10);
    const c = text('C', 0, 20);
    const plan = planCount([a, b, c], doc, { sort: 'Y', start: 1, inc: 1, place: 'F', find: '#' });
    expect(plan.map((p) => [p.handle, (p.after as TextEntity).text])).toEqual([
      [b.handle, 'B-1'],
      [a.handle, 'A-2'],
    ]);
    expect(a.text).toBe('A-#');
  });
});

describe('TORIENT', () => {
  it('가장 읽기 쉬운 방향: (90°, 270°]는 180° 돌린다', () => {
    expect(readableAngle(0) / D).toBeCloseTo(0, 9);
    expect(readableAngle(90 * D) / D).toBeCloseTo(90, 9);
    expect(readableAngle(91 * D) / D).toBeCloseTo(271, 9);
    expect(readableAngle(180 * D) / D).toBeCloseTo(0, 9);
    expect(readableAngle(270 * D) / D).toBeCloseTo(90, 9);
    expect(readableAngle(-45 * D) / D).toBeCloseTo(315, 9);
    expect(readableAngle(450 * D) / D).toBeCloseTo(90, 9);
    expect(normalizeAngle(-D) / D).toBeCloseTo(359, 9);
  });
  it('뒤집힌 문자는 상자 가운데를 축으로 0°로, 이미 읽기 쉬우면 null', () => {
    const t = text('ABC', 10, 10, { rotation: Math.PI });
    const c0 = textBox(t, doc)!.c;
    const r = orientEntity(t, 'readable', doc) as TextEntity;
    expect(normalizeAngle(textAngle(r)!)).toBeCloseTo(0, 9);
    const c1 = textBox(r, doc)!.c;
    expect(c1.x).toBeCloseTo(c0.x, 6);
    expect(c1.y).toBeCloseTo(c0.y, 6);
    expect(r.handle).toBe(t.handle);
    expect(orientEntity(text('X', 0, 0, { rotation: 30 * D }), 'readable', doc)).toBeNull();
  });
  it('새 절대 각도와 여러 줄 문자', () => {
    const m = mtext('ABC', 0, 0);
    const r = orientEntity(m, 45 * D, doc) as MTextEntity;
    expect(normalizeAngle(textAngle(r)!) / D).toBeCloseTo(45, 9);
  });
});

describe('TEXTFIT', () => {
  it('왼쪽 문자: 시작점은 그대로, 폭 비율 = 새 길이 / 지금 길이', () => {
    const t = text('ABCD', 0, 0, { widthFactor: 1 });
    const base = fitBaseline(t, doc, { unitWidth: 2 });
    expect(base.length).toBeCloseTo(5, 9); // 2 × 2.5 × 1
    const r = fitText(t, { x: 10, y: 3 }, doc, { unitWidth: 2 }) as TextEntity;
    expect(r.widthFactor).toBeCloseTo(2, 9);
    expect(r.insert.x).toBeCloseTo(0, 9);
    expect(r.alignPoint).toBeUndefined();
  });
  it('가운데 문자: 왼쪽 끝을 지키고 자리맞추기 점을 옮긴다', () => {
    // 폭 5인 가운데 맞춤: 왼쪽 끝 = 10 − 2.5
    const t = text('ABCD', 0, 0, { halign: 1, alignPoint: { x: 10, y: 0, z: 0 } });
    const r = fitText(t, { x: 17.5, y: 0 }, doc, { unitWidth: 2 }) as TextEntity;
    expect(r.widthFactor).toBeCloseTo(2, 9);
    expect(r.alignPoint!.x).toBeCloseTo(12.5, 9);
    expect(r.insert.x).toBeCloseTo(7.5, 9);
  });
  it('시작점 옵션과 끝점이 거꾸로면 안내', () => {
    const t = text('ABCD', 0, 0);
    const r = fitText(t, { x: 12, y: 0 }, doc, { unitWidth: 2, start: { x: 2, y: 5 } }) as TextEntity;
    expect(r.insert.x).toBeCloseTo(2, 9);
    expect(r.insert.y).toBeCloseTo(0, 9);
    expect(r.widthFactor).toBeCloseTo(2, 9);
    expect(typeof fitText(t, { x: -1, y: 0 }, doc, { unitWidth: 2 })).toBe('string');
  });
  it('맞춤(F) 문자는 두 번째 점을 옮긴다', () => {
    const t = text('ABCD', 0, 0, { halign: 5, alignPoint: { x: 5, y: 0, z: 0 } });
    const r = fitText(t, { x: 8, y: 1 }, doc, { unitWidth: 2 }) as TextEntity;
    expect(r.halign).toBe(5);
    expect(r.alignPoint!.x).toBeCloseTo(8, 9);
    expect(r.alignPoint!.y).toBeCloseTo(0, 9);
  });
});

describe('TEXTMASK', () => {
  it('가리개는 상자를 비율 × 높이만큼 넓힌다', () => {
    const t = text('ABC', 0, 0);
    const b = textBox(t, doc)!;
    const poly = maskPolygon(t, 0.4, doc)!;
    expect(poly[0]!.x).toBeCloseTo(b.o.x - 1, 9);
    expect(poly[2]!.y).toBeCloseTo(b.o.y + b.h + 1, 9);
    const w = makeMask(t, { type: 'wipeout', offset: 0.4 }, doc) as ImageEntity;
    expect(w.type).toBe('WIPEOUT');
    expect(w.uVector.x).toBeCloseTo(b.w + 2, 9);
    expect(w.layer).toBe(t.layer);
    const s = makeMask(t, { type: 'solid', offset: 0, color: { aci: 3 } }, doc)!;
    expect(s.type).toBe('SOLID');
    expect(s.color.aci).toBe(3);
  });
  it('짝 기록 넣고 읽고 지우기(다른 앱 자료는 그대로)', () => {
    const x0 = [{ app: 'OTHER', items: [{ code: 1000, value: 'k' }] }];
    const x1 = withMaskLink(x0, { type: 'solid', offset: 0.5, mask: '1A', group: '2B' })!;
    expect(x1.map((d) => d.app)).toEqual(['OTHER', TEXTMASK_APP]);
    expect(readMaskLink({ xdata: x1 })).toEqual({ type: 'solid', offset: 0.5, mask: '1A', group: '2B' });
    expect(withMaskLink(x1, null)).toEqual(x0);
    expect(withMaskLink([{ app: TEXTMASK_APP, items: [] }], null)).toBeUndefined();
  });
});

describe('TCIRCLE', () => {
  const props = { ...entityDefaults() };
  it('가변 원: 상자 구석을 지나는 원 + 비율 × 높이', () => {
    const t = text('ABCD', 0, 0);
    const b = textBox(t, doc)!;
    const c = encloseText(t, doc, 'circle', 0.35, props) as CircleEntity;
    expect(c.radius).toBeCloseTo(Math.hypot(b.w / 2, b.h / 2) + 0.35 * 2.5, 9);
    expect(c.center.x).toBeCloseTo(b.c.x, 9);
    expect(circleRadius(b, 0)).toBeCloseTo(Math.hypot(b.w / 2, b.h / 2), 9);
  });
  it('사각형과 슬롯(반원 끝)', () => {
    const t = text('ABCD', 0, 0, { rotation: Math.PI / 2 });
    const b = textBox(t, doc)!;
    const r = encloseText(t, doc, 'rect', 0.2, props) as LwPolylineEntity;
    expect(r.closed).toBe(true);
    expect(r.vertices).toHaveLength(4);
    const side = Math.hypot(r.vertices[1]!.x - r.vertices[0]!.x, r.vertices[1]!.y - r.vertices[0]!.y);
    expect(side).toBeCloseTo(b.w + 2 * 0.5, 9);
    const s = encloseText(t, doc, 'slot', 0.2, props) as LwPolylineEntity;
    expect(s.vertices.map((v) => v.bulge)).toEqual([0, 1, 0, 1]);
  });
  it('일정 크기: 가장 큰 상자', () => {
    const a = text('AB', 0, 0);
    const b = text('ABCDEF', 0, 10);
    const big = largestBox([a, b], doc)!;
    expect(big.w).toBeCloseTo(textBox(b, doc)!.w, 9);
    const r = encloseText(a, doc, 'rect', 0, props, { w: big.w, h: big.h }) as LwPolylineEntity;
    expect(Math.hypot(r.vertices[1]!.x - r.vertices[0]!.x, r.vertices[1]!.y - r.vertices[0]!.y)).toBeCloseTo(big.w, 9);
  });
});

describe('TXTEXP', () => {
  const eng = new TextEngine(null);
  const strokesOf = (s: string) =>
    [...s].reduce((n, ch) => n + (strokeFace.glyph(ch.codePointAt(0)!)?.strokes?.filter((st) => st.length >= 4).length ?? 0), 0);
  it('단선 글꼴: 획마다 열린 폴리선, 문자 특성을 잇는다', () => {
    const t = text('AB', 5, 5, { layer: 'L1', color: { aci: 2 } });
    const parts = explodeTextGeometry(t, doc, eng);
    expect(parts.length).toBe(strokesOf('AB'));
    expect(parts.every((p) => p.type === 'LWPOLYLINE' && !(p as LwPolylineEntity).closed)).toBe(true);
    expect(parts[0]!.layer).toBe('L1');
    expect(parts[0]!.color.aci).toBe(2);
    expect(parts[0]!.handle).toBe('');
  });
  it('밑줄은 선, 여러 줄 문자도 나눈다', () => {
    const t = text('%%uA', 0, 0);
    const parts = explodeTextGeometry(t, doc, eng);
    expect(parts.filter((p) => p.type === 'LINE')).toHaveLength(1);
    const m = mtext('A\\PB', 0, 0);
    expect(explodeTextGeometry(m, doc, eng).length).toBe(strokesOf('AB'));
  });
  it('윤곽 글꼴: 윤곽마다 닫힌 폴리선(가짜 엔진)', () => {
    const square = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    const hole = new Float32Array([0.25, 0.25, 0.75, 0.25, 0.75, 0.75, 0.25, 0.75]);
    const glyph = { advance: 1, tris: new Float32Array(), contours: [square, hole], minX: 0, minY: 0, maxX: 1, maxY: 1 };
    const lay = { glyphs: [0, 1].map((i) => ({ geom: glyph, kind: 'outline' as const, m: [2, 0, 0, 2, i * 2, 0] as [number, number, number, number, number, number], color: null })), lines: [], minX: 0, minY: 0, maxX: 4, maxY: 2 };
    const fake = { layoutText: () => lay, layoutMText: () => lay };
    const parts = explodeTextGeometry(text('OO', 10, 0), doc, fake as unknown as TextEngine) as LwPolylineEntity[];
    expect(parts).toHaveLength(4);
    expect(parts.every((p) => p.closed && p.vertices.length === 4)).toBe(true);
    expect(parts[2]!.vertices[1]!.x).toBeCloseTo(4, 9);
  });
  it('회전한 문자의 획은 회전한 자리에', () => {
    const t0 = text('I', 0, 0);
    const t1 = text('I', 0, 0, { rotation: Math.PI / 2 });
    const a = explodeTextGeometry(t0, doc, eng)[0] as LwPolylineEntity;
    const b = explodeTextGeometry(t1, doc, eng)[0] as LwPolylineEntity;
    expect(b.vertices[0]!.x).toBeCloseTo(-a.vertices[0]!.y, 6);
    expect(b.vertices[0]!.y).toBeCloseTo(a.vertices[0]!.x, 6);
  });
});
