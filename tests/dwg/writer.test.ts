/**
 * DWG 쓰기: 단위 시험과 왕복 시험(readDwg(writeDwg(문서)) ≈ 문서).
 * - 비트 쓰기·압축·객체 지도는 읽기 쪽 코드와 맞물려 확인한다.
 * - 새 도면과 직접 만든 도면을 모든 버전으로 쓴다.
 * - 표본 DWG(CAD_FIXTURES)와 DXF 원본을 모든 버전으로 쓰고 요약·깊은 비교를 한다(알려진 손실은 writer-compare.ts).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CadDocument, Entity } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { readDwg, writeDwg } from '../../src/io/dwg';
import { BitReader } from '../../src/io/dwg/bitstream';
import { decompressR18 } from '../../src/io/dwg/lz77';
import { compressR18 } from '../../src/io/dwg/writer/lz77enc';
import { BitWriter } from '../../src/io/dwg/writer/bitwriter';
import { encoderFor } from '../../src/io/dwg/writer/codepage';
import { objectMap } from '../../src/io/dwg/writer/container';
import { readObjectMap } from '../../src/io/dwg/handles';
import { nearestAci } from '../../src/io/dwg/color';
import { R2000, R2004, R2007, R2010, R2013, R2018 } from '../../src/io/dwg/version';
import { summarizeDocument } from '../oracle/summarize';
import { compareSummaries } from '../oracle/compare';
import { FIXTURES } from '../oracle/ezdxf';
import { compareDocs, droppable } from './writer-compare';
import { WRITE_VERSIONS, dwgSources, dxfSources, normText, readSource, stable, syntheticDocument } from './writer-fixtures';

type Sum = Record<string, unknown>;
type ESum = Sum & { type: string; handle: string; color?: { aci: number | null; rgb?: number } };

/** 요약 비교 정규화: 버전 차이로 잃는 것과 읽기 정규화만 맞춘다 */
function normalizeSummary(src: CadDocument, e: Sum, a: Sum, ver: number, warnings: string[]): void {
  e.version = a.version;
  if (warnings.includes('dwg.write_codepage') || !src.header.get('$DWGCODEPAGE')) e.codepage = a.codepage;
  if (!src.header.has('$INSUNITS')) e.insunits = a.insunits;
  const up = (s: unknown) => normText(String(s)).toUpperCase();
  for (const k of ['linetypes', 'textStyles', 'dimStyles']) {
    const ev = new Set((e[k] as string[]).map(up));
    e[k] = [...ev].sort();
    a[k] = [...new Set((a[k] as string[]).map(up))].filter((x) => ev.has(x)).sort();
  }
  const el = e.layers as Sum[];
  const names = new Set(el.map((l) => up(l.name)));
  a.layers = (a.layers as Sum[]).filter((l) => names.has(up(l.name)));
  const rgbLayers = new Set([...src.layers.values()].filter((l) => l.color.rgb !== undefined).map((l) => up(l.name)));
  for (const list of [el, a.layers as Sum[]]) {
    for (const l of list) {
      l.name = up(l.name);
      l.linetype = up(l.linetype);
      if (rgbLayers.has(l.name as string)) l.color = null;
    }
  }
  const sameVersion = src.format === 'dwg' && src.version === `AC${ver}`;
  const index = new Map<string, Entity>();
  for (const b of src.blocks.values()) for (const x of b.entities) index.set(x.handle, x);
  const eb = e.blocks as Record<string, ESum[]>;
  const ab = a.blocks as Record<string, ESum[]>;
  for (const key of Object.keys(eb)) {
    let akey = key;
    if (!(key in ab)) {
      const tn = src.blockRecords.get(key)?.xdata?.find((x) => x.app.toUpperCase() === 'ACDBDYNAMICBLOCKTRUENAME')?.items.find((i) => i.code === 1000)?.value;
      if (typeof tn === 'string' && tn.toUpperCase() in ab) akey = tn.toUpperCase();
    }
    const act = ab[akey] ?? [];
    if (akey !== key) {
      ab[key] = act;
      delete ab[akey];
    }
    const am = new Map(act.map((x) => [x.handle, x]));
    const out: ESum[] = [];
    for (const x of eb[key]) {
      const de = index.get(x.handle);
      const y = am.get(x.handle);
      if (!y) {
        if (de && droppable(de, sameVersion)) continue;
        out.push(x);
        continue;
      }
      if (x.type === 'ACAD_TABLE' && y.type === 'INSERT') {
        out.push(y);
        continue;
      }
      for (const z of [x, y]) {
        if (typeof z.linetype === 'string') z.linetype = up(z.linetype);
        if (typeof z.style === 'string') z.style = up(z.style);
        if (typeof z.text === 'string') z.text = normText(z.text);
        if (z.type === 'SPLINE') z.flags = null;
        if (de?.color.rgb !== undefined && z.color) z.color = ver >= R2004 ? { aci: null, rgb: de.color.rgb } : { aci: de.color.aci >= 1 && de.color.aci <= 255 ? de.color.aci : nearestAci(de.color.rgb) };
        if (de?.color.name && z.color) z.color = { aci: null };
      }
      out.push(x);
    }
    eb[key] = out;
    ab[key] = act.filter((y) => out.some((x) => x.handle === y.handle));
  }
}

function roundTrip(src: CadDocument, version: string, fromDxf: boolean): { summary: unknown[]; deep: string[]; warnings: string[]; ms: number } {
  const t0 = performance.now();
  const r = writeDwg(src, { version: version as never });
  const ms = performance.now() - t0;
  const back = readDwg(r.data);
  const ver = Number(version.slice(2));
  const warnings = r.warnings.map((w) => w.code);
  const e = summarizeDocument(src) as Sum;
  const a = summarizeDocument(back) as Sum;
  normalizeSummary(src, e, a, ver, warnings);
  const summary = compareSummaries(e, a);
  const deep = compareDocs(src, back, { ver, sameVersion: !fromDxf && src.version === version, fromDxf });
  expect(back.version).toBe(version);
  expect(back.warnings.filter((w) => w.code !== 'dwg.orphan_entities')).toEqual([]);
  return { summary, deep, warnings, ms };
}

// ---------------------------------------------------------------------------
// 단위 시험
// ---------------------------------------------------------------------------

describe('DWG 쓰기 기초', () => {
  it('LZ77 압축 ↔ 풀기', () => {
    let seed = 7;
    const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 0x100000000);
    const cases: Uint8Array[] = [new Uint8Array(0), new Uint8Array([1]), new Uint8Array([1, 2, 3]), new Uint8Array(0x7400)];
    for (let k = 0; k < 60; k++) {
      const n = Math.floor(rand() * 30000);
      const a = new Uint8Array(n);
      const alpha = 1 + Math.floor(rand() * 255);
      for (let i = 0; i < n; i++) {
        if (i > 10 && rand() < 0.3) {
          const d = 1 + Math.floor(rand() * Math.min(i, 30000));
          const L = Math.floor(rand() * 300);
          for (let j = 0; j < L && i < n; j++, i++) a[i] = a[i - d];
          i--;
        } else a[i] = Math.floor(rand() * alpha);
      }
      cases.push(a);
    }
    for (const c of cases) {
      const z = compressR18(c);
      const d = decompressR18(z, 0, z.length, c.length);
      expect(Buffer.from(d).equals(Buffer.from(c))).toBe(true);
    }
  });

  it('비트 쓰기 ↔ 읽기(모든 버전)', () => {
    const enc = encoderFor('ANSI_1252');
    for (const ver of [R2000, R2004, R2007, R2010, R2013, R2018]) {
      const w = new BitWriter(ver, enc);
      const bs = [0, 1, 255, 256, 257, 32767, -1];
      const bl = [0, 1, 255, 256, 70000, -5];
      const bd = [0, 1, -1, 0.5, 1e300, -0];
      const mc = [0, 63, 64, 4610, -1, -112823273];
      const handles: [number, number][] = [
        [5, 0],
        [3, 0x1f],
        [2, 0x123456],
        [4, 0x7fffffffff],
      ];
      for (const v of bs) w.BS(v);
      for (const v of bl) w.BL(v);
      for (const v of bd) w.BD(v);
      w.DD(1.5, 1.5);
      w.DD(1.5000001, 1.5);
      w.DD(-7, 1.5);
      w.BLL(0);
      w.BLL(0x123456789);
      for (const v of mc) w.MC(v);
      w.UMC(300);
      w.MS(100000);
      for (const [c, h] of handles) w.H(c, h);
      w.OT(77);
      w.OT(500);
      w.OT(1000);
      w.T('café');
      w.TU('한글');
      w.CMC({ index: 256 });
      w.CMC({ index: 3, rgb: 0x112233 });
      w.ENC({ index: 5, rgb: 0x445566, transparency: 51 });
      w.BE({ x: 0, y: 0, z: 1 });
      w.BT(2.5);
      const r = new BitReader(w.bytes(), ver, new TextDecoder('windows-1252'));
      for (const v of bs) expect(r.BS()).toBe(v);
      for (const v of bl) expect(r.BL()).toBe(v);
      for (const v of bd) expect(Object.is(r.BD(), v)).toBe(true);
      expect(r.DD(1.5)).toBe(1.5);
      expect(r.DD(1.5)).toBe(1.5000001);
      expect(r.DD(1.5)).toBe(-7);
      expect(r.BLL()).toBe(0);
      expect(r.BLL()).toBe(0x123456789);
      for (const v of mc) expect(r.MC()).toBe(v);
      expect(r.UMC()).toBe(300);
      expect(r.MS()).toBe(100000);
      for (const [, h] of handles) expect(r.H()).toBe(h);
      expect(r.OT()).toBe(77);
      expect(r.OT()).toBe(500);
      expect(r.OT()).toBe(1000);
      expect(r.T()).toBe('café');
      expect(r.TU()).toBe('한글');
      expect(r.CMC().index).toBe(ver >= R2004 ? 0 : 256);
      const c = r.CMC();
      if (ver >= R2004) expect(c.rgb! >>> 0).toBe(0xc2112233);
      const ec = r.ENC();
      expect(ec.index).toBe(5);
      if (ver >= R2004) {
        expect(ec.rgb! & 0xffffff).toBe(0x445566);
        expect(ec.transparency).toBe(51);
      }
      expect(r.BE()).toEqual({ x: 0, y: 0, z: 1 });
      expect(r.BT()).toBe(2.5);
    }
  });

  it('객체 지도 쓰기 ↔ 읽기(구역 나눔 포함)', () => {
    const entries: [number, number][] = [];
    let loc = 100;
    for (let h = 1; h < 5000; h += 1 + (h % 7)) {
      entries.push([h, loc]);
      loc += 10 + ((h * 37) % 900) - (h % 5 === 0 ? 3000 : 0);
      if (loc < 0) loc += 100000;
    }
    const data = objectMap(entries);
    const map = readObjectMap({ handles: data, warnings: [] } as never);
    expect([...map.entries()]).toEqual(entries);
  });

  it('쓸 수 없는 버전 요청', () => {
    const doc = createNewDocument('metric');
    const a = writeDwg(doc, { version: 'AC1021' });
    expect(new TextDecoder().decode(a.data.subarray(0, 6))).toBe('AC1018');
    expect(a.warnings.some((w) => w.code === 'dwg.write_version')).toBe(true);
    const b = writeDwg(doc, { version: 'AC1014' });
    expect(new TextDecoder().decode(b.data.subarray(0, 6))).toBe('AC1015');
    const c = writeDwg(doc);
    expect(new TextDecoder().decode(c.data.subarray(0, 6))).toBe('AC1032');
    expect(c.warnings).toEqual([]);
  });

  it('진행률', () => {
    const seen: number[] = [];
    writeDwg(syntheticDocument(), { onProgress: (f) => seen.push(f) });
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  for (const units of ['metric', 'imperial'] as const) {
    for (const v of WRITE_VERSIONS) {
      it(`새 도면(${units}) → ${v}`, () => {
        const doc = createNewDocument(units);
        const r = roundTrip(doc, v, true);
        expect(r.warnings).toEqual([]);
        expect(r.summary).toEqual([]);
        expect(r.deep).toEqual([]);
      });
    }
  }

  for (const v of WRITE_VERSIONS) {
    it(`여러 도형 도면 → ${v}`, () => {
      const doc = syntheticDocument();
      const r = roundTrip(doc, v, true);
      expect(r.summary).toEqual([]);
      expect(r.deep).toEqual([]);
    });
  }

  it('원본 본문은 같은 버전·같은 값일 때만 되쓴다', () => {
    const path = join(FIXTURES, 'samples', 'sample_AC1032.dwg');
    if (!existsSync(path)) return;
    const doc = readDwg(new Uint8Array(readFileSync(path)));
    const solids = [...doc.entityIndex.values()].filter((e) => e.type === '3DSOLID');
    expect(solids.length).toBeGreaterThan(0);
    // 같은 버전: ACIS 도형이 남는다
    let back = readDwg(writeDwg(doc, { version: 'AC1032' }).data);
    for (const s of solids) expect(back.entityIndex.get(s.handle)?.type).toBe('3DSOLID');
    // 다른 버전: 빠지고 경고가 남는다
    const r = writeDwg(doc, { version: 'AC1027' });
    expect(r.warnings.some((w) => w.code === 'dwg.write_entity_dropped')).toBe(true);
    back = readDwg(r.data);
    for (const s of solids) expect(back.entityIndex.get(s.handle)).toBeUndefined();
    // 값이 바뀌면(지문이 다르면) 원본 본문을 쓰지 않는다
    const changed = solids[0] as Entity & { wires?: unknown };
    changed.wires = [[{ x: 0, y: 0, z: 0 }]];
    back = readDwg(writeDwg(doc, { version: 'AC1032' }).data);
    expect(back.entityIndex.get(changed.handle)).toBeUndefined();
    delete changed.wires;
  });
});

// ---------------------------------------------------------------------------
// 표본 DWG·DXF 왕복
// ---------------------------------------------------------------------------

const dwgs = dwgSources();
const timings: string[] = [];

describe.skipIf(!dwgs.length)('DWG 쓰기 ↔ 다시 읽기(표본 DWG)', () => {
  for (const f of dwgs) {
    it(`${f.group}/${f.name}`, () => {
      const doc = readSource(f);
      for (const v of WRITE_VERSIONS) {
        const r = roundTrip(doc, v, false);
        timings.push(`${f.name} → ${v} ${r.ms.toFixed(0)}ms`);
        if (r.summary.length || r.deep.length) console.log(f.name, v, JSON.stringify(r.summary.slice(0, 5)), r.deep.slice(0, 10).join('\n'));
        expect(r.summary).toEqual([]);
        expect(r.deep).toEqual([]);
        // 같은 버전이면 버리는 것이 없어야 한다
        if (doc.version === v) expect(r.warnings.filter((w) => w !== 'dwg.write_codepage')).toEqual([]);
      }
    });
  }
  it('쓰기 시간', () => {
    console.log('DWG 쓰기 시간\n' + timings.join('\n'));
    expect(timings.length).toBeGreaterThan(0);
  });
});

const dxfs = dxfSources();

describe.skipIf(!dxfs.length)('DXF 원본 → DWG 쓰기 ↔ 다시 읽기', () => {
  for (const f of dxfs) {
    it(`${f.group}/${f.name}`, () => {
      const doc = stable(readSource(f));
      for (const v of WRITE_VERSIONS) {
        const r = roundTrip(doc, v, true);
        if (r.summary.length || r.deep.length) console.log(f.name, v, JSON.stringify(r.summary.slice(0, 5)), r.deep.slice(0, 10).join('\n'));
        expect(r.summary).toEqual([]);
        expect(r.deep).toEqual([]);
      }
    });
  }
});
