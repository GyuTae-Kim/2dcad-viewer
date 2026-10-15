/** ATTOUT·ATTIN: 탭 구분 파일 꼴(머리·핸들 앞 작은따옴표·없는 태그 <>·같은 태그 번호)과 왕복 */
import { describe, expect, it } from 'vitest';
import type { AttribEntity, InsertEntity } from '../../src/core/model';
import { attInOps, attOutText, attribColumns, parseAttIn } from '../../src/edit/blkcmds/attout';
import { addBlock, attdef, insert, put, setup } from '../util2/helpers';

function attrib(h: string, owner: string, tag: string, value: string): AttribEntity {
  return { ...attdef(h, tag, value, 0, 0), type: 'ATTRIB', owner, prompt: undefined };
}

function fixture() {
  const t = setup();
  addBlock(t.doc, t.h, 'TAG', [attdef(t.h(), 'NO', '1', 0, 0), attdef(t.h(), 'NAME', 'x', 0, 5)]);
  addBlock(t.doc, t.h, 'ROOM', [attdef(t.h(), 'NAME', 'r', 0, 0), attdef(t.h(), 'AREA', '0', 0, 5)]);
  const a = insert('A1', 'TAG', 0, 0, { attribs: [attrib('B1', 'A1', 'NO', '101'), attrib('B2', 'A1', 'NAME', '펌프')] });
  const b = insert('A2', 'ROOM', 10, 0, { attribs: [attrib('B3', 'A2', 'NAME', '거실'), attrib('B4', 'A2', 'AREA', '24.5')] });
  // 같은 태그가 두 번
  const c = insert('A3', 'TAG', 20, 0, { attribs: [attrib('B5', 'A3', 'NO', '7'), attrib('B6', 'A3', 'NO', '8')] });
  const plain = insert('A4', 'TAG', 30, 0);
  put(t.doc, a, b, c, plain);
  return { ...t, a, b, c, plain };
}

describe('ATTOUT', () => {
  it('머리 줄과 행: 핸들 앞 작은따옴표, 없는 태그는 <>, 속성 없는 블록은 뺀다', () => {
    const f = fixture();
    const r = attOutText([f.a, f.b, f.c, f.plain]);
    const lines = r.text.split('\r\n');
    expect(lines[0]).toBe('HANDLE\tBLOCKNAME\tNO\tNAME\tAREA\tNO(1)');
    expect(lines[1]).toBe("'A1\tTAG\t101\t펌프\t<>\t<>");
    expect(lines[2]).toBe("'A2\tROOM\t<>\t거실\t24.5\t<>");
    expect(lines[3]).toBe("'A3\tTAG\t7\t<>\t<>\t8");
    expect(r.rows).toBe(3);
    expect(r.text.endsWith('\r\n')).toBe(true);
  });

  it('값 안의 탭·줄바꿈은 빈칸으로', () => {
    const f = fixture();
    (f.a.attribs[1] as AttribEntity).text = '가\t나\n다';
    expect(attOutText([f.a]).text.split('\r\n')[1]).toBe("'A1\tTAG\t101\t가 나 다");
  });

  it('같은 태그 열 이름', () => {
    const f = fixture();
    expect(attribColumns(f.c).map((c) => c.column)).toEqual(['NO', 'NO(1)']);
  });
});

describe('ATTIN', () => {
  it('파일 읽기: 머리 확인, 작은따옴표 핸들, <> 칸 건너뛰기, 따옴표로 감싼 칸', () => {
    const p = parseAttIn('﻿HANDLE\tBLOCKNAME\tNO\tNAME\r\n\'a1\tTAG\t"102"\t<>\r\nzz\tTAG\t1\t2\r\n\r\n');
    expect(p.columns).toEqual(['NO', 'NAME']);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]!.handle).toBe('A1');
    expect([...p.rows[0]!.values]).toEqual([['NO', '102']]);
    expect(p.errors).toHaveLength(1);
    expect(parseAttIn('X\tY\n').errors[0]).toMatch(/HANDLE/);
  });

  it('왕복: 내보낸 파일을 고쳐 읽으면 값만 바뀐다(핸들로 맞춤, 같은 태그 두 번째 열)', () => {
    const f = fixture();
    const out = attOutText([f.a, f.b, f.c]).text;
    const edited = out.replace('펌프', '송풍기').replace("'A3\tTAG\t7\t<>\t<>\t8", "'A3\tTAG\t7\t<>\t<>\t9");
    const p = parseAttIn(edited);
    const r = attInOps(f.doc, p.rows, (h) => f.s.ownerOf(h));
    expect(r.updated).toBe(2);
    expect(r.unchanged).toBe(1);
    f.s.commit({ label: 'ATTIN', ops: r.ops });
    const a = f.doc.entityIndex.get('A1') as InsertEntity;
    expect(a.attribs.map((x) => x.text)).toEqual(['101', '송풍기']);
    const c = f.doc.entityIndex.get('A3') as InsertEntity;
    expect(c.attribs.map((x) => x.text)).toEqual(['7', '9']);
    // 속성 핸들은 그대로
    expect(c.attribs.map((x) => x.handle)).toEqual(['B5', 'B6']);
    // 되돌리기
    f.s.undo();
    expect((f.doc.entityIndex.get('A1') as InsertEntity).attribs[1]!.text).toBe('펌프');
  });

  it('없는 핸들·잠긴 도면층·모르는 태그', () => {
    const f = fixture();
    f.doc.layers.set('LOCK', { ...f.doc.layers.get('0')!, name: 'LOCK', locked: true });
    f.b.layer = 'LOCK';
    const p = parseAttIn("HANDLE\tBLOCKNAME\tNAME\tZZZ\n'A1\tTAG\t새이름\tq\n'A2\tROOM\t방\t<>\n'FFFF\tTAG\t1\t2\n");
    const r = attInOps(f.doc, p.rows, (h) => f.s.ownerOf(h));
    expect(r.updated).toBe(1);
    expect(r.locked).toBe(1);
    expect(r.missing).toEqual(['FFFF']);
    expect([...r.unknownTags]).toEqual(['ZZZ']);
  });
});
