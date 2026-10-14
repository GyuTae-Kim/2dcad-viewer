/**
 * 표(ACAD_TABLE) DXF 쓰기: 원본 태그가 없는 표(앱이 만든 표)를 쓸 때 셀 병합(173·175·176)·셀 정렬(170)·
 * 셀 서식(140 문자 높이·64 문자 색·63/283 채우기·7 문자 스타일)을 쓰는지, 우리 리더(rawTableCells)와 ezdxf로
 * 다시 읽어 맞는지 본다. AutoCAD 표본 표를 다른 형식 계열로 쓸 때 병합·정렬이 남는지도 본다.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CadDocument, TableEntity } from '../../src/core/model';
import { readDxf } from '../../src/io/dxf/reader';
import { readDwg } from '../../src/io/dwg';
import { writeDxf } from '../../src/io/dxf/writer';
import type { DxfVersion } from '../../src/io/dxf/tagwriter';
import { TABLE_APP, rawTableCells, tableFromEntity } from '../../src/edit/table/entity';
import { FIXTURES, OUT, ROOT, hasPython } from './writer.helpers';
import { PYTHON } from '../oracle/ezdxf';
import { expectedAligns, tableFixture } from './table.fixture';

const VERSIONS: DxfVersion[] = ['AC1018', 'AC1021', 'AC1024', 'AC1027', 'AC1032'];

function tablesOf(doc: CadDocument): TableEntity[] {
  const out: TableEntity[] = [];
  for (const b of doc.blocks.values()) for (const e of b.entities) if (e.type === 'ACAD_TABLE') out.push(e);
  return out;
}

interface EzCell {
  merged?: number;
  spanCols?: number;
  spanRows?: number;
  flags?: number;
  align?: number;
  height?: number;
  color?: number;
  fill?: number;
  fillFlag?: number;
  textStyle?: string;
  text: string;
}
interface EzTables {
  version: string;
  errors: string[];
  fixes: string[];
  tables: { handle: string; rows: number; cols: number; cells: EzCell[] }[];
}

function ezTables(data: Uint8Array, name: string): EzTables {
  mkdirSync(OUT, { recursive: true });
  const src = join(OUT, name);
  writeFileSync(src, data);
  const out = src + '.tables.json';
  execFileSync(PYTHON, ['-I', join(ROOT, 'scripts/oracle/ezdxf_table.py'), src, out], { stdio: 'pipe', timeout: 120_000 });
  return JSON.parse(readFileSync(out, 'utf8')) as EzTables;
}

describe('DXF 표 쓰기: 앱이 만든 표', () => {
  for (const version of VERSIONS) {
    it(`${version}: 병합·정렬·셀 서식이 남고 table.synthesized 경고가 없다`, () => {
      const f = tableFixture();
      const res = writeDxf(f.doc, { version });
      expect(res.warnings.map((w) => w.code)).not.toContain('table.synthesized');
      const back = readDxf(res.data);
      const [te] = tablesOf(back);
      expect(te).toBeTruthy();
      // 원본 태그(우리 리더가 남긴 AcDbTable 태그)의 병합·정렬
      const raw = rawTableCells(te!.raw);
      expect(raw.count).toBe(f.data.rows * f.data.cols);
      const sortM = (m: { row: number; col: number }[]) => [...m].sort((a, b) => a.row - b.row || a.col - b.col);
      expect(sortM(raw.merges)).toEqual(sortM(f.data.merges));
      const aligns = expectedAligns(f);
      expect(Array.from({ length: raw.count }, (_, i) => raw.aligns.get(i))).toEqual(aligns);
      // 확장 자료가 없어도(다른 프로그램이 지운 경우) 원본 태그만으로 병합·정렬이 돌아온다
      const noX: TableEntity = { ...te!, xdata: te!.xdata?.filter((x) => x.app.toUpperCase() !== TABLE_APP) };
      const rt = tableFromEntity(noX, back)!;
      expect(sortM(rt.data.merges)).toEqual(sortM(f.data.merges));
      expect(rt.data.cells.map((c) => c.align)).toEqual(aligns);
      // 확장 자료가 있으면 표 정의가 그대로
      expect(tableFromEntity(te!, back)!.data).toEqual(f.data);
    });
  }

  it('셀 재지정 태그: 덮인 셀 173 = 1, 기준 셀 175·176, 서식 값', () => {
    const f = tableFixture();
    const back = readDxf(writeDxf(f.doc, { version: 'AC1032' }).data);
    const raw = tablesOf(back)[0]!.raw!;
    const start = raw.findIndex((t) => t.code === 100 && t.value === 'AcDbTable');
    const cells: Map<number, string | number>[] = [];
    for (let k = start + 1; k < raw.length; k++) {
      const t = raw[k]!;
      if (t.code === 171) cells.push(new Map());
      else if (cells.length && !cells[cells.length - 1]!.has(t.code)) cells[cells.length - 1]!.set(t.code, t.code === 7 ? String(t.value) : Number(t.value));
    }
    const cols = f.data.cols;
    const at = (r: number, c: number) => cells[r * cols + c]!;
    // 제목 행은 모든 열 병합
    expect(at(0, 0).get(175)).toBe(cols);
    expect(at(0, 1).get(173)).toBe(1);
    expect(at(3, 1).get(175)).toBe(2);
    expect(at(3, 1).get(176)).toBe(2);
    expect(at(4, 2).get(173)).toBe(1);
    expect(at(2, 3).get(176)).toBe(4);
    // 서식: 제목 높이 7, 머리글 채우기 8·문자 색 1, 데이터 정렬 4, 재지정 9
    expect(at(0, 0).get(140)).toBe(7);
    expect(at(1, 0).get(63)).toBe(8);
    expect(at(1, 0).get(283)).toBe(0);
    expect(at(1, 0).get(64)).toBe(1);
    expect(at(2, 0).get(170)).toBe(4);
    expect(at(2, 2).get(170)).toBe(9);
    expect(at(2, 0).has(63)).toBe(false);
    expect(at(2, 0).get(7)).toBe('Standard');
    // R2007+ 재지정 플래그(91): 정렬 1 + 채우기 6 + 색 8 + 문자 스타일 0x10 + 높이 0x20
    expect(at(1, 0).get(91)).toBe(0x3f);
    expect(at(2, 0).get(91)).toBe(0x39);
  });
});

describe.skipIf(!hasPython)('DXF 표 쓰기: ezdxf로 다시 읽기', () => {
  for (const version of VERSIONS) {
    it(`${version}`, () => {
      const f = tableFixture();
      const ez = ezTables(writeDxf(f.doc, { version }).data, `table-app-${version}.dxf`);
      expect(ez.errors).toEqual([]);
      expect(ez.tables).toHaveLength(1);
      const t = ez.tables[0]!;
      expect([t.rows, t.cols]).toEqual([f.data.rows, f.data.cols]);
      expect(t.cells).toHaveLength(f.data.rows * f.data.cols);
      const aligns = expectedAligns(f);
      const covered = new Set<number>();
      const anchors = new Map<number, { rows: number; cols: number }>();
      for (const m of f.data.merges) {
        anchors.set(m.row * f.data.cols + m.col, { rows: m.rows, cols: m.cols });
        for (let r = m.row; r < m.row + m.rows; r++) for (let c = m.col; c < m.col + m.cols; c++) if (r !== m.row || c !== m.col) covered.add(r * f.data.cols + c);
      }
      t.cells.forEach((c, i) => {
        const kind = f.data.rowKinds[Math.floor(i / f.data.cols)]!;
        const cs = f.style.cells[kind];
        expect(c.merged, `셀 ${i} 173`).toBe(covered.has(i) ? 1 : 0);
        expect([c.spanCols, c.spanRows], `셀 ${i} 175·176`).toEqual(anchors.has(i) ? [anchors.get(i)!.cols, anchors.get(i)!.rows] : [1, 1]);
        expect(c.align, `셀 ${i} 170`).toBe(aligns[i]);
        expect(c.height, `셀 ${i} 140`).toBe(cs.height);
        expect(c.color, `셀 ${i} 64`).toBe(cs.color.aci);
        expect(c.fill ?? null, `셀 ${i} 63`).toBe(cs.fill ? cs.fill.aci : null);
        expect(c.text.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))).toBe(covered.has(i) ? '' : f.data.cells[i]!.text);
      });
    });
  }
});

const SAMPLE = (v: string) => join(FIXTURES, 'samples-dxf', `sample_${v}_ascii.dxf`);

describe.skipIf(!existsSync(SAMPLE('AC1018')))('DXF 표 쓰기: AutoCAD 표를 다른 형식 계열로', () => {
  for (const [src, dst] of [
    ['AC1018', 'AC1032'],
    ['AC1032', 'AC1018'],
  ] as const) {
    it(`${src} → ${dst}: 병합·정렬이 남는다`, () => {
      const doc = readDxf(readFileSync(SAMPLE(src)));
      const before = tablesOf(doc).map((t) => rawTableCells(t.raw));
      expect(before.some((b) => b.merges.length > 0)).toBe(true);
      const res = writeDxf(doc, { version: dst });
      const w = res.warnings.find((x) => x.code === 'table.synthesized');
      expect(w?.message).toContain('병합·정렬');
      const after = tablesOf(readDxf(res.data)).map((t) => rawTableCells(t.raw));
      expect(after.map((a) => a.merges)).toEqual(before.map((b) => b.merges));
      expect(after.map((a) => [...a.aligns])).toEqual(before.map((b) => [...b.aligns]));
    });
  }
});

const SAMPLE_DWG = (v: string) => join(FIXTURES, 'samples', `sample_${v}.dwg`);

describe.skipIf(!existsSync(SAMPLE_DWG('AC1032')))('DXF 표 쓰기: DWG에서 읽은 표', () => {
  for (const [src, dst] of [
    ['AC1032', 'AC1032'],
    ['AC1032', 'AC1018'],
    ['AC1018', 'AC1027'],
  ] as const) {
    it(`DWG ${src} → DXF ${dst}: AutoCAD DXF와 같은 병합·정렬`, () => {
      const doc = readDwg(readFileSync(SAMPLE_DWG(src)));
      const res = writeDxf(doc, { version: dst });
      // 같은 형식 계열이면 DWG 리더가 만든 원본 태그를 그대로 쓴다
      if (Number(src.slice(2)) >= 1021 === Number(dst.slice(2)) >= 1021) expect(res.warnings.map((w) => w.code)).not.toContain('table.synthesized');
      const want = tablesOf(readDxf(readFileSync(SAMPLE(src)))).map((t) => rawTableCells(t.raw));
      const got = tablesOf(readDxf(res.data)).map((t) => rawTableCells(t.raw));
      expect(got.map((g) => g.merges)).toEqual(want.map((w) => w.merges));
      expect(got.map((g) => [...g.aligns])).toEqual(want.map((w) => [...w.aligns]));
    });
  }
});
