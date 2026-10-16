/** Express Tools 선택·조회·그리기·수정 도구(SSX·GETSEL·XDLIST·XLIST·NCOPY·GATTE·BREAKLINE·EXOFFSET·FLATTEN·CDORDER·MKLTYPE·REDIR) 순수 계산 */
import { describe, expect, it } from 'vitest';
import type {
  ArcEntity,
  AttribEntity,
  BlockDef,
  CadDocument,
  CircleEntity,
  Entity,
  ImageDefObject,
  InsertEntity,
  LineEntity,
  LwPolylineEntity,
  PointEntity,
  TextEntity,
} from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { getselSelect, ssxFilterLines, ssxFilterOf, ssxMatch, ssxSelect, ssxSetValue } from '../../src/edit/express/ssx';
import { nestedCopy, xdataLines, xlistRows } from '../../src/edit/express/xlist';
import { gatteChanges } from '../../src/edit/express/gatte';
import { breaklinePoints } from '../../src/edit/express/breakline';
import { applyGap, chainsOf, offsetChain } from '../../src/edit/express/exoffset';
import { flattenEntity } from '../../src/edit/express/flatten';
import { cdorderList, colorKey, colorsOf, displayColorKey, reorderOps } from '../../src/edit/express/cdorder';
import { linFileText, linetypeFromObjects, linetypeNameProblem } from '../../src/edit/express/mkltype';
import { redirOps, redirPath } from '../../src/edit/express/redir';
import { lwVertices, packLw } from '../../src/core/lwpoly';

const doc: CadDocument = createNewDocument('metric');
let hn = 0x400;
const nh = () => (hn++).toString(16).toUpperCase();
const base = () => ({ ...entityDefaults(), handle: nh() });

const line = (x0: number, y0: number, x1: number, y1: number, over: Partial<LineEntity> = {}): LineEntity => ({ ...base(), type: 'LINE', start: { x: x0, y: y0, z: 0 }, end: { x: x1, y: y1, z: 0 }, ...over });
const point = (x: number, y: number): PointEntity => ({ ...base(), type: 'POINT', position: { x, y, z: 0 }, angle: 0 });
const text = (s: string, x: number, y: number, over: Partial<TextEntity> = {}): TextEntity => ({
  ...base(),
  type: 'TEXT',
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
});
const insert = (block: string, x: number, y: number, over: Partial<InsertEntity> = {}): InsertEntity => ({
  ...base(),
  type: 'INSERT',
  block,
  insert: { x, y, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
  rotation: 0,
  columnCount: 1,
  rowCount: 1,
  columnSpacing: 0,
  rowSpacing: 0,
  attribs: [],
  ...over,
});

describe('SSX·GETSEL', () => {
  const a = text('A', 0, 0, { layer: 'WALL', color: { aci: 1 } });
  const b = text('B', 5, 0, { layer: 'WALL', color: { aci: 1 } });
  const c = text('C', 5, 0, { layer: 'WALL', color: { aci: 2 } });
  const d = line(0, 0, 1, 1, { layer: 'WALL', color: { aci: 1 } });
  const e = text('E', 0, 0, { layer: 'DOOR', color: { aci: 1 } });
  const list: Entity[] = [a, b, c, d, e];
  it('기준 객체의 유형·도면층·색으로 고른다(ByLayer 색·선종류는 필터가 아니다)', () => {
    const f = ssxFilterOf(a);
    expect(f).toEqual({ type: 'TEXT', layer: 'WALL', color: { aci: 1 }, style: 'Standard' });
    expect(ssxSelect(list, f)).toEqual([a.handle, b.handle]);
    expect(ssxFilterOf(line(0, 0, 1, 0))).toEqual({ type: 'LINE', layer: '0' });
  });
  it('항목 바꾸기·빼기, 와일드카드', () => {
    let f = ssxFilterOf(a);
    f = ssxSetValue(f, 'color', '') as typeof f;
    expect(ssxSelect(list, f)).toEqual([a.handle, b.handle, c.handle]);
    f = ssxSetValue(f, 'layer', 'W*') as typeof f;
    f = ssxSetValue(f, 'type', '*') as typeof f;
    // 문자 스타일 필터가 남아 있으면 선은 빠진다
    expect(ssxSelect(list, f)).toEqual([a.handle, b.handle, c.handle]);
    f = ssxSetValue(f, 'style', '') as typeof f;
    expect(ssxSelect(list, f)).toEqual([a.handle, b.handle, c.handle, d.handle]);
    expect(typeof ssxSetValue(f, 'color', 'zzz')).toBe('string');
    expect(ssxMatch(c, ssxSetValue({}, 'color', '2') as object)).toBe(true);
    expect(ssxFilterLines({ type: 'TEXT', layer: 'WALL' })).toEqual(['객체 = TEXT (문자)', '도면층 = WALL']);
  });
  it('GETSEL: 도면층·유형(* = 모두)', () => {
    expect(getselSelect(list, 'WALL', 'TEXT')).toEqual([a.handle, b.handle, c.handle]);
    expect(getselSelect(list, '*', 'LINE')).toEqual([d.handle]);
    expect(getselSelect(list, 'door', '*')).toEqual([e.handle]);
  });
});

describe('XDLIST·XLIST·NCOPY', () => {
  it('확장 데이터 줄: 응용 프로그램 이름 와일드카드', () => {
    const x = [
      { app: 'ACAD', items: [{ code: 1000, value: 'hello' }] },
      { app: 'MYAPP', items: [{ code: 1070, value: 7 }, { code: 1010, value: { x: 1, y: 2, z: 3 } }, { code: 1005, value: '1F' }] },
    ];
    expect(xdataLines(x, 'MY*')).toEqual(['* 등록된 응용 프로그램 이름: MYAPP', '* 코드 1070, 정수: 7', '* 코드 1010, 3D 점: (1, 2, 3)', '* 코드 1005, 데이터베이스 핸들: 1F']);
    expect(xdataLines(x).length).toBe(6);
    expect(xdataLines(undefined)).toEqual([]);
  });
  const def: BlockDef = { name: 'BOX', handle: nh(), recordHandle: nh(), basePoint: { x: 1, y: 1, z: 0 }, flags: 0, entities: [] };
  it('XLIST 표: 유형·블록 이름·도면층·색·선종류·선가중치', () => {
    const l = line(0, 0, 2, 0, { layer: 'IN', color: { aci: 3 }, linetype: 'HIDDEN', lineweight: 25 });
    const rows = xlistRows(l, [{ def, insert: insert('BOX', 0, 0) }]);
    expect(rows.map((r) => r.value)).toEqual(['선 (LINE)', 'BOX', 'IN', '3', 'HIDDEN', '0.25 mm']);
    const xr = xlistRows(l, [{ def: { ...def, name: 'XR', flags: 4 }, insert: insert('XR', 0, 0), xref: 'XR' }]);
    expect(xr[2]!.value).toBe('XR|IN');
  });
  it('NCOPY: 바깥 참조들의 변환(바깥부터)으로 옮긴 새 객체', () => {
    const inner: BlockDef = { name: 'IN', handle: nh(), recordHandle: nh(), basePoint: { x: 0, y: 0, z: 0 }, flags: 0, entities: [] };
    const l = line(1, 1, 3, 1);
    const outerIns = insert('BOX', 10, 0, { rotation: Math.PI / 2 });
    const innerIns = insert('IN', 2, 0, { scale: { x: 2, y: 2, z: 1 } });
    const c = nestedCopy(l, [
      { def, insert: outerIns },
      { def: inner, insert: innerIns },
    ], doc) as LineEntity;
    // 안쪽: (1,1) → ×2 + (2,0) = (4,2); 바깥: −기준점(1,1) → (3,1), 90° → (−1,3), + (10,0) → (9,3)
    expect(c.start.x).toBeCloseTo(9, 9);
    expect(c.start.y).toBeCloseTo(3, 9);
    expect(c.end.x).toBeCloseTo(9, 9);
    expect(c.end.y).toBeCloseTo(7, 9);
    expect(c.handle).toBe('');
    expect(l.start.x).toBe(1);
    expect(typeof nestedCopy(l, [{ def, insert: insert('BOX', 0, 0, { scale: { x: 1, y: 2, z: 1 } }) }], doc)).toBe('string');
  });
});

describe('GATTE', () => {
  const att = (tag: string, v: string): AttribEntity => ({ ...text(v, 0, 0), type: 'ATTRIB', tag, attFlags: 0 });
  it('모든 참조에서 태그(대소문자 무시) 값을 바꾸고 이미 같은 값은 뺀다', () => {
    const r1 = insert('TB', 0, 0, { attribs: [att('NO', '1'), att('NAME', 'a')] });
    const r2 = insert('TB', 0, 0, { attribs: [att('no', 'X'), att('NAME', 'b')] });
    const r3 = insert('TB', 0, 0, { attribs: [att('NO', 'X')] });
    const { changes, found } = gatteChanges(
      [r1, r2, r3].map((e) => ({ block: '*MODEL_SPACE', entity: e })),
      'No',
      'X',
    );
    expect(found).toBe(3);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.before).toBe(r1);
    expect(changes[0]!.after.attribs[0]!.text).toBe('X');
    expect(changes[0]!.after.attribs[1]!.text).toBe('a');
    expect(r1.attribs[0]!.text).toBe('1');
  });
});

describe('BREAKLINE', () => {
  it('확장 거리만큼 나가고 가운데에 지그재그 기호', () => {
    const p = breaklinePoints({ x: 0, y: 0 }, { x: 10, y: 0 }, { size: 2, extension: 1 }) as { x: number; y: number }[];
    expect(p.map((q) => [+q.x.toFixed(9), +q.y.toFixed(9)])).toEqual([
      [-1, 0],
      [4, 0],
      [4.5, 1],
      [5.5, -1],
      [6, 0],
      [11, 0],
    ]);
  });
  it('기호 위치는 선 위로 내려 두 점 안에 둔다, 짧으면 안내', () => {
    const p = breaklinePoints({ x: 0, y: 0 }, { x: 0, y: 10 }, { size: 2, extension: 0, at: { x: 5, y: 9.9 } }) as { x: number; y: number }[];
    expect(p[1]!.y).toBeCloseTo(8, 9);
    expect(p[4]!.y).toBeCloseTo(10, 9);
    expect(p).toHaveLength(5);
    expect(typeof breaklinePoints({ x: 0, y: 0 }, { x: 1, y: 0 }, { size: 2, extension: 0 })).toBe('string');
  });
});

describe('EXOFFSET', () => {
  // ㄱ자: (0,0)→(10,0)→(10,10)
  const a = line(0, 0, 10, 0);
  const b = line(10, 0, 10, 10);
  it('닿는 선들을 한 줄로 묶어 간격띄운다(모서리가 이어진다)', () => {
    const chains = chainsOf([a, b]);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.joined).toBe(true);
    const r = offsetChain(chains[0]!, 1, { x: 20, y: -5 }, { gap: 'N', join: true }, doc);
    expect(r.add).toHaveLength(1);
    const pl = r.add[0] as LwPolylineEntity;
    expect(pl.type).toBe('LWPOLYLINE');
    // 바깥 모서리는 늘려서 (11, −1)에서 만난다
    expect(lwVertices(pl).some((v) => Math.abs(v.x - 11) < 1e-9 && Math.abs(v.y + 1) < 1e-9)).toBe(true);
  });
  it('모깎기: 바깥 모서리를 반지름 d 호로, 결합하지 않으면 선·호로 나눈다', () => {
    const c = chainsOf([a, b])[0]!;
    const r = offsetChain(c, 1, { x: 20, y: -5 }, { gap: 'F', join: true }, doc);
    const pl = r.add[0] as LwPolylineEntity;
    const k = lwVertices(pl).findIndex((v) => Math.abs(v.bulge) > 1e-9);
    expect(k).toBeGreaterThanOrEqual(0);
    expect(Math.abs(lwVertices(pl)[k]!.bulge)).toBeCloseTo(Math.tan(Math.PI / 8), 9);
    expect(lwVertices(pl)[k]!.x).toBeCloseTo(10, 9);
    expect(lwVertices(pl)[k]!.y).toBeCloseTo(-1, 9);
    const parts = offsetChain(c, 1, { x: 20, y: -5 }, { gap: 'F', join: false }, doc).add;
    expect(parts.map((e) => e.type).sort()).toEqual(['ARC', 'LINE', 'LINE']);
    const arc = parts.find((e) => e.type === 'ARC') as ArcEntity;
    expect(arc.radius).toBeCloseTo(1, 9);
  });
  it('모따기: 꼭짓점에서 d 떨어진 직선', () => {
    const c = chainsOf([a, b])[0]!;
    const pl = offsetChain(c, 1, { x: 20, y: -5 }, { gap: 'C', join: true }, doc).add[0] as LwPolylineEntity;
    // 바깥 모서리 (11,−1) 대신 두 점: 직선이 (10,0)에서 1 떨어진다
    const extra = lwVertices(pl).filter((v) => v.x > 10 + 1e-9 && v.y < -1e-9);
    expect(extra).toHaveLength(2);
    const p = extra[0]!;
    const q = extra[1]!;
    const m = { x: Math.SQRT1_2, y: -Math.SQRT1_2 };
    expect((p.x - 10) * m.x + p.y * m.y).toBeCloseTo(1, 9);
    expect((q.x - 10) * m.x + q.y * m.y).toBeCloseTo(1, 9);
  });
  it('안쪽 모서리와 낱개 객체는 그대로', () => {
    const c = chainsOf([a, b])[0]!;
    const pl = offsetChain(c, 1, { x: 5, y: 5 }, { gap: 'F', join: true }, doc).add[0] as LwPolylineEntity;
    expect(lwVertices(pl).every((v) => Math.abs(v.bulge) < 1e-12)).toBe(true);
    const single = chainsOf([line(0, 50, 10, 50)]);
    expect(single[0]!.joined).toBe(false);
    const lw = applyGap({ ...base(), type: 'LWPOLYLINE', ...packLw([]), closed: false, plinegen: false, constantWidth: 0, elevation: 0 }, a, 1, 'F');
    expect(lwVertices(lw)).toEqual([]);
  });
});

describe('FLATTEN', () => {
  it('Z·고도·두께를 0으로, 이미 평면이면 null', () => {
    const l = line(0, 0, 1, 1, { start: { x: 0, y: 0, z: 5 }, end: { x: 1, y: 1, z: -2 }, thickness: 3 });
    const r = flattenEntity(l, doc) as { entity: LineEntity };
    expect(r.entity.start.z).toBe(0);
    expect(r.entity.end.z).toBe(0);
    expect(r.entity.thickness).toBeUndefined();
    expect(flattenEntity(line(0, 0, 1, 1), doc)).toBeNull();
    const pl: LwPolylineEntity = { ...base(), type: 'LWPOLYLINE', ...packLw([{ x: 0, y: 0, bulge: 0, startWidth: 0, endWidth: 0 }]), closed: false, plinegen: false, constantWidth: 0, elevation: 7 };
    expect((flattenEntity(pl, doc) as { entity: LwPolylineEntity }).entity.elevation).toBe(0);
  });
  it('기울어진 원은 건너뛰고, −Z 원은 같은 평면도 모양의 +Z 원으로', () => {
    const tilted: CircleEntity = { ...base(), type: 'CIRCLE', center: { x: 0, y: 0, z: 0 }, radius: 1, extrusion: { x: 0, y: 0.6, z: 0.8 } };
    expect(flattenEntity(tilted, doc)).toHaveProperty('skip');
    const neg: CircleEntity = { ...base(), type: 'CIRCLE', center: { x: 3, y: 4, z: 2 }, radius: 1, extrusion: { x: 0, y: 0, z: -1 } };
    const r = flattenEntity(neg, doc) as { entity: CircleEntity };
    expect(r.entity.extrusion).toBeUndefined();
    expect(r.entity.center.x).toBeCloseTo(-3, 9);
    expect(r.entity.center.y).toBeCloseTo(4, 9);
    expect(r.entity.center.z).toBe(0);
  });
});

describe('CDORDER', () => {
  it('목록 위쪽 색이 앞(나중)에, 같은 색은 원래 순서, 맨 앞·맨 뒤', () => {
    const r1 = line(0, 0, 1, 0, { color: { aci: 1 } });
    const g1 = line(0, 0, 1, 0, { color: { aci: 3 } });
    const x = line(0, 0, 1, 0, { color: { aci: 5 } });
    const r2 = line(0, 0, 1, 0, { color: { aci: 1 } });
    const ents = [r1, g1, x, r2];
    const sel = new Set([r1.handle, g1.handle, r2.handle]);
    const key = (e: Entity) => displayColorKey(e, doc);
    expect(colorsOf([g1, r1, r2], doc)).toEqual(['aci:1', 'aci:3']);
    // 빨강을 맨 위(앞)에: 초록 → 빨강1 → 빨강2 순서로 그린다
    expect(cdorderList(ents, sel, key, ['aci:1', 'aci:3'], 'F')!.map((e) => e.handle)).toEqual([x.handle, g1.handle, r1.handle, r2.handle]);
    expect(cdorderList(ents, sel, key, ['aci:3', 'aci:1'], 'B')!.map((e) => e.handle)).toEqual([r1.handle, r2.handle, g1.handle, x.handle]);
    expect(colorKey({ aci: 7, rgb: 0x102030 })).toBe('rgb:102030');
    expect(displayColorKey(line(0, 0, 1, 0), doc)).toBe('aci:7');
  });
  it('작업: 고른 것을 빼고 정한 자리에 넣는다', () => {
    const a = line(0, 0, 1, 0, { color: { aci: 1 } });
    const b = line(0, 0, 1, 0, { color: { aci: 2 } });
    const c = line(0, 0, 1, 0, { color: { aci: 3 } });
    const sel = new Set([a.handle, b.handle]);
    const next = cdorderList([a, b, c], sel, (e) => colorKey(e.color), ['aci:1', 'aci:2'], 'F')!;
    const ops = reorderOps('*MODEL_SPACE', [a, b, c], sel, next, 'F');
    // 지금 목록에 작업을 적용해 결과를 확인한다
    const list: Entity[] = [a, b, c];
    for (const op of ops) {
      if (op.kind === 'remove') list.splice(op.index, 1);
      else if (op.kind === 'add') list.splice(op.index ?? list.length, 0, op.entity);
    }
    expect(list.map((e) => e.handle)).toEqual(next.map((e) => e.handle));
    expect(list.map((e) => e.handle)).toEqual([c.handle, b.handle, a.handle]);
  });
});

describe('MKLTYPE', () => {
  it('선·점으로 대시·틈·점, 앞 틈은 끝 틈으로 돌린다', () => {
    const r = linetypeFromObjects(
      { start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      [line(1, 0, 4, 0), line(3, 0, 5, 0), point(7, 0), line(0, 3, 10, 3)],
      doc,
    );
    if (typeof r === 'string') throw new Error(r);
    expect(r.elements.map((e) => +e.length.toFixed(9))).toEqual([4, -2, 0, -4]);
    expect(r.pattern).toBe('A,4,-2,0,-4');
    expect(r.patternLength).toBe(10);
  });
  it('문자 요소는 그 자리에서 시작하는 요소에 붙는다', () => {
    const t = text('GAS', 5, -0.5, { height: 0.5 });
    const r = linetypeFromObjects({ start: { x: 0, y: 0 }, end: { x: 8, y: 0 } }, [line(0, 0, 3, 0), t], doc);
    if (typeof r === 'string') throw new Error(r);
    expect(r.elements.map((e) => +e.length.toFixed(9))).toEqual([3, -2, -3]);
    expect(r.elements[2]!.flags).toBe(2);
    expect(r.elements[2]!.text).toBe('GAS');
    expect(r.elements[2]!.offset.y).toBeCloseTo(-0.5, 9);
    expect(r.pattern).toBe('A,3,-2,["GAS",Standard,S=0.5,R=0,X=0,Y=-0.5],-3');
    expect(linFileText('GASLINE', 'Gas line', r.pattern)).toContain('*GASLINE,Gas line\nA,3,-2,');
  });
  it('선이 없으면 안내, 이름 검사', () => {
    expect(typeof linetypeFromObjects({ start: { x: 0, y: 0 }, end: { x: 5, y: 0 } }, [line(0, 1, 5, 1)], doc)).toBe('string');
    expect(linetypeNameProblem('ByLayer')).not.toBeNull();
    expect(linetypeNameProblem('A;B')).not.toBeNull();
    expect(linetypeNameProblem('MY_LINE')).toBeNull();
  });
});

describe('REDIR', () => {
  it('폴더 바꾸기(대소문자·구분 기호 무시), * = 폴더 전체', () => {
    expect(redirPath('C:\\Old\\Refs\\a.dwg', 'c:/old', 'D:\\New')).toBe('D:\\New\\Refs\\a.dwg');
    expect(redirPath('C:\\Old\\a.dwg', '*', 'E:\\x')).toBe('E:\\x\\a.dwg');
    expect(redirPath('a.dwg', '*', 'E:/x')).toBe('E:/x/a.dwg');
    expect(redirPath('C:\\Other\\a.dwg', 'old', 'new')).toBeNull();
    expect(redirPath('romans.shx', '*', 'C:\\fonts', true)).toBeNull();
  });
  it('외부 참조·이미지·스타일 글꼴 작업', () => {
    const d = createNewDocument('metric');
    d.blocks.set('XR1', { name: 'XR1', handle: '9001', recordHandle: '9002', basePoint: { x: 0, y: 0, z: 0 }, flags: 4, xrefPath: 'C:\\proj\\xr1.dwg', entities: [] });
    const img: ImageDefObject = { type: 'IMAGEDEF', handle: '9003', fileName: 'C:\\proj\\img\\p.png', imageSize: { x: 1, y: 1 }, pixelSize: { x: 1, y: 1 }, loaded: true, resolutionUnits: 0 };
    d.objects.set('9003', img);
    const st = [...d.textStyles.values()][0]!;
    d.textStyles.set('FONTDIR', { ...st, name: 'FONTDIR', handle: '9004', font: 'C:\\proj\\fonts\\x.shx' });
    const { ops, changes } = redirOps(d, 'C:\\proj', 'Z:\\p2', { styles: true, xrefs: true, images: true, rtext: false });
    expect(changes.map((c) => [c.kind, c.after])).toEqual([
      ['xref', 'Z:\\p2\\xr1.dwg'],
      ['image', 'Z:\\p2\\img\\p.png'],
      ['style', 'Z:\\p2\\fonts\\x.shx'],
    ]);
    expect(ops.map((o) => o.kind)).toEqual(['blockDef', 'object', 'textStyle']);
    const none = redirOps(d, 'C:\\proj', 'Z:\\p2', { styles: false, xrefs: false, images: false, rtext: false });
    expect(none.ops).toEqual([]);
  });
});

describe('SSX 벡터', () => {
  it('돌출 방향은 공백이나 쉼표로 받고 단위 벡터로', () => {
    const f = ssxSetValue({}, 'vector', '0 0 -2') as { vector: { x: number; y: number; z: number } };
    expect(f.vector).toEqual({ x: 0, y: 0, z: -1 });
    expect(ssxSetValue({}, 'vector', '0,0,1')).toEqual({ vector: { x: 0, y: 0, z: 1 } });
    expect(typeof ssxSetValue({}, 'vector', '0 0')).toBe('string');
  });
});

describe('SSX 색', () => {
  it('트루컬러는 R G B(공백)로도 받는다', () => {
    expect(ssxSetValue({}, 'color', '255 128 0')).toEqual({ color: { aci: 7, rgb: 0xff8000 } });
    expect(ssxSetValue({}, 'color', 'bylayer')).toEqual({ color: { aci: 256 } });
  });
});
