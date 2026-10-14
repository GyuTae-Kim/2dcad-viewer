/** 필드 코드 나누기·평가·보관 */
import { describe, expect, it } from 'vitest';
import type { CircleEntity, Entity, MTextEntity, TextEntity } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { countFields, objectField, objectHandleOf, objectPropertyOf, splitFields, varField } from '../../src/edit/field/code';
import { formatDate, formatFileName, formatNumber, textCase } from '../../src/edit/field/format';
import { type FieldContext, FIELD_EMPTY, FIELD_ERROR, evaluateTemplate, julianToLocal } from '../../src/edit/field/evaluate';
import { applyTemplate, decodeFieldXData, encodeFieldXData, fieldCount, fieldTemplate, isFieldStale, updateEntityFields } from '../../src/edit/field/store';

const date = new Date(2026, 9, 5, 14, 7, 9); // 2026-10-05 월요일 14:07:09

function ctx(): FieldContext & { doc: ReturnType<typeof createNewDocument> } {
  const doc = createNewDocument('metric');
  return { doc, fileName: 'C:\\work\\plan-A.dwg', fileSize: 20480, now: date };
}

describe('필드 코드', () => {
  it('나누기(중첩 객체 필드 포함)', () => {
    const s = `날짜: ${varField('Date', 'yyyy-MM-dd')} / ${objectField('2a', 'Area', '%lu2%pr2')} 끝`;
    const parts = splitFields(s);
    expect(parts.map((p) => p.kind)).toEqual(['text', 'field', 'text', 'field', 'text']);
    const f = parts[3]!;
    expect(f.kind === 'field' && f.evaluator).toBe('AcObjProp');
    expect(f.kind === 'field' && f.format).toBe('%lu2%pr2');
    expect(f.kind === 'field' && objectHandleOf(f.body)).toBe('2A');
    expect(f.kind === 'field' && objectPropertyOf(f.body)).toBe('Area');
    expect(countFields(s)).toBe(2);
    expect(countFields('100%<가')).toBe(0);
  });

  it('날짜·파일 이름·숫자·대소문자 형식', () => {
    expect(formatDate(date, 'yyyy-MM-dd')).toBe('2026-10-05');
    expect(formatDate(date, 'M/d/yy')).toBe('10/5/26');
    expect(formatDate(date, 'yyyy년 MMMM d일 dddd')).toBe('2026년 10월 5일 월요일');
    expect(formatDate(date, 'tt h:mm:ss')).toBe('오후 2:07:09');
    expect(formatDate(date, 'HH:mm')).toBe('14:07');
    expect(formatFileName('C:\\work\\plan-A.dwg', '%fn2')).toBe('plan-A');
    expect(formatFileName('C:\\work\\plan-A.dwg', '%fn6')).toBe('plan-A.dwg');
    expect(formatFileName('C:\\work\\plan-A.dwg', '%fn7')).toBe('C:\\work\\plan-A.dwg');
    expect(formatFileName('C:\\work\\plan-A.dwg', '%tc1%fn2')).toBe('PLAN-A');
    expect(formatNumber(1234.5678, '%lu2%pr2', { luprec: 4, lunits: 2 })).toBe('1234.57');
    expect(formatNumber(1234.5678, '%lu2%pr0%th%ps[약 ,mm]', { luprec: 4, lunits: 2 })).toBe('약 1,235mm');
    expect(formatNumber(2, '%ct8[0.5]', { luprec: 1, lunits: 2 })).toBe('1.0');
    expect(formatNumber(12345, '%lu1%pr2', { luprec: 4, lunits: 2 })).toBe('1.23E+04');
    expect(textCase('hello world', '%tc4')).toBe('Hello World');
    expect(julianToLocal(2440587.5)!.getFullYear()).toBe(1970);
  });

  it('평가: 변수·시스템 변수·객체 특성·오류', () => {
    const c = ctx();
    const circle: CircleEntity = { ...entityDefaults(), type: 'CIRCLE', handle: '2A', center: { x: 0, y: 0, z: 0 }, radius: 10 };
    c.doc.entityIndex.set('2A', circle);
    c.doc.header.set('$LTSCALE', 2.5);
    const r = evaluateTemplate(
      [varField('Date', 'yyyy-MM-dd'), varField('Filename', '%fn2'), varField('ltscale', '%lu2%pr1'), varField('Author'), objectField('2A', 'Area', '%lu2%pr2'), objectField('2A', 'Diameter', '%pr0'), objectField('FF', 'Area'), '%<\\AcDiesel $(getvar,clayer)>%'].join('|'),
      c,
    );
    expect(r.text).toBe(`2026-10-05|plan-A|2.5|${FIELD_EMPTY}|314.16|20|${FIELD_ERROR}|0`);
    expect(r.fields).toBe(8);
    expect(r.errors).toBe(1);
    // 여러 줄 문자에는 \ { } 를 이스케이프
    c.doc.header.set('$PROJECTNAME', 'a{b}\\c');
    expect(evaluateTemplate(varField('projectname'), c, { mtext: true }).text).toBe('a\\{b\\}\\\\c');
  });

  it('확장 자료 보관과 다시 계산', () => {
    const c = ctx();
    const tpl = `작성일 ${varField('Date', 'yyyy.MM.dd')} ${'긴 문자 '.repeat(40)}`;
    const x = encodeFieldXData(tpl);
    expect(decodeFieldXData(x)).toBe(tpl);
    const base: MTextEntity = { ...entityDefaults(), type: 'MTEXT', handle: '1F', insert: { x: 0, y: 0, z: 0 }, height: 2.5, width: 0, attachment: 1, drawingDirection: 1, text: '', style: 'Standard', rotation: 0, lineSpacingStyle: 1, lineSpacingFactor: 1, backgroundFlags: 0, backgroundScale: 1.5 };
    const m = applyTemplate(base, tpl, c);
    expect(m.text.startsWith('작성일 2026.10.05 ')).toBe(true);
    expect(fieldTemplate(m)).toBe(tpl);
    expect(fieldCount(m)).toBe(1);
    // 날짜가 바뀌면 업데이트
    const u = updateEntityFields(m as Entity, { ...c, now: new Date(2027, 0, 2) });
    expect(u.changed).toBe(true);
    expect((u.entity as MTextEntity).text.startsWith('작성일 2027.01.02')).toBe(true);
    const same = updateEntityFields(m as Entity, c);
    expect(same.changed).toBe(false);
    expect(same.fields).toBe(1);
    // 다른 명령이 내용을 바꾼 문자는 필드를 뗀다(템플릿으로 덮어쓰지 않는다)
    const edited = { ...m, text: '손으로 고친 문자' } as MTextEntity;
    expect(isFieldStale(edited)).toBe(true);
    const s2 = updateEntityFields(edited as Entity, c);
    expect(s2.stale).toBe(1);
    expect((s2.entity as MTextEntity).text).toBe('손으로 고친 문자');
    expect(fieldTemplate(s2.entity)).toBeNull();
    expect(isFieldStale(m)).toBe(false);
    // 필드가 없는 문자
    const t: TextEntity = { ...entityDefaults(), type: 'TEXT', handle: '20', insert: { x: 0, y: 0, z: 0 }, height: 1, text: 'a', rotation: 0, widthFactor: 1, oblique: 0, style: 'Standard', generation: 0, halign: 0, valign: 0 };
    expect(updateEntityFields(t as Entity, c).fields).toBe(0);
  });
});
