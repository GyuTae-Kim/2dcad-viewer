/**
 * DXF 쓰기 검증 도우미(로컬 개발 전용).
 *
 * 왕복 비교의 기준은 "쓰기가 쓰려고 정한 문서"다. WriteContext가 버전에 맞게 바꾼 객체(예: R2004 이전의
 * MULTILEADER 분해, 표·호 치수 → INSERT, 새 핸들)를 요약한 것을 기준으로 삼고, 다음 의도된 차이만 맞춘다.
 *  1. R2004 이전(AC1015)에는 트루컬러가 없다 → 기준의 color.rgb를 지운다.
 *  2. 정렬된 TEXT·ATTRIB·ATTDEF는 늘 두 번째 정렬점(11)을 쓴다 → 기준에 alignPoint가 없으면 insert로 둔다.
 *  3. R2007 이전은 비ASCII 문자를 \U+XXXX로 쓴다 → 양쪽 문자열의 \U+ 이스케이프를 푼다.
 *  4. 쓰기는 $DWGCODEPAGE·$INSUNITS를 늘 쓴다 → 기준 값은 쓰기가 쓴 값(문서 코드 페이지, 단위 없으면 0)이다.
 *  5. 문자열의 제어 문자(DWG MTEXT의 줄바꿈 등)는 AutoCAD처럼 ^J 같은 캐럿 표기로 쓰고, 리더는 그 표기를 그대로 둔다
 *     → 기준 문자열의 제어 문자를 캐럿 표기로 바꾼다.
 * 버전 변환이 없는 경우(대상 버전 ≥ 원본 버전)에는 변환 경고가 "자료가 없어 뺀 객체" 종류뿐인지도 따로 본다.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BlockDef, CadDocument, Entity } from '../../src/core/model';
import { decodeCadEscapes } from '../../src/core/codepage';
import { WriteContext } from '../../src/io/dxf/wcontext';
import type { DxfVersion } from '../../src/io/dxf/tagwriter';
import { type Summary, summarizeDocument } from '../oracle/summarize';
import { FIXTURES, PYTHON, hasPython } from '../oracle/ezdxf';

export { FIXTURES, hasPython };

export const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
export const OUT = join(ROOT, '.runtime/dxfw-test');
const CACHE = join(ROOT, '.runtime/dxfw-cache');

export const TARGETS: DxfVersion[] = ['AC1015', 'AC1018', 'AC1021', 'AC1024', 'AC1027', 'AC1032'];

/** 왕복 검증에 쓰는 DXF(로컬에만 있다) */
export function dxfFixtures(): string[] {
  const dirs = [join(FIXTURES, 'samples-dxf'), join(ROOT, '.runtime/gen'), join(ROOT, '.runtime/oracle-dxf')];
  const out = dirs.flatMap((d) => (existsSync(d) ? readdirSync(d).filter((f) => f.toLowerCase().endsWith('.dxf')).sort().map((f) => join(d, f)) : []));
  const sample = join(ROOT, 'public/samples/opencad-sample.dxf');
  if (existsSync(sample)) out.push(sample);
  return out;
}

/** DWG 비교 도면(그룹/이름). all-samples의 sample_*는 samples와 같은 파일이다. */
export function dwgFixtures(): { group: string; name: string; path: string }[] {
  const out: { group: string; name: string; path: string }[] = [];
  for (const group of ['samples', 'all-samples', 'templates']) {
    const dir = join(FIXTURES, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.toLowerCase().endsWith('.dwg')) continue;
      if (group === 'all-samples' && name.startsWith('sample_')) continue;
      out.push({ group, name, path: join(dir, name) });
    }
  }
  return out;
}

/** 출력 파일 이름 */
export function outName(src: string, version: string, suffix = ''): string {
  const base = basename(src).replace(/\.(dxf|dwg)$/i, '').replace(/[^\w.-]+/g, '_');
  return join(OUT, `${base}${suffix}.${version}.dxf`);
}

/** 날짜·GUID가 없는 문서에 고정 값을 넣어 쓰기 결과를 늘 같게 한다(ezdxf 결과 캐시용). */
export function pinVolatile(doc: CadDocument): void {
  const H = doc.header;
  for (const k of ['$TDCREATE', '$TDUCREATE', '$TDUPDATE', '$TDUUPDATE']) if (typeof H.get(k) !== 'number') H.set(k, 2460000.5);
  for (const k of ['$TDINDWG', '$TDUSRTIMER']) if (typeof H.get(k) !== 'number') H.set(k, 0);
  if (typeof H.get('$FINGERPRINTGUID') !== 'string') H.set('$FINGERPRINTGUID', '{00000000-0000-0000-0000-000000000001}');
  if (typeof H.get('$VERSIONGUID') !== 'string') H.set('$VERSIONGUID', '{00000000-0000-0000-0000-000000000002}');
}

/** 변환 경고 중 "버전 때문에 바꾼 것"이 아닌 것(자료가 없어 못 쓰는 객체) */
export const DATA_LOSS_WARNINGS = new Set([
  'entity.acis_dropped',
  'entity.acis_as_wires',
  'entity.ole_dropped',
  'entity.shape_dropped',
  'entity.unknown_dropped',
  'entity.invalid_dropped',
  'entity.image_dropped',
  'entity.underlay_dropped',
  'entity.table_dropped',
  'entity.dimension_dropped',
]);

/** 버전 변환 경고(대상 버전이 원본보다 낮을 때만 나와야 한다) */
export const VERSION_WARNINGS = new Set([
  'entity.mleader_exploded',
  'entity.table_as_insert',
  'entity.dimension_as_insert',
  'entity.mesh_as_polyface',
  'mtext.columns_dropped',
]);

/** 쓰기가 쓰려고 정한 문서의 요약(기준) */
export function plannedSummary(doc: CadDocument, version: DxfVersion): { summary: Summary; ctx: WriteContext } {
  const ctx = new WriteContext(doc, { version });
  const blocks = new Map<string, BlockDef>();
  const withHandle = (e: Entity): Entity => {
    const x = { ...e, handle: ctx.hOf(e) } as Entity;
    if (x.type === 'INSERT') x.attribs = e.type === 'INSERT' ? e.attribs.map((a) => ({ ...a, handle: ctx.hOf(a) })) : [];
    return x;
  };
  for (const pb of ctx.blocks) blocks.set(pb.key, { ...pb.def, name: pb.name, entities: pb.entities.map(withHandle) });
  const planned: CadDocument = {
    ...doc,
    version,
    blocks,
    layers: new Map(ctx.layers.map((p) => [p.rec.name.toUpperCase(), p.rec])),
    linetypes: new Map(ctx.ltypes.map((p) => [p.rec.name.toUpperCase(), p.rec])),
    textStyles: new Map(ctx.styles.map((p) => [p.rec.name.toUpperCase(), p.rec])),
    dimStyles: new Map(ctx.dimstyles.map((p) => [p.rec.name.toUpperCase(), p.rec])),
    layouts: ctx.layouts.map((pl) => ({ ...pl.layout, blockName: pl.block.name })),
    header: new Map(doc.header),
  };
  const cp = (typeof doc.header.get('$DWGCODEPAGE') === 'string' && (doc.header.get('$DWGCODEPAGE') as string)) || doc.codepage || 'ANSI_1252';
  planned.header.set('$DWGCODEPAGE', cp.toUpperCase());
  planned.header.set('$INSUNITS', typeof doc.header.get('$INSUNITS') === 'number' ? doc.header.get('$INSUNITS')! : 0);
  return { summary: summarizeDocument(planned), ctx };
}

type Obj = Record<string, unknown>;

function mapEntities(s: Summary, fn: (e: Obj) => void): void {
  for (const list of Object.values(s.blocks as Record<string, Obj[]>)) for (const e of list) fn(e);
}

const TEXT_KEYS = ['text', 'tag'];

const caret = (s: string): string => s.replace(/[\x00-\x1f]/g, (c) => '^' + String.fromCharCode(c.charCodeAt(0) + 64));

/**
 * ezdxf와 우리 리더의 표기 차이를 맞춘다.
 * - \U+XXXX: ezdxf는 문자열(TEXT 등)은 풀고 이름(도면층·블록·배치)은 풀지 않으며, 우리 리더는 반대다 → 양쪽을 모두 푼다.
 * - ezdxf는 읽을 때 Defpoints 도면층이 없으면 만든다 → 우리 쪽에 없으면 ezdxf 쪽에서 뺀다.
 */
export function normalizeEzdxf(theirs: Summary, ours: Summary): { theirs: Summary; ours: Summary } {
  const t = decodeAll(theirs) as Summary;
  const o = decodeAll(ours) as Summary;
  const names = new Set((o.layers as Obj[]).map((l) => String(l.name).toUpperCase()));
  if (!names.has('DEFPOINTS')) t.layers = (t.layers as Obj[]).filter((l) => String(l.name) !== 'Defpoints');
  return { theirs: t, ours: o };
}

function decodeAll(v: unknown): unknown {
  if (typeof v === 'string') return decodeCadEscapes(v);
  if (Array.isArray(v)) return v.map(decodeAll);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[decodeCadEscapes(k)] = decodeAll(x);
    return o;
  }
  return v;
}

/** 의도된 차이 맞추기(머리말 1~4) */
export function normalizeRoundTrip(expected: Summary, actual: Summary, version: DxfVersion): void {
  const ver = Number(version.slice(2));
  mapEntities(expected, (e) => {
    for (const k of TEXT_KEYS) if (typeof e[k] === 'string') e[k] = caret(e[k] as string);
    const c = e.color as { aci: number; rgb?: number } | undefined;
    if (ver < 1018 && c && c.rgb !== undefined) delete c.rgb;
    if ((e.type === 'TEXT' || e.type === 'ATTRIB' || e.type === 'ATTDEF') && (e.halign || e.valign) && !e.alignPoint) e.alignPoint = e.insert;
  });
  if (ver < 1021) {
    for (const s of [expected, actual]) {
      mapEntities(s, (e) => {
        for (const k of TEXT_KEYS) if (typeof e[k] === 'string') e[k] = decodeCadEscapes(e[k] as string);
      });
    }
  }
}

// ---------------------------------------------------------------------------
// ezdxf 검사(결과는 파일 내용의 해시로 캐시)

export interface AuditResult {
  ok: boolean;
  load_error: string | null;
  errors: { code: number; message: string }[];
  fixes: { code: number; message: string }[];
  log: string[];
  summary?: Summary;
}

let scriptHash = '';

/** 캐시 키: 검사 스크립트 + 파일 내용 */
function hashOf(path: string): string {
  if (!scriptHash) {
    const h = createHash('sha1');
    for (const f of ['ezdxf_audit.py', 'ezdxf_dump.py']) h.update(readFileSync(join(ROOT, 'scripts/oracle', f)));
    scriptHash = h.digest('hex');
  }
  return createHash('sha1').update(scriptHash).update(readFileSync(path)).digest('hex');
}

function runPython(files: string[], out: string): Promise<void> {
  return new Promise((res, rej) => {
    execFile(PYTHON, ['-I', '-B', join(ROOT, 'scripts/oracle/ezdxf_audit.py'), out, '--summary', ...files], { maxBuffer: 64 << 20, timeout: 1_800_000 }, (err) => (err ? rej(err) : res()));
  });
}

/** 긴 준비 작업 중에 테스트 실행기(RPC)가 멈추지 않게 이벤트 루프를 잠깐 돌려준다. */
export function yieldToRunner(): Promise<void> {
  return new Promise((res) => setImmediate(res));
}

/** 파일마다 ezdxf.readfile + audit + 요약. 캐시에 없는 파일만 여러 프로세스로 나눠 돌린다. */
export async function ezdxfAudit(files: string[], workers = 4): Promise<Map<string, AuditResult>> {
  mkdirSync(CACHE, { recursive: true });
  const out = new Map<string, AuditResult>();
  const todo: { path: string; cache: string }[] = [];
  for (const path of files) {
    const cache = join(CACHE, hashOf(path) + '.json');
    if (existsSync(cache)) out.set(path, JSON.parse(readFileSync(cache, 'utf8')));
    else todo.push({ path, cache });
  }
  if (todo.length) {
    const groups: (typeof todo)[] = Array.from({ length: Math.min(workers, todo.length) }, () => []);
    todo.forEach((t, i) => groups[i % groups.length]!.push(t));
    await Promise.all(
      groups.map(async (g, i) => {
        const tmp = join(CACHE, `batch-${process.pid}-${i}.json`);
        await runPython(
          g.map((t) => t.path),
          tmp,
        );
        const res = JSON.parse(readFileSync(tmp, 'utf8')) as Record<string, AuditResult>;
        unlinkSync(tmp);
        for (const t of g) {
          const r = res[t.path];
          if (!r) continue;
          writeFileSync(t.cache, JSON.stringify(r));
          out.set(t.path, r);
        }
      }),
    );
  }
  return out;
}

/**
 * ezdxf가 고치는 항목 중 문제가 아닌 것:
 * - 사전(DICTIONARY)에 붙은 확장 사전: ezdxf는 소유 사전의 항목이 아닌 사전을 지우고(AutoCAD에서는 올바른 구조),
 *   그 안의 XRECORD를 "소유자가 없는 객체"로 지운다. 원본 DXF를 읽을 때도 똑같이 고친다.
 */
export function harmfulFixes(r: AuditResult, xdictsOfDictionaries: Set<string>): AuditResult['fixes'] {
  return r.fixes.filter((f) => {
    const m = /invalid owner handle #([0-9A-F]+)/i.exec(f.message);
    if (f.code === 202 && m && xdictsOfDictionaries.has(m[1]!.toUpperCase())) return false;
    return true;
  });
}

/** 사전 객체에 붙은 확장 사전과 그 아래 사전들의 핸들 */
export function dictionaryXdicts(doc: CadDocument): Set<string> {
  const out = new Set<string>();
  const add = (h: string) => {
    if (out.has(h)) return;
    out.add(h);
    const d = doc.objects.get(h);
    if (d && (d.type === 'DICTIONARY' || d.type === 'ACDBDICTIONARYWDFLT')) for (const c of (d as { entries: Map<string, string> }).entries.values()) add(c);
  };
  for (const o of doc.objects.values()) if ((o.type === 'DICTIONARY' || o.type === 'ACDBDICTIONARYWDFLT') && o.xdict) add(o.xdict);
  return out;
}

// ---------------------------------------------------------------------------
// 구조 검사(ASCII DXF): 핸들이 겹치지 않고, $HANDSEED가 가장 큰 핸들보다 크고, 다른 객체를 가리키는 핸들(320~369·390~399·480·481)이
// 모두 쓴 객체를 가리킨다. 확장 자료의 1005는 응용 프로그램 자료라 보지 않는다. SORTENTSTABLE의 5는 정렬 핸들이다.

export interface StructureReport {
  duplicates: string[];
  dangling: string[];
  seedOk: boolean;
  /** SECTION·ENDSEC, BLOCK·ENDBLK, TABLE·ENDTAB 짝 */
  balanced: boolean;
}

export function checkStructure(data: Uint8Array): StructureReport {
  const text = new TextDecoder('latin1').decode(data);
  const lines = text.split(/\r?\n/);
  const handles = new Set<string>();
  const duplicates: string[] = [];
  const refs: string[] = [];
  let type = '';
  let sec = '';
  let inX = false;
  let seed = 0n;
  let depth = 0;
  let balanced = true;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const c = Number(lines[i]!.trim());
    const v = lines[i + 1]!.trim();
    if (c === 0) {
      type = v;
      inX = false;
      if (v === 'SECTION') {
        sec = lines[i + 3]!.trim();
        if (depth !== 0) balanced = false;
        depth = 1;
      } else if (v === 'ENDSEC') {
        if (depth !== 1) balanced = false;
        depth = 0;
      } else if (v === 'BLOCK' || v === 'TABLE') depth++;
      else if (v === 'ENDBLK' || v === 'ENDTAB') depth--;
      continue;
    }
    if (c === 1001) inX = true;
    if (inX) continue;
    if (sec === 'HEADER') {
      if (c === 5 && lines[i - 1]!.trim() === '$HANDSEED') seed = BigInt('0x' + v);
      continue;
    }
    if (c === 5 || c === 105) {
      if (type === 'SORTENTSTABLE' && c === 5 && handles.size && lines[i - 2]!.trim() === '331') continue;
      if (handles.has(v)) duplicates.push(`${type} ${v}`);
      handles.add(v);
    } else if ((c >= 320 && c <= 369) || (c >= 390 && c <= 399) || c === 480 || c === 481) refs.push(`${c} ${type} ${v}`);
  }
  let max = 0n;
  for (const h of handles) {
    const x = BigInt('0x' + h);
    if (x > max) max = x;
  }
  const dangling = refs.filter((r) => {
    const v = r.slice(r.lastIndexOf(' ') + 1);
    return v !== '0' && v !== '' && !handles.has(v);
  });
  return { duplicates, dangling, seedOk: seed > max, balanced: balanced && depth === 0 };
}
