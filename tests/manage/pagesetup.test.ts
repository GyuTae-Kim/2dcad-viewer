import { describe, expect, it } from 'vitest';
import { MODEL_SPACE, tableKey } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { EditSession } from '../../src/edit/session';
import { namedPageSetups } from '../../src/edit/script/pagesetup';
import { readDxf } from '../../src/io/dxf/reader';
import { writeDxf } from '../../src/io/dxf/writer';
import { readDwg, writeDwg } from '../../src/io/dwg';
import { applyNamedSetupOps, deleteNamedSetupOps, pageFormOf, pageSettingsOf, renameNamedSetupOps, saveNamedSetupOps } from '../../src/app/pagesetup-ui';

function setup() {
  const doc = createNewDocument('metric');
  const s = new EditSession(doc, () => {});
  const layout = doc.layouts.find((l) => tableKey(l.blockName) !== MODEL_SPACE)!;
  return { doc, s, layout };
}

describe('페이지 설정 관리자: 명명된 페이지 설정', () => {
  it('칸 ↔ 플롯 설정 왕복(용지·방향·축척·간격띄우기·중심)', () => {
    const { layout } = setup();
    const f = pageFormOf(layout.plot, false);
    const next = pageSettingsOf(layout.plot, { ...f, paper: 'A1', landscape: true, scale: '1:1', centered: false, offsetX: 10, offsetY: 5, styleSheet: 'monochrome.ctb' }, false);
    expect(next).toMatchObject({ paperWidth: 841, paperHeight: 594, plotOrigin: { x: 10, y: 5 }, styleSheet: 'monochrome.ctb', standardScaleType: 16 });
    expect(next.flags & 4).toBe(0);
    const back = pageFormOf(next, false);
    expect(back).toMatchObject({ paper: 'A1', landscape: true, centered: false, offsetX: 10, offsetY: 5, scale: '1:1' });
    // 모형: 사용자 축척과 모형 플래그
    const m = pageSettingsOf(layout.plot, { ...f, scale: '1:25', area: 'extents' }, true);
    expect(m.flags & 1024).toBe(1024);
    expect(pageFormOf(m, true)).toMatchObject({ scale: '1:25', area: 'extents' });
  });

  it('새로 만들기·현재로 설정·이름 바꾸기·삭제는 명령 취소로 되돌린다', () => {
    const { doc, s, layout } = setup();
    const plot = pageSettingsOf(layout.plot, { ...pageFormOf(layout.plot, false), paper: 'A2', landscape: true }, false);
    s.commit({ label: 'PAGESETUP', ops: saveNamedSetupOps(doc, 'A2 가로', plot, () => s.newHandle())!, group: 7 });
    expect(namedPageSetups(doc).items.map((x) => x.name)).toEqual(['A2 가로']);
    const item = namedPageSetups(doc).items[0]!;
    s.commit({ label: 'PAGESETUP', ops: applyNamedSetupOps(layout, item), group: 7 });
    const lay = doc.layouts.find((l) => l.handle === layout.handle)!;
    expect(lay.plot.pageSetupName).toBe('A2 가로');
    expect(lay.plot.paperWidth).toBe(594);
    s.commit({ label: 'PAGESETUP', ops: renameNamedSetupOps(doc, 'A2 가로', '출력용')!, group: 7 });
    expect(namedPageSetups(doc).items.map((x) => x.name)).toEqual(['출력용']);
    expect(doc.layouts.find((l) => l.handle === layout.handle)!.plot.pageSetupName).toBe('출력용');
    s.commit({ label: 'PAGESETUP', ops: deleteNamedSetupOps(doc, '출력용')!, group: 7 });
    expect(namedPageSetups(doc).items).toEqual([]);
    expect(doc.layouts.find((l) => l.handle === layout.handle)!.plot.pageSetupName).toBe('');
    // 같은 묶음은 명령 취소 한 번
    s.undo();
    expect(namedPageSetups(doc).items).toEqual([]);
    expect(doc.layouts.find((l) => l.handle === layout.handle)!.plot.paperWidth).toBe(layout.plot.paperWidth);
  });

  it('DXF·DWG에 저장해 다시 열어도 남는다', () => {
    const { doc, s, layout } = setup();
    const plot = pageSettingsOf(layout.plot, { ...pageFormOf(layout.plot, false), paper: 'A0', landscape: true, styleSheet: 'monochrome.ctb' }, false);
    s.commit({ label: 'PAGESETUP', ops: saveNamedSetupOps(doc, 'BIG', plot, () => s.newHandle())! });
    const dxf = readDxf(writeDxf(doc).data as Uint8Array);
    const a = namedPageSetups(dxf).items.find((x) => x.name === 'BIG');
    expect(a?.plot).toMatchObject({ paperWidth: 1189, styleSheet: 'monochrome.ctb' });
    const dwg = readDwg(writeDwg(doc, { version: 'AC1032' }).data);
    const b = namedPageSetups(dwg).items.find((x) => x.name === 'BIG');
    expect(b?.plot).toMatchObject({ paperWidth: 1189, styleSheet: 'monochrome.ctb' });
  });
});

describe('뷰 관리자: 이름 바꾸기', () => {
  it('열쇠를 옮기고 핸들은 지킨다(대소문자만이면 한 작업)', async () => {
    const { renameViewOps } = await import('../../src/app/viewcmds');
    const { makeHarness } = await import('../cmds2/harness');
    const h = makeHarness();
    const v = { name: 'Plan', handle: 'AB', flags: 0, center: { x: 0, y: 0 }, width: 10, height: 5, viewDirection: { x: 0, y: 0, z: 1 }, viewTarget: { x: 0, y: 0, z: 0 }, twist: 0 };
    h.st.session.commit({ label: 'VIEW', ops: [{ kind: 'view', key: 'PLAN', before: null, after: v }] });
    h.st.session.commit({ label: 'VIEW', ops: renameViewOps(h.st, 'Plan', '평면')! });
    expect(h.doc.views.has('PLAN')).toBe(false);
    expect(h.doc.views.get('평면')).toMatchObject({ name: '평면', handle: 'AB' });
    expect(renameViewOps(h.st, '평면', '평면')!.length).toBe(1);
    h.st.session.undo();
    expect(h.doc.views.get('PLAN')?.name).toBe('Plan');
  });
});

describe('배치 이동 또는 복사', () => {
  it('탭 순서를 바꾸고 명령 취소로 되돌린다', async () => {
    const { createLayoutOps, defaultPlot, layoutOrderOps } = await import('../../src/app/layoutcmds');
    const { DocState } = await import('../../src/app/docstate');
    const doc = createNewDocument('metric');
    const st = new DocState(1, doc, 'a.dwg', 0, 0);
    st.session = new EditSession(doc, () => {});
    const { ops, layout } = createLayoutOps(null as never, st, '두번째', defaultPlot(st));
    st.session.commit({ label: 'LAYOUT', ops });
    const papers = () => doc.layouts.filter((l) => tableKey(l.blockName) !== MODEL_SPACE).sort((a, b) => a.tabOrder - b.tabOrder).map((l) => l.name);
    const first = papers()[0]!;
    expect(papers()).toEqual([first, '두번째']);
    const keyOf = (n: string) => tableKey(doc.layouts.find((l) => l.name === n)!.blockName);
    st.session.commit({ label: 'LAYOUT', ops: layoutOrderOps(st, [tableKey(layout.blockName), keyOf(first)]) });
    expect(papers()).toEqual(['두번째', first]);
    st.session.undo();
    expect(papers()).toEqual([first, '두번째']);
  });
});
