import { describe, expect, it } from 'vitest';
import type { AttribEntity, InsertEntity, LineEntity } from '../../src/core/model';
import { MODEL_SPACE } from '../../src/core/model';
import { allAttdefs, buildAttribs, syncAllOps, withAttdefs } from '../../src/edit/util/blockutil';
import { createGroupOps, listGroups } from '../../src/edit/util/groups';
import { buildWblockDocument } from '../../src/edit/util/wblock';
import { CalcError, prepareCalc } from '../../src/edit/util/calc';
import { readDwg, writeDwg } from '../../src/io/dwg/index';
import { addBlock, attdef, circle, insert, line, put, setup } from './helpers';

describe('BATTMAN 정의 고치기', () => {
  it('속성 정의 자리를 새 순서로 채우고, 동기화가 참조를 맞춘다', () => {
    const { doc, s, h } = setup();
    const def = addBlock(doc, h, 'T', [attdef(h(), 'A', 'a', 0, 0), line(h(), 0, 0, 1, 0), attdef(h(), 'B', 'b', 0, 2)]);
    const ins = insert(h(), 'T', 10, 0, { layer: '0' });
    ins.attribs = buildAttribs(def, ins, new Map([['A', '1'], ['B', '2']]), h);
    put(doc, ins);
    const [a, b] = allAttdefs(def);
    const b2 = { ...b!, tag: 'BB', text: 'bb' } as AttribEntity;
    const nd = withAttdefs(def, [b2, a!]);
    expect(nd.entities.map((e) => (e.type === 'ATTDEF' ? (e as AttribEntity).tag : e.type))).toEqual(['BB', 'LINE', 'A']);
    const r = syncAllOps(doc, 'T', h, nd);
    s.commit({ label: 'BATTMAN', ops: [{ kind: 'blockDef', key: 'T', before: def, after: nd }, ...r.ops] });
    const got = doc.entityIndex.get(ins.handle) as InsertEntity;
    expect(got.attribs.map((x) => `${x.tag}=${x.text}`)).toEqual(['BB=bb', 'A=1']);
    expect(withAttdefs(nd, []).flags & 2).toBe(0);
    // 잠긴 도면층은 건너뛴다
    doc.layers.get('0')!.locked = true;
    expect(syncAllOps(doc, 'T', h).locked).toBe(1);
  });
});

describe('getvar 풀기', () => {
  it('getvar는 값으로, 없는 변수는 오류', () => {
    expect(prepareCalc('getvar(ltscale)+cur', (n) => (n === 'ltscale' ? 3 : undefined)).picks).toEqual(['cur']);
    expect(() => prepareCalc('getvar(nope)', () => undefined)).toThrow(CalcError);
  });
});

describe('DWG로 쓰고 읽기', () => {
  it('WBLOCK 결과와 그룹이 DWG에서도 남는다', () => {
    const { doc, s, h } = setup();
    addBlock(doc, h, 'B', [circle(h(), 0, 0, 1)]);
    const a = line(h(), 50, 50, 60, 50);
    const i = insert(h(), 'B', 55, 55);
    put(doc, a, i);
    s.commit({ label: 'GROUP', ops: createGroupOps(doc, 'G1', '', [a.handle, i.handle], h)!.ops });
    const back = readDwg(writeDwg(doc, { version: 'AC1032' }).data);
    expect(listGroups(back).map((g) => [g.name, g.group.entities.length])).toEqual([['G1', 2]]);
    const w = buildWblockDocument(doc, { kind: 'objects', handles: [a.handle, i.handle], base: { x: 50, y: 50 } });
    const wb = readDwg(writeDwg(w.doc, { version: 'AC1018' }).data);
    const ms = wb.blocks.get(MODEL_SPACE)!.entities;
    expect(ms.map((e) => e.type)).toEqual(['LINE', 'INSERT']);
    expect((ms[0] as LineEntity).end.x).toBeCloseTo(10);
    expect(wb.blocks.has('B')).toBe(true);
    expect(listGroups(wb)).toEqual([]);
  });
});
