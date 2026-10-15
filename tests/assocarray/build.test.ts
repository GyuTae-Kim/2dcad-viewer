/** 이 앱이 만드는 연관 배열: 만들기, 다시 계산(값·지우기·대체·재설정·원본 내용·복사본), 경로 따라가기, DXF·DWG 왕복 */
import { describe, expect, it } from 'vitest';
import type { Entity, InsertEntity, LineEntity } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults, tableKey } from '../../src/core/model';
import { type BuildEnv, blockCopies, createArrayOps, regenerateOps } from '../../src/edit/assocarray/build';
import { readArray } from '../../src/edit/assocarray/read';
import { cloneState, type ArrayParams, type PathParams, type RectParams } from '../../src/edit/assocarray/types';
import { allocBlockName } from '../../src/edit/geom/types';
import { affTranslate } from '../../src/edit/geom/math';
import { insertAffine } from '../../src/edit/dynblock/build';
import { EditSession } from '../../src/edit/session';
import { readCadFile } from '../../src/io';
import { writeDxf } from '../../src/io/dxf/writer';
import { writeDwg } from '../../src/io/dwg';
import { type Bench, addModel, bench, circleE, insertE, lineE } from './fixture';

const env = (b: Bench): BuildEnv => ({ doc: b.doc, newHandle: () => b.s.newHandle(), newBlockName: () => allocBlockName(b.doc, '*U') });
const props = () => {
  const { handle: _h, ...rest } = { ...entityDefaults(), handle: '' };
  void _h;
  return rest;
};

/** 모형 공간에 원 하나(중심 (1,1)) → 3열 × 2행 직사각형 연관 배열 */
function makeRect(b: Bench): InsertEntity {
  const c = addModel(b, circleE(1, 1, 0.5));
  const params: RectParams = { kind: 'rect', base: { x: 0, y: 0 }, origin: { x: 0, y: 0 }, columns: 3, columnSpacing: 4, rows: 2, rowSpacing: 3, rowElevation: 0, levels: 1, levelSpacing: 1, axesAngle: Math.PI / 2 };
  const r = createArrayOps(env(b), { params, sources: [c], normalize: affTranslate(-1, -1), insert: { x: 1, y: 1, z: 0 }, rotation: 0, props: props(), space: MODEL_SPACE });
  if ('error' in r) throw new Error(r.error);
  b.s.commit({ label: 'ARRAYRECT', ops: r.ops });
  return b.doc.entityIndex.get(r.insert.handle) as InsertEntity;
}

/** 배열 항목 원의 도면 중심 */
function circleCenters(b: Bench, ins: InsertEntity): string[] {
  const def = b.doc.blocks.get(tableKey(ins.block))!;
  const W = insertAffine(def, ins);
  const out: string[] = [];
  for (const it of def.entities as InsertEntity[]) {
    const sd = b.doc.blocks.get(tableKey(it.block))!;
    const M = insertAffine(sd, it);
    for (const e of sd.entities) {
      if (e.type !== 'CIRCLE') continue;
      const x = M[0] * e.center.x + M[2] * e.center.y + M[4];
      const y = M[1] * e.center.x + M[3] * e.center.y + M[5];
      out.push(`${+(W[0] * x + W[2] * y + W[4]).toFixed(6)},${+(W[1] * x + W[3] * y + W[5]).toFixed(6)}`);
    }
  }
  return out.sort();
}

function regen(b: Bench, ins: InsertEntity, f: (s: ReturnType<typeof cloneState>) => void, opt = {}): InsertEntity {
  const info = readArray(b.doc, b.doc.entityIndex.get(ins.handle))!;
  const next = cloneState(info.state);
  f(next);
  const r = regenerateOps(env(b), info, next, opt);
  if ('error' in r) throw new Error(r.error);
  b.s.commit({ label: 'ARRAYEDIT', ops: r.ops });
  return b.doc.entityIndex.get(ins.handle) as InsertEntity;
}

describe('연관 배열 만들기', () => {
  it('원본은 원본 블록으로 들어가고 배열 참조 하나가 남는다', () => {
    const b = bench();
    const ins = makeRect(b);
    const ms = b.doc.blocks.get(MODEL_SPACE)!.entities;
    expect(ms.length).toBe(1);
    expect(ms[0]!.type).toBe('INSERT');
    const info = readArray(b.doc, ins)!;
    // 새 배열도 AutoCAD 연관 객체 망을 만든다(src/edit/assocnet/array.ts) → AutoCAD 기록으로 읽힌다
    expect(info.origin).toBe('acad');
    expect(info.acad?.raw).toBe(true);
    expect(info.items.size).toBe(6);
    // 원본 블록: 기준점(범위 중심)이 원점
    const src = b.doc.blocks.get(tableKey(info.state.source))!;
    expect((src.entities[0] as { center: { x: number } }).center.x).toBe(0);
    expect(circleCenters(b, ins)).toEqual(['1,1', '1,4', '5,1', '5,4', '9,1', '9,4']);
    // 항목 참조는 도면층 0, ByBlock
    const it0 = b.doc.blocks.get(tableKey(ins.block))!.entities[0] as InsertEntity;
    expect([it0.layer, it0.color.aci, it0.linetype, it0.lineweight]).toEqual(['0', 0, 'ByBlock', -2]);
    // 명령 취소 한 번에 원본이 돌아온다
    b.s.undo();
    expect(b.doc.blocks.get(MODEL_SPACE)!.entities.map((e) => e.type)).toEqual(['CIRCLE']);
  });

  it('항목이 하나뿐이거나 경로가 원본이면 만들지 않는다', () => {
    const b = bench();
    const c = addModel(b, circleE(0, 0, 1));
    const one: RectParams = { kind: 'rect', base: { x: 0, y: 0 }, origin: { x: 0, y: 0 }, columns: 1, columnSpacing: 1, rows: 1, rowSpacing: 1, rowElevation: 0, levels: 1, levelSpacing: 1, axesAngle: Math.PI / 2 };
    const r = createArrayOps(env(b), { params: one, sources: [c], normalize: affTranslate(0, 0), insert: { x: 0, y: 0, z: 0 }, rotation: 0, props: props(), space: MODEL_SPACE });
    expect('error' in r && r.error).toContain('하나뿐');
    const pp: PathParams = { kind: 'path', base: { x: 0, y: 0 }, method: 'divide', items: 3, spacing: 1, align: true, zDir: true, reverse: false, path: c.handle, rows: 1, rowSpacing: 1, rowElevation: 0, levels: 1, levelSpacing: 1 };
    const r2 = createArrayOps(env(b), { params: pp, sources: [c], normalize: affTranslate(0, 0), insert: { x: 0, y: 0, z: 0 }, rotation: 0, props: props(), space: MODEL_SPACE });
    expect('error' in r2 && r2.error).toContain('경로');
  });
});

describe('연관 배열 다시 계산(ARRAYEDIT와 같은 길)', () => {
  it('값 바꾸기·지우기·대체·재설정', () => {
    const b = bench();
    let ins = makeRect(b);
    const block0 = ins.block;
    ins = regen(b, ins, (s) => {
      (s.params as RectParams).columns = 4;
    });
    expect(ins.block).toBe(block0);
    expect(circleCenters(b, ins).length).toBe(8);
    // 지우기
    ins = regen(b, ins, (s) => s.removed.add('3,1,0'));
    expect(circleCenters(b, ins)).not.toContain('13,4');
    expect(readArray(b.doc, ins)!.state.removed.has('3,1,0')).toBe(true);
    // 대체: 새 블록(선 하나)으로 항목 하나
    const repName = allocBlockName(b.doc, '*U');
    const rep = blockCopies(env(b), [lineE(0, 0, 2, 0)], affTranslate(0, 0)).entities;
    ins = regen(b, ins, (s) => s.replaced.set('0,0,0', repName), { newBlocks: [{ name: repName, entities: rep }] });
    const info = readArray(b.doc, ins)!;
    expect(info.state.replaced.get('0,0,0')).toBe(repName);
    expect(circleCenters(b, ins).length).toBe(6);
    // 재설정
    ins = regen(b, ins, (s) => {
      s.removed.clear();
      s.replaced.clear();
    });
    expect(circleCenters(b, ins).length).toBe(8);
    // 항목이 하나도 안 남으면 오류
    const all = readArray(b.doc, ins)!;
    const next = cloneState(all.state);
    for (const k of all.items.keys()) next.removed.add(k);
    const r = regenerateOps(env(b), all, next);
    expect('error' in r && r.error).toContain('항목이 하나도');
  });

  it('원본 블록 내용을 바꾸면(원본 편집 저장) 모든 항목이 바뀐다', () => {
    const b = bench();
    let ins = makeRect(b);
    const info = readArray(b.doc, ins)!;
    const copies = blockCopies(env(b), [circleE(0, 0, 0.5), circleE(0.25, 0, 0.1)], affTranslate(0, 0));
    ins = regen(b, ins, () => {}, { contents: [{ name: info.state.source, entities: copies.entities }] });
    expect(circleCenters(b, ins).length).toBe(12);
  });

  it('같은 배열 블록을 쓰는 복사본은 그대로 둔다', () => {
    const b = bench();
    const ins = makeRect(b);
    const copy = { ...structuredClone(ins), handle: '', insert: { x: 100, y: 0, z: 0 } } as InsertEntity;
    const cp = addModel(b, copy) as InsertEntity;
    expect(readArray(b.doc, cp)!.items.size).toBe(6);
    const edited = regen(b, ins, (s) => {
      (s.params as RectParams).rows = 3;
    });
    // AutoCAD 기록 배열은 종속이 블록 레코드를 가리키므로 고친 배열이 블록을 지키고 복사본이 복제 블록으로 간다
    const cp2 = b.doc.entityIndex.get(cp.handle) as InsertEntity;
    expect(edited.block).not.toBe(cp2.block);
    expect(readArray(b.doc, cp2)!.items.size).toBe(6);
    expect(readArray(b.doc, edited)!.items.size).toBe(9);
  });

  it('직사각형 기준점을 옮겨도 항목은 그대로', () => {
    const b = bench();
    let ins = makeRect(b);
    const before = circleCenters(b, ins);
    ins = regen(b, ins, (s) => {
      const p = s.params as RectParams;
      p.base = { x: 0.5, y: 0 };
      p.origin = { x: 0.5, y: 0 };
    });
    expect(circleCenters(b, ins)).toEqual(before);
  });
});

describe('경로 연관 배열', () => {
  it('경로 곡선을 고친 뒤 다시 계산하면 새 경로를 따른다', () => {
    const b = bench();
    const path = addModel(b, lineE(0, 0, 10, 0)) as LineEntity;
    const c = addModel(b, circleE(0, 0, 0.5));
    const params: PathParams = { kind: 'path', base: { x: 0, y: 0 }, method: 'divide', items: 3, spacing: 5, align: true, zDir: true, reverse: false, path: path.handle, tangentRef: 0, rows: 1, rowSpacing: 1, rowElevation: 0, levels: 1, levelSpacing: 1 };
    const r = createArrayOps(env(b), { params, sources: [c], normalize: affTranslate(0, 0), insert: { x: 0, y: 0, z: 0 }, rotation: 0, props: props(), space: MODEL_SPACE });
    if ('error' in r) throw new Error(r.error);
    b.s.commit({ label: 'ARRAYPATH', ops: r.ops });
    let ins = b.doc.entityIndex.get(r.insert.handle) as InsertEntity;
    expect(circleCenters(b, ins)).toEqual(['0,0', '10,0', '5,0']);
    // 경로를 늘린다(배열은 아직 그대로 — 기록을 믿고 "다시 계산할 배열"로 읽는다)
    const longer = { ...path, end: { x: 20, y: 0, z: 0 } } as Entity;
    b.s.commit({ label: 'STRETCH', ops: [{ kind: 'modify', block: MODEL_SPACE, before: path, after: longer }] });
    const stale = readArray(b.doc, ins)!;
    expect(stale.stale).toBe(true);
    expect(stale.items.size).toBe(3);
    ins = regen(b, ins, () => {});
    expect(circleCenters(b, ins)).toEqual(['0,0', '10,0', '20,0']);
    expect(readArray(b.doc, ins)!.stale).toBeUndefined();
  });

  it('지운 경로: 기록에 곡선 캐시가 있으면 그것으로 계산한다', () => {
    const b = bench();
    const c = addModel(b, circleE(0, 0, 0.5));
    const params: PathParams = {
      kind: 'path',
      base: { x: 0, y: 0 },
      method: 'measure',
      items: 3,
      spacing: 2,
      align: false,
      zDir: true,
      reverse: true,
      path: null,
      fallback: [{ k: 'line', a: { x: 0, y: 0 }, b: { x: 0, y: 10 } }],
      rows: 1,
      rowSpacing: 1,
      rowElevation: 0,
      levels: 1,
      levelSpacing: 1,
    };
    const r = createArrayOps(env(b), { params, sources: [c], normalize: affTranslate(0, 0), insert: { x: 0, y: 0, z: 0 }, rotation: 0, props: props(), space: MODEL_SPACE });
    if ('error' in r) throw new Error(r.error);
    b.s.commit({ label: 'ARRAYPATH', ops: r.ops });
    const ins = b.doc.entityIndex.get(r.insert.handle) as InsertEntity;
    // 거꾸로(끝에서 시작) 2씩
    expect(circleCenters(b, ins)).toEqual(['0,10', '0,6', '0,8']);
  });
});

describe('저장 뒤 다시 읽기', () => {
  const kinds: ['dxf' | 'dwg', 'AC1032' | 'AC1015'][] = [
    ['dxf', 'AC1032'],
    ['dxf', 'AC1015'],
    ['dwg', 'AC1032'],
    ['dwg', 'AC1015'],
  ];
  for (const [fmt, version] of kinds)
    it(`${fmt.toUpperCase()} ${version}: 매개변수·지운 항목·대체 블록이 남고 고칠 수 있다`, () => {
      const b = bench();
      let ins = makeRect(b);
      const repName = allocBlockName(b.doc, '*U');
      const rep = blockCopies(env(b), [lineE(0, 0, 2, 0)], affTranslate(0, 0)).entities;
      ins = regen(b, ins, (s) => {
        s.removed.add('1,1,0');
        s.replaced.set('2,0,0', repName);
      }, { newBlocks: [{ name: repName, entities: rep }] });
      const data = fmt === 'dxf' ? writeDxf(b.doc, { version }).data : writeDwg(b.doc, { version }).data;
      const doc = readCadFile(data, `x.${fmt}`);
      const e = [...doc.entityIndex.values()].find((x) => x.type === 'INSERT' && x.xdata?.some((d) => d.app.toUpperCase() === 'OPENCAD_ARRAY'));
      const info = readArray(doc, e)!;
      expect(info).not.toBeNull();
      expect(info.origin).toBe('acad');
      const p: ArrayParams = info.state.params;
      expect(p.kind).toBe('rect');
      expect([...info.state.removed]).toEqual(['1,1,0']);
      expect(info.state.replaced.size).toBe(1);
      expect(info.items.size).toBe(5);
      // 다시 읽은 도면에서 고치기
      const b2: Bench = { doc, s: new EditSession(doc, () => {}) };
      const again = regen(b2, e as InsertEntity, (s) => {
        (s.params as RectParams).columns = 5;
      });
      // 5열 × 2행 − 지운 1
      expect(readArray(doc, again)!.items.size).toBe(9);
    });
});

describe('삽입점 그립 이동과 무관한 참조 변환', () => {
  it('배열 참조를 옮겨도(이동) 다시 읽힌다', () => {
    const b = bench();
    const ins = makeRect(b);
    const moved = { ...ins, insert: { x: 50, y: 60, z: 0 } } as InsertEntity;
    b.s.commit({ label: 'MOVE', ops: [{ kind: 'modify', block: MODEL_SPACE, before: ins, after: moved }] });
    expect(readArray(b.doc, b.doc.entityIndex.get(ins.handle))!.items.size).toBe(6);
    void insertE;
  });
});
