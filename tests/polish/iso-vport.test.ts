/**
 * 등각 설정 저장(SNAPSTYL·SNAPISOPAIR): *Active VPORT의 77·78(DXF R2000+), R12는 머리말 $SNAPSTYLE·$SNAPISOPAIR도,
 * DWG는 VPORT 객체의 스냅 스타일·등각평면. 왕복(DXF R12·R2000·R2018, DWG R2000·R2018)과 ezdxf 오라클,
 * 그리고 App 쪽(viewtools-iso.ts): 열 때 그 값을 쓰고, 바꾸면 도면에 기록하고 수정 표시만 한다(명령 취소 단위가 아니다).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CadDocument, VPortRecord } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { readCadFile } from '../../src/io';
import { writeDxf } from '../../src/io/dxf/writer';
import { writeDwg } from '../../src/io/dwg';
import { activeVport, vportSnap } from '../../src/io/vportsnap';
import { isoPlaneOf, isoState, setIso } from '../../src/app/viewtools-iso';
import { syncActiveVports } from '../../src/app/vports';
import { PYTHON, hasPython } from '../oracle/ezdxf';
import { browserGlobals } from './fakes';
import { makeApp } from './real-app';

vi.mock('../../src/app/view', async (orig) => ({ ...(await orig<object>()), CadView: (await import('./fakes')).FakeView }));
vi.mock('../../src/app/commandline', async (orig) => ({ ...(await orig<object>()), CommandLine: (await import('./fakes')).FakeCommandLine }));
vi.mock('../../src/app/engine', async (orig) => ({ ...(await orig<object>()), EngineClient: (await import('./fakes')).FakeEngine }));
vi.mock('../../src/text/fonts', async (orig) => ({ ...(await orig<object>()), OutlineLibrary: (await import('./fakes')).FakeFonts }));

beforeAll(() => {
  const g = browserGlobals();
  vi.stubGlobal('window', g.window);
  vi.stubGlobal('document', g.document);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../../.runtime/polish');

const DXF_VERSIONS = ['AC1009', 'AC1015', 'AC1032'] as const;
const DWG_VERSIONS = ['AC1015', 'AC1032'] as const;

/** 새 도면의 *Active에 등각 설정 */
function isoDoc(style: number, pair: number): CadDocument {
  const doc = createNewDocument('metric');
  const v = activeVport(doc)!;
  Object.assign(v, { snapStyle: style, snapIsoPair: pair });
  return doc;
}

const dxfText = (doc: CadDocument, version: (typeof DXF_VERSIONS)[number]) => new TextDecoder().decode(writeDxf(doc, { version }).data);
const backDxf = (doc: CadDocument, version: (typeof DXF_VERSIONS)[number]) => readCadFile(writeDxf(doc, { version }).data, 'x.dxf');
const backDwg = (doc: CadDocument, version: (typeof DWG_VERSIONS)[number]) => readCadFile(writeDwg(doc, { version }).data, 'x.dwg');

/** DXF 글에서 *Active VPORT 레코드의 그룹 코드 값 */
function vportCode(text: string, code: number): string | undefined {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const at = lines.findIndex((l, i) => l.toUpperCase() === '*ACTIVE' && lines[i - 1] === '2');
  if (at < 0) return undefined;
  for (let i = at + 1; i + 1 < lines.length; i += 2) {
    if (lines[i] === '0') return undefined;
    if (lines[i] === String(code)) return lines[i + 1];
  }
  return undefined;
}

/** DXF 글의 머리말 변수 값 */
function headerVar(text: string, name: string): string | undefined {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const i = lines.indexOf(name);
  return i >= 0 && lines[i - 1] === '9' ? lines[i + 2] : undefined;
}

describe('VPORT 77·78 왕복', () => {
  for (const version of DXF_VERSIONS) {
    it(`DXF ${version}: 스냅 스타일 1·등각평면 2(오른쪽)`, () => {
      const doc = isoDoc(1, 2);
      const text = dxfText(doc, version);
      expect(vportCode(text, 77)).toBe('1');
      expect(vportCode(text, 78)).toBe('2');
      if (version === 'AC1009') {
        expect(headerVar(text, '$SNAPSTYLE')).toBe('1');
        expect(headerVar(text, '$SNAPISOPAIR')).toBe('2');
      } else {
        expect(headerVar(text, '$SNAPSTYLE')).toBeUndefined();
        expect(headerVar(text, '$SNAPISOPAIR')).toBeUndefined();
      }
      const back = backDxf(doc, version);
      const v = activeVport(back)!;
      expect([v.snapStyle, v.snapIsoPair]).toEqual([1, 2]);
      expect(vportSnap(back, v)).toEqual({ style: 1, pair: 2 });
    });
  }

  for (const version of DWG_VERSIONS) {
    it(`DWG ${version}: 스냅 스타일 1·등각평면 1(위), 다시 DXF로`, () => {
      const back = backDwg(isoDoc(1, 1), version);
      const v = activeVport(back)!;
      expect([v.snapStyle, v.snapIsoPair]).toEqual([1, 1]);
      // DWG → DXF R2018 → 다시 읽기
      const again = backDxf(back, 'AC1032');
      expect(vportSnap(again, activeVport(again))).toEqual({ style: 1, pair: 1 });
    });
  }

  it('기본(표준 스냅): 77·78은 0이고 모델에는 필드가 없다(선택 필드)', () => {
    const doc = createNewDocument('metric');
    for (const version of DXF_VERSIONS) {
      const text = dxfText(doc, version);
      expect(vportCode(text, 77)).toBe('0');
      expect(vportCode(text, 78)).toBe('0');
      const v = activeVport(backDxf(doc, version))!;
      expect('snapStyle' in v || 'snapIsoPair' in v).toBe(false);
    }
    for (const version of DWG_VERSIONS) {
      const v = activeVport(backDwg(doc, version))!;
      expect('snapStyle' in v || 'snapIsoPair' in v).toBe(false);
    }
  });

  it('R12 머리말에만 있는 등각 설정(레코드에 값 없음)은 *Active 값으로 보고 R2000+ VPORT·DWG로 옮긴다', () => {
    const doc = createNewDocument('metric');
    doc.header.set('$SNAPSTYLE', 1);
    doc.header.set('$SNAPISOPAIR', 2);
    expect(vportSnap(doc, activeVport(doc))).toEqual({ style: 1, pair: 2 });
    const text = dxfText(doc, 'AC1032');
    expect(vportCode(text, 77)).toBe('1');
    expect(vportCode(text, 78)).toBe('2');
    // R2000+ 머리말에는 쓰지 않는다(지난 값이 남지 않게)
    expect(headerVar(text, '$SNAPSTYLE')).toBeUndefined();
    expect(vportSnap(backDwg(doc, 'AC1032'), activeVport(backDwg(doc, 'AC1032')))).toEqual({ style: 1, pair: 2 });
    // 레코드 값이 머리말보다 먼저
    Object.assign(activeVport(doc)!, { snapStyle: 0, snapIsoPair: 0 });
    const r12 = dxfText(doc, 'AC1009');
    expect(headerVar(r12, '$SNAPSTYLE')).toBe('0');
    expect(vportCode(r12, 77)).toBe('0');
  });

  it('이름 있는 뷰포트 구성(*Active 아님)은 머리말 값을 따르지 않는다', () => {
    const doc = createNewDocument('metric');
    doc.header.set('$SNAPSTYLE', 1);
    const named: VPortRecord = { ...activeVport(doc)!, name: 'SAVED', handle: 'FFA0' };
    expect(vportSnap(doc, named)).toEqual({ style: 0, pair: 0 });
  });
});

describe.skipIf(!hasPython)('ezdxf 오라클', () => {
  for (const version of DXF_VERSIONS) {
    it(`DXF ${version}: ezdxf가 *Active의 snap_style·snap_isopair를 읽고 감사 오류가 없다`, () => {
      mkdirSync(OUT, { recursive: true });
      const dxf = join(OUT, `iso-vport-${version}.dxf`);
      const json = join(OUT, `iso-vport-${version}.json`);
      writeFileSync(dxf, writeDxf(isoDoc(1, 2), { version }).data);
      execFileSync(PYTHON, ['-I', join(HERE, 'ezdxf_vport.py'), dxf, json], { stdio: 'pipe' });
      const r = JSON.parse(readFileSync(json, 'utf8')) as { active: { snap_style: number; snap_isopair: number }[]; header: Record<string, number>; audit_errors: number; audit_messages: string[] };
      expect(r.active).toEqual([{ snap_style: 1, snap_isopair: 2 }]);
      if (version === 'AC1009') expect(r.header).toEqual({ $SNAPSTYLE: 1, $SNAPISOPAIR: 2 });
      else expect(r.header).toEqual({});
      expect(r.audit_messages).toEqual([]);
      expect(r.audit_errors).toBe(0);
    });
  }
});

describe('App: 등각 설정을 도면에서 읽고 도면에 기록한다', () => {
  it('열 때 *Active 레코드의 값을 쓴다(R12 머리말만 있으면 그 값)', () => {
    const h = makeApp((doc) => Object.assign(activeVport(doc)!, { snapStyle: 1, snapIsoPair: 2 }));
    expect(isoState(h.st)).toEqual({ style: 1, pair: 2 });
    expect(isoPlaneOf(h.st)).toBe(2);
    const r12 = makeApp((doc) => {
      doc.header.set('$SNAPSTYLE', 1);
      doc.header.set('$SNAPISOPAIR', 1);
    });
    expect(isoPlaneOf(r12.st)).toBe(1);
  });

  it('바꾸면 *Active 레코드(타일이면 모두)에 기록하고 워커에도 보내며, 명령 취소 기록 없이 수정 표시만 한다', () => {
    const h = makeApp((doc) => {
      const a = activeVport(doc)!;
      doc.vports.push({ ...a, handle: 'FFB0', lowerLeft: { x: 0.5, y: 0 } }, { ...a, name: 'SAVED', handle: 'FFB1' });
    });
    const depth = h.st.session.depth;
    expect(h.st.session.dirty).toBe(false);
    setIso(h.app, h.st, { style: 1, pair: 0 });
    expect(h.doc.vports.map((v) => [v.name, v.snapStyle, v.snapIsoPair])).toEqual([
      ['*Active', 1, 0],
      ['*Active', 1, 0],
      ['SAVED', undefined, undefined],
    ]);
    expect(h.st.session.depth).toBe(depth);
    expect(h.st.session.dirty).toBe(true);
    expect(h.ui.refreshTabs).toBeGreaterThan(0);
    const sent = h.engine.edits.at(-1)!.ops[0]!;
    expect(sent.kind).toBe('vports');
    expect(sent.kind === 'vports' && sent.after.map((v) => v.snapStyle)).toEqual([1, 1, undefined]);
    // 같은 값이면 아무것도 하지 않는다
    const n = h.engine.edits.length;
    h.st.session.markSaved();
    setIso(h.app, h.st, { style: 1 });
    expect(h.engine.edits.length).toBe(n);
    expect(h.st.session.dirty).toBe(false);
    // F5(등각평면 순환)도 기록
    setIso(h.app, h.st, { pair: 1 });
    expect(activeVport(h.doc)!.snapIsoPair).toBe(1);
    expect(h.st.session.dirty).toBe(true);
  });

  it('*Active 레코드가 없는 도면에는 레코드를 만들어 기록하고, 저장 직전 화면 맞추기(syncActiveVports)도 값을 지킨다', () => {
    const h = makeApp((doc) => {
      doc.vports.length = 0;
    });
    expect(isoState(h.st)).toEqual({ style: 0, pair: 0 });
    setIso(h.app, h.st, { style: 0 });
    expect(h.doc.vports.length).toBe(0);
    setIso(h.app, h.st, { style: 1, pair: 2 });
    expect(h.doc.vports.map((v) => [v.name, v.snapStyle, v.snapIsoPair])).toEqual([['*Active', 1, 2]]);
    syncActiveVports(h.app, h.st);
    expect(vportSnap(h.doc, activeVport(h.doc))).toEqual({ style: 1, pair: 2 });
    // 저장(DXF R2018·DWG)하고 다시 읽어도
    expect(vportSnap(backDxf(h.doc, 'AC1032'), activeVport(backDxf(h.doc, 'AC1032')))).toEqual({ style: 1, pair: 2 });
    const dwg = backDwg(h.doc, 'AC1032');
    expect(vportSnap(dwg, activeVport(dwg))).toEqual({ style: 1, pair: 2 });
  });

  it('VPORTS 같은 표 편집을 명령 취소해 레코드가 돌아가면 등각 설정도 도면을 따른다', () => {
    const h = makeApp();
    const before = h.doc.vports.slice();
    const after = before.map((v) => ({ ...v, height: v.height * 2 }));
    h.st.session.commit({ label: 'VPORTS', ops: [{ kind: 'vports', before, after }] });
    setIso(h.app, h.st, { style: 1 });
    expect(isoState(h.st).style).toBe(1);
    h.st.session.undo();
    expect(isoState(h.st).style).toBe(0);
  });
});
