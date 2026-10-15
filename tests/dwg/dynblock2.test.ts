/**
 * DWG 동적 블록 2(손으로 만든 자료 tests/dynblock/fixture2.ts):
 * - 배열 동작이 있는 정의와 사본이 든 표현 블록(같은 ETag 색인의 사본), 정렬 매개변수 정의가 모든 쓰기 버전에서 DWG로 왕복하고
 *   다시 연 도면에서 이어서 고칠 수 있다.
 * - 구속 기반 정의: 대리 노드는 DWG로 쓰지만, 구속 매개변수(BLOCK…CONSTRAINTPARAMETER)는 DWG 배치를 확인하지 못해 쓰지 않으므로
 *   다른 버전으로 쓰면 그 그래프를 뺀다(dwg.write_object_dropped).
 */
import { describe, expect, it } from 'vitest';
import type { CadDocument, CircleEntity, Entity, GenericObject, InsertEntity, LineEntity } from '../../src/core/model';
import { applyOps } from '../../src/edit/session';
import { dynProperties, dynSetOps, readDefinition, readReference } from '../../src/edit/dynblock';
import { readDwg, writeDwg } from '../../src/io/dwg';
import { encodeDyn } from '../../src/io/dwg/dyncodec';
import { loadFixture2 } from '../dynblock/fixture2';

function handles(start: number): () => string {
  let n = start;
  return () => (n++).toString(16).toUpperCase();
}

const etagIdx = (e: Entity) => Number(e.xdata?.find((x) => x.app === 'AcDbBlockRepETag')?.items.find((i) => i.code === 1071)?.value);
const r6 = (n: number) => Math.round(n * 1e6) / 1e6 + 0;
const shape = (doc: CadDocument, ins: InsertEntity) =>
  doc.blocks.get(ins.block.toUpperCase())!.entities.map((e) =>
    e.type === 'CIRCLE' ? `C${etagIdx(e)} ${r6((e as CircleEntity).center.x)},${r6((e as CircleEntity).center.y)}` : `L${etagIdx(e)} ${r6((e as LineEntity).start.x)},${r6((e as LineEntity).start.y)}`,
  );

describe('배열·정렬 정의와 사본이 든 표현 블록이 DWG로 왕복한다', () => {
  for (const v of ['AC1032', 'AC1027', 'AC1024', 'AC1018', 'AC1015'] as const) {
    it(v, () => {
      const { doc, h } = loadFixture2();
      const ins = (d: CadDocument, k: string) => d.entityIndex.get(h[k]!) as InsertEntity;
      applyOps(doc, dynSetOps(doc, ins(doc, 'insR'), [{ key: '길이', value: 17 }, { key: '가로', value: 9 }], handles(0x9000)).ops);
      const want = shape(doc, ins(doc, 'insR'));
      expect(want.length).toBe(2 + 2 + 5);
      const w = writeDwg(doc, { version: v });
      const c = readDwg(w.data);
      for (const k of ['ARR-TEST', 'ALIGN-TEST']) {
        const d = readDefinition(c, k)!;
        expect(d.undecoded, `${v} ${k}`).toEqual([]);
        // 배열 동작·정렬 매개변수 객체는 같은 태그로(블록 요소 판은 형식 계열 값이라 빼고 본다)
        for (const id of [...d.nodeTypes.keys()]) {
          const node = [...c.objects.values()].find((o) => o.owner === d.graphHandle && (o as GenericObject).raw?.some((t) => t.code === 90 && Number(t.value) === id));
          expect(node, `${v} ${k} 노드 ${id}`).toBeTruthy();
        }
      }
      const rc = ins(c, 'insR');
      expect(shape(c, rc)).toEqual(want);
      expect(dynProperties(c, rc)!.map((p) => p.value)).toEqual([17, 9, 4]);
      // 다시 연 도면에서 이어서 고친다: 사본을 다시 만든다
      applyOps(c, dynSetOps(c, rc, { key: '세로', value: 2 }, handles(0x30000)).ops);
      expect(shape(c, ins(c, 'insR'))).toEqual(['C0 0,0', 'L1 0,-0.5', 'C0 5,0', 'C0 10,0', 'L1 3,-0.5', 'L1 6,-0.5']);
      // 정렬 정의도 남는다
      expect(readReference(c, ins(c, 'insG'))!.def.params.map((p) => p.kind)).toEqual(['alignment']);
    });
  }
});

describe('구속 기반 정의와 DWG', () => {
  it('대리 노드는 쓰고, 구속 매개변수는 쓰지 않아 그 그래프를 뺀다(정의는 보통 블록, 형상은 남는다)', () => {
    const { doc, h } = loadFixture2();
    const def = readDefinition(doc, 'CON-TEST')!;
    const proxy = [...doc.objects.values()].find((o) => o.type === 'ACDB_DYNAMICBLOCKPROXYNODE') as GenericObject;
    expect(encodeDyn(proxy.type, proxy.raw, 1032)).toBeTruthy();
    expect(encodeDyn(proxy.type, proxy.raw, 1018)).toBeTruthy();
    applyOps(doc, dynSetOps(doc, doc.entityIndex.get(h.insK!) as InsertEntity, { key: 'W', value: 15 }, handles(0x9000)).ops);
    const w = writeDwg(doc, { version: 'AC1032' });
    expect(w.warnings.some((x) => x.code === 'dwg.write_object_dropped')).toBe(true);
    const c = readDwg(w.data);
    expect(c.objects.has(def.graphHandle)).toBe(false);
    expect(readDefinition(c, 'CON-TEST')).toBeNull();
    const k = c.entityIndex.get(h.insK!) as InsertEntity;
    const ls = c.blocks.get(k.block.toUpperCase())!.entities as LineEntity[];
    expect(ls.map((l) => [r6(l.end.x), r6(l.end.y)])).toEqual([
      [15, 0],
      [15, 5],
    ]);
    // 배열 정의는 같은 도면에서 그대로 남는다
    expect(readDefinition(c, 'ARR-TEST')?.undecoded).toEqual([]);
  });
});
