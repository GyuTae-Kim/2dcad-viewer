import { describe, expect, it } from 'vitest';
import { createNewDocument } from '../../src/core/newdoc';
import { readDwg, writeDwg } from '../../src/io/dwg';
import { readDxf } from '../../src/io/dxf/reader';
import { writeDxf } from '../../src/io/dxf/writer';
import { type DrawingProps, drawingProps, dwgPropsObject, encodeSummaryInfo, parseSummaryInfo } from '../../src/io/dwgprops';
import { drawingPropsOps } from '../../src/app/dwgprops';
import { EditSession } from '../../src/edit/session';

const PROPS: DrawingProps = {
  title: '평면도',
  subject: '1층',
  author: '김규태',
  keywords: '건축, 평면',
  comments: '줄 하나\n줄 둘',
  lastSavedBy: '',
  revisionNumber: '3',
  hyperlinkBase: 'https://example.com/a/',
  custom: [
    ['프로젝트', 'OpenCAD'],
    ['번호', 'A-101'],
  ],
};

function edited() {
  const doc = createNewDocument('metric');
  const s = new EditSession(doc, () => {});
  const ops = drawingPropsOps(doc, PROPS, () => s.newHandle());
  s.commit({ label: 'DWGPROPS', ops });
  return { doc, s };
}

function expectProps(p: DrawingProps) {
  expect(p.title).toBe('평면도');
  expect(p.subject).toBe('1층');
  expect(p.author).toBe('김규태');
  expect(p.keywords).toBe('건축, 평면');
  expect(p.comments).toBe('줄 하나 줄 둘');
  expect(p.revisionNumber).toBe('3');
  expect(p.hyperlinkBase).toBe('https://example.com/a/');
  expect(p.custom).toEqual(PROPS.custom);
}

describe('도면 특성(DWGPROPS)', () => {
  it('편집은 XRECORD를 만들고 명령 취소 한 단계로 되돌린다', () => {
    const { doc, s } = edited();
    expect(dwgPropsObject(doc)).toBeTruthy();
    expectProps(drawingProps(doc));
    expect(doc.header.get('$HYPERLINKBASE')).toBe('https://example.com/a/');
    s.undo();
    expect(dwgPropsObject(doc)).toBeNull();
    expect(drawingProps(doc).title).toBe('');
    // 같은 값이면 작업 없음
    s.redo();
    expect(drawingPropsOps(doc, drawingProps(doc), () => s.newHandle())).toEqual([]);
  });

  it('요약 정보 구역 인코딩 왕복(R2004 바이트·R2007 UTF-16)', () => {
    const si = { ...PROPS, comments: '한 줄', lastSavedBy: 'sean', editTime: 0.5, created: 2460000.25, modified: 2460001.5 };
    for (const wide of [false, true]) {
      const enc = new TextEncoder();
      const dec = new TextDecoder();
      const b = encodeSummaryInfo(si, wide, (t) => enc.encode(t));
      const r = parseSummaryInfo(b, wide, (x) => dec.decode(x));
      expect(r).toMatchObject({ title: '평면도', author: '김규태', lastSavedBy: 'sean', revisionNumber: '3', hyperlinkBase: si.hyperlinkBase, custom: si.custom });
      expect(r.created).toBeCloseTo(2460000.25, 6);
      expect(r.editTime).toBeCloseTo(0.5, 6);
    }
  });

  it('DXF 저장 왕복: XRECORD와 $CUSTOMPROPERTYTAG 쌍', () => {
    const { doc } = edited();
    const out = writeDxf(doc, { version: 'AC1032' } as never);
    const text = new TextDecoder().decode(out.data as Uint8Array);
    expect(text).toContain('DWGPROPS COOKIE');
    expect(text.match(/\$CUSTOMPROPERTYTAG/g)?.length).toBe(2);
    const back = readDxf(out.data as Uint8Array);
    expectProps(drawingProps(back));
  });

  for (const version of ['AC1018', 'AC1024', 'AC1032', 'AC1015'] as const) {
    it(`DWG ${version} 저장 왕복: 다시 열어도 남고, 다시 저장해도 남는다`, () => {
      const { doc } = edited();
      const a = readDwg(writeDwg(doc, { version }).data);
      expectProps(drawingProps(a));
      // 다시 고쳐 저장
      const s = new EditSession(a, () => {});
      const next = { ...drawingProps(a), title: '배치도', custom: [...drawingProps(a).custom, ['단계', '실시'] as [string, string]] };
      s.commit({ label: 'DWGPROPS', ops: drawingPropsOps(a, next, () => s.newHandle()) });
      const b = readDwg(writeDwg(a, { version }).data);
      expect(drawingProps(b).title).toBe('배치도');
      expect(drawingProps(b).custom.map((c) => c[0])).toEqual(['프로젝트', '번호', '단계']);
    });
  }
});
