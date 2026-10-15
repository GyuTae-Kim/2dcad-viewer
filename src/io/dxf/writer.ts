/**
 * CadDocument → DXF(ASCII 또는 이진). AC1009(R12)·AC1015(R2000)·AC1018(R2004)·AC1021(R2007)·AC1024(R2010)·AC1027(R2013)·AC1032(R2018).
 *
 * 구역: HEADER, CLASSES(R2000+), TABLES, BLOCKS, ENTITIES, OBJECTS(R2000+), 그리고 모델이 해석하지 않은 구역(THUMBNAILIMAGE,
 * ACDSDATA 등, 그 구역을 담을 수 있는 버전일 때). 무엇을 어떻게 쓰는지는 WRITER_NOTES.md에 정리했다.
 */
import type { CadDocument, HeaderValue, ReadWarning, Vec3 } from '../../core/model';
import { tableKey } from '../../core/model';
import { STANDARD_CLASSES } from './classes';
import { DEFAULT_HEADER, HEADER_VARS, R12_HEADER_VARS } from './headervars';
import { DxfSerializer, type DxfVersion, DXF_VERSIONS, type TagSink, concatChunks, kindOf } from './tagwriter';
import { type DxfWriteOptions, WriteContext } from './wcontext';
import { TagOut, writeEntity } from './wentities';
import { writeObjects } from './wobjects';
import { writeTables } from './wtables';
import { arcTextsForWrite } from '../arctext';
import { activeVport, vportSnap } from '../vportsnap';

export type { DxfVersion } from './tagwriter';
export type { DxfWriteOptions } from './wcontext';
export { WriteContext } from './wcontext';
export { entityTags } from './wentities';

export interface DxfWriteResult {
  data: Uint8Array;
  warnings: ReadWarning[];
}

/** AutoCAD가 각 버전으로 저장할 때 쓰는 $ACADMAINTVER */
const MAINT_VER: Record<number, number> = { 1009: 0, 1015: 20, 1018: 104, 1021: 50, 1024: 226, 1027: 125, 1032: 329 };

/** 핸들 값을 갖는 헤더 변수(가리키는 객체를 쓸 때만 쓴다) */
function isHandleHeaderCode(code: number): boolean {
  return (code >= 320 && code <= 369) || (code >= 390 && code <= 399);
}

/** 1970-01-01 기준 율리우스일 */
function julianNow(): number {
  return Date.now() / 86400000 + 2440587.5;
}

function guid(): string {
  const b = new Uint8Array(16);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  const h = [...b].map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join('');
  return `{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}}`;
}

function isPoint(v: HeaderValue | undefined): v is { x: number; y: number; z?: number } {
  return typeof v === 'object' && v !== null && 'x' in v;
}

function writeHeader(s: TagSink, ctx: WriteContext, codepage: string): void {
  const doc = ctx.doc;
  const ver = ctx.ver;
  const w = new TagOut(s, ctx);
  const H = doc.header;
  const now = julianNow();
  const has = (name: string) => H.has(name);
  const nameIn = (v: HeaderValue | undefined, map: Map<string, string>, def: string) => (typeof v === 'string' && map.has(tableKey(v)) ? v : def);
  const special = (name: string): HeaderValue | undefined => {
    switch (name) {
      case '$ACADVER':
        return ctx.version;
      case '$ACADMAINTVER':
        return MAINT_VER[ver] ?? 0;
      case '$DWGCODEPAGE':
        return codepage;
      case '$HANDSEED':
        return ctx.handseed;
      case '$HANDLING':
        return 1;
      case '$CLAYER':
        return nameIn(H.get(name), ctx.layerH, '0');
      case '$CELTYPE': {
        const v = H.get(name);
        if (typeof v === 'string' && (['BYLAYER', 'BYBLOCK'].includes(v.toUpperCase()) || ctx.ltypeH.has(tableKey(v)))) return v;
        return 'ByLayer';
      }
      case '$TEXTSTYLE':
      case '$DIMTXSTY':
        return nameIn(H.get(name), ctx.styleH, 'Standard');
      case '$DIMSTYLE':
        return nameIn(H.get(name), ctx.dimstyleH, ctx.dimStyleName('Standard'));
      case '$CMLSTYLE': {
        if (ver <= 1009) return H.get(name) ?? 'Standard';
        const v = H.get(name);
        return typeof v === 'string' && ctx.mlineStyleH.has(tableKey(v)) ? v : 'Standard';
      }
      case '$DIMLTYPE':
      case '$DIMLTEX1':
      case '$DIMLTEX2':
        return nameIn(H.get(name), ctx.ltypeH, '');
      case '$TDCREATE':
      case '$TDUPDATE':
        return typeof H.get(name) === 'number' ? H.get(name) : now;
      case '$TDUCREATE':
        return typeof H.get(name) === 'number' ? H.get(name) : typeof H.get('$TDCREATE') === 'number' ? H.get('$TDCREATE') : now;
      case '$TDUUPDATE':
        return typeof H.get(name) === 'number' ? H.get(name) : typeof H.get('$TDUPDATE') === 'number' ? H.get('$TDUPDATE') : now;
      case '$TDINDWG':
      case '$TDUSRTIMER':
        return typeof H.get(name) === 'number' ? H.get(name) : 0;
      case '$FINGERPRINTGUID':
      case '$VERSIONGUID': {
        const v = H.get(name);
        return typeof v === 'string' && v ? v : guid();
      }
      case '$LASTSAVEDBY':
        return typeof H.get(name) === 'string' ? H.get(name) : '';
      case '$INSUNITS':
        // 값이 없는 문서(R12 등)는 단위 없음으로 둔다(acad.dwt의 1 = 인치를 붙이지 않는다).
        return typeof H.get(name) === 'number' ? H.get(name) : 0;
    }
    return undefined;
  };
  const emit = (name: string, code: number, dims: number, value: HeaderValue | undefined) => {
    if (value === undefined) return;
    if (isHandleHeaderCode(code)) {
      if (typeof value !== 'string' || !ctx.isLive(value)) return;
    }
    w.t(9, name);
    if (dims) {
      const p = isPoint(value) ? value : { x: 0, y: 0, z: 0 };
      w.t(code, p.x);
      w.t(code + 10, p.y);
      if (dims === 3) w.t(code + 20, (p as Vec3).z ?? 0);
      return;
    }
    const kind = kindOf(code);
    if (kind === 'str') w.t(code, typeof value === 'string' ? value : isPoint(value) ? '' : String(value));
    else w.t(code, typeof value === 'number' ? value : typeof value === 'string' ? Number(value) || 0 : 0);
  };
  w.t(0, 'SECTION');
  w.t(2, 'HEADER');
  const written = new Set<string>();
  // 등각투영 설정: R12는 머리말에도(*Active 뷰포트 값), R2000+는 VPORT 표의 77·78에만 쓴다(src/io/vportsnap.ts)
  written.add('$SNAPSTYLE');
  written.add('$SNAPISOPAIR');
  if (ver <= 1009) {
    for (const [name, code, dims] of R12_HEADER_VARS) {
      written.add(name);
      emit(name, code, dims, special(name) ?? H.get(name) ?? DEFAULT_HEADER[name]);
    }
    const snap = vportSnap(doc, activeVport(doc));
    emit('$SNAPSTYLE', 70, 0, snap.style);
    emit('$SNAPISOPAIR', 70, 0, snap.pair);
  } else {
    for (const [name, code0, dims, minVer] of HEADER_VARS) {
      if (ver < minVer) continue;
      written.add(name);
      let code = code0;
      if (name === '$ACADMAINTVER') code = ver >= 1032 ? 90 : 70;
      else if (name === '$XCLIPFRAME') code = ver >= 1024 ? 280 : 290;
      emit(name, code, dims, special(name) ?? (has(name) ? H.get(name) : DEFAULT_HEADER[name]));
    }
  }
  // 표에 없는 변수: 원래 그룹 코드를 알면 쓴다.
  const known = new Set<string>([...HEADER_VARS.map((v) => v[0]), ...R12_HEADER_VARS.map((v) => v[0])]);
  for (const [name, value] of H) {
    if (written.has(name) || known.has(name)) continue;
    const code = doc.headerCodes?.get(name);
    if (code === undefined) continue;
    const dims = code >= 10 && code <= 18 ? (isPoint(value) && 'z' in value ? 3 : 2) : 0;
    emit(name, code, dims, value);
  }
  w.t(0, 'ENDSEC');
}

function writeClasses(s: TagSink, ctx: WriteContext): void {
  const w = new TagOut(s, ctx);
  w.t(0, 'SECTION');
  w.t(2, 'CLASSES');
  const seen = new Set<string>();
  const list = [...ctx.doc.classes];
  for (const t of ctx.typeCounts.keys()) {
    const std = STANDARD_CLASSES.get(t);
    if (std && !list.some((c) => c.dxfName.toUpperCase() === t)) list.push(std);
  }
  for (const c of list) {
    const k = c.dxfName.toUpperCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    w.t(0, 'CLASS');
    w.t(1, c.dxfName);
    w.t(2, c.cppName);
    w.t(3, c.appName);
    w.t(90, c.proxyFlags);
    if (ctx.ver >= 1018) w.t(91, ctx.typeCounts.get(k) ?? 0);
    w.t(280, c.wasProxy ? 1 : 0);
    w.t(281, c.isEntity ? 1 : 0);
  }
  w.t(0, 'ENDSEC');
}

function writeBlocks(s: TagSink, ctx: WriteContext): void {
  const w = new TagOut(s, ctx);
  const r12 = w.r12;
  w.t(0, 'SECTION');
  w.t(2, 'BLOCKS');
  for (const pb of ctx.blocks) {
    const b = pb.def;
    const paper = pb.kind === 'active' || pb.kind === 'paper';
    let name = pb.name;
    if (r12 && pb.kind === 'model') name = '$MODEL_SPACE';
    else if (r12 && pb.kind === 'active') name = '$PAPER_SPACE';
    w.t(0, 'BLOCK');
    w.t(5, pb.beginH);
    if (!r12) {
      w.t(330, pb.recH);
      w.t(100, 'AcDbEntity');
    }
    if (paper) w.t(67, 1);
    w.t(8, b.layer || '0');
    w.sub('AcDbBlockBegin');
    w.t(2, name);
    w.t(70, b.flags);
    w.p3(10, b.basePoint);
    w.t(3, name);
    w.t(1, b.xrefPath ?? '');
    if (!r12 && b.description) w.t(4, b.description);
    if (pb.kind === 'block' || pb.kind === 'paper') {
      for (const e of pb.entities) writeEntity(s, e, ctx, pb.recH, paper);
    }
    w.t(0, 'ENDBLK');
    w.t(5, pb.endH);
    if (!r12) {
      w.t(330, pb.recH);
      w.t(100, 'AcDbEntity');
    }
    if (paper) w.t(67, 1);
    w.t(8, b.layer || '0');
    w.sub('AcDbBlockEnd');
  }
  w.t(0, 'ENDSEC');
}

function writeEntities(s: TagSink, ctx: WriteContext): void {
  s.tag(0, 'SECTION');
  s.tag(2, 'ENTITIES');
  for (const e of ctx.model.entities) writeEntity(s, e, ctx, ctx.model.recH, false);
  for (const e of ctx.active.entities) writeEntity(s, e, ctx, ctx.active.recH, true);
  s.tag(0, 'ENDSEC');
}

function writeRawSections(s: TagSink, ctx: WriteContext): void {
  const secs = ctx.doc.rawSections;
  if (!secs || ctx.ver <= 1009) return;
  const w = new TagOut(s, ctx);
  for (const sec of secs) {
    const src = Number(sec.version.slice(2)) || 0;
    if (sec.name === 'ACDSDATA' && (ctx.ver < 1027 || src < 1027)) continue;
    if (sec.name === 'THUMBNAILIMAGE' && src < 1015) continue;
    w.t(0, 'SECTION');
    w.t(2, sec.name);
    w.raw(sec.tags, true);
    w.t(0, 'ENDSEC');
  }
}

function serialize(doc: CadDocument, options: DxfWriteOptions, codepage: string) {
  const ctx = new WriteContext(doc, options);
  const opts = { version: ctx.version, binary: !!options.binary, codepage, escapeNonAscii: options.escapeNonAscii };
  const body = new DxfSerializer(opts);
  writeTables(body, ctx);
  writeBlocks(body, ctx);
  writeEntities(body, ctx);
  if (ctx.ver >= 1015) writeObjects(body, ctx);
  writeRawSections(body, ctx);
  body.tag(0, 'EOF');
  const head = new DxfSerializer(opts);
  head.writeSentinel();
  writeHeader(head, ctx, codepage);
  if (ctx.ver >= 1015) writeClasses(head, ctx);
  const data = concatChunks([...head.finish(), ...body.finish()]);
  const unencodable = new Set([...head.unencodable, ...body.unencodable]);
  return { data, warnings: ctx.warnings, unencodable };
}

/**
 * 문서를 DXF로 쓴다. 문서는 바꾸지 않는다.
 * R2007 이전 버전은 기본으로 모든 비ASCII 문자를 \U+XXXX로 써서 파일 전체를 ASCII로 둔다($DWGCODEPAGE는 문서 값 그대로).
 * options.codepage를 주면 그 코드 페이지 바이트로 쓰고, 그 코드 페이지에 없는 문자만 \U+XXXX로 쓴다.
 */
export function writeDxf(doc: CadDocument, options: DxfWriteOptions = {}): DxfWriteResult {
  // R13·R14(AC1012·AC1014)는 R2000으로, 모르는 버전은 R2018로 쓴다.
  const asked = options.version as string | undefined;
  let version: DxfVersion = 'AC1032';
  if (asked && (DXF_VERSIONS as readonly string[]).includes(asked)) version = asked as DxfVersion;
  else if (asked === 'AC1012' || asked === 'AC1014') version = 'AC1015';
  const docCp = (typeof doc.header.get('$DWGCODEPAGE') === 'string' ? (doc.header.get('$DWGCODEPAGE') as string) : doc.codepage) || 'ANSI_1252';
  const codepage = (options.codepage ?? docCp).toUpperCase();
  const escapeNonAscii = options.escapeNonAscii ?? !options.codepage;
  const arc = arcTextsForWrite(doc, 'dxf', version);
  const res = serialize(arc.doc, { ...options, version, escapeNonAscii }, codepage);
  res.warnings.push(...arc.warnings);
  if (asked && asked !== version) res.warnings.push({ code: 'version.changed', message: `${asked}로는 쓸 수 없어 ${version}로 썼습니다.`, detail: { from: asked, to: version } });
  if (res.unencodable.size && !escapeNonAscii) {
    res.warnings.push({ code: 'text.escaped', message: '코드 페이지에 없는 문자를 \\U+XXXX로 썼습니다.', count: res.unencodable.size });
  }
  return { data: res.data, warnings: res.warnings };
}
