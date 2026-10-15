import { describe, expect, it } from 'vitest';
import type { ImageEntity, UnderlayEntity } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { dimCenterSegments } from '../../src/edit/editcmds2/dimcenter';
import { addToGroupOps, explodeGroupOps, removeFromGroupOps, renameGroupOps } from '../../src/edit/editcmds2/groupedit';
import { adjustImage, adjustUnderlay, imageQuality, imageQualityOps, underlayAdjustOf } from '../../src/edit/editcmds2/imagevars';
import { csvField, csvFileText, effectiveAlign, matchCellAlign, tableToCsv } from '../../src/edit/editcmds2/table';
import { createTable, mergeCells, setText } from '../../src/edit/table/model';
import { defaultTableStyle } from '../../src/edit/table/style';
import { createGroupOps, listGroups } from '../../src/edit/util/groups';
import { circle, line, put, setup } from '../util2/helpers';

describe('TABLEEXPORT: CSV', () => {
  it('쉼표·큰따옴표·줄바꿈·앞뒤 공백 칸만 감싼다', () => {
    expect(csvField('abc')).toBe('abc');
    expect(csvField('')).toBe('');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('그는 "예"라고')).toBe('"그는 ""예""라고"');
    expect(csvField('줄1\n줄2')).toBe('"줄1\n줄2"');
    expect(csvField(' 앞')).toBe('" 앞"');
    expect(csvField('한글 이름')).toBe('한글 이름');
  });

  it('병합 셀은 기준 셀에만, 여러 줄 문자 서식은 걷고 문단은 칸 안 줄바꿈', () => {
    const style = defaultTableStyle(true);
    let t = createTable({ cols: 3, colWidth: 20, dataRows: 2, rowLines: 1, first: 'title', second: 'header' }, style);
    t = setText(t, 0, 0, '부품 목록');
    t = setText(t, 1, 0, '번호');
    t = setText(t, 1, 1, '이름');
    t = setText(t, 1, 2, '수량, 개');
    t = setText(t, 2, 0, '1');
    t = setText(t, 2, 1, '{\\fArial|b1;볼트}\\P"M8"');
    t = setText(t, 2, 2, '4');
    t = mergeCells(t, 3, 0, 3, 1)!;
    t = setText(t, 3, 0, '합계');
    t = setText(t, 3, 2, '4');
    expect(tableToCsv(t)).toBe('부품 목록,,\r\n번호,이름,"수량, 개"\r\n1,"볼트\n""M8""",4\r\n합계,,4\r\n');
    expect(csvFileText(t).startsWith('﻿부품 목록')).toBe(true);
  });
});

describe('MATCHCELL: 셀 정렬 일치', () => {
  it('원본의 실제 정렬을 옮기고, 대상 행 기본값과 같으면 재지정을 지운다', () => {
    const style = defaultTableStyle(true);
    const t = createTable({ cols: 2, colWidth: 20, dataRows: 2, rowLines: 1, first: 'title', second: 'header' }, style);
    // 제목 행(중간 중심 5) → 데이터 셀(기본 맨 위 중심 2)
    const src = effectiveAlign(t, style, 0, 0);
    expect(src).toBe(5);
    const a = matchCellAlign(t, style, { r: 2, c: 1 }, src)!;
    expect(a.cells[2 * 2 + 1]!.align).toBe(5);
    // 다시 데이터 기본(2)으로 맞추면 재지정이 없어진다
    const b = matchCellAlign(a, style, { r: 2, c: 1 }, 2)!;
    expect(b.cells[2 * 2 + 1]!.align).toBeUndefined();
    // 바뀐 것이 없으면 null
    expect(matchCellAlign(b, style, { r: 2, c: 1 }, 2)).toBeNull();
    // 병합된 셀은 기준 셀에 적용
    const m = mergeCells(t, 2, 0, 3, 0)!;
    const c = matchCellAlign(m, style, { r: 3, c: 0 }, 9)!;
    expect(c.cells[2 * 2 + 0]!.align).toBe(9);
  });
});

describe('GROUPEDIT', () => {
  it('객체 추가·제거, 이름 바꾸기, 분해, 명령 취소', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 1, 0);
    const b = line(h(), 0, 0, 0, 1);
    const c = circle(h(), 5, 5, 1);
    put(doc, a, b, c);
    const g = createGroupOps(doc, '창문', '', [a.handle], h)!;
    s.commit({ label: 'GROUP', ops: g.ops });
    const add = addToGroupOps(doc, g.handle, [a.handle, b.handle, c.handle, 'FFFF']);
    expect(add.added).toBe(2);
    s.commit({ label: 'GROUPEDIT', ops: add.ops });
    expect(listGroups(doc)[0]!.group.entities).toEqual([a.handle, b.handle, c.handle]);
    expect(addToGroupOps(doc, g.handle, [b.handle]).ops).toEqual([]);
    const rem = removeFromGroupOps(doc, g.handle, [b.handle]);
    expect(rem.removed).toBe(1);
    s.commit({ label: 'GROUPEDIT', ops: rem.ops });
    expect(listGroups(doc)[0]!.group.entities).toEqual([a.handle, c.handle]);
    // 이름: 겹침·금지 글자·* 시작은 거절
    const g2 = createGroupOps(doc, '문', '', [b.handle], h)!;
    s.commit({ label: 'GROUP', ops: g2.ops });
    expect(renameGroupOps(doc, g.handle, '문')).toMatch(/이미/);
    expect(renameGroupOps(doc, g.handle, 'a*b')).toMatch(/문자/);
    expect(renameGroupOps(doc, g.handle, '*A9')).toMatch(/문자/);
    const ren = renameGroupOps(doc, g.handle, '큰 창문');
    expect(Array.isArray(ren)).toBe(true);
    s.commit({ label: 'GROUPEDIT', ops: ren as never });
    expect(listGroups(doc).map((x) => x.name)).toEqual(['큰 창문', '문']);
    s.commit({ label: 'GROUPEDIT', ops: explodeGroupOps(doc, g.handle) });
    expect(listGroups(doc).map((x) => x.name)).toEqual(['문']);
    // 이름 없는 그룹은 구성원이 모두 빠지면 지운다
    const u = createGroupOps(doc, null, '', [c.handle], h)!;
    s.commit({ label: 'GROUP', ops: u.ops });
    s.commit({ label: 'GROUPEDIT', ops: removeFromGroupOps(doc, u.handle, [c.handle]).ops });
    expect(listGroups(doc).map((x) => x.name)).toEqual(['문']);
    // 명령 취소로 하나씩 되돌린다
    s.undo();
    s.undo();
    s.undo();
    expect(listGroups(doc).map((x) => x.name)).toEqual(['큰 창문', '문']);
    s.undo();
    expect(listGroups(doc).map((x) => x.name)).toEqual(['창문', '문']);
  });
});

describe('DIMCENTER: DIMCEN 중심 표식 선', () => {
  it('양수 십자, 음수 십자 + 중심선, 0 없음, UCS 각도', () => {
    expect(dimCenterSegments({ x: 0, y: 0 }, 10, 0)).toEqual([]);
    const p = dimCenterSegments({ x: 1, y: 2 }, 10, 2.5);
    expect(p).toHaveLength(2);
    expect(p[0]).toEqual([
      { x: -1.5, y: 2 },
      { x: 3.5, y: 2 },
    ]);
    const n = dimCenterSegments({ x: 0, y: 0 }, 10, -2);
    expect(n).toHaveLength(6);
    // 오른쪽 중심선: 중심에서 4부터 12까지(원 밖으로 2)
    expect(n[2]![0].x).toBeCloseTo(4);
    expect(n[2]![1].x).toBeCloseTo(12);
    // 반지름이 표식보다 작으면 중심선 없음
    expect(dimCenterSegments({ x: 0, y: 0 }, 1.5, -2)).toHaveLength(2);
    const r = dimCenterSegments({ x: 0, y: 0 }, 10, 1, Math.PI / 2);
    expect(r[0]![1].y).toBeCloseTo(1);
    expect(r[0]![1].x).toBeCloseTo(0);
  });
});

describe('IMAGEADJUST·PDFADJUST·IMAGEQUALITY', () => {
  const img = (): ImageEntity => ({ ...entityDefaults(), type: 'IMAGE', handle: '1', insert: { x: 0, y: 0, z: 0 }, uVector: { x: 1, y: 0, z: 0 }, vVector: { x: 0, y: 1, z: 0 }, imageSize: { x: 10, y: 10 }, displayFlags: 7, clipping: false, brightness: 50, contrast: 50, fade: 0, clipBoundaryType: 1, clipBoundary: [] });
  const pdf = (): UnderlayEntity => ({ ...entityDefaults(), type: 'PDFUNDERLAY', handle: '2', insert: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotation: 0, flags: 2, contrast: 20, fade: 25, clipBoundary: [] });

  it('이미지 값을 0~100으로 고치고, 바뀐 것이 없으면 null', () => {
    const e = img();
    expect(adjustImage(e, { brightness: 50 })).toBeNull();
    const a = adjustImage(e, { brightness: 70, contrast: 130, fade: 10.4 })!;
    expect([a.brightness, a.contrast, a.fade]).toEqual([70, 100, 10]);
  });

  it('PDF 흐리기(0~80)·대비·단색 플래그', () => {
    const e = pdf();
    expect(underlayAdjustOf(e)).toEqual({ fade: 25, contrast: 20, monochrome: false });
    const m = adjustUnderlay(e, { monochrome: true })!;
    expect(m.flags).toBe(6);
    expect(adjustUnderlay(m, { monochrome: true })).toBeNull();
    expect(adjustUnderlay(e, { fade: 95 })!.fade).toBe(80);
    expect(adjustUnderlay(m, { monochrome: false })!.flags).toBe(2);
  });

  it('IMAGEQUALITY는 RASTERVARIABLES 그룹 71에 저장하고 명령 취소로 되돌린다', () => {
    const { doc, s, h } = setup();
    expect(imageQuality(doc)).toBe(1);
    const ops = imageQualityOps(doc, 0, h)!;
    s.commit({ label: 'IMAGEQUALITY', ops });
    expect(imageQuality(doc)).toBe(0);
    expect(imageQualityOps(doc, 0, h)).toEqual([]);
    s.commit({ label: 'IMAGEQUALITY', ops: imageQualityOps(doc, 1, h)! });
    expect(imageQuality(doc)).toBe(1);
    s.undo();
    expect(imageQuality(doc)).toBe(0);
    s.undo();
    expect(imageQuality(doc)).toBe(1);
  });
});
