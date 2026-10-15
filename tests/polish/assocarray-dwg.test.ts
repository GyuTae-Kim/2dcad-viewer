/**
 * DXF에서 읽은 AutoCAD 연관 배열을 DWG로 저장: 연관 객체(ACDBASSOC…)는 DWG 코덱(src/io/dwg/assoccodec.ts)으로 함께 쓰이고,
 * DWG 쓰기는 배열 참조에 이 앱의 배열 기록(OPENCAD_ARRAY)도 붙인다(연관 객체를 쓸 수 없는 배열의 근거) — 다시 열어도 배열로 남는다.
 * 문서 자체와 DXF 저장은 그대로(AutoCAD 기록만)다.
 */
import { describe, expect, it } from 'vitest';
import type { CadDocument, InsertEntity } from '../../src/core/model';
import { readArray } from '../../src/edit/assocarray/read';
import { ARRAY_APP, recordOf } from '../../src/edit/assocarray/record';
import type { PathParams, PolarParams, RectParams } from '../../src/edit/assocarray/types';
import { readCadFile } from '../../src/io';
import { writeDxf } from '../../src/io/dxf/writer';
import { writeDwg } from '../../src/io/dwg';
import { bench, pathFixture, polarFixture, rectFixture } from '../assocarray/fixture';

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

/** AutoCAD 배열 세 개(직사각형·원형·경로)를 DXF R2018로 저장했다 다시 읽은 문서(원본 태그가 있다) */
function dxfDoc() {
  const b = bench();
  const rect = rectFixture(b);
  const polar = polarFixture(b);
  const path = pathFixture(b, [200, 0]);
  const doc = readCadFile(writeDxf(b.doc, { version: 'AC1032' }).data, 'acad-arrays.dxf');
  return { doc, rect: rect.ins.handle, polar: polar.ins.handle, path: path.ins.handle };
}

const ins = (doc: CadDocument, h: string) => doc.entityIndex.get(h) as InsertEntity;

describe('AutoCAD 연관 배열 DXF → DWG', () => {
  for (const version of ['AC1032', 'AC1015'] as const) {
    it(`DWG ${version}로 저장하고 다시 열어도 같은 매개변수의 배열이다(AutoCAD 기록 + 이 앱 기록)`, () => {
      const s = dxfDoc();
      for (const h of [s.rect, s.polar, s.path]) expect(readArray(s.doc, ins(s.doc, h))!.origin).toBe('acad');
      const out = writeDwg(s.doc, { version });
      const back = readCadFile(out.data, 'x.dwg');
      // 연관 객체도 DWG로 쓰인다(DWG 코덱)
      expect([...back.objects.values()].some((o) => o.type === 'ACDBASSOCARRAYACTIONBODY')).toBe(true);
      const r = readArray(back, ins(back, s.rect))!;
      expect(r).not.toBeNull();
      expect(r.origin).toBe('acad');
      const rp = r.state.params as RectParams;
      expect([rp.columns, rp.rows, rp.columnSpacing, rp.rowSpacing]).toEqual([4, 2, 10, 5]);
      expect(r.items.size).toBe(8);
      const p = readArray(back, ins(back, s.polar))!;
      const pp = p.state.params as PolarParams;
      expect(p.origin).toBe('acad');
      expect(pp.items).toBe(6);
      close(pp.radius, 8, 1e-9);
      close(pp.center.x, 20, 1e-9);
      expect(p.items.size).toBe(6);
      const q = readArray(back, ins(back, s.path))!;
      const qp = q.state.params as PathParams;
      // 경로 배열의 곡선 캐시(복합 곡선, 호 포함)도 DWG 코덱이 쓴다(곡선 경로 배열 DWG로 확인한 배치) → AutoCAD 기록으로 남는다
      expect(q.origin).toBe('acad');
      expect([qp.items, qp.method]).toEqual([5, 'divide']);
      expect(q.items.size).toBe(5);
      // 원본 블록도 같다
      expect(q.state.source.toUpperCase()).toBe(readArray(s.doc, ins(s.doc, s.path))!.state.source.toUpperCase());
      // 이 앱 기록도 붙어 있고, 떼어도 AutoCAD 기록으로 배열이다
      expect(recordOf(ins(back, s.rect).xdata)).toBeDefined();
      const bare = { ...ins(back, s.rect), xdata: ins(back, s.rect).xdata?.filter((x) => x.app.toUpperCase() !== ARRAY_APP) };
      expect(readArray(back, bare)!.origin).toBe('acad');
    });
  }

  it('문서는 고치지 않는다: DWG로 쓴 뒤에도 DXF 저장에는 이 앱 기록이 없다', () => {
    const s = dxfDoc();
    writeDwg(s.doc, { version: 'AC1032' });
    for (const h of [s.rect, s.polar, s.path]) expect(recordOf(ins(s.doc, h).xdata)).toBeUndefined();
    const text = new TextDecoder().decode(writeDxf(s.doc, { version: 'AC1032' }).data);
    expect(text.includes(ARRAY_APP)).toBe(false);
  });

  it('DWG에서 다시 DWG·DXF로 저장해도 배열로 남는다', () => {
    const s = dxfDoc();
    const dwg = readCadFile(writeDwg(s.doc, { version: 'AC1032' }).data, 'x.dwg');
    const again = readCadFile(writeDwg(dwg, { version: 'AC1018' }).data, 'y.dwg');
    expect((readArray(again, ins(again, s.rect))!.state.params as RectParams).columns).toBe(4);
    const dxf = readCadFile(writeDxf(dwg, { version: 'AC1032' }).data, 'z.dxf');
    expect((readArray(dxf, ins(dxf, s.polar))!.state.params as PolarParams).items).toBe(6);
  });
});
