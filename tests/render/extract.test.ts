/** 데이터 추출(DATAEXTRACTION)의 행 모으기와 CSV */
import { describe, expect, it } from 'vitest';
import type { AttribEntity, Entity, InsertEntity } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { extractData, toCsv } from '../../src/edit/extract';
import { P, add, line, newDoc } from '../hatch/helpers';

let n = 0xb00;
const H = () => (n++).toString(16).toUpperCase();

function ins(block: string, attrs: Record<string, string> = {}): InsertEntity {
  const attribs = Object.entries(attrs).map(([tag, text]) => ({ type: 'ATTRIB', ...entityDefaults(), handle: H(), tag, text, insert: P(0, 0), height: 1, rotation: 0, widthFactor: 1, oblique: 0, style: 'Standard', generation: 0, halign: 0, valign: 0, attFlags: 0 }) as unknown as AttribEntity);
  return { type: 'INSERT', ...entityDefaults(), handle: H(), block, insert: P(0, 0), scale: P(1, 1, 1), rotation: 0, attribs, columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0 } as unknown as InsertEntity;
}

describe('데이터 추출', () => {
  it('블록 이름·속성으로 묶어 개수를 센다', () => {
    const doc = newDoc();
    const list: Entity[] = [ins('문', { NO: 'D1', TYPE: '목재' }), ins('문', { NO: 'D1', TYPE: '목재' }), ins('문', { NO: 'D2', TYPE: '철재' }), ins('창'), line(0, 0, 1, 1)];
    add(doc, ...list);
    const r = extractData(doc, list, { blocksOnly: true, attributes: true, layer: false, combine: true });
    expect(r.columns).toEqual(['개수', '이름', 'NO', 'TYPE']);
    expect(r.rows).toEqual([
      ['2', '문', 'D1', '목재'],
      ['1', '문', 'D2', '철재'],
      ['1', '창', '', ''],
    ]);
  });

  it('모든 객체는 종류별로, CSV는 BOM·따옴표 처리', () => {
    const doc = newDoc();
    const list: Entity[] = [line(0, 0, 1, 1), line(1, 1, 2, 2), ins('A,B')];
    add(doc, ...list);
    const r = extractData(doc, list, { blocksOnly: false, attributes: false, layer: true, combine: true });
    expect(r.columns).toEqual(['개수', '종류', '이름', '도면층']);
    expect(r.rows).toContainEqual(['2', '선', '', '0']);
    const csv = toCsv(r);
    expect(csv.startsWith('﻿개수,종류,이름,도면층\r\n')).toBe(true);
    expect(csv).toContain('"A,B"');
  });
});
