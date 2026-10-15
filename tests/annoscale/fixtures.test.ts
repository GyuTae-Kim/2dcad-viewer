/**
 * 표본·오라클로 확인하는 컨텍스트 데이터(표본 CAD_FIXTURES·파이썬 CAD_PYTHON이 없으면 건너뛴다):
 * - AutoCAD 표본 DWG의 문자·속성·블록 참조 레코드(R2007~R2018)가 모두 풀리고, 다시 쓴 비트가 원본과 같다.
 * - 다중 지시선 컨텍스트 자료 코덱 = AutoCAD DXF의 CONTEXT_DATA 태그(같은 도면의 DWG·DXF, 같은 핸들), 다시 쓴 비트도 같다.
 * - 표본을 DWG R2018·DXF R2018로 저장하고 다시 읽어도 레코드가 같다.
 * - ezdxf가 이 앱이 쓴 DXF(R2018·R2010·R2007·R2000)의 레코드를 감사 오류 없이 읽고, 사전 사슬(확장 사전 →
 *   AcDbContextDataManager → ACDB_ANNOTATIONSCALES → *A1…)·SCALE 참조·클래스 등록이 맞다.
 * 표본은 읽기만 한다(저장소에 복사하지 않는다).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GenericObject, RawTag } from '../../src/core/model';
import { CTX_TYPES, encodeCtx, encodeMLeaderContext, readMLeaderContext, writeCtxOps } from '../../src/io/dwg/ctxcodec';
import { BitReader } from '../../src/io/dwg/bitstream';
import { readDwg, writeDwg } from '../../src/io/dwg';
import { BitWriter } from '../../src/io/dwg/writer/bitwriter';
import { encoderFor } from '../../src/io/dwg/writer/codepage';
import { writeDxf } from '../../src/io/dxf/writer';
import { readCadFile } from '../../src/io/index';
import { FIXTURES, PYTHON, hasPython } from '../oracle/ezdxf';
import { ctxFixture } from './ctxfix';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const OUT = join(ROOT, '.runtime/annoscale/oracle');

const DWG = (v: string) => join(FIXTURES, 'samples', `sample_${v}.dwg`);
const DXF = (v: string) => join(FIXTURES, 'samples-dxf', `sample_${v}_ascii.dxf`);

const bits = (b: Uint8Array, n: number) => {
  let s = '';
  for (let i = 0; i < n; i++) s += (b[i >> 3]! >> (7 - (i & 7))) & 1;
  return s;
};

function sameValue(a: string | number, b: string | number): boolean {
  const na = Number(a);
  const nb = Number(b);
  if (String(a).trim() !== '' && String(b).trim() !== '' && Number.isFinite(na) && Number.isFinite(nb)) return Math.abs(na - nb) <= 1e-9 * Math.max(1, Math.abs(na), Math.abs(nb));
  return String(a).trim().toUpperCase() === String(b).trim().toUpperCase();
}

/** 표본 DWG(sample_*와 AutoCAD 예제 도면) */
function dwgFiles(): string[] {
  const out: string[] = [];
  for (const v of ['AC1021', 'AC1024', 'AC1027', 'AC1032']) if (existsSync(DWG(v))) out.push(DWG(v));
  const dir = join(FIXTURES, 'all-samples');
  if (existsSync(dir)) for (const n of readdirSync(dir).sort()) if (n.endsWith('.dwg') && !n.startsWith('sample_')) out.push(join(dir, n));
  return out;
}

const ctxObjects = (doc: ReturnType<typeof readDwg>) => [...doc.objects.values()].filter((o) => CTX_TYPES.has(o.type)) as GenericObject[];

describe.skipIf(!dwgFiles().length)('AutoCAD 표본 DWG의 컨텍스트 레코드: 모두 풀리고 다시 쓴 비트가 같다', () => {
  for (const f of dwgFiles()) {
    const name = f.split('/').pop()!;
    it(name, () => {
      const doc = readDwg(readFileSync(f));
      const blockH = new Map<string, number>();
      for (const [k, br] of doc.blockRecords) blockH.set(k, parseInt(br.handle, 16));
      for (const o of ctxObjects(doc)) {
        const what = `${name} ${o.type} ${o.handle}`;
        expect(o.raw, what).toBeTruthy();
        const raw = o.dwgRaw!;
        const ver = Number(raw.version.slice(2));
        const ops = encodeCtx(o.type, o.raw, ver)!;
        const enc = encoderFor('ANSI_1252');
        const d = new BitWriter(ver, enc);
        const s = new BitWriter(ver, enc);
        const hd = new BitWriter(ver, enc);
        if (ver >= 1021) d.strWriter = s;
        writeCtxOps(d, hd, ops, ver, (h) => parseInt(h, 16) || 0, (n) => blockH.get(n.toUpperCase()) ?? 0);
        expect(bits(d.bytes(), d.pos), what).toBe(bits(raw.data, raw.dataBits));
        expect(bits(hd.bytes(), hd.pos), what).toBe(bits(raw.handles, hd.pos));
      }
    });
  }
});

/** AutoCAD DXF의 MULTILEADER CONTEXT_DATA 태그(핸들 → 300·301 사이) */
function dxfContexts(path: string): Map<string, RawTag[]> {
  const out = new Map<string, RawTag[]>();
  const lines = readFileSync(path, 'latin1').split(/\r?\n/);
  let cur: RawTag[] | null = null;
  let h = '';
  let inCtx = false;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]!.trim());
    const v = lines[i + 1]!;
    if (code === 0) {
      if (cur && h) out.set(h, cur);
      cur = v.trim() === 'MULTILEADER' ? [] : null;
      h = '';
      inCtx = false;
      continue;
    }
    if (!cur) continue;
    if (code === 5 && !h) h = v.trim();
    if (code === 300 && v.trim() === 'CONTEXT_DATA{') inCtx = true;
    else if (code === 301 && inCtx) inCtx = false;
    else if (inCtx) cur.push({ code, value: v });
  }
  return out;
}

describe.skipIf(!existsSync(DWG('AC1032')) || !existsSync(DXF('AC1032')))('다중 지시선 컨텍스트 자료 코덱 = AutoCAD DXF(MULTILEADER 본문의 같은 자료)', () => {
  for (const v of ['AC1018', 'AC1021', 'AC1024', 'AC1027', 'AC1032']) {
    it(v, () => {
      const doc = readDwg(readFileSync(DWG(v)));
      const ref = dxfContexts(DXF(v));
      let n = 0;
      for (const b of doc.blocks.values()) {
        for (const e of b.entities) {
          if (e.type !== 'MULTILEADER' || !e.dwgRaw) continue;
          const raw = e.dwgRaw;
          const ver = Number(raw.version.slice(2));
          const dec = new TextDecoder('windows-1252');
          const r = new BitReader(raw.data, ver, dec);
          r.end = raw.dataBits;
          if (ver >= 1021 && raw.strings) {
            const s = new BitReader(raw.strings, ver, dec);
            s.end = raw.stringBits ?? 0;
            r.strReader = s;
          }
          const hr = new BitReader(raw.handles, ver, dec);
          hr.end = raw.handleBits;
          if (ver >= 1024) r.BS();
          const tags = readMLeaderContext(r, hr, parseInt(e.handle, 16), ver);
          const end = r.pos;
          const theirs = ref.get(e.handle)!;
          expect(theirs, e.handle).toBeTruthy();
          expect(tags.map((t) => t.code), e.handle).toEqual(theirs.map((t) => t.code));
          tags.forEach((t, i) => expect(sameValue(t.value, theirs[i]!.value), `${e.handle} #${i} ${t.code}`).toBe(true));
          // 다시 쓴 비트 = 원본(지시선 선의 재지정 특성이 없는 것도 AutoCAD 기본값과 같다)
          const ops = encodeMLeaderContext(tags, ver)!;
          const enc = encoderFor('ANSI_1252');
          const d = new BitWriter(ver, enc);
          const s2 = new BitWriter(ver, enc);
          const hd = new BitWriter(ver, enc);
          if (ver >= 1021) d.strWriter = s2;
          if (ver >= 1024) d.BS(2);
          writeCtxOps(d, hd, ops, ver, (h) => parseInt(h, 16) || 0, () => 0);
          expect(bits(d.bytes(), d.pos), e.handle).toBe(bits(raw.data, raw.dataBits).slice(0, end));
          n++;
        }
      }
      expect(n).toBeGreaterThanOrEqual(15);
    });
  }
});

describe.skipIf(!existsSync(join(FIXTURES, 'all-samples', 'Annotation - Metric.dwg')))('예제 도면 저장 → 다시 읽기: 레코드가 같다', () => {
  for (const name of ['Annotation - Metric.dwg', 'Structural - Metric.dwg']) {
    it(name, () => {
      const p = join(FIXTURES, 'all-samples', name);
      if (!existsSync(p)) return;
      const a = readDwg(readFileSync(p));
      const recs = ctxObjects(a);
      expect(recs.length).toBeGreaterThan(0);
      for (const out of [writeDwg(a, { version: 'AC1032' }).data, writeDwg(a, { version: 'AC1024' }).data, writeDxf(a, { version: 'AC1032' as never }).data]) {
        const b = readCadFile(out, 'x');
        for (const o of recs) {
          const x = b.objects.get(o.handle) as GenericObject | undefined;
          expect(x?.type, o.handle).toBe(o.type);
          const want = o.raw!.map((t, i) => (i === 1 && t.code === 70 ? { code: 70, value: 4 } : t));
          expect(x!.raw!.map((t) => t.code)).toEqual(want.map((t) => t.code));
          x!.raw!.forEach((t, i) => expect(sameValue(t.value, want[i]!.value), `${o.handle} #${i}`).toBe(true));
        }
      }
    });
  }
});

describe.skipIf(!hasPython)('ezdxf 오라클: 이 앱이 쓴 DXF의 컨텍스트 데이터 구조', () => {
  const f = ctxFixture();
  for (const v of ['AC1032', 'AC1024', 'AC1021', 'AC1015']) {
    it(v, () => {
      mkdirSync(OUT, { recursive: true });
      const src = join(OUT, `ctx_${v}.dxf`);
      const json = `${src}.json`;
      writeFileSync(src, writeDxf(f.doc, { version: v as never }).data);
      try {
        execFileSync(PYTHON, ['-I', join(ROOT, 'scripts/oracle/ezdxf_ctxdata.py'), src, json], { stdio: 'pipe', timeout: 120_000 });
        const j = JSON.parse(readFileSync(json, 'utf8')) as {
          audit_errors: string[];
          classes: string[];
          records: { type: string; key: string; scales_dict: string; manager: string; entity_type: string; entity_xdict_ok: boolean; reactor_ok: boolean; scale_type: string; subclasses: string[] }[];
        };
        expect(j.audit_errors).toEqual([]);
        // R2000은 이 버전에 없는 다중 지시선·호 길이 치수를 나누거나 블록으로 바꾸므로 그 레코드가 빠진다
        expect(j.records.length).toBe(v === 'AC1015' ? 24 : 28);
        for (const r of j.records) {
          expect(r.scales_dict, r.type).toBe('ACDB_ANNOTATIONSCALES');
          expect(r.manager, r.type).toBe('AcDbContextDataManager');
          expect(r.key, r.type).toMatch(/^\*A\d+$/);
          expect(r.entity_xdict_ok, r.type).toBe(true);
          expect(r.reactor_ok, r.type).toBe(true);
          expect(r.scale_type, r.type).toBe('SCALE');
          expect(r.subclasses.slice(0, 2)).toEqual(['AcDbObjectContextData', 'AcDbAnnotScaleObjectContextData']);
          expect(j.classes, r.type).toContain(r.type);
        }
        const kinds = new Map(j.records.map((r) => [r.type, r.entity_type]));
        expect(kinds.get('ACDB_ALDIMOBJECTCONTEXTDATA_CLASS')).toBe('DIMENSION');
        expect(kinds.get('ACDB_HATCHSCALECONTEXTDATA_CLASS')).toBe('HATCH');
        if (v !== 'AC1015') expect(kinds.get('ACDB_MLEADEROBJECTCONTEXTDATA_CLASS')).toBe('MULTILEADER');
      } finally {
        rmSync(src, { force: true });
        rmSync(json, { force: true });
      }
    });
  }
});
