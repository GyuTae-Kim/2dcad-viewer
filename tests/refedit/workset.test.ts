/** 참조 편집: 작업 세트 ↔ 정의 변환과 역변환, 새 객체 넣기·빼기, 거절 */
import { describe, expect, it } from 'vitest';
import type { BlockDef, CadDocument, Entity, InsertEntity, LineEntity, TextEntity } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults, tableKey } from '../../src/core/model';
import { applyOps } from '../../src/edit/session';
import { MSG_MINSERT, MSG_NONUNIFORM, insertXf, chainXf, composeXf, invertXf } from '../../src/edit/refedit/xform';
import { openWorkingSet, planSave, referencedBlocks, dropBlocksOps, seedAllocator } from '../../src/edit/refedit/workset';
import { affApply } from '../../src/edit/geom/math';
import { arc, circle, line, lw, newDoc, text } from '../edit/make';

function counter(start = 0x8000): () => string {
  let n = start;
  return () => (n++).toString(16).toUpperCase();
}

function blockDoc(ents: Entity[], base = { x: 0, y: 0, z: 0 }): { doc: CadDocument; def: BlockDef } {
  const doc = newDoc();
  const def: BlockDef = { name: 'PART', handle: 'B1', recordHandle: 'B2', basePoint: base, flags: 0, entities: [] };
  doc.blocks.set('PART', def);
  doc.blockRecords.set('PART', { name: 'PART', handle: 'B2', flags: 0, insertUnits: 0, explodable: true, scalable: true });
  for (const e of ents) {
    e.owner = 'B2';
    def.entities.push(e);
    doc.entityIndex.set(e.handle, e);
  }
  return { doc, def };
}

function insert(block: string, x: number, y: number, s = 1, rot = 0, extra: Partial<InsertEntity> = {}): InsertEntity {
  return {
    type: 'INSERT',
    ...entityDefaults(),
    handle: 'I' + Math.floor(Math.random() * 1e6).toString(16).toUpperCase(),
    block,
    insert: { x, y, z: 0 },
    scale: { x: s, y: s, z: s },
    rotation: rot,
    columnCount: 1,
    rowCount: 1,
    columnSpacing: 0,
    rowSpacing: 0,
    attribs: [],
    ...extra,
  };
}

const near = (a: number, b: number, tol = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(tol);

function msEntities(doc: CadDocument): Entity[] {
  return doc.blocks.get(MODEL_SPACE)!.entities;
}

describe('참조 변환', () => {
  it('삽입점·회전·축척·기준점 — 분해와 같은 행렬, 역변환은 원래대로', () => {
    const ins = insert('PART', 100, 50, 2, Math.PI / 6);
    const xf = insertXf({ basePoint: { x: 10, y: 0, z: 0 } }, ins);
    expect(typeof xf).toBe('object');
    if (typeof xf === 'string') return;
    // 기준점(10,0)은 삽입점으로
    const p = affApply(xf.m, { x: 10, y: 0 });
    near(p.x, 100);
    near(p.y, 50);
    const q = affApply(xf.m, { x: 11, y: 0 });
    near(Math.hypot(q.x - 100, q.y - 50), 2);
    near(Math.atan2(q.y - 50, q.x - 100), Math.PI / 6);
    const inv = invertXf(xf)!;
    const r = affApply(inv.m, q);
    near(r.x, 11);
    near(r.y, 0);
  });

  it('MINSERT·X≠Y 축척은 거절, 대칭(음의 균일 축척)은 받는다', () => {
    expect(insertXf({ basePoint: { x: 0, y: 0, z: 0 } }, insert('PART', 0, 0, 1, 0, { columnCount: 3, columnSpacing: 10 }))).toBe(MSG_MINSERT);
    expect(insertXf({ basePoint: { x: 0, y: 0, z: 0 } }, insert('PART', 0, 0, 1, 0, { scale: { x: 1, y: 2, z: 1 } }))).toBe(MSG_NONUNIFORM);
    const m = insertXf({ basePoint: { x: 0, y: 0, z: 0 } }, insert('PART', 0, 0, 1, 0, { scale: { x: -1, y: 1, z: 1 } }));
    expect(typeof m).toBe('object');
  });

  it('내포된 참조는 바깥부터 곱한다', () => {
    const a = insert('A', 100, 0, 2);
    const b = insert('B', 5, 5, 1, Math.PI / 2);
    const xf = chainXf([
      { def: { basePoint: { x: 0, y: 0, z: 0 } }, insert: a },
      { def: { basePoint: { x: 0, y: 0, z: 0 } }, insert: b },
    ]);
    if (typeof xf === 'string') throw new Error(xf);
    // B 정의의 (1,0) → B 안에서 (5,6) → A 안에서 (110,12)
    const p = affApply(xf.m, { x: 1, y: 0 });
    near(p.x, 110);
    near(p.y, 12);
    const xa = insertXf({ basePoint: { x: 0, y: 0, z: 0 } }, a) as Exclude<ReturnType<typeof insertXf>, string>;
    const xb = insertXf({ basePoint: { x: 0, y: 0, z: 0 } }, b) as Exclude<ReturnType<typeof insertXf>, string>;
    const c = composeXf(xa, xb);
    near(c.m[4], xf.m[4]);
  });
});

describe('작업 세트(블록)', () => {
  function setup(s = 2, rot = Math.PI / 6) {
    const l = line(0, 0, 10, 0);
    const c = circle(5, 5, 2);
    const a = arc(0, 0, 4, 0, 90);
    const t = text(1, 1, 'A1', 2.5, 0);
    const p = lw([
      [0, 0],
      [3, 0, 0.5],
      [3, 3],
    ]);
    const { doc, def } = blockDoc([l, c, a, t, p]);
    const ins = insert('PART', 100, 50, s, rot);
    ins.owner = doc.blocks.get(MODEL_SPACE)!.recordHandle;
    msEntities(doc).push(ins);
    doc.entityIndex.set(ins.handle, ins);
    const xf = insertXf(def, ins);
    if (typeof xf === 'string') throw new Error(xf);
    const newHandle = counter();
    const target = { kind: 'block' as const, doc, key: 'PART', xf };
    const res = openWorkingSet(target, { host: doc, space: MODEL_SPACE, attdefs: false, newHandle });
    applyOps(doc, res.ops);
    return { doc, def, ins, xf, target, res, newHandle, l, c, a, t, p };
  }

  it('열면 정의의 객체가 참조 자리에 사본으로 놓인다', () => {
    const { doc, res, xf, l } = setup();
    expect(res.copies.length).toBe(5);
    expect(res.skipped).toBe(0);
    expect(msEntities(doc).length).toBe(6);
    const cl = res.copies.find((e) => res.origin.get(e.handle) === l.handle) as LineEntity;
    const s = affApply(xf.m, { x: 0, y: 0 });
    const e = affApply(xf.m, { x: 10, y: 0 });
    near(cl.start.x, s.x);
    near(cl.start.y, s.y);
    near(cl.end.x, e.x);
    near(cl.end.y, e.y);
    // 사본은 새 핸들, 현재 공간 소유
    expect(cl.handle).not.toBe(l.handle);
    expect(cl.owner).toBe(doc.blocks.get(MODEL_SPACE)!.recordHandle);
  });

  it('그대로 저장하면 정의는 바뀌지 않고 작업 세트만 빠진다', () => {
    const { doc, def, target, res, newHandle } = setup();
    const before = JSON.stringify(def.entities);
    const working = msEntities(doc).filter((e) => res.origin.has(e.handle));
    const plan = planSave({ target, host: doc, space: MODEL_SPACE, working, origin: res.origin, snapshot: res.snapshot, newHandle });
    expect(plan.error).toBeUndefined();
    expect(plan.kept).toBe(5);
    expect(plan.changed + plan.added + plan.removed).toBe(0);
    expect(plan.defOps.length).toBe(0);
    applyOps(doc, [...plan.removeWorking, ...plan.defOps]);
    expect(msEntities(doc).length).toBe(1);
    expect(JSON.stringify(doc.blocks.get('PART')!.entities)).toBe(before);
  });

  it('바꾼 사본은 역변환해 원래 핸들로, 새 객체는 정의에 더하고, 지운 사본은 정의에서 지운다', () => {
    const { doc, target, res, newHandle, xf, l, c, t } = setup();
    const ms = doc.blocks.get(MODEL_SPACE)!;
    const work = (h: string) => ms.entities.find((e) => res.origin.get(e.handle) === h)!;
    // 선 끝점 옮기기: 정의 좌표 (10,0) → (10,4)
    const wl = work(l.handle) as LineEntity;
    const to = affApply(xf.m, { x: 10, y: 4 });
    applyOps(doc, [{ kind: 'modify', block: MODEL_SPACE, before: wl, after: { ...wl, end: { x: to.x, y: to.y, z: 0 } } }]);
    // 원 지우기
    const wc = work(c.handle);
    applyOps(doc, [{ kind: 'remove', block: MODEL_SPACE, entity: wc, index: ms.entities.indexOf(wc) }]);
    // 새 선: 정의 좌표 (0,10)-(10,10)
    const a0 = affApply(xf.m, { x: 0, y: 10 });
    const a1 = affApply(xf.m, { x: 10, y: 10 });
    const nl: Entity = { ...line(a0.x, a0.y, a1.x, a1.y), handle: newHandle() };
    applyOps(doc, [{ kind: 'add', block: MODEL_SPACE, entity: nl }]);
    // 문자 내용 바꾸기
    const wt = work(t.handle) as TextEntity;
    applyOps(doc, [{ kind: 'modify', block: MODEL_SPACE, before: wt, after: { ...wt, text: 'B2' } }]);

    const ins = ms.entities.find((e) => e.type === 'INSERT')!;
    const working = ms.entities.filter((e) => e !== ins);
    const plan = planSave({ target, host: doc, space: MODEL_SPACE, working, origin: res.origin, snapshot: res.snapshot, newHandle });
    expect(plan.error).toBeUndefined();
    expect(plan.changed).toBe(2);
    expect(plan.added).toBe(1);
    expect(plan.removed).toBe(1);
    expect(plan.kept).toBe(2);
    applyOps(doc, [...plan.removeWorking, ...plan.defOps]);
    const d = doc.blocks.get('PART')!;
    expect(d.entities.length).toBe(5);
    const dl = d.entities.find((e) => e.handle === l.handle) as LineEntity;
    near(dl.start.x, 0, 1e-7);
    near(dl.start.y, 0, 1e-7);
    near(dl.end.x, 10, 1e-7);
    near(dl.end.y, 4, 1e-7);
    expect(dl.owner).toBe('B2');
    expect(d.entities.some((e) => e.handle === c.handle)).toBe(false);
    const dt = d.entities.find((e) => e.handle === t.handle) as TextEntity;
    expect(dt.text).toBe('B2');
    near(dt.insert.x, 1, 1e-7);
    near(dt.height, 2.5, 1e-9);
    near(dt.rotation, 0, 1e-9);
    const added = d.entities[d.entities.length - 1] as LineEntity;
    expect(added.type).toBe('LINE');
    near(added.start.y, 10, 1e-7);
    near(added.end.x, 10, 1e-7);
    expect(added.owner).toBe('B2');
    // 현재 공간에는 블록 참조만 남는다
    expect(ms.entities.map((e) => e.type)).toEqual(['INSERT']);
    // 색인
    expect(doc.entityIndex.get(l.handle)).toBe(dl);
  });

  it('작업 세트에서 뺀 사본(REFSET 제거)은 도면에 남고 정의에서는 빠진다', () => {
    const { doc, target, res, newHandle, a } = setup();
    const ms = doc.blocks.get(MODEL_SPACE)!;
    const wa = ms.entities.find((e) => res.origin.get(e.handle) === a.handle)!;
    const working = ms.entities.filter((e) => e.type !== 'INSERT' && e !== wa);
    const plan = planSave({ target, host: doc, space: MODEL_SPACE, working, origin: res.origin, snapshot: res.snapshot, newHandle });
    expect(plan.removed).toBe(1);
    applyOps(doc, [...plan.removeWorking, ...plan.defOps]);
    expect(ms.entities.includes(wa)).toBe(true);
    expect(doc.blocks.get('PART')!.entities.some((e) => e.handle === a.handle)).toBe(false);
  });

  it('도면 객체를 작업 세트에 넣으면(REFSET 추가) 역변환해 정의로 옮긴다', () => {
    const { doc, target, res, newHandle, xf } = setup(1, 0);
    const ms = doc.blocks.get(MODEL_SPACE)!;
    const p0 = affApply(xf.m, { x: -5, y: -5 });
    const host: Entity = { ...circle(p0.x, p0.y, 1), handle: newHandle(), owner: ms.recordHandle };
    applyOps(doc, [{ kind: 'add', block: MODEL_SPACE, entity: host }]);
    const working = ms.entities.filter((e) => e.type !== 'INSERT');
    const plan = planSave({ target, host: doc, space: MODEL_SPACE, working, origin: res.origin, snapshot: res.snapshot, newHandle });
    expect(plan.added).toBe(1);
    applyOps(doc, [...plan.removeWorking, ...plan.defOps]);
    expect(ms.entities.includes(host)).toBe(false);
    const d = doc.blocks.get('PART')!;
    const nc = d.entities[d.entities.length - 1]!;
    expect(nc.type).toBe('CIRCLE');
    if (nc.type === 'CIRCLE') {
      near(nc.center.x, -5, 1e-9);
      near(nc.radius, 1, 1e-12);
    }
  });

  it('대칭 참조의 문자: 고쳐도 되돌리면 원래 방향', () => {
    const t = text(2, 3, 'MIR', 2.5, 0);
    const { doc, def } = blockDoc([t]);
    const ins = insert('PART', 0, 0, 1, 0, { scale: { x: -1, y: 1, z: 1 } });
    msEntities(doc).push(ins);
    const xf = insertXf(def, ins);
    if (typeof xf === 'string') throw new Error(xf);
    const newHandle = counter();
    const target = { kind: 'block' as const, doc, key: 'PART', xf };
    const res = openWorkingSet(target, { host: doc, space: MODEL_SPACE, attdefs: false, newHandle });
    applyOps(doc, res.ops);
    const w = res.copies[0] as TextEntity;
    // 거울상 문자(뒤집힘)
    expect(w.generation & 2).toBe(2);
    applyOps(doc, [{ kind: 'modify', block: MODEL_SPACE, before: w, after: { ...w, text: 'MIR2' } }]);
    const working = msEntities(doc).filter((e) => e.type !== 'INSERT');
    const plan = planSave({ target, host: doc, space: MODEL_SPACE, working, origin: res.origin, snapshot: res.snapshot, newHandle });
    applyOps(doc, [...plan.removeWorking, ...plan.defOps]);
    const back = doc.blocks.get('PART')!.entities[0] as TextEntity;
    expect(back.text).toBe('MIR2');
    expect(back.generation & 2).toBe(0);
    near(back.insert.x, 2, 1e-9);
    near(back.insert.y, 3, 1e-9);
  });

  it('블록 자신의 참조를 넣거나 모두 지우면 저장할 수 없다', () => {
    const { doc, target, res, newHandle } = setup();
    const ms = doc.blocks.get(MODEL_SPACE)!;
    const self = { ...insert('PART', 0, 0), handle: newHandle() };
    applyOps(doc, [{ kind: 'add', block: MODEL_SPACE, entity: self }]);
    const ins = ms.entities.find((e) => e.type === 'INSERT' && e !== self)!;
    const working = ms.entities.filter((e) => e !== ins);
    const plan = planSave({ target, host: doc, space: MODEL_SPACE, working, origin: res.origin, snapshot: res.snapshot, newHandle });
    expect(plan.error).toBe('블록 "PART"이(가) 자신을 참조합니다.');
    const none = planSave({ target, host: doc, space: MODEL_SPACE, working: [], origin: res.origin, snapshot: res.snapshot, newHandle });
    expect(none.error).toBe('작업 세트가 비어 있어 블록 정의를 저장할 수 없습니다.');
  });

  it('속성 정의는 표시를 켰을 때만 작업 세트에 든다', () => {
    const att: Entity = { ...(text(0, 0, 'TAG', 2.5) as TextEntity), type: 'ATTDEF', tag: 'TAG', attFlags: 0, prompt: '값' } as unknown as Entity;
    const { doc, def } = blockDoc([line(0, 0, 1, 0), att]);
    const ins = insert('PART', 0, 0);
    msEntities(doc).push(ins);
    const xf = insertXf(def, ins) as Exclude<ReturnType<typeof insertXf>, string>;
    const off = openWorkingSet({ kind: 'block', doc, key: 'PART', xf }, { host: doc, space: MODEL_SPACE, attdefs: false, newHandle: counter() });
    expect(off.copies.length).toBe(1);
    expect(off.hiddenAttdefs).toBe(1);
    const on = openWorkingSet({ kind: 'block', doc, key: 'PART', xf }, { host: doc, space: MODEL_SPACE, attdefs: true, newHandle: counter(0x9000) });
    expect(on.copies.length).toBe(2);
    expect(on.copies[1]!.type).toBe('ATTDEF');
  });
});

describe('블록 정리·핸들', () => {
  it('쓰이지 않는 만든 블록만 지운다', () => {
    const { doc } = blockDoc([line(0, 0, 1, 0)]);
    const used = referencedBlocks(doc);
    expect(used.has('PART')).toBe(false);
    const ops = dropBlocksOps(doc, ['PART'], used);
    expect(ops.map((o) => o.kind)).toEqual(['blockDef', 'blockRecord']);
    msEntities(doc).push(insert('PART', 0, 0));
    expect(dropBlocksOps(doc, ['PART'], referencedBlocks(doc)).length).toBe(0);
  });

  it('다른 도면의 핸들은 가장 큰 핸들 다음부터, $HANDSEED 작업을 돌려준다', () => {
    const { doc } = blockDoc([line(0, 0, 1, 0)]);
    doc.header.set('$HANDSEED', '10');
    const a = seedAllocator(doc);
    const h1 = a.newHandle();
    const h2 = a.newHandle();
    expect(BigInt('0x' + h2)).toBe(BigInt('0x' + h1) + 1n);
    const fin = a.finish();
    expect(fin.length).toBe(1);
    const op = fin[0]!;
    expect(op.kind === 'header' && op.name === '$HANDSEED' && BigInt('0x' + String(op.after)) === BigInt('0x' + h2) + 1n).toBe(true);
    expect(tableKey(h1)).toBe(h1);
  });
});
