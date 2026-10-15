import { describe, expect, it } from 'vitest';
import type { DictionaryObject, Entity, PlotSettings, PlotSettingsObject } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { rootDictionary } from '../../src/core/framevars';
import { EditSession, applyOps } from '../../src/edit/session';
import { importPageSetupOps, namedPageSetups } from '../../src/edit/script/pagesetup';
import { parsePatternSpec } from '../../src/app/dashcmds-hatch';
import { parseIgnoreList } from '../../src/app/dashcmds-misc';
import { emptyText, parseFontSpec, zeroLength } from '../../src/app/dashcmds-tables';
import { deviceKind, paperKeyOf, parsePlotScale } from '../../src/app/dashcmds-plot';
import { DocState } from '../../src/app/docstate';
import { registerDashCommands } from '../../src/app/dashcmds';
import { makeScriptApp } from './app';

const plot = (name: string, w: number, h: number, flags = 688): PlotSettings => ({
  pageSetupName: name,
  printerName: 'DWG To PDF.pc3',
  paperName: `ISO_full_bleed_A3_(${w}_x_${h}_MM)`,
  paperWidth: w,
  paperHeight: h,
  margins: [0, 0, 0, 0],
  plotOrigin: { x: 0, y: 0 },
  windowMin: { x: 0, y: 0 },
  windowMax: { x: 0, y: 0 },
  scaleNumerator: 1,
  scaleDenominator: 1,
  flags,
  paperUnits: 1,
  rotation: 1,
  plotType: 5,
  styleSheet: 'monochrome.ctb',
  standardScaleType: 16,
});

/** 원본 도면에 이름 있는 페이지 설정을 넣는다 */
function withSetups(names: [string, number][]) {
  const doc = createNewDocument('metric');
  const s = new EditSession(doc, () => {});
  const r = importPageSetupOps(
    doc,
    names.map(([n, w]) => ({ name: n, plot: plot(n, w, 297, n.startsWith('M') ? 1024 : 688), model: false })),
    new Set(),
    () => s.newHandle(),
  )!;
  applyOps(doc, r.ops);
  return doc;
}

describe('페이지 설정 가져오기(PSETUPIN)', () => {
  it('이름 있는 설정 읽기와 새로 넣기·재정의', () => {
    const src = withSetups([
      ['A3 가로', 420],
      ['Model PDF', 297],
    ]);
    const list = namedPageSetups(src).items;
    expect(list.map((x) => [x.name, x.model])).toEqual([
      ['A3 가로', false],
      ['Model PDF', true],
    ]);
    const host = withSetups([['a3 가로', 100]]);
    const s = new EditSession(host, () => {});
    // 재정의하지 않으면 같은 이름은 건너뛴다
    const r1 = importPageSetupOps(host, list, new Set(), () => s.newHandle())!;
    expect(r1.added).toEqual(['Model PDF']);
    expect(r1.replaced).toEqual([]);
    const r2 = importPageSetupOps(host, list, new Set(['A3 가로'.toUpperCase()]), () => s.newHandle())!;
    expect(r2.replaced).toEqual(['a3 가로']);
    s.commit({ label: 'PSETUPIN', ops: r2.ops });
    const after = namedPageSetups(host).items;
    expect(after.map((x) => x.name).sort()).toEqual(['Model PDF', 'a3 가로']);
    expect(after.find((x) => x.name === 'a3 가로')!.plot.paperWidth).toBe(420);
    // 사전 소유·반응자
    const dict = namedPageSetups(host).dict!;
    const o = host.objects.get(dict.entries.get('Model PDF')!) as PlotSettingsObject;
    expect(o.owner).toBe(dict.handle);
    expect(o.plot.pageSetupName).toBe('Model PDF');
    s.undo();
    expect(namedPageSetups(host).items.map((x) => x.name)).toEqual(['a3 가로']);
  });

  it('사전이 없으면 루트 사전에 ACAD_PLOTSETTINGS를 만든다', () => {
    const host = createNewDocument('metric');
    const root = rootDictionary(host)!;
    const h = root.entries.get('ACAD_PLOTSETTINGS');
    if (h) {
      host.objects.delete(h);
      root.entries.delete('ACAD_PLOTSETTINGS');
    }
    const s = new EditSession(host, () => {});
    const r = importPageSetupOps(host, [{ name: 'P1', plot: plot('P1', 420, 297), model: false }], new Set(), () => s.newHandle())!;
    s.commit({ label: 'X', ops: r.ops });
    expect(namedPageSetups(host).items.map((x) => x.name)).toEqual(['P1']);
    expect((host.objects.get(rootDictionary(host)!.entries.get('ACAD_PLOTSETTINGS')!) as DictionaryObject).entries.size).toBe(1);
  });

  it('-PSETUPIN: 열린 다른 도면에서 이름으로(스크립트), 와일드카드·재정의 질문', async () => {
    const h = makeScriptApp();
    registerDashCommands(h.app);
    const src = withSetups([
      ['A3 가로', 420],
      ['A4 세로', 210],
      ['B', 500],
    ]);
    h.app.docs.push(new DocState(2, src, 'source.dwg', 0, 0));
    expect(await h.script('-PSETUPIN\nsource.dwg\nA*\n')).toBe('idle');
    expect(namedPageSetups(h.doc).items.map((x) => x.name)).toEqual(['A3 가로', 'A4 세로']);
    expect(await h.script('-PSETUPIN\nsource\n*\nY\nN\n')).toBe('idle');
    expect(h.prompts.filter((p) => p.includes('재정의'))).toHaveLength(2);
    expect(namedPageSetups(h.doc).items.map((x) => x.name)).toEqual(['A3 가로', 'A4 세로', 'B']);
    expect(await h.script('-PSETUPIN\nnothere.dwg\n')).toBe('paused');
  });
});

describe('명령행 입력 해석', () => {
  it('해치 무늬 이름(섬 스타일 붙임)', () => {
    expect(parsePatternSpec('ansi31')).toEqual({ name: 'ANSI31', style: null });
    expect(parsePatternSpec('ANSI31,O')).toEqual({ name: 'ANSI31', style: 'outer' });
    expect(parsePatternSpec('solid,i')).toEqual({ name: 'SOLID', style: 'ignore' });
    expect(parsePatternSpec('_USER')).toEqual({ name: '_USER', style: null });
    expect(parsePatternSpec('NOPAT')).toBeNull();
    expect(parsePatternSpec('ANSI31,X')).toBeNull();
  });

  it('OVERKILL 무시할 특성 목록', () => {
    expect(parseIgnoreList('C,LA')).toEqual(['color', 'layer']);
    expect(parseIgnoreList('N')).toEqual([]);
    expect(parseIgnoreList('A')).toHaveLength(9);
    expect(parseIgnoreList('XX')).toBeNull();
  });

  it('STYLE 글꼴: 트루타입 이름·파일, SHX와 큰 글꼴', () => {
    expect(parseFontSpec('Arial')).toEqual({ font: 'arial.ttf', bigFont: '', family: 'Arial' });
    expect(parseFontSpec('malgun.ttf')).toEqual({ font: 'malgun.ttf', bigFont: '', family: '맑은 고딕' });
    expect(parseFontSpec('romans.shx,whgtxt.shx')).toEqual({ font: 'romans.shx', bigFont: 'whgtxt.shx' });
  });

  it('PURGE 0 길이 형상·빈 문자', () => {
    const base = { ...entityDefaults(), handle: '1' };
    expect(zeroLength({ ...base, type: 'LINE', start: { x: 1, y: 1, z: 0 }, end: { x: 1, y: 1, z: 0 } } as Entity)).toBe(true);
    expect(zeroLength({ ...base, type: 'LINE', start: { x: 1, y: 1, z: 0 }, end: { x: 2, y: 1, z: 0 } } as Entity)).toBe(false);
    expect(zeroLength({ ...base, type: 'CIRCLE', center: { x: 0, y: 0, z: 0 }, radius: 0 } as Entity)).toBe(true);
    expect(emptyText({ ...base, type: 'MTEXT', text: '{\\P}' } as unknown as Entity)).toBe(true);
    expect(emptyText({ ...base, type: 'TEXT', text: ' a ' } as unknown as Entity)).toBe(false);
  });

  it('-PLOT 장치·용지·축척', () => {
    expect(deviceKind('DWG To PDF.pc3')).toBe('pdf');
    expect(deviceKind('AutoCAD PDF (High Quality Print)')).toBe('pdf');
    expect(deviceKind('svg')).toBe('svg');
    expect(deviceKind('없음')).toBe('none');
    expect(deviceKind('HP LaserJet')).toBeNull();
    expect(paperKeyOf('ISO A3 (297.00 x 420.00 MM)')).toBe('A3');
    expect(paperKeyOf('ISO_full_bleed_A1_(594.00_x_841.00_MM)')).toBe('A1');
    expect(paperKeyOf('ANSI_B_(11.00_x_17.00_Inches)')).toBe('TABLOID');
    expect(paperKeyOf('letter')).toBe('LETTER');
    expect(paperKeyOf('A9')).toBeNull();
    expect(parsePlotScale('F')).toBe('fit');
    expect(parsePlotScale('1=100')).toEqual({ paper: 1, units: 100 });
    expect(parsePlotScale('1:50')).toEqual({ paper: 1, units: 50 });
    expect(parsePlotScale('0=1')).toBeNull();
  });
});

describe('명령 취소 묶기(EditSession.squashUndo)', () => {
  it('깊이 뒤의 항목을 하나로 합치고 저장 상태를 맞춘다', () => {
    const doc = createNewDocument('metric');
    const s = new EditSession(doc, () => {});
    const add = (x: number) => {
      const e = { ...entityDefaults(), type: 'POINT', handle: s.newHandle(), position: { x, y: 0, z: 0 }, angle: 0 } as Entity;
      s.commit({ label: 'POINT', ops: [{ kind: 'add', block: MODEL_SPACE, entity: e }] });
    };
    add(0);
    const d = s.depth;
    add(1);
    add(2);
    s.markSaved();
    expect(s.squashUndo(d, 'SCRIPT')).toBe(2);
    expect(s.depth).toBe(d + 1);
    expect(s.dirty).toBe(false);
    expect(s.undo()!.label).toBe('SCRIPT');
    expect(doc.blocks.get(MODEL_SPACE)!.entities).toHaveLength(1);
    expect(s.dirty).toBe(true);
    s.redo();
    expect(doc.blocks.get(MODEL_SPACE)!.entities).toHaveLength(3);
    expect(s.squashUndo(s.depth, 'X')).toBe(0);
  });
});
