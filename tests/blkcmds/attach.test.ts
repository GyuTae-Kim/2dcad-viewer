/** IMAGEATTACH·PDFATTACH 작업: 사전 항목·정의 재사용·반응자·축척(INSUNITS), DXF·DWG 왕복 */
import { describe, expect, it } from 'vitest';
import type { DictionaryObject, ImageDefObject, ImageEntity, UnderlayDefObject, UnderlayEntity } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults } from '../../src/core/model';
import { imageAttachOps, pdfAttachOps, unitsPerInch } from '../../src/edit/blkcmds/attach';
import { writeDxf } from '../../src/io/dxf/writer';
import { writeDwg } from '../../src/io/dwg/writer/index';
import { readCadFile } from '../../src/io/index';
import { setup } from '../util2/helpers';

const props = () => {
  const { handle: _h, ...rest } = entityDefaults();
  return rest;
};

const dict = (doc: ReturnType<typeof setup>['doc'], name: string) => {
  const root = doc.objects.get(doc.rootDictionary!) as DictionaryObject;
  const h = [...root.entries].find(([k]) => k.toUpperCase() === name)?.[1];
  return h ? (doc.objects.get(h) as DictionaryObject) : undefined;
};

describe('이미지 부착', () => {
  it('ACAD_IMAGE_DICT·IMAGEDEF·반응자·IMAGE(폭 = 축척, 회전)', () => {
    const t = setup();
    const r = imageAttachOps(t.doc, { fileName: 'site.png', widthPx: 400, heightPx: 300, space: MODEL_SPACE, insert: { x: 10, y: 20, z: 0 }, width: 80, rotation: Math.PI / 2, props: props() }, t.h);
    t.s.commit({ label: 'IMAGEATTACH', ops: r.ops });
    const d = dict(t.doc, 'ACAD_IMAGE_DICT')!;
    expect([...d.entries.keys()]).toEqual(['site']);
    const def = t.doc.objects.get(d.entries.get('site')!) as ImageDefObject;
    expect(def.fileName).toBe('site.png');
    expect(def.imageSize).toEqual({ x: 400, y: 300 });
    const img = t.doc.entityIndex.get(r.image.handle) as ImageEntity;
    expect(img.imageDef).toBe(def.handle);
    expect(t.doc.objects.get(img.imageDefReactor!)!.type).toBe('IMAGEDEF_REACTOR');
    expect(def.reactors).toContain(img.imageDefReactor);
    // 폭 80 → 화소 하나 0.2, 90° 회전
    expect(img.uVector.x).toBeCloseTo(0);
    expect(img.uVector.y).toBeCloseTo(0.2);
    expect(img.vVector.x).toBeCloseTo(-0.2);
    // 같은 파일을 다시 부착하면 정의를 다시 쓰고 사전은 그대로
    const r2 = imageAttachOps(t.doc, { fileName: 'C:\\img\\SITE.PNG', widthPx: 400, heightPx: 300, space: MODEL_SPACE, insert: { x: 0, y: 0, z: 0 }, width: 1, rotation: 0, props: props() }, t.h);
    expect(r2.reused).toBe(true);
    t.s.commit({ label: 'IMAGEATTACH', ops: r2.ops });
    expect([...dict(t.doc, 'ACAD_IMAGE_DICT')!.entries.keys()]).toEqual(['site']);
    expect((t.doc.objects.get(def.handle) as ImageDefObject).reactors).toHaveLength(3);
    // 다른 파일이 같은 이름이면 사전 이름에 번호
    const r3 = imageAttachOps(t.doc, { fileName: 'site.jpg', widthPx: 10, heightPx: 10, space: MODEL_SPACE, insert: { x: 0, y: 0, z: 0 }, width: 1, rotation: 0, props: props() }, t.h);
    t.s.commit({ label: 'IMAGEATTACH', ops: r3.ops });
    expect([...dict(t.doc, 'ACAD_IMAGE_DICT')!.entries.keys()]).toEqual(['site', 'site (2)']);
  });

  it('DXF·DWG로 쓰고 다시 읽으면 이미지와 정의가 이어져 있다', () => {
    const t = setup();
    const r = imageAttachOps(t.doc, { fileName: 'site.png', widthPx: 400, heightPx: 300, space: MODEL_SPACE, insert: { x: 10, y: 20, z: 0 }, width: 80, rotation: 0, props: props() }, t.h);
    t.s.commit({ label: 'IMAGEATTACH', ops: r.ops });
    for (const [name, data] of [
      ['a.dxf', writeDxf(t.doc).data],
      ['a.dwg', writeDwg(t.doc).data],
    ] as const) {
      const back = readCadFile(data, name);
      const img = back.blocks.get(MODEL_SPACE)!.entities.find((e) => e.type === 'IMAGE') as ImageEntity;
      expect(img, name).toBeTruthy();
      const def = back.objects.get(img.imageDef!) as ImageDefObject;
      expect(def.fileName, name).toBe('site.png');
      expect(img.uVector.x, name).toBeCloseTo(0.2);
      expect(dict(back, 'ACAD_IMAGE_DICT')?.entries.has('site'), name).toBe(true);
    }
  });
});

describe('PDF 부착', () => {
  it('ACAD_PDFDEFINITIONS·페이지 이름·INSUNITS 축척', () => {
    expect(unitsPerInch(4)).toBeCloseTo(25.4);
    expect(unitsPerInch(1)).toBe(1);
    expect(unitsPerInch(0)).toBe(1);
    const t = setup();
    const r = pdfAttachOps(t.doc, { fileName: 'plan.pdf', page: 2, space: MODEL_SPACE, insert: { x: 0, y: 0, z: 0 }, scale: 0.5, rotation: 0, insunits: 4, props: props() }, t.h);
    t.s.commit({ label: 'PDFATTACH', ops: r.ops });
    const d = dict(t.doc, 'ACAD_PDFDEFINITIONS')!;
    expect([...d.entries.keys()]).toEqual(['plan - 2']);
    const def = t.doc.objects.get(d.entries.get('plan - 2')!) as UnderlayDefObject;
    expect(def.name).toBe('2');
    const u = t.doc.entityIndex.get(r.underlay.handle) as UnderlayEntity;
    expect(u.definition).toBe(def.handle);
    expect(u.scale.x).toBeCloseTo(12.7);
    // 같은 파일의 다른 페이지는 새 정의, 같은 페이지는 다시 쓴다
    expect(pdfAttachOps(t.doc, { fileName: 'plan.pdf', page: 2, space: MODEL_SPACE, insert: { x: 0, y: 0, z: 0 }, scale: 1, rotation: 0, insunits: 4, props: props() }, t.h).reused).toBe(true);
    expect(pdfAttachOps(t.doc, { fileName: 'plan.pdf', page: 1, space: MODEL_SPACE, insert: { x: 0, y: 0, z: 0 }, scale: 1, rotation: 0, insunits: 4, props: props() }, t.h).reused).toBe(false);
  });

  it('DXF·DWG 왕복', () => {
    const t = setup();
    const r = pdfAttachOps(t.doc, { fileName: 'plan.pdf', page: 3, space: MODEL_SPACE, insert: { x: 5, y: 6, z: 0 }, scale: 1, rotation: 0.25, insunits: 4, props: props() }, t.h);
    t.s.commit({ label: 'PDFATTACH', ops: r.ops });
    for (const [name, data] of [
      ['a.dxf', writeDxf(t.doc).data],
      ['a.dwg', writeDwg(t.doc).data],
    ] as const) {
      const back = readCadFile(data, name);
      const u = back.blocks.get(MODEL_SPACE)!.entities.find((e) => e.type === 'PDFUNDERLAY') as UnderlayEntity;
      expect(u, name).toBeTruthy();
      const def = back.objects.get(u.definition!) as UnderlayDefObject;
      expect(def.fileName, name).toBe('plan.pdf');
      expect(def.name, name).toBe('3');
      expect(u.scale.x, name).toBeCloseTo(25.4);
      expect(u.rotation, name).toBeCloseTo(0.25);
    }
  });
});
