import { describe, expect, it } from 'vitest';
import type { BlockDef, CadDocument, Entity } from '../../src/core/model';
import { MODEL_SPACE, PAPER_SPACE, entityDefaults, tableKey } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { registerLayoutCommands } from '../../src/app/layoutcmds';
import { importLayoutOps, layoutFileIO, layoutTemplateDocument } from '../../src/app/layoutcmds-file';
import { rememberFile } from '../../src/app/sessionfiles';
import { scriptVars } from '../../src/app/script';
import { writeDxf } from '../../src/io/dxf/writer';
import { readCadFile } from '../../src/io';
import { makeScriptApp } from './app';

let hs = 0xa000;
const H = () => (hs++).toString(16).toUpperCase();

const line = (x0: number, y0: number, x1: number, y1: number, layer = '0', owner?: string) =>
  ({ ...entityDefaults(), layer, owner, type: 'LINE', handle: H(), start: { x: x0, y: y0, z: 0 }, end: { x: x1, y: y1, z: 0 } }) as Entity;

/** 템플릿 도면: Layout1 종이 공간에 표제 선(TITLE 도면층)과 블록 TB 참조, 모형 공간에 선 하나 */
function templateDoc(): CadDocument {
  const doc = createNewDocument('metric');
  doc.layers.set('TITLE', { ...doc.layers.get('0')!, name: 'TITLE', handle: H(), color: { aci: 3 } });
  const rec = H();
  const tb: BlockDef = { name: 'TB', handle: H(), recordHandle: rec, basePoint: { x: 0, y: 0, z: 0 }, flags: 0, entities: [line(0, 0, 10, 0, '0', rec)] };
  doc.blockRecords.set('TB', { name: 'TB', handle: rec, flags: 0, insertUnits: 0, explodable: true, scalable: true });
  doc.blocks.set('TB', tb);
  const paper = doc.blocks.get(PAPER_SPACE)!;
  paper.entities.push(line(10, 10, 400, 10, 'TITLE', paper.recordHandle));
  paper.entities.push({ ...entityDefaults(), type: 'INSERT', handle: H(), owner: paper.recordHandle, block: 'TB', insert: { x: 300, y: 20, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotation: 0, columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0, attribs: [] } as Entity);
  doc.blocks.get(MODEL_SPACE)!.entities.push(line(0, 0, 1, 1));
  for (const b of doc.blocks.values()) for (const e of b.entities) doc.entityIndex.set(e.handle, e);
  return doc;
}

const paperNames = (doc: CadDocument) => doc.layouts.filter((l) => tableKey(l.blockName) !== MODEL_SPACE).map((l) => l.name);

describe('배치 템플릿(T)', () => {
  it('원본 배치를 가져오고 쓰는 도면층·블록이 함께 온다(같은 이름은 "이름 (2)")', () => {
    const src = templateDoc();
    const dst = createNewDocument('metric');
    const h = makeScriptApp();
    const { ops, added } = importLayoutOps(h.doc, src, ['Layout1'], () => h.st.session.newHandle());
    void dst;
    expect(added).toEqual([{ from: 'Layout1', to: 'Layout1 (2)' }]);
    h.st.session.commit({ label: 'LAYOUT', ops });
    expect(paperNames(h.doc)).toEqual(['Layout1', 'Layout1 (2)']);
    const l = h.doc.layouts.find((x) => x.name === 'Layout1 (2)')!;
    const blk = h.doc.blocks.get(tableKey(l.blockName))!;
    expect(blk.entities.map((e) => e.type).sort()).toEqual(['INSERT', 'LINE']);
    expect(h.doc.layers.has('TITLE')).toBe(true);
    expect(h.doc.blocks.has('TB')).toBe(true);
    // 원본은 그대로
    expect(paperNames(src)).toEqual(['Layout1']);
  });

  it('-LAYOUT T: 스크립트에서는 이번 세션에 고른 파일 이름으로, 명령 취소 한 번에 되돌린다', async () => {
    const src = templateDoc();
    rememberFile('A3표제.dwt', new Blob([writeDxf(src).data as BlobPart]));
    const h = makeScriptApp();
    registerLayoutCommands(h.app);
    const depth = h.st.session.depth;
    expect(await h.script('-LAYOUT T A3표제 ?\n*\n')).toBe('idle');
    expect(h.errors()).toEqual([]);
    expect(h.out()).toContain('"A3표제.dwt"의 배치: Layout1');
    expect(paperNames(h.doc)).toEqual(['Layout1', 'Layout1 (2)']);
    expect(h.out()).toContain('배치 "Layout1"을(를) "A3표제.dwt"에서 "Layout1 (2)"(으)로 가져왔습니다');
    expect(h.doc.layers.get('TITLE')?.color.aci).toBe(3);
    h.st.session.undo();
    expect(h.st.session.depth).toBe(depth);
    expect(paperNames(h.doc)).toEqual(['Layout1']);
    expect(h.doc.layers.has('TITLE')).toBe(false);
  });

  it('-LAYOUT T: 없는 파일·배치는 알리고 멈춘다', async () => {
    const h = makeScriptApp();
    registerLayoutCommands(h.app);
    expect(await h.script('-LAYOUT T 없는파일.dwt\n')).toBe('paused');
    expect(h.errors()[0]).toContain('템플릿 파일 "없는파일.dwt"을(를) 찾을 수 없습니다');
  });

  it('FILEDIA 0이면 대화상자 대신 이름을 묻는다', async () => {
    const h = makeScriptApp();
    registerLayoutCommands(h.app);
    scriptVars.FILEDIA = 0;
    try {
      void h.app.run('LAYOUT');
      await Promise.resolve();
      h.app.submitInput('T');
      await Promise.resolve();
      expect(h.prompts[h.prompts.length - 1]).toBe('템플릿 파일 이름 입력:');
      h.app.cancel();
    } finally {
      scriptVars.FILEDIA = 1;
    }
  });
});

describe('배치 다른 이름으로 저장(SA)', () => {
  it('배치 하나만 든 새 도면: 모형 공간은 비우고 그 배치가 *Paper_Space가 된다', () => {
    const src = templateDoc();
    // 두 번째 배치(가져오기로 만든다)
    const h = makeScriptApp();
    const { ops } = importLayoutOps(h.doc, src, ['Layout1'], () => h.st.session.newHandle());
    h.st.session.commit({ label: 'T', ops });
    const out = layoutTemplateDocument(h.doc, 'Layout1 (2)');
    expect(paperNames(out)).toEqual(['Layout1 (2)']);
    expect(out.layouts.find((l) => l.name === 'Layout1 (2)')!.blockName).toBe('*Paper_Space');
    expect(out.blocks.get(MODEL_SPACE)!.entities).toHaveLength(0);
    expect(out.blocks.get(PAPER_SPACE)!.entities.map((e) => e.type).sort()).toEqual(['INSERT', 'LINE']);
    expect(out.blocks.has('TB')).toBe(true);
    expect(out.layers.has('TITLE')).toBe(true);
    // 원본은 그대로
    expect(paperNames(h.doc)).toEqual(['Layout1', 'Layout1 (2)']);
    // 쓰고 다시 읽어도 배치가 하나
    const back = readCadFile(writeDxf(out).data, 'x.dxf');
    expect(paperNames(back)).toEqual(['Layout1 (2)']);
  });

  it('-LAYOUT SA: 스크립트에서 이름으로 내려받는다(.dxf는 DXF, 확장자가 없으면 .dwt)', async () => {
    const saved: { name: string; size: number; data: Uint8Array }[] = [];
    const prev = layoutFileIO.download;
    layoutFileIO.download = (b, name) => void b.arrayBuffer().then((x) => saved.push({ name, size: b.size, data: new Uint8Array(x) }));
    try {
      const h = makeScriptApp((doc) => {
        const paper = doc.blocks.get(PAPER_SPACE)!;
        const e = line(5, 5, 50, 5, '0', paper.recordHandle);
        paper.entities.push(e);
      });
      registerLayoutCommands(h.app);
      expect(await h.script('-LAYOUT SA Layout1 표제.dxf\n')).toBe('idle');
      expect(h.errors()).toEqual([]);
      await new Promise((r) => setTimeout(r, 10));
      expect(saved.map((s) => s.name)).toEqual(['표제.dxf']);
      const back = readCadFile(saved[0]!.data, '표제.dxf');
      expect(paperNames(back)).toEqual(['Layout1']);
      expect(back.blocks.get(PAPER_SPACE)!.entities.some((e) => e.type === 'LINE')).toBe(true);
      expect(await h.script('-LAYOUT SA  표제2\n')).toBe('idle');
      await new Promise((r) => setTimeout(r, 10));
      expect(saved.map((s) => s.name)).toEqual(['표제.dxf', '표제2.dwt']);
      expect(h.out()).toContain('배치 "Layout1"을(를) 표제2.dwt(으)로 저장했습니다');
      expect(await h.script('-LAYOUT SA 없음\n')).toBe('paused');
    } finally {
      layoutFileIO.download = prev;
    }
  });
});
