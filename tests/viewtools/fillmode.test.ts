/** 채우기(FILLMODE·FILL)와 빠른 문자(QTEXTMODE·QTEXT): 그리기 규칙과 장면 출력 차이 */
import { describe, expect, it } from 'vitest';
import type { CadDocument, Entity, HatchEntity } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { buildSpace } from '../../src/render/build';
import { boundaryEdges, contourSegments, stripOutline, textLineBoxes } from '../../src/render/fillmode';
import { TextEngine } from '../../src/text/layout';
import { P, add, newDoc } from '../hatch/helpers';
import { packBulge, packLw } from '../../src/core/lwpoly';

let serial = 0x700;
const H = () => (serial++).toString(16).toUpperCase();

function solidHatch(x: number, y: number, w: number, h: number, pattern = 'SOLID'): HatchEntity {
  return {
    type: 'HATCH',
    ...entityDefaults(),
    handle: H(),
    patternName: pattern,
    solid: pattern === 'SOLID',
    associative: false,
    hatchStyle: 0,
    patternType: 1,
    patternAngle: 0,
    patternScale: 1,
    patternDouble: false,
    elevation: 0,
    paths: [
      {
        flags: 3,
        polyline: {
          closed: true,
          verts: packBulge([
            { x, y, bulge: 0 },
            { x: x + w, y, bulge: 0 },
            { x: x + w, y: y + h, bulge: 0 },
            { x, y: y + h, bulge: 0 },
          ]),
        },
      },
    ],
    patternLines: pattern === 'SOLID' ? [] : [{ angle: Math.PI / 4, base: { x: 0, y: 0 }, offset: { x: -1, y: 1 }, dashes: [] }],
    pixelSize: 0,
    seedPoints: [],
  } as HatchEntity;
}

function widePline(): Entity {
  return {
    type: 'LWPOLYLINE',
    ...entityDefaults(),
    handle: H(),
    ...packLw([
      { x: 0, y: 0, bulge: 0, startWidth: 2, endWidth: 2 },
      { x: 10, y: 0, bulge: 0, startWidth: 2, endWidth: 2 },
      { x: 10, y: 10, bulge: 0, startWidth: 2, endWidth: 2 },
    ]),
    closed: false,
    plinegen: false,
    constantWidth: 2,
    elevation: 0,
  } as Entity;
}

/** 도넛(DONUT과 같은 모양: 볼록도 1인 두 세그먼트, 폭 2) */
function donut(): Entity {
  return {
    type: 'LWPOLYLINE',
    ...entityDefaults(),
    handle: H(),
    ...packLw([
      { x: -4, y: 0, bulge: 1, startWidth: 2, endWidth: 2 },
      { x: 4, y: 0, bulge: 1, startWidth: 2, endWidth: 2 },
    ]),
    closed: true,
    plinegen: false,
    constantWidth: 2,
    elevation: 0,
  } as Entity;
}

function solid(): Entity {
  return { type: 'SOLID', ...entityDefaults(), handle: H(), points: [P(0, 0), P(5, 0), P(0, 5), P(5, 5)], invisibleEdges: 0 } as Entity;
}

function text(s: string, x = 0, y = 0): Entity {
  return { type: 'TEXT', ...entityDefaults(), handle: H(), insert: P(x, y), height: 2.5, text: s, rotation: 0, widthFactor: 1, oblique: 0, style: 'Standard', generation: 0, halign: 0, valign: 0 } as Entity;
}

function mtext(s: string): Entity {
  return { type: 'MTEXT', ...entityDefaults(), handle: H(), insert: P(0, 20), height: 2.5, width: 0, attachment: 1, drawingDirection: 1, text: s, style: 'Standard', rotation: 0, lineSpacingStyle: 1, lineSpacingFactor: 1, backgroundFlags: 0, backgroundScale: 1.5 } as Entity;
}

function counts(doc: CadDocument): { segs: number; tris: number; glyphs: number } {
  const list = buildSpace(doc, '*Model_Space', { text: new TextEngine(null) }).list;
  return {
    segs: list.chunks.reduce((a, c) => a + c.segCount + c.tsegCount, 0),
    tris: list.chunks.reduce((a, c) => a + c.triCount + c.ttriCount, 0),
    glyphs: list.glyphs.instanceCount,
  };
}

function docWith(vars: Record<string, number>, ...ents: Entity[]): CadDocument {
  const doc = newDoc();
  for (const [k, v] of Object.entries(vars)) doc.header.set(k, v);
  add(doc, ...ents);
  return doc;
}

describe('그리기 규칙(순수 함수)', () => {
  it('삼각형들의 바깥 윤곽: 정사각형 두 삼각형 → 네 변', () => {
    const e = boundaryEdges([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);
    expect(e.length).toBe(16);
    // 대각선(0,0)-(1,1)은 없다
    for (let i = 0; i < e.length; i += 4) expect(Math.abs(e[i + 2]! - e[i]!) + Math.abs(e[i + 3]! - e[i + 1]!)).toBe(1);
  });
  it('윤곽선 → 닫힌 선분', () => {
    const s = contourSegments([new Float32Array([0, 0, 1, 0, 1, 1])]);
    expect([...s]).toEqual([0, 0, 1, 0, 1, 0, 1, 1, 1, 1, 0, 0]);
  });
  it('QTEXT 줄 상자: 기준선이 가까운 글자끼리', () => {
    const boxes = textLineBoxes(
      [
        { minX: 0, minY: 0, maxX: 1, maxY: 2, base: 0 },
        { minX: 1, minY: -0.5, maxX: 2, maxY: 2, base: 0.1 },
        { minX: 0, minY: -4, maxX: 3, maxY: -2, base: -4 },
      ],
      1,
    );
    expect(boxes).toEqual([
      { minX: 0, minY: -0.5, maxX: 2, maxY: 2 },
      { minX: 0, minY: -4, maxX: 3, maxY: -2 },
    ]);
  });
  it('폭 있는 띠의 윤곽: 양쪽 가장자리와 끝 선', () => {
    const o = stripOutline([0, 1, 10, 1], [0, -1, 10, -1]);
    expect(o).toEqual([
      [0, 1, 10, 1],
      [0, -1, 10, -1],
      [0, 1, 0, -1],
      [10, 1, 10, -1],
    ]);
  });
});

describe('FILLMODE 장면 출력', () => {
  it('솔리드 해치: 켜면 삼각형, 끄면 경계선만', () => {
    const on = counts(docWith({}, solidHatch(0, 0, 10, 10)));
    const off = counts(docWith({ $FILLMODE: 0 }, solidHatch(0, 0, 10, 10)));
    expect(on.tris).toBeGreaterThan(0);
    expect(on.segs).toBe(0);
    expect(off.tris).toBe(0);
    expect(off.segs).toBe(4);
  });
  it('패턴 해치도 끄면 경계선만', () => {
    const on = counts(docWith({}, solidHatch(0, 0, 10, 10, 'USER')));
    const off = counts(docWith({ $FILLMODE: 0 }, solidHatch(0, 0, 10, 10, 'USER')));
    expect(on.segs).toBeGreaterThan(4);
    expect(off.segs).toBe(4);
  });
  it('2D 솔리드: 끄면 테두리 네 변', () => {
    expect(counts(docWith({}, solid())).tris).toBe(2);
    const off = counts(docWith({ $FILLMODE: 0 }, solid()));
    expect(off.tris).toBe(0);
    expect(off.segs).toBe(4);
  });
  it('폭 있는 폴리선: 끄면 양쪽 가장자리와 세그먼트 끝 선(중심선 아님)', () => {
    const on = counts(docWith({}, widePline()));
    const off = counts(docWith({ $FILLMODE: 0 }, widePline()));
    expect(on.tris).toBe(4);
    expect(on.segs).toBe(0);
    expect(off.tris).toBe(0);
    // 세그먼트 둘 × (가장자리 2 + 끝 선 2)
    expect(off.segs).toBe(8);
  });
  it('도넛: 끄면 안·밖 원(호 선분)과 끝 선', () => {
    const on = counts(docWith({}, donut()));
    const off = counts(docWith({ $FILLMODE: 0 }, donut()));
    expect(on.tris).toBeGreaterThan(0);
    expect(off.tris).toBe(0);
    expect(off.segs).toBeGreaterThan(8);
  });
  it('채우기 켜기가 기본(FILLMODE 없음 = 1)', () => {
    expect(counts(docWith({ $FILLMODE: 1 }, solid()))).toEqual(counts(docWith({}, solid())));
  });
});

describe('QTEXTMODE 장면 출력', () => {
  it('문자는 테두리 사각형 하나(글자 없음)', () => {
    const on = counts(docWith({}, text('ABC')));
    const q = counts(docWith({ $QTEXTMODE: 1 }, text('ABC')));
    expect(on.glyphs).toBeGreaterThan(0);
    expect(q.glyphs).toBe(0);
    expect(q.segs).toBe(4);
  });
  it('여러 줄 문자는 줄마다 사각형', () => {
    const q = counts(docWith({ $QTEXTMODE: 1 }, mtext('첫 줄\\P둘째 줄\\P셋')));
    expect(q.glyphs).toBe(0);
    expect(q.segs).toBe(12);
  });
  it('사각형은 글자 범위를 감싼다', () => {
    const doc = docWith({ $QTEXTMODE: 1 }, text('HELLO', 100, 50));
    const b = buildSpace(doc, '*Model_Space', { text: new TextEngine(null) }).list.entities[0]!;
    expect(b.minX).toBeGreaterThanOrEqual(99.9);
    expect(b.minY).toBeGreaterThanOrEqual(49);
    expect(b.maxX).toBeGreaterThan(105);
    expect(b.maxY).toBeLessThanOrEqual(53);
  });
});
