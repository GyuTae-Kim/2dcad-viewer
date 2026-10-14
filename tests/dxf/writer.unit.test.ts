/**
 * DXF 쓰기 단위 검사(비교 도면 없이 도는 것). 새 도면과 표본 객체로 버전별 규칙을 본다.
 */
import { describe, expect, it } from 'vitest';
import type { CadDocument, DictionaryObject, DimensionEntity, Entity, HatchEntity, LineEntity, MTextEntity, RawTag, XRecordObject } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { readDxf } from '../../src/io/dxf/reader';
import { WriteContext, entityTags, writeDxf } from '../../src/io/dxf/writer';
import { textChunks } from '../../src/io/dxf/wentities';
import { DXF_VERSIONS } from '../../src/io/dxf/tagwriter';
import { addSampleEntities } from './writer.samples';
import { checkStructure } from './writer.helpers';

/** ASCII DXF → (코드, 값) 목록(R2007+는 UTF-8) */
function tagsOf(data: Uint8Array, utf8 = true): [number, string][] {
  const lines = new TextDecoder(utf8 ? 'utf-8' : 'latin1').decode(data).split('\r\n');
  const out: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([Number(lines[i]!.trim()), lines[i + 1]!]);
  return out;
}

/** 0 TYPE부터 다음 0까지 */
function recordsOf(tags: [number, string][], type: string): [number, string][][] {
  const out: [number, string][][] = [];
  for (let i = 0; i < tags.length; i++) {
    if (tags[i]![0] !== 0 || tags[i]![1] !== type) continue;
    let j = i + 1;
    while (j < tags.length && tags[j]![0] !== 0) j++;
    out.push(tags.slice(i, j));
  }
  return out;
}

function filled(units: 'metric' | 'imperial' = 'metric'): CadDocument {
  const doc = createNewDocument(units);
  addSampleEntities(doc);
  return doc;
}

function snapshot(doc: CadDocument): string {
  return JSON.stringify(doc, (_k, v) => (v instanceof Map ? [...v] : v instanceof Uint8Array ? [...v] : v));
}

describe('DXF 쓰기: 버전·형식', () => {
  for (const version of DXF_VERSIONS) {
    for (const binary of [false, true]) {
      it(`${version}${binary ? ' 이진' : ''}: 다시 읽힌다`, () => {
        const doc = filled();
        const before = snapshot(doc);
        const res = writeDxf(doc, { version, binary });
        expect(snapshot(doc)).toBe(before); // 문서를 바꾸지 않는다
        const back = readDxf(res.data);
        expect(back.version).toBe(version);
        expect(!!back.binary).toBe(binary);
        expect(back.layers.has('0')).toBe(true);
        expect(back.blocks.get('*MODEL_SPACE')!.entities.length).toBeGreaterThan(20);
        if (!binary) {
          const st = checkStructure(res.data);
          expect(st).toEqual({ duplicates: [], dangling: [], seedOk: true, balanced: true });
        }
      });
    }
  }

  it('쓸 수 없는 버전: R13·R14 → R2000(경고), 모르는 값 → R2018', () => {
    const doc = createNewDocument('metric');
    const r14 = writeDxf(doc, { version: 'AC1014' as never });
    expect(readDxf(r14.data).version).toBe('AC1015');
    expect(r14.warnings.map((w) => w.code)).toContain('version.changed');
    expect(readDxf(writeDxf(doc, { version: 'R99' as never }).data).version).toBe('AC1032');
  });

  it('기본 버전은 R2018 ASCII', () => {
    const res = writeDxf(createNewDocument('metric'));
    const t = tagsOf(res.data);
    expect(t[0]).toEqual([0, 'SECTION']);
    expect(t.find((_x, i) => t[i - 1]?.[1] === '$ACADVER')?.[1]).toBe('AC1032');
  });

  it('R2007 이전: 비ASCII는 \\U+XXXX(파일 전체 ASCII), 다시 읽으면 같은 글자', () => {
    const doc = filled();
    const res = writeDxf(doc, { version: 'AC1018' });
    expect(res.data.every((b) => b < 0x80)).toBe(true);
    const back = readDxf(res.data);
    expect(back.layers.has('벽')).toBe(true); // 이름은 리더가 푼다
    const text = back.blocks.get('*MODEL_SPACE')!.entities.find((e) => e.type === 'TEXT')!;
    expect((text as { text: string }).text).toBe('\\U+C67C\\U+CABD \\U+AE30\\U+C900\\U+C120 ABC');
    expect(tagsOf(res.data).find((_x, i, a) => a[i - 1]?.[1] === '$DWGCODEPAGE')?.[1]).toBe('ANSI_1252');
  });

  it('R2007 이전 + codepage: 그 코드 페이지 바이트로 쓴다', () => {
    const doc = filled();
    const res = writeDxf(doc, { version: 'AC1015', codepage: 'ANSI_949' });
    expect(res.data.some((b) => b >= 0x80)).toBe(true);
    const back = readDxf(res.data);
    const text = back.blocks.get('*MODEL_SPACE')!.entities.find((e) => e.type === 'TEXT') as { text: string };
    expect(text.text).toBe('왼쪽 기준선 ABC');
    expect(back.codepage.toUpperCase()).toBe('ANSI_949');
  });

  it('R2007+: UTF-8 그대로', () => {
    const back = readDxf(writeDxf(filled(), { version: 'AC1021' }).data);
    const text = back.blocks.get('*MODEL_SPACE')!.entities.find((e) => e.type === 'TEXT') as { text: string };
    expect(text.text).toBe('왼쪽 기준선 ABC');
  });

  it('$HANDSEED는 가장 큰 핸들보다 크고, 빠진 핸들은 새로 붙인다', () => {
    const doc = createNewDocument('imperial');
    const ms = doc.blocks.get('*MODEL_SPACE')!;
    const line = (h: string): LineEntity => ({ ...entityDefaults(), type: 'LINE', handle: h, start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 1, z: 0 } });
    ms.entities.push(line(''), line('FFFF0'), line('FFFF0'));
    const res = writeDxf(doc);
    expect(res.warnings.map((w) => w.code)).toContain('handle.duplicate');
    const back = readDxf(res.data);
    const hs = back.blocks.get('*MODEL_SPACE')!.entities.map((e) => e.handle);
    expect(new Set(hs).size).toBe(3);
    expect(hs).toContain('FFFF0');
    expect(BigInt('0x' + String(back.header.get('$HANDSEED')))).toBeGreaterThan(0xffff0n);
    expect(checkStructure(res.data).seedOk).toBe(true);
  });
});

describe('DXF 쓰기: 객체 규칙', () => {
  it('MTEXT는 250자 조각(3…3, 1)으로 쓴다', () => {
    const doc = filled();
    const m = doc.blocks.get('*MODEL_SPACE')!.entities.find((e) => e.type === 'MTEXT') as MTextEntity;
    for (const version of ['AC1015', 'AC1032'] as const) {
      const res = writeDxf(doc, { version });
      const rec = recordsOf(tagsOf(res.data, version === 'AC1032'), 'MTEXT')[0]!;
      const parts = rec.filter(([c]) => c === 3 || c === 1);
      expect(parts.length).toBeGreaterThan(2);
      expect(parts.slice(0, -1).every(([c]) => c === 3)).toBe(true);
      expect(parts.at(-1)![0]).toBe(1);
      for (const [, v] of parts) expect(version === 'AC1032' ? [...v].length : v.length).toBeLessThanOrEqual(250);
      const back = readDxf(res.data).blocks.get('*MODEL_SPACE')!.entities.find((e) => e.type === 'MTEXT') as MTextEntity;
      if (version === 'AC1032') expect(back.text).toBe(m.text);
    }
    // 서로게이트 쌍은 자르지 않는다.
    const chunks = textChunks('😀'.repeat(200), true);
    expect(chunks.join('')).toBe('😀'.repeat(200));
    for (const c of chunks) expect(c.length % 2).toBe(0);
  });

  it('TEXT 정렬: 왼쪽은 11 없음, 그 밖은 11과 72·73', () => {
    const rec = recordsOf(tagsOf(writeDxf(filled()).data), 'TEXT');
    const left = rec.find((r) => r.some(([c, v]) => c === 1 && v.startsWith('왼쪽')))!;
    expect(left.some(([c]) => c === 11)).toBe(false);
    const mid = rec.find((r) => r.some(([c, v]) => c === 1 && v === '가운데'))!;
    expect(mid.find(([c]) => c === 72)?.[1]).toBe('1');
    expect(mid.find(([c]) => c === 73)?.[1]).toBe('2');
    expect(mid.find(([c]) => c === 11)?.[1]).toBe('20.0');
    // 73은 두 번째 AcDbText 뒤에
    const subs = mid.map(([c, v], i) => (c === 100 ? [v, i] : null)).filter(Boolean) as [string, number][];
    expect(subs.map((s) => s[0])).toEqual(['AcDbEntity', 'AcDbText', 'AcDbText']);
    expect(mid.findIndex(([c]) => c === 73)).toBeGreaterThan(subs[2]![1]);
  });

  it('해치 시계 방향 호: 파일은 보각(360 − 각도)으로, 다시 읽으면 모델 각도', () => {
    const doc = filled();
    const res = writeDxf(doc);
    const h = recordsOf(tagsOf(res.data), 'HATCH').find((r) => r.some(([c, v]) => c === 2 && v === 'ANSI31'))!;
    const arcs: number[][] = [];
    // 72 2(호) 10 20 40 50 51 73 — 경계 경로의 72(볼록 표시)와 구분하려고 바로 뒤가 10인지 본다.
    for (let i = 0; i < h.length; i++) if (h[i]![0] === 72 && h[i]![1].trim() === '2' && h[i + 1]![0] === 10) arcs.push([Number(h[i + 4]![1]), Number(h[i + 5]![1]), Number(h[i + 6]![1])]);
    expect(arcs).toEqual([
      [-90, 90, 1],
      [270, 450, 0],
    ]);
    const src = doc.blocks.get('*MODEL_SPACE')!.entities.find((e) => e.type === 'HATCH' && e.patternName === 'ANSI31') as HatchEntity;
    const back = readDxf(res.data).blocks.get('*MODEL_SPACE')!.entities.find((e) => e.type === 'HATCH' && e.patternName === 'ANSI31') as HatchEntity;
    expect(back.paths[0]!.edges).toEqual(src.paths[0]!.edges!.map((e) => ({ ...e })));
  });

  it('치수 스타일 340~347은 이름에서 핸들로, 뷰포트 동결 도면층은 341 핸들로', () => {
    const doc = filled();
    doc.dimStyles.get('STANDARD')!.vars.DIMBLK = '문';
    doc.dimStyles.get('STANDARD')!.vars.DIMLTYPE = 'DASHED';
    const res = writeDxf(doc);
    const t = tagsOf(res.data);
    const ds = recordsOf(t, 'DIMSTYLE').find((r) => r.some(([c, v]) => c === 2 && v === 'Standard'))!;
    const handleOf = (type: string, name: string) => recordsOf(t, type).find((r) => r.some(([c, v]) => c === 2 && v === name))!.find(([c]) => c === 5)![1];
    expect(ds.find(([c]) => c === 340)?.[1]).toBe(handleOf('STYLE', 'Standard'));
    expect(ds.find(([c]) => c === 342)?.[1]).toBe(handleOf('BLOCK_RECORD', '문'));
    expect(ds.find(([c]) => c === 345)?.[1]).toBe(handleOf('LTYPE', 'DASHED'));
    const vp = recordsOf(t, 'VIEWPORT').find((r) => r.some(([c, v]) => c === 69 && v.trim() === '2'))!;
    expect(vp.filter(([c]) => c === 341).map(([, v]) => v)).toEqual([handleOf('LAYER', '벽')]);
    const back = readDxf(res.data);
    expect(back.dimStyles.get('STANDARD')!.vars.DIMBLK).toBe('문');
  });

  it('치수 재지정은 ACAD DSTYLE 확장 자료로', () => {
    const doc = filled();
    const res = writeDxf(doc);
    const back = readDxf(res.data);
    const d = back.blocks.get('*MODEL_SPACE')!.entities.find((e) => e.type === 'DIMENSION' && (e as DimensionEntity).overrides) as DimensionEntity;
    expect(d.overrides).toEqual({ 140: 3.5, 178: 1 });
    expect(d.block).toMatch(/^\*D\d+$/);
    expect(back.blocks.has(d.block.toUpperCase())).toBe(true);
  });

  it('R12: 단순 형식(하위 클래스 표지·OBJECTS·BLOCK_RECORD 없음)과 변환 경고', () => {
    const res = writeDxf(filled(), { version: 'AC1009' });
    const t = tagsOf(res.data);
    expect(t.some(([c]) => c === 100)).toBe(false);
    expect(t.some(([c]) => c === 330)).toBe(false);
    expect(t.some(([c, v]) => c === 2 && (v === 'OBJECTS' || v === 'CLASSES' || v === 'BLOCK_RECORD'))).toBe(false);
    const codes = res.warnings.map((w) => w.code);
    for (const c of ['r12.mtext_as_text', 'r12.approximated', 'r12.leader_as_polyline', 'r12.unsupported', 'entity.mleader_exploded']) expect(codes).toContain(c);
    const back = readDxf(res.data);
    const types = new Set(back.blocks.get('*MODEL_SPACE')!.entities.map((e) => e.type));
    for (const x of ['LWPOLYLINE', 'MTEXT', 'ELLIPSE', 'SPLINE', 'HATCH', 'MULTILEADER', 'LEADER']) expect(types.has(x as Entity['type'])).toBe(false);
    expect(types.has('POLYLINE')).toBe(true);
    expect(res.data.every((b) => b < 0x80)).toBe(true);
  });

  it('버전에 없는 객체 바꾸기: R2004 이전 MULTILEADER 분해, R2010 이전 MESH → 폴리페이스, 표·호 치수 → INSERT', () => {
    const doc = filled();
    const r15 = writeDxf(doc, { version: 'AC1015' });
    const codes = r15.warnings.map((w) => w.code);
    // 호 치수는 그림 블록이 없어(표본) 빠진다.
    expect(codes).toEqual(expect.arrayContaining(['entity.mleader_exploded', 'entity.mesh_as_polyface', 'entity.dimension_dropped']));
    const back = readDxf(r15.data).blocks.get('*MODEL_SPACE')!.entities;
    expect(back.some((e) => e.type === 'MULTILEADER' || e.type === 'MESH')).toBe(false);
    expect(back.some((e) => e.type === 'POLYLINE' && e.kind === 'polyface' && e.vertices.length > 5)).toBe(true);
    const r24 = readDxf(writeDxf(doc, { version: 'AC1024' }).data).blocks.get('*MODEL_SPACE')!.entities;
    expect(r24.some((e) => e.type === 'MULTILEADER')).toBe(true);
    expect(r24.some((e) => e.type === 'MESH')).toBe(true);
  });

  it('ACIS 자료가 없는 객체·OLE는 빼고 경고한다', () => {
    const res = writeDxf(filled());
    const codes = res.warnings.map((w) => w.code);
    expect(codes).toContain('entity.acis_dropped');
    expect(codes).toContain('entity.ole_dropped');
    const types = readDxf(res.data).blocks.get('*MODEL_SPACE')!.entities.map((e) => e.type);
    expect(types).not.toContain('REGION');
    expect(types).not.toContain('OLE2FRAME');
  });

  it('값이 잘못된 XRECORD는 빼고, 쓰지 않는 객체를 가리키는 원본 핸들은 0으로 쓴다', () => {
    const doc = createNewDocument('metric');
    const root = doc.objects.get(doc.rootDictionary!) as DictionaryObject;
    const add = (h: string, data: RawTag[]) => {
      root.entries.set('X' + h, h);
      doc.objects.set(h, { type: 'XRECORD', handle: h, owner: root.handle, cloning: 1, data } as XRecordObject);
    };
    add('F001', [{ code: 280, value: 8961 }]);
    add('F002', [{ code: 0, value: '' }]);
    add('F003', [
      { code: 1, value: 'ok' },
      { code: 340, value: 'ABCDE' },
      { code: 340, value: 'F003' },
    ]);
    const res = writeDxf(doc);
    expect(res.warnings.find((w) => w.code === 'object.corrupt_dropped')?.count).toBe(2);
    const back = readDxf(res.data);
    expect(back.objects.has('F001')).toBe(false);
    expect(back.objects.has('F002')).toBe(false);
    expect((back.objects.get('F003') as XRecordObject).data).toEqual([
      { code: 1, value: 'ok' },
      { code: 340, value: '0' },
      { code: 340, value: 'F003' },
    ]);
    expect(checkStructure(res.data).dangling).toEqual([]);
  });

  it('모델이 해석하지 않은 구역은 담을 수 있는 버전일 때 그대로 쓴다', () => {
    const doc = createNewDocument('metric');
    doc.rawSections = [{ name: 'THUMBNAILIMAGE', version: 'AC1032', tags: [{ code: 90, value: 2 }, { code: 310, value: 'ABCD' }] }];
    const back = readDxf(writeDxf(doc, { version: 'AC1024' }).data);
    // ASCII 리더는 원본 태그 값을 문자열로 둔다.
    expect(back.rawSections).toEqual([{ name: 'THUMBNAILIMAGE', version: 'AC1024', tags: [{ code: 90, value: '2' }, { code: 310, value: 'ABCD' }] }]);
    expect(readDxf(writeDxf(doc, { version: 'AC1009' }).data).rawSections).toBeUndefined();
  });

  it('entityTags: 객체 하나(딸린 VERTEX·ATTRIB·SEQEND 포함)와 버전 변환', () => {
    const doc = filled();
    const ctx = new WriteContext(doc, { version: 'AC1032' });
    const ms = doc.blocks.get('*MODEL_SPACE')!;
    const line = ms.entities[0]!;
    const tags = entityTags(line, ctx);
    expect(tags[0]).toEqual({ code: 0, value: 'LINE' });
    expect(tags[1]).toEqual({ code: 5, value: line.handle });
    expect(tags.find((t) => t.code === 330)?.value).toBe(ms.recordHandle);
    const pl = ms.entities.find((e) => e.type === 'POLYLINE')!;
    const pt = entityTags(pl, ctx);
    expect(pt.filter((t) => t.code === 0).map((t) => t.value)).toEqual(['POLYLINE', 'VERTEX', 'VERTEX', 'VERTEX', 'SEQEND']);
    const ins = ms.entities.find((e) => e.type === 'INSERT' && e.attribs.length)!;
    expect(entityTags(ins, ctx).filter((t) => t.code === 0).map((t) => t.value)).toEqual(['INSERT', 'ATTRIB', 'SEQEND']);
    // R2004: MULTILEADER는 분해한 객체들의 태그
    const ctx18 = new WriteContext(doc, { version: 'AC1018' });
    const ml = ms.entities.find((e) => e.type === 'MULTILEADER')!;
    const mt = entityTags(ml, ctx18).filter((t) => t.code === 0).map((t) => t.value);
    expect(mt).toContain('MTEXT');
    expect(mt).not.toContain('MULTILEADER');
  });
});
