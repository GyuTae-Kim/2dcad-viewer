/**
 * DWG 표(ACAD_TABLE)·테이블 스타일(TABLESTYLE):
 * - 본문 배치(src/io/dwg/tablecodec.ts): AutoCAD 표본의 표·스타일을 풀어 다시 쓰면 자료·문자열 비트와 핸들 값이 같다.
 * - 리더: DWG 표의 원본 태그(병합·정렬·셀 재지정)와 스타일 태그가 같은 도면 AutoCAD DXF와 같다.
 * - 쓰기: 앱이 만든 표·스타일, 다른 버전 DWG, AutoCAD DXF를 진짜 표로 쓰고(블록 참조로 바꾸지 않고) 다시 읽어 같다.
 * - 엔진(블랙박스)이 쓴 표를 열고 같은 셀(병합·정렬·높이·문자)로 읽는다.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CadDocument, GenericObject, TableEntity } from '../../src/core/model';
import { codepageToEncoding, decoderFor, dwgCodepageName } from '../../src/core/codepage';
import { readDwg, writeDwg } from '../../src/io/dwg';
import { readDxf } from '../../src/io/dxf/reader';
import { writeDxf } from '../../src/io/dxf/writer';
import { BitReader } from '../../src/io/dwg/bitstream';
import { readClasses } from '../../src/io/dwg/classes';
import { readR2000Container } from '../../src/io/dwg/container/r2000';
import { readR2004Container } from '../../src/io/dwg/container/r2004';
import { readR2007Container } from '../../src/io/dwg/container/r2007';
import { readObjectMap } from '../../src/io/dwg/handles';
import { ObjectReader } from '../../src/io/dwg/objects/reader';
import { stringStreamRange } from '../../src/io/dwg/streams';
import { type TableIO, readIO, tableOld, tableR24, tableStyleOld, tableStyleR24, writeIO } from '../../src/io/dwg/tablecodec';
import { BitWriter } from '../../src/io/dwg/writer/bitwriter';
import { encoderFor } from '../../src/io/dwg/writer/codepage';
import { rawCellOverrides } from '../../src/io/tablecells';
import { parseTableStyleTags } from '../../src/io/tablestyle';
import { TABLE_APP, rawTableCells, tableFromEntity } from '../../src/edit/table/entity';
import { FIXTURES } from '../oracle/ezdxf';
import { expectedAligns, tableFixture } from '../dxf/table.fixture';
import { engineAvailable, engineRead } from './engine';
import { dwgFixtures } from './oracle';

const DWG = (v: string) => join(FIXTURES, 'samples', `sample_${v}.dwg`);
const DXF = (v: string) => join(FIXTURES, 'samples-dxf', `sample_${v}_ascii.dxf`);
const WRITE = ['AC1015', 'AC1018', 'AC1024', 'AC1027', 'AC1032'] as const;

function bitsOf(b: Uint8Array, s: number, n: number): string {
  let o = '';
  for (let i = 0; i < n; i++) {
    const p = s + i;
    o += (b[p >> 3]! >> (7 - (p & 7))) & 1;
  }
  return o;
}

interface CodecResult {
  type: string;
  handle: string;
  consumed: boolean;
  dataSame: boolean;
  stringsSame: boolean;
  handlesSame: boolean;
}

/** 파일의 표·스타일을 풀어 다시 쓴 결과 */
function codecRoundtrip(path: string): CodecResult[] {
  const data = readFileSync(path);
  const ver = Number(new TextDecoder().decode(data.subarray(2, 6)));
  const sec = ver <= 1015 ? readR2000Container(data, ver) : ver === 1021 ? readR2007Container(data, ver) : readR2004Container(data, ver);
  const decoder = decoderFor(codepageToEncoding(dwgCodepageName(sec.codepage)));
  const or = new ObjectReader(sec.objects, ver, decoder, readClasses(sec, decoder));
  const out: CodecResult[] = [];
  for (const [h, off] of readObjectMap(sec)) {
    const info = or.peekType(off);
    if (!info || (info.typeName !== 'ACAD_TABLE' && info.typeName !== 'TABLESTYLE')) continue;
    const oh = or.begin(off, h);
    const r = or.dat;
    const hr = or.hdl;
    const hv: number[] = [];
    const base = readIO(r, hr, h, ver);
    const io: TableIO = { ...base, H: (c, v) => (hv.push(base.H(c, v)), hv[hv.length - 1]!) };
    let model: unknown;
    let start: number;
    if (info.typeName === 'ACAD_TABLE') {
      or.commonEntity();
      r.BD3();
      if (ver <= 1014) r.BD3();
      else {
        const bb = r.BB();
        if (bb === 1) (r.DD(1), r.DD(1));
        else if (bb === 2) r.RD();
        else if (bb === 0) {
          const x = r.RD();
          r.DD(x);
          r.DD(x);
        }
      }
      r.BD();
      r.BD3();
      const att = r.B();
      let owned = 0;
      if (ver >= 1018 && att) owned = r.BL();
      hr.H(h);
      if (att) {
        const n = ver < 1018 ? 2 : owned;
        for (let i = 0; i <= n; i++) hr.H(h);
      }
      start = r.pos;
      model = ver >= 1024 ? tableR24(io) : tableOld(io);
    } else {
      or.commonObject();
      start = r.pos;
      model = ver >= 1024 ? tableStyleR24(io) : tableStyleOld(io);
    }
    const consumed = ver >= 1021 ? r.pos === r.end || r.pos === r.end - 1 : r.pos === r.end;
    const enc = encoderFor(dwgCodepageName(sec.codepage));
    const d = new BitWriter(ver, enc, 4096);
    const s = new BitWriter(ver, enc, 1024);
    const hd = new BitWriter(ver, enc, 1024);
    if (ver >= 1021) d.strWriter = s;
    const wv: number[] = [];
    const sink = { ...hd, H: (c: number, v: number) => (wv.push(v), hd.H(c, v)) };
    const wio = writeIO(d, sink as unknown as BitWriter, ver);
    if (info.typeName === 'ACAD_TABLE') {
      if (ver >= 1024) tableR24(wio, model as never);
      else tableOld(wio, model as never);
    } else if (ver >= 1024) tableStyleR24(wio, model as never);
    else tableStyleOld(wio, model as never);
    let stringsSame = true;
    if (ver >= 1021) {
      const rg = stringStreamRange(new BitReader(or.buf, ver, decoder), oh.startBit, oh.handleBit);
      stringsSame = (rg ? bitsOf(or.buf, rg.start, rg.end - rg.start) : '') === bitsOf(s.buf, 0, s.pos);
    }
    out.push({
      type: info.typeName,
      handle: h.toString(16),
      consumed,
      dataSame: bitsOf(or.buf, start, r.pos - start) === bitsOf(d.buf, 0, d.pos),
      stringsSame,
      handlesSame: JSON.stringify(hv) === JSON.stringify(wv),
    });
  }
  return out;
}

describe.skipIf(!existsSync(DWG('AC1032')))('표·테이블 스타일 본문 배치: 풀어 다시 쓰면 같은 비트', () => {
  for (const f of dwgFixtures()) {
    it(`${f.group}/${f.name}`, () => {
      const res = codecRoundtrip(f.path);
      expect(res.length).toBeGreaterThan(0);
      for (const r of res) expect(r, `${r.type} ${r.handle}`).toEqual({ ...r, consumed: true, dataSame: true, stringsSame: true, handlesSame: true });
    });
  }
});

function tablesOf(doc: CadDocument): TableEntity[] {
  const out: TableEntity[] = [];
  for (const b of doc.blocks.values()) for (const e of b.entities) if (e.type === 'ACAD_TABLE') out.push(e);
  return out.sort((a, b) => parseInt(a.handle, 16) - parseInt(b.handle, 16));
}

const round = (o: unknown) => JSON.parse(JSON.stringify(o, (_k, v: unknown) => (typeof v === 'number' ? +v.toPrecision(12) : v)));

describe.skipIf(!existsSync(DWG('AC1032')))('DWG 리더: 표·스타일 원본 태그 = AutoCAD DXF', () => {
  for (const v of ['AC1015', 'AC1018', 'AC1021', 'AC1024', 'AC1027', 'AC1032']) {
    it(v, () => {
      const a = readDwg(readFileSync(DWG(v)));
      const b = readDxf(readFileSync(DXF(v)));
      const ta = tablesOf(a);
      expect(ta).toHaveLength(2);
      for (const e of ta) {
        const d = b.entityIndex.get(e.handle) as TableEntity;
        expect(e.rawVersion).toBe(v);
        const ra = rawTableCells(e.raw);
        const rb = rawTableCells(d.raw);
        expect(ra.merges).toEqual(rb.merges);
        expect([...ra.aligns]).toEqual([...rb.aligns]);
        expect(round(rawCellOverrides(e.raw))).toEqual(round(rawCellOverrides(d.raw)));
        // 문자: AutoCAD DXF의 302는 형식을 적용한 문자다(예: %tc1 대문자) → 대소문자만 다를 수 있다
        expect(e.cells?.map((c) => c.text.toUpperCase())).toEqual(d.cells?.map((c) => c.text.toUpperCase()));
        expect([e.rows, e.columns]).toEqual([d.rows, d.columns]);
      }
      for (const o of a.objects.values()) {
        if (o.type !== 'TABLESTYLE') continue;
        expect(round(parseTableStyleTags((o as GenericObject).raw))).toEqual(round(parseTableStyleTags((b.objects.get(o.handle) as GenericObject).raw)));
      }
    });
  }
});

const sortM = (m: { row: number; col: number }[]) => [...m].sort((a, b) => a.row - b.row || a.col - b.col);

describe('DWG 쓰기: 앱이 만든 표', () => {
  for (const version of WRITE) {
    it(`${version}: 진짜 표로 쓰고 다시 읽으면 병합·정렬·서식·스타일이 같다`, () => {
      const f = tableFixture();
      const res = writeDwg(f.doc, { version });
      const codes = res.warnings.map((w) => w.code);
      expect(codes).not.toContain('dwg.write_table_as_insert');
      expect(codes).not.toContain('dwg.write_object_dropped');
      const back = readDwg(res.data);
      const [te] = tablesOf(back);
      expect(te?.type).toBe('ACAD_TABLE');
      expect(tableFromEntity(te!, back)!.data).toEqual(f.data);
      // 확장 자료 없이 표 본문만으로
      const raw = rawTableCells(te!.raw);
      expect(sortM(raw.merges)).toEqual(sortM(f.data.merges));
      expect(Array.from({ length: raw.count }, (_, i) => raw.aligns.get(i))).toEqual(expectedAligns(f));
      const noX: TableEntity = { ...te!, xdata: te!.xdata?.filter((x) => x.app.toUpperCase() !== TABLE_APP) };
      const rt = tableFromEntity(noX, back)!;
      expect(rt.data.cells.map((c) => c.text)).toEqual(f.data.cells.map((c) => c.text));
      expect(rt.styleEntry?.name).toBe('공정표');
      expect(rt.style.cells.header.fill).toEqual({ aci: 8 });
      expect(rt.style.cells.header.color).toEqual({ aci: 1 });
      expect(rt.style.cells.title.height).toBe(7);
      expect(rt.style.cells.data.align).toBe(4);
      expect(rt.style.hMargin).toBe(1);
      // 셀 재지정(높이·색·채우기)
      const ovr = rawCellOverrides(te!.raw);
      f.data.cells.forEach((_, i) => {
        const cs = f.style.cells[f.data.rowKinds[Math.floor(i / f.data.cols)]!];
        expect(ovr[i]!.height).toBe(cs.height);
        expect(ovr[i]!.color).toEqual(cs.color);
        if (cs.fill) expect(ovr[i]!.fill).toEqual(cs.fill);
      });
      // 다시 DXF로: 원본 태그로 표가 남는다
      const dxf = readDxf(writeDxf(back, { version: 'AC1032' }).data);
      expect(sortM(rawTableCells(tablesOf(dxf)[0]!.raw).merges)).toEqual(sortM(f.data.merges));
    });
  }
  it('새 도면의 기본 테이블 스타일(원본 태그 없음)도 Standard로 쓴다', () => {
    const f = tableFixture();
    const std = [...f.doc.objects.values()].find((o) => o.type === 'TABLESTYLE' && !(o as GenericObject).raw)!;
    expect(std).toBeTruthy();
    const back = readDwg(writeDwg(f.doc, { version: 'AC1032' }).data);
    const s = parseTableStyleTags((back.objects.get(std.handle) as GenericObject).raw)!;
    expect([s.hMargin, s.rows[0]!.height, s.rows[1]!.height]).toEqual([1.5, 4.5, 6]);
  });
});

describe.skipIf(!existsSync(DWG('AC1032')))('DWG 쓰기: AutoCAD 표를 다른 버전·DXF에서', () => {
  for (const [src, dst] of [
    ['AC1032', 'AC1015'],
    ['AC1032', 'AC1018'],
    ['AC1018', 'AC1032'],
    ['AC1021', 'AC1024'],
  ] as const) {
    it(`DWG ${src} → ${dst}`, () => {
      const a = readDwg(readFileSync(DWG(src)));
      const res = writeDwg(a, { version: dst });
      expect(res.warnings.map((w) => w.code)).not.toContain('dwg.write_table_as_insert');
      const b = readDwg(res.data);
      const ta = tablesOf(a);
      const tb = tablesOf(b);
      expect(tb.map((t) => t.handle)).toEqual(ta.map((t) => t.handle));
      tb.forEach((t, i) => {
        expect(rawTableCells(t.raw).merges).toEqual(rawTableCells(ta[i]!.raw).merges);
        expect([...rawTableCells(t.raw).aligns]).toEqual([...rawTableCells(ta[i]!.raw).aligns]);
        expect(round(rawCellOverrides(t.raw))).toEqual(round(rawCellOverrides(ta[i]!.raw)));
        expect(t.cells).toEqual(ta[i]!.cells);
        expect(round(t.rowHeights)).toEqual(round(ta[i]!.rowHeights));
      });
    });
  }
  for (const dst of ['AC1018', 'AC1032'] as const) {
    it(`AutoCAD DXF(AC1032) → DWG ${dst}`, () => {
      const a = readDxf(readFileSync(DXF('AC1032')));
      const b = readDwg(writeDwg(a, { version: dst }).data);
      const ta = tablesOf(a);
      const tb = tablesOf(b);
      expect(tb).toHaveLength(2);
      tb.forEach((t, i) => {
        expect(rawTableCells(t.raw).merges).toEqual(rawTableCells(ta[i]!.raw).merges);
        expect(t.cells?.map((c) => c.text)).toEqual(ta[i]!.cells?.map((c, k) => (rawTableCells(ta[i]!.raw).merges.some((m) => k !== m.row * t.columns + m.col && Math.floor(k / t.columns) >= m.row && Math.floor(k / t.columns) < m.row + m.rows && k % t.columns >= m.col && k % t.columns < m.col + m.cols) ? '' : c.text)));
      });
    });
  }
});

describe.skipIf(!engineAvailable)('DWG 표 ↔ 엔진(블랙박스)', () => {
  it('엔진이 쓴 표를 열고 같은 셀로 읽는다', () => {
    const files = new Map<string, Uint8Array>();
    for (const v of WRITE) files.set(`app@${v}`, writeDwg(tableFixture().doc, { version: v }).data);
    if (existsSync(DWG('AC1032'))) {
      files.set('dwg1032@AC1015', writeDwg(readDwg(readFileSync(DWG('AC1032'))), { version: 'AC1015' }).data);
      files.set('dxf1032@AC1032', writeDwg(readDxf(readFileSync(DXF('AC1032'))), { version: 'AC1032' }).data);
    }
    const res = engineRead(files);
    const f = tableFixture();
    const aligns = expectedAligns(f);
    for (const [k, r] of res) {
      expect(r.ok, `${k}: ${r.error}`).toBe(true);
      expect((r.warnings ?? []).filter((w) => /invalid|skipped|corrupt/i.test(w)), k).toEqual([]);
      if (!k.startsWith('app')) {
        expect(r.counts?.ACAD_TABLE, k).toBe(2);
        continue;
      }
      expect(r.counts?.ACAD_TABLE, k).toBe(1);
      const t = r.tables![0]!;
      expect([t.rows, t.cols], k).toEqual([f.data.rows, f.data.cols]);
      const anchors = new Map(f.data.merges.map((m) => [m.row * f.data.cols + m.col, [m.cols, m.rows]]));
      t.cells.forEach((c, i) => {
        const kind = f.data.rowKinds[Math.floor(i / f.data.cols)]!;
        expect(c.span, `${k} 셀 ${i}`).toEqual(anchors.get(i) ?? [1, 1]);
        expect(c.align, `${k} 셀 ${i}`).toBe(aligns[i]);
        expect(c.height, `${k} 셀 ${i}`).toBe(f.style.cells[kind].height);
        if (!c.merged) expect(c.text, `${k} 셀 ${i}`).toBe(f.data.cells[i]!.text);
      });
    }
  }, 600_000);
});
