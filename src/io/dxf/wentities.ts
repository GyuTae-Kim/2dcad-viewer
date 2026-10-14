/**
 * 객체(ENTITIES·BLOCKS 구역) 태그 쓰기.
 * 하위 클래스 표지·그룹 코드 순서는 AutoCAD가 저장한 DXF를 따른다. R12는 하위 클래스 표지·소유자·R2000+ 코드를 쓰지 않는다.
 * entityTags()로 객체 하나(딸린 VERTEX·ATTRIB·SEQEND 포함)의 태그를 따로 꺼낼 수 있다(부분 저장용).
 */
import type {
  AcisEntity,
  AttribEntity,
  CadColor,
  DimensionEntity,
  Entity,
  EntityBase,
  HatchEdge,
  HatchEntity,
  HatchPath,
  ImageEntity,
  InsertEntity,
  LeaderEntity,
  MLeaderEntity,
  MLineEntity,
  MTextEntity,
  PolylineEntity,
  RawTag,
  SplineEntity,
  TableEntity,
  TextEntity,
  UnderlayEntity,
  Vec2,
  Vec3,
  ViewportEntity,
  XData,
} from '../../core/model';
import { tableKey } from '../../core/model';
import { clampedKnots } from '../../geom/curves';
import { CollectSink, kindOf, rawTagValid, rawTagsValid, type TagSink } from './tagwriter';
import type { WriteContext } from './wcontext';
import { mtextPlainLines } from './wconvert';
import { parseDimOverrides } from './tagutil';
import { acdbTableTags, tableCellsOut } from '../tablecells';

const RAD2DEG = 180 / Math.PI;
const TAU = Math.PI * 2;

/** DXF가 허용하는 선가중치 */
const LINEWEIGHTS = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];

export function validLineweight(lw: number): number {
  if (lw === -1 || lw === -2 || lw === -3) return lw;
  if (LINEWEIGHTS.includes(lw)) return lw;
  if (!Number.isFinite(lw) || lw < 0) return -3;
  let best = 0;
  for (const v of LINEWEIGHTS) if (Math.abs(v - lw) < Math.abs(best - lw)) best = v;
  return best;
}

/** CadColor → MULTILEADER·DWG 원시 색 정수(부호 있는 32비트) */
export function cadColorToRaw(c: CadColor | undefined): number {
  if (!c) return 0xc1000000 | 0;
  if (c.rgb !== undefined) return (0xc2000000 | (c.rgb & 0xffffff)) | 0;
  if (c.aci === 256) return 0xc0000000 | 0;
  if (c.aci === 0) return 0xc1000000 | 0;
  if (c.aci === 257) return 0xc8000000 | 0;
  return (0xc3000000 | (c.aci & 0xff)) | 0;
}

/** 다른 객체를 가리키는 핸들 코드(5·105 자기 핸들 제외) */
function isRefCode(code: number): boolean {
  return (code >= 320 && code <= 369) || (code >= 390 && code <= 399) || code === 480 || code === 481;
}

function isZ(v: Vec3 | undefined): boolean {
  return !v || (Math.abs(v.x) < 1e-12 && Math.abs(v.y) < 1e-12 && Math.abs(v.z - 1) < 1e-12);
}

function fin(n: number, d = 0): number {
  return Number.isFinite(n) ? n : d;
}

/** 태그 쓰기 도우미 */
export class TagOut {
  readonly r12: boolean;
  constructor(
    readonly s: TagSink,
    readonly ctx: WriteContext,
  ) {
    this.r12 = ctx.ver <= 1009;
  }
  t(code: number, v: string | number): void {
    this.s.tag(code, v);
  }
  sub(name: string): void {
    if (!this.r12) this.s.tag(100, name);
  }
  p3(code: number, p: Vec3 | undefined): void {
    const q = p ?? { x: 0, y: 0, z: 0 };
    this.s.tag(code, fin(q.x));
    this.s.tag(code + 10, fin(q.y));
    this.s.tag(code + 20, fin(q.z));
  }
  p2(code: number, p: Vec2 | Vec3 | undefined): void {
    const q = p ?? { x: 0, y: 0 };
    this.s.tag(code, fin(q.x));
    this.s.tag(code + 10, fin(q.y));
  }
  deg(code: number, rad: number): void {
    this.s.tag(code, fin(rad) * RAD2DEG);
  }
  /** 쓸 객체를 가리킬 때만 */
  h(code: number, h: string | undefined): boolean {
    if (h && this.ctx.isLive(h)) {
      this.s.tag(code, h.toUpperCase());
      return true;
    }
    return false;
  }
  /** 원본 태그(점 값이 "x,y,z" 문자열이면 나눠 쓴다). 쓰지 않는 객체를 가리키는 핸들은 0으로, 구조를 깨는 태그는 뺀다. */
  raw(tags: RawTag[], section = false): void {
    for (const t of tags) {
      // 구역(ACDSDATA 등)의 원본 태그에는 레코드를 여는 0번 코드가 있다.
      if (!(section && t.code === 0 && typeof t.value === 'string' && t.value) && !rawTagValid(t.code, t.value)) continue;
      if (isRefCode(t.code)) {
        const h = String(t.value).trim().toUpperCase();
        this.s.tag(t.code, h && h !== '0' && this.ctx.isLive(h) ? h : '0');
        continue;
      }
      if (typeof t.value === 'string' && t.value.includes(',') && kindOf(t.code) === 'dbl') {
        const parts = t.value.split(',').map(Number);
        this.s.tag(t.code, parts[0] ?? 0);
        if (parts.length > 1) this.s.tag(t.code + 10, parts[1] ?? 0);
        if (parts.length > 2) this.s.tag(t.code + 20, parts[2] ?? 0);
        continue;
      }
      this.s.tag(t.code, t.value);
    }
  }
}

// ---------------------------------------------------------------------------
// 공통 부분

/** 102 {ACAD_XDICTIONARY …}, 102 {ACAD_REACTORS …} */
export function appGroups(w: TagOut, xdict: string | undefined, reactors: readonly string[] | undefined): void {
  if (w.r12) return;
  const ctx = w.ctx;
  if (xdict && ctx.isLive(xdict)) {
    const o = ctx.objByH.get(xdict.toUpperCase())?.obj;
    if (o && (o.type === 'DICTIONARY' || o.type === 'ACDBDICTIONARYWDFLT')) {
      w.t(102, '{ACAD_XDICTIONARY');
      w.t(360, xdict.toUpperCase());
      w.t(102, '}');
    }
  }
  if (reactors && reactors.length) {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const r of reactors) {
      const h = r.toUpperCase();
      if (!seen.has(h) && ctx.isLive(h)) {
        seen.add(h);
        list.push(h);
      }
    }
    if (list.length) {
      w.t(102, '{ACAD_REACTORS');
      for (const h of list) w.t(330, h);
      w.t(102, '}');
    }
  }
}

function hexChunks(bytes: Uint8Array, size = 127): string[] {
  const out: string[] = [];
  const HEX = '0123456789ABCDEF';
  for (let i = 0; i < bytes.length; i += size) {
    let s = '';
    const end = Math.min(bytes.length, i + size);
    for (let j = i; j < end; j++) s += HEX[bytes[j]! >> 4]! + HEX[bytes[j]! & 15]!;
    out.push(s);
  }
  return out;
}

function common(w: TagOut, type: string, h: string, owner: string, e: EntityBase, paper: boolean): void {
  const ctx = w.ctx;
  const ver = ctx.ver;
  w.t(0, type);
  w.t(5, h);
  if (!w.r12) {
    const reactors = [...(e.reactors ?? []), ...(ctx.groupReactors.get(h) ?? [])];
    appGroups(w, e.xdict, reactors);
    w.t(330, owner || '0');
    w.t(100, 'AcDbEntity');
  }
  if (paper) w.t(67, 1);
  w.t(8, e.layer || '0');
  if (e.linetype && tableKey(e.linetype) !== 'BYLAYER') w.t(6, e.linetype);
  const aci = e.color?.aci ?? 256;
  if (aci >= 0 && aci <= 255) w.t(62, aci);
  if (ver >= 1018) {
    if (e.color?.rgb !== undefined) w.t(420, e.color.rgb & 0xffffff);
    if (e.color?.name) w.t(430, e.color.name);
    const tr = e.transparency;
    if (tr === -2) w.t(440, 0x01000000);
    else if (tr >= 0 && tr <= 255) w.t(440, 0x02000000 | tr);
  }
  if (ver >= 1015) {
    const lw = validLineweight(e.lineweight);
    if (lw !== e.lineweight) ctx.warn('entity.lineweight_fixed', '허용되지 않는 선가중치를 가까운 값으로 바꿨습니다.', String(e.lineweight));
    if (lw !== -1) w.t(370, lw);
  }
  if (!w.r12) {
    if (e.ltscale !== 1 && Number.isFinite(e.ltscale) && e.ltscale > 0) w.t(48, e.ltscale);
    if (e.invisible) w.t(60, 1);
    if (ver >= 1015) w.h(390, e.plotStyle);
    const gfx = (e as { graphics?: Uint8Array }).graphics;
    if (gfx && gfx.length && e.type === 'UNKNOWN') {
      w.t(ver >= 1024 ? 160 : 92, gfx.length);
      for (const c of hexChunks(gfx)) w.t(310, c);
    }
  }
}

/** 확장 자료(등록된 APPID만) */
export function writeXData(w: TagOut, list: XData[] | undefined): void {
  if (!list) return;
  for (const x of list) {
    if (!x.app || !w.ctx.appidSet.has(tableKey(x.app))) continue;
    w.t(1001, x.app);
    for (const it of x.items) {
      const v = it.value;
      if (it.code >= 1010 && it.code <= 1013 && typeof v === 'object' && !(v instanceof Uint8Array)) {
        w.p3(it.code, v as Vec3);
      } else if (v instanceof Uint8Array) {
        for (const c of hexChunks(v)) w.t(1004, c);
      } else if (typeof v === 'object') {
        w.p3(it.code, v as Vec3);
      } else if (it.code === 1071 && w.r12) {
        // R12에는 32비트 정수(1071)가 없다.
        const n = Number(v);
        if (Number.isInteger(n) && n >= -32768 && n <= 32767) w.t(1070, n);
        else w.t(1040, n);
      } else w.t(it.code, v);
    }
  }
}

/** 치수 재지정 확장 자료(ACAD DSTYLE)를 overrides에서 다시 만든다. */
function sameOverrides(a: Record<number, string | number>, b: Record<number, string | number>, ctx: WriteContext): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const x = a[Number(k)];
    const y = b[Number(k)];
    if (y === undefined) return false;
    const code = Number(k);
    if (code >= 340 && code <= 347) {
      if (String(x).toUpperCase() !== String(y).toUpperCase() || !ctx.isLive(String(x))) return false;
    } else if (typeof x === 'number' || typeof y === 'number') {
      if (Math.abs(Number(x) - Number(y)) > 1e-12 * Math.max(1, Math.abs(Number(x)))) return false;
    } else if (x !== y) return false;
  }
  return true;
}

function dimXData(e: DimensionEntity | LeaderEntity, ctx: WriteContext): XData[] | undefined {
  const ov = e.overrides;
  if (!ov) return e.xdata;
  // 확장 자료의 DSTYLE이 재지정 값과 같으면 원래 순서 그대로 둔다.
  const cur = parseDimOverrides(e.xdata);
  if (cur && sameOverrides(cur, ov, ctx)) return e.xdata;
  const list = e.xdata ? e.xdata.map((x) => ({ app: x.app, items: [...x.items] })) : [];
  let acad = list.find((x) => x.app.toUpperCase() === 'ACAD');
  if (acad) {
    // 기존 DSTYLE 묶음 제거
    const i = acad.items.findIndex((it) => it.code === 1000 && String(it.value).toUpperCase() === 'DSTYLE');
    if (i >= 0) {
      let j = i + 1;
      let depth = 0;
      for (; j < acad.items.length; j++) {
        const it = acad.items[j]!;
        if (it.code === 1002 && it.value === '{') depth++;
        else if (it.code === 1002 && it.value === '}') {
          depth--;
          if (depth <= 0) {
            j++;
            break;
          }
        }
      }
      acad.items.splice(i, j - i);
    }
  } else {
    acad = { app: 'ACAD', items: [] };
    list.push(acad);
  }
  const keys = Object.keys(ov)
    .map(Number)
    .sort((a, b) => a - b);
  if (keys.length) {
    acad.items.push({ code: 1000, value: 'DSTYLE' }, { code: 1002, value: '{' });
    for (const k of keys) {
      const v = ov[k]!;
      const kind = kindOf(k);
      if (k >= 340 && k <= 347) {
        if (typeof v !== 'string' || !ctx.isLive(v)) continue;
        acad.items.push({ code: 1070, value: k }, { code: 1005, value: v.toUpperCase() });
      } else if (kind === 'dbl') acad.items.push({ code: 1070, value: k }, { code: 1040, value: Number(v) });
      else if (kind === 'str') acad.items.push({ code: 1070, value: k }, { code: 1000, value: String(v) });
      else acad.items.push({ code: 1070, value: k }, { code: 1070, value: Math.trunc(Number(v)) });
    }
    acad.items.push({ code: 1002, value: '}' });
  }
  return list.filter((x) => x.items.length);
}

function xdataOf(e: Entity, ctx: WriteContext): XData[] | undefined {
  let x = e.xdata;
  if ((e.type === 'DIMENSION' || e.type === 'LEADER') && e.overrides) x = dimXData(e, ctx);
  if (e.hyperlink && e.hyperlink.url && !(x ?? []).some((a) => a.app.toUpperCase() === 'PE_URL')) {
    const items: XData['items'] = [{ code: 1000, value: e.hyperlink.url }];
    if (e.hyperlink.description || e.hyperlink.location) {
      items.push({ code: 1002, value: '{' }, { code: 1000, value: e.hyperlink.description ?? '' });
      if (e.hyperlink.location) items.push({ code: 1002, value: '{' }, { code: 1000, value: e.hyperlink.location }, { code: 1002, value: '}' });
      items.push({ code: 1002, value: '}' });
    }
    x = [...(x ?? []), { app: 'PE_URL', items }];
  }
  return x;
}

function thickness(w: TagOut, e: EntityBase): void {
  if (e.thickness) w.t(39, e.thickness);
}

function extrusion(w: TagOut, e: { extrusion?: Vec3 }): void {
  if (!isZ(e.extrusion)) w.p3(210, e.extrusion);
}

// ---------------------------------------------------------------------------
// 문자열

/** MTEXT 본문을 250자 조각으로(서로게이트 쌍을 자르지 않고, R2007 이전은 비ASCII를 7바이트로 보고 자른다) */
export function textChunks(text: string, utf8: boolean): string[] {
  const out: string[] = [];
  let cur = '';
  let size = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ch = text[i]!;
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      ch += text[i + 1]!;
      i++;
    }
    const n = utf8 ? ch.length : c < 0x80 ? 1 : 7 * ch.length;
    if (size + n > 250) {
      out.push(cur);
      cur = '';
      size = 0;
    }
    cur += ch;
    size += n;
  }
  out.push(cur);
  return out;
}

function writeMTextBody(w: TagOut, text: string): void {
  const chunks = textChunks(text, w.ctx.ver >= 1021);
  for (let i = 0; i < chunks.length - 1; i++) w.t(3, chunks[i]!);
  w.t(1, chunks[chunks.length - 1]!);
}

function plainOneLine(s: string): string {
  return mtextPlainLines(s).join(' ');
}

// ---------------------------------------------------------------------------
// 객체별

function textBody(w: TagOut, e: TextEntity | AttribEntity, isText: boolean): void {
  w.sub('AcDbText');
  thickness(w, e);
  w.p3(10, e.insert);
  w.t(40, fin(e.height, 1) || 1);
  let text = e.text ?? '';
  if (!isText && (e as AttribEntity).mtext && w.ctx.ver < 1032 && !text) text = plainOneLine((e as AttribEntity).mtext!.text);
  w.t(1, text);
  if (e.rotation) w.deg(50, e.rotation);
  if (e.widthFactor !== 1 && e.widthFactor > 0) w.t(41, e.widthFactor);
  if (e.oblique) w.deg(51, e.oblique);
  w.t(7, e.style || 'Standard');
  if (e.generation) w.t(71, e.generation);
  if (e.halign) w.t(72, e.halign);
  if (e.halign || e.valign) w.p3(11, e.alignPoint ?? e.insert);
  extrusion(w, e);
}

function writeText(w: TagOut, e: TextEntity): void {
  textBody(w, e, true);
  w.sub('AcDbText');
  if (e.valign) w.t(73, e.valign);
}

function writeAttrib(w: TagOut, e: AttribEntity): void {
  const ver = w.ctx.ver;
  const def = e.type === 'ATTDEF';
  if (w.r12) {
    // R12: 10, 40, 1, (3), 2, 70, 73, 50, 41, 51, 7, 71, 72, 74, 11, 210
    thickness(w, e);
    w.p3(10, e.insert);
    w.t(40, fin(e.height, 1) || 1);
    w.t(1, e.text || (e.mtext ? plainOneLine(e.mtext.text) : ''));
    if (def) w.t(3, e.prompt ?? '');
    w.t(2, e.tag || 'TAG');
    w.t(70, e.attFlags);
    if (e.rotation) w.deg(50, e.rotation);
    if (e.widthFactor !== 1 && e.widthFactor > 0) w.t(41, e.widthFactor);
    if (e.oblique) w.deg(51, e.oblique);
    w.t(7, e.style || 'Standard');
    if (e.generation) w.t(71, e.generation);
    if (e.halign) w.t(72, e.halign);
    if (e.valign) w.t(74, e.valign);
    if (e.halign || e.valign) w.p3(11, e.alignPoint ?? e.insert);
    extrusion(w, e);
    return;
  }
  textBody(w, e, false);
  w.sub(def ? 'AcDbAttributeDefinition' : 'AcDbAttribute');
  if (ver >= 1024) w.t(280, 0);
  if (def) w.t(3, e.prompt ?? '');
  w.t(2, e.tag || 'TAG');
  w.t(70, e.attFlags);
  if (e.valign) w.t(74, e.valign);
  if (ver >= 1021 && e.lockPosition) w.t(280, 1);
  if (ver >= 1032 && e.mtext) {
    const m = e.mtext;
    w.t(71, def ? 4 : 2);
    w.t(72, 0);
    w.p3(11, e.alignPoint ?? m.insert);
    w.t(101, 'Embedded Object');
    w.p3(10, m.insert);
    w.t(40, fin(m.height, 1) || 1);
    w.t(41, fin(m.width));
    w.t(46, fin(m.rectHeight ?? 0));
    w.t(71, m.attachment || 1);
    w.t(72, m.drawingDirection || 5);
    writeMTextBody(w, m.text);
    if (m.style && tableKey(m.style) !== 'STANDARD' && w.ctx.styleH.has(tableKey(m.style))) w.t(7, m.style);
    extrusion(w, m);
    if (m.direction) w.p3(11, m.direction);
    else if (m.rotation) w.deg(50, m.rotation);
    w.t(73, m.lineSpacingStyle || 1);
    w.t(44, m.lineSpacingFactor || 1);
  }
}

function writeMText(w: TagOut, e: MTextEntity): void {
  const ver = w.ctx.ver;
  w.sub('AcDbMText');
  w.p3(10, e.insert);
  w.t(40, fin(e.height, 1) || 1);
  w.t(41, fin(e.width));
  if (ver >= 1021 && e.rectHeight !== undefined) w.t(46, fin(e.rectHeight));
  w.t(71, e.attachment >= 1 && e.attachment <= 9 ? e.attachment : 1);
  w.t(72, e.drawingDirection || 1);
  writeMTextBody(w, e.text ?? '');
  w.t(7, e.style || 'Standard');
  extrusion(w, e);
  if (e.direction) w.p3(11, e.direction);
  else if (e.rotation) w.deg(50, e.rotation);
  w.t(73, e.lineSpacingStyle || 1);
  w.t(44, e.lineSpacingFactor || 1);
  if (ver >= 1018 && e.backgroundFlags) {
    w.t(90, e.backgroundFlags);
    if (e.backgroundFlags & 1) {
      const c = e.backgroundColor ?? { aci: 1 };
      w.t(63, c.aci >= 0 && c.aci <= 256 ? c.aci : 1);
      if (c.rgb !== undefined) w.t(421, c.rgb & 0xffffff);
      if (c.name) w.t(431, c.name);
    }
    w.t(45, e.backgroundScale || 1.5);
    if (ver >= 1021) w.t(441, 0);
  }
  const cols = e.columns;
  if (ver >= 1032 && cols && cols.type > 0) {
    const count = cols.count || 1;
    const totalW = count * cols.width + (count - 1) * cols.gutter;
    w.t(101, 'Embedded Object');
    w.t(70, 1);
    w.p3(10, e.direction ?? { x: Math.cos(e.rotation), y: Math.sin(e.rotation), z: 0 });
    w.p3(11, e.insert);
    w.t(40, fin(e.width));
    w.t(41, fin(e.rectHeight ?? 0));
    w.t(42, totalW);
    w.t(43, cols.heights.length ? Math.max(...cols.heights) : fin(e.rectHeight ?? 0));
    w.t(71, cols.type);
    w.t(72, cols.type === 2 && cols.autoHeight ? 0 : cols.count);
    w.t(44, cols.width);
    w.t(45, cols.gutter);
    w.t(73, cols.autoHeight ? 1 : 0);
    w.t(74, cols.flowReversed ? 1 : 0);
    for (const hgt of cols.heights) w.t(46, hgt);
  } else if (cols && cols.type > 0 && ver < 1032) {
    w.ctx.warn('mtext.columns_dropped', 'R2018 이전 버전에는 MTEXT 단 정보를 쓰지 않았습니다(문자는 그대로).');
  }
}

function writeLwPolyline(w: TagOut, e: Extract<Entity, { type: 'LWPOLYLINE' }>): void {
  w.sub('AcDbPolyline');
  w.t(90, e.vertices.length);
  w.t(70, (e.closed ? 1 : 0) | (e.plinegen ? 128 : 0));
  const widths = e.vertices.some((v) => v.startWidth || v.endWidth);
  if (e.constantWidth || !widths) w.t(43, fin(e.constantWidth));
  if (e.elevation) w.t(38, e.elevation);
  thickness(w, e);
  for (const v of e.vertices) {
    w.t(10, fin(v.x));
    w.t(20, fin(v.y));
    if (widths) {
      w.t(40, fin(v.startWidth));
      w.t(41, fin(v.endWidth));
    }
    if (v.bulge) w.t(42, v.bulge);
  }
  extrusion(w, e);
}

function polySub(kind: PolylineEntity['kind']): string {
  return kind === '3d' ? 'AcDb3dPolyline' : kind === 'mesh' ? 'AcDbPolygonMesh' : kind === 'polyface' ? 'AcDbPolyFaceMesh' : 'AcDb2dPolyline';
}

function writePolylineHead(w: TagOut, e: PolylineEntity): void {
  w.sub(polySub(e.kind));
  w.t(66, 1);
  w.p3(10, { x: 0, y: 0, z: e.kind === '2d' ? fin(e.elevation) : 0 });
  thickness(w, e);
  let flags = e.flags;
  if (e.kind === '3d') flags |= 8;
  else if (e.kind === 'mesh') flags |= 16;
  else if (e.kind === 'polyface') flags |= 64;
  w.t(70, flags);
  if (e.defaultStartWidth) w.t(40, e.defaultStartWidth);
  if (e.defaultEndWidth) w.t(41, e.defaultEndWidth);
  if (e.kind === 'mesh' || e.kind === 'polyface') {
    let m = e.mCount;
    let n = e.nCount;
    if (e.kind === 'polyface') {
      m = e.vertices.filter((v) => !v.faceIndices || v.flags & 64).length;
      n = e.vertices.length - m;
    }
    w.t(71, m);
    w.t(72, n);
  }
  if (e.kind === 'mesh') {
    if (e.mDensity) w.t(73, e.mDensity);
    if (e.nDensity) w.t(74, e.nDensity);
  }
  if (e.smoothType) w.t(75, e.smoothType);
  extrusion(w, e);
}

function writeVertices(w: TagOut, e: PolylineEntity, h: string, paper: boolean): void {
  const ctx = w.ctx;
  for (const v of e.vertices) {
    const vh = ctx.alloc();
    w.t(0, 'VERTEX');
    w.t(5, vh);
    if (!w.r12) {
      w.t(330, h);
      w.t(100, 'AcDbEntity');
    }
    if (paper) w.t(67, 1);
    w.t(8, e.layer || '0');
    let flags = v.flags;
    const face = e.kind === 'polyface' && v.faceIndices && v.faceIndices.length > 0 && !(v.flags & 64);
    if (e.kind === '3d') flags |= 32;
    else if (e.kind === 'mesh') flags |= 64;
    else if (e.kind === 'polyface') flags = face ? 128 : 192;
    if (!w.r12) {
      if (face) w.t(100, 'AcDbFaceRecord');
      else {
        w.t(100, 'AcDbVertex');
        w.t(100, e.kind === '3d' ? 'AcDb3dPolylineVertex' : e.kind === 'mesh' ? 'AcDbPolygonMeshVertex' : e.kind === 'polyface' ? 'AcDbPolyFaceMeshVertex' : 'AcDb2dVertex');
      }
    }
    w.p3(10, face ? { x: 0, y: 0, z: 0 } : e.kind === '2d' ? { x: v.location.x, y: v.location.y, z: fin(e.elevation) } : v.location);
    if (e.kind === '2d') {
      if (v.startWidth) w.t(40, v.startWidth);
      if (v.endWidth) w.t(41, v.endWidth);
      if (v.bulge) w.t(42, v.bulge);
    }
    w.t(70, flags);
    if (e.kind === '2d' && v.flags & 2 && v.tangent !== undefined) w.deg(50, v.tangent);
    if (face) {
      const idx = v.faceIndices!;
      for (let i = 0; i < Math.min(4, idx.length); i++) w.t(71 + i, idx[i]!);
    }
  }
  seqend(w, h, e.layer, paper);
}

function seqend(w: TagOut, owner: string, layer: string, paper: boolean): void {
  w.t(0, 'SEQEND');
  w.t(5, w.ctx.alloc());
  if (!w.r12) {
    w.t(330, owner);
    w.t(100, 'AcDbEntity');
  }
  if (paper) w.t(67, 1);
  w.t(8, layer || '0');
}

function writeSpline(w: TagOut, e: SplineEntity): void {
  w.sub('AcDbSpline');
  if (e.normal) w.p3(210, e.normal);
  const n = e.controlPoints.length;
  let knots = e.knots;
  if (n > 0 && knots.length !== n + e.degree + 1) {
    knots = clampedKnots(n, e.degree);
    w.ctx.warn('spline.knots_fixed', '매듭 수가 맞지 않는 스플라인의 매듭을 다시 만들었습니다.');
  }
  w.t(70, e.flags);
  w.t(71, e.degree);
  w.t(72, knots.length);
  w.t(73, n);
  w.t(74, e.fitPoints.length);
  w.t(42, e.knotTolerance || 1e-10);
  w.t(43, e.controlTolerance || 1e-10);
  if (e.fitPoints.length) w.t(44, e.fitTolerance || 1e-10);
  if (e.startTangent) w.p3(12, e.startTangent);
  if (e.endTangent) w.p3(13, e.endTangent);
  for (const k of knots) w.t(40, k);
  if (e.weights && e.weights.length === n) for (const wt of e.weights) w.t(41, wt);
  for (const p of e.controlPoints) w.p3(10, p);
  for (const p of e.fitPoints) w.p3(11, p);
  if (e.helix && w.ctx.ver >= 1021) {
    const hx = e.helix;
    w.sub('AcDbHelix');
    w.t(90, 29);
    w.t(91, 63);
    w.p3(10, hx.axisBase);
    w.p3(11, hx.start);
    w.p3(12, hx.axis);
    w.t(40, hx.radius);
    w.t(41, hx.turns);
    w.t(42, hx.turnHeight);
    w.t(290, hx.ccw ? 1 : 0);
    w.t(280, hx.constrain);
  }
}

function writeInsert(w: TagOut, e: InsertEntity): void {
  const multi = e.columnCount > 1 || e.rowCount > 1;
  w.sub(multi ? 'AcDbMInsertBlock' : 'AcDbBlockReference');
  if (e.attribs.length) w.t(66, 1);
  w.t(2, e.block);
  w.p3(10, e.insert);
  if (e.scale.x !== 1) w.t(41, fin(e.scale.x, 1));
  if (e.scale.y !== 1) w.t(42, fin(e.scale.y, 1));
  if (e.scale.z !== 1) w.t(43, fin(e.scale.z, 1));
  if (e.rotation) w.deg(50, e.rotation);
  if (multi) {
    w.t(70, Math.max(1, e.columnCount));
    w.t(71, Math.max(1, e.rowCount));
    if (e.columnSpacing) w.t(44, e.columnSpacing);
    if (e.rowSpacing) w.t(45, e.rowSpacing);
  }
  extrusion(w, e);
}

const DIM_SUB = ['AcDbAlignedDimension', 'AcDbAlignedDimension', 'AcDb2LineAngularDimension', 'AcDbDiametricDimension', 'AcDbRadialDimension', 'AcDb3PointAngularDimension', 'AcDbOrdinateDimension'];

function writeDimension(w: TagOut, e: DimensionEntity, blockName: string): void {
  const ctx = w.ctx;
  const ver = ctx.ver;
  const kind = e.dimType & 7;
  w.sub('AcDbDimension');
  if (ver >= 1024) w.t(280, 0);
  w.t(2, blockName);
  w.p3(10, e.defPoint);
  w.p3(11, e.textMid);
  if (e.insertPoint && !w.r12) w.p3(12, e.insertPoint);
  w.t(70, e.dimType);
  if (!w.r12) {
    w.t(71, e.attachment || 5);
    if (e.lineSpacingStyle && e.lineSpacingStyle !== 1) w.t(72, e.lineSpacingStyle);
    if (e.lineSpacingFactor && e.lineSpacingFactor !== 1) w.t(41, e.lineSpacingFactor);
    if (Number.isFinite(e.measurement)) w.t(42, e.measurement);
  }
  if (e.text) w.t(1, e.text);
  if (e.textRotation) w.deg(53, e.textRotation);
  if (e.horizontalDirection) w.deg(51, e.horizontalDirection);
  extrusion(w, e);
  w.t(3, ctx.dimStyleName(e.dimStyle));
  if (e.subtype === 'ARC_DIMENSION') {
    const a = e.arc;
    w.sub('AcDbArcDimension');
    w.p3(13, a?.start ?? e.defPoint2);
    w.p3(14, a?.end ?? e.defPoint3);
    w.p3(15, a?.center ?? e.defPoint4);
    w.t(40, a?.startAngle ?? 0);
    w.t(41, a?.endAngle ?? 0);
    w.t(70, a?.partial ? 1 : 0);
    const lead = !!(a?.leader1 || a?.leader2);
    w.t(71, lead ? 1 : 0);
    if (a?.leader1) w.p3(16, a.leader1);
    if (a?.leader2) w.p3(17, a.leader2);
    return;
  }
  if (e.subtype === 'LARGE_RADIAL_DIMENSION') {
    w.sub('AcDbRadialDimensionLarge');
    w.p3(13, e.defPoint2);
    w.p3(14, e.defPoint3);
    w.p3(15, e.defPoint4);
    w.t(40, e.leaderLength);
    return;
  }
  w.sub(DIM_SUB[kind] ?? 'AcDbAlignedDimension');
  switch (kind) {
    case 0:
    case 1:
      w.p3(13, e.defPoint2);
      w.p3(14, e.defPoint3);
      if (kind === 0) w.deg(50, e.rotation);
      if (e.obliqueAngle) w.deg(52, e.obliqueAngle);
      if (kind === 0) w.sub('AcDbRotatedDimension');
      break;
    case 2:
      w.p3(13, e.defPoint2);
      w.p3(14, e.defPoint3);
      w.p3(15, e.defPoint4);
      w.p3(16, e.defPoint5);
      break;
    case 3:
    case 4:
      w.p3(15, e.defPoint4);
      w.t(40, e.leaderLength);
      break;
    case 5:
      w.p3(13, e.defPoint2);
      w.p3(14, e.defPoint3);
      w.p3(15, e.defPoint4);
      break;
    case 6:
      w.p3(13, e.defPoint2);
      w.p3(14, e.defPoint3);
      break;
  }
}

function writeLeader(w: TagOut, e: LeaderEntity): void {
  w.sub('AcDbLeader');
  w.t(3, w.ctx.dimStyleName(e.dimStyle));
  w.t(71, e.arrowHead ? 1 : 0);
  w.t(72, e.pathType);
  w.t(73, e.creation);
  w.t(74, e.hooklineDirection);
  w.t(75, e.hookline ? 1 : 0);
  w.t(40, fin(e.textHeight));
  w.t(41, fin(e.textWidth));
  w.t(76, e.vertices.length);
  for (const v of e.vertices) w.p3(10, v);
  w.h(340, e.annotation);
  if (e.normal) w.p3(210, e.normal);
  if (e.horizontalDirection) w.p3(211, e.horizontalDirection);
  if (e.blockOffset) w.p3(212, e.blockOffset);
  if (e.annotationOffset) w.p3(213, e.annotationOffset);
}

function writeMLeader(w: TagOut, e: MLeaderEntity): void {
  const ctx = w.ctx;
  const ver = ctx.ver;
  const P = e.props ?? {};
  const c = e.context;
  const CP = c.props ?? {};
  const stdText = ctx.styleH.get('STANDARD') ?? '';
  w.sub('AcDbMLeader');
  w.t(270, P[270] ?? 2);
  w.t(300, 'CONTEXT_DATA{');
  w.t(40, c.scale || 1);
  w.p3(10, c.contentBase);
  w.t(41, fin(c.textHeight));
  w.t(140, fin(c.arrowSize));
  w.t(145, fin(c.landingGap));
  w.t(174, CP[174] ?? 1);
  w.t(175, CP[175] ?? 1);
  w.t(176, CP[176] ?? 0);
  w.t(177, CP[177] ?? 0);
  const t = c.text;
  if (t) {
    const TP = t.props ?? {};
    w.t(290, 1);
    w.t(304, t.text);
    w.p3(11, t.normal);
    const sh = t.styleHandle && ctx.isLive(t.styleHandle) ? t.styleHandle : stdText;
    w.t(340, sh || '0');
    w.p3(12, t.location);
    w.p3(13, t.direction);
    w.t(42, fin(t.rotation));
    w.t(43, fin(t.width));
    w.t(44, fin(t.height));
    w.t(45, t.lineSpacingFactor || 1);
    w.t(170, t.lineSpacingStyle || 1);
    w.t(90, cadColorToRaw(t.color));
    w.t(171, t.attachment || 1);
    w.t(172, t.flowDirection || 1);
    w.t(91, cadColorToRaw(t.backgroundColor ?? { aci: 256 }) === (0xc0000000 | 0) && !t.backgroundColor ? 0xc0000000 | 0 : cadColorToRaw(t.backgroundColor));
    w.t(141, fin(t.backgroundScale, 1.5));
    w.t(92, TP[92] ?? 0);
    w.t(291, TP[291] ?? 0);
    w.t(292, t.backgroundFill ? 1 : 0);
    w.t(173, TP[173] ?? 0);
    w.t(293, TP[293] ?? 0);
    w.t(142, TP[142] ?? 0);
    w.t(143, TP[143] ?? 0);
    w.t(294, TP[294] ?? 0);
    w.t(295, TP[295] ?? 0);
  } else w.t(290, 0);
  const b = c.block;
  if (b && b.blockHandle && ctx.isLive(b.blockHandle)) {
    w.t(296, 1);
    w.t(341, b.blockHandle.toUpperCase());
    w.p3(14, b.normal);
    w.p3(15, b.location);
    w.p3(16, b.scale);
    w.t(46, fin(b.rotation));
    w.t(93, cadColorToRaw(b.color));
    const m = b.matrix && b.matrix.length === 16 ? b.matrix : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (const x of m) w.t(47, x);
  } else w.t(296, 0);
  w.p3(110, c.basePoint);
  w.p3(111, c.baseDirection);
  w.p3(112, c.baseVertical);
  w.t(297, CP[297] ?? 0);
  for (const ld of c.leaders) {
    w.t(302, 'LEADER{');
    w.t(290, ld.hasLastPoint ? 1 : 0);
    w.t(291, ld.hasDogleg ? 1 : 0);
    if (ld.lastLeaderPoint) w.p3(10, ld.lastLeaderPoint);
    if (ld.doglegVector) w.p3(11, ld.doglegVector);
    w.t(90, ld.index);
    w.t(40, fin(ld.doglegLength));
    for (const ln of ld.lines) {
      w.t(304, 'LEADER_LINE{');
      for (const p of ln.vertices) w.p3(10, p);
      if (ln.breaks) {
        for (const br of ln.breaks) {
          w.t(90, 0);
          w.p3(11, br.start);
          w.p3(12, br.end);
        }
      }
      w.t(91, ln.index);
      if (ln.color) w.t(92, cadColorToRaw(ln.color));
      w.t(305, '}');
    }
    if (ver >= 1024) w.t(271, ld.attachmentDirection);
    w.t(303, '}');
  }
  if (ver >= 1024) {
    w.t(272, CP[272] ?? 9);
    w.t(273, CP[273] ?? 9);
  }
  w.t(301, '}');
  w.t(340, e.styleHandle && ctx.isLive(e.styleHandle) ? e.styleHandle.toUpperCase() : ctx.mleaderStandardH || '0');
  w.t(90, P[90] ?? 0);
  w.t(170, e.leaderLineType);
  w.t(91, cadColorToRaw(e.leaderLineColor));
  if (!w.h(341, e.leaderLineTypeHandle)) {
    const bb = ctx.ltypeH.get('BYBLOCK');
    if (bb) w.t(341, bb);
  }
  w.t(171, validLineweight(e.leaderLineWeight));
  w.t(290, e.landing ? 1 : 0);
  w.t(291, e.dogleg ? 1 : 0);
  w.t(41, fin(e.doglegLength));
  w.h(342, e.arrowHeadHandle);
  w.t(42, fin(e.arrowSize));
  w.t(172, e.contentType);
  w.t(343, e.textStyleHandle && ctx.isLive(e.textStyleHandle) ? e.textStyleHandle.toUpperCase() : stdText || '0');
  w.t(173, P[173] ?? 1);
  w.t(95, P[95] ?? 1);
  w.t(174, P[174] ?? 1);
  w.t(175, P[175] ?? 0);
  w.t(92, cadColorToRaw(e.textColor));
  w.t(292, e.textFrame ? 1 : 0);
  w.h(344, e.blockHandle);
  w.t(93, cadColorToRaw(e.blockColor));
  w.p3(10, e.blockScale);
  w.t(43, fin(e.blockRotation));
  w.t(176, e.blockConnection);
  w.t(293, P[293] ?? 0);
  if (e.blockAttributes) {
    for (const a of e.blockAttributes) {
      if (!ctx.isLive(a.attdefHandle)) continue;
      w.t(330, a.attdefHandle.toUpperCase());
      w.t(177, a.index);
      w.t(44, a.width);
      w.t(302, a.text);
    }
  }
  w.t(294, P[294] ?? 0);
  w.t(178, P[178] ?? 0);
  w.t(179, P[179] ?? 1);
  w.t(45, e.scale || 1);
  if (ver >= 1024) {
    w.t(271, P[271] ?? 0);
    w.t(272, P[272] ?? 9);
    w.t(273, P[273] ?? 9);
  }
  if (ver >= 1027) w.t(295, P[295] ?? 0);
}

/** 해치 호·타원 경계: 모델의 반시계 각도 → 파일 각도(시계 방향 경로는 보각) */
function edgeAngles(startAngle: number, endAngle: number, ccw: boolean): [number, number] {
  let s = startAngle * RAD2DEG;
  let e = endAngle * RAD2DEG;
  if (!ccw) {
    const s0 = 360 - e;
    const e0 = 360 - s;
    s = s0;
    e = e0;
  }
  return [s, e];
}

function writeEdge(w: TagOut, edge: HatchEdge): void {
  const ver = w.ctx.ver;
  switch (edge.type) {
    case 'line':
      w.t(72, 1);
      w.p2(10, edge.start);
      w.p2(11, edge.end);
      return;
    case 'arc': {
      w.t(72, 2);
      w.p2(10, edge.center);
      w.t(40, fin(edge.radius));
      const [s, e] = edgeAngles(edge.startAngle, edge.endAngle, edge.ccw);
      w.t(50, s);
      w.t(51, e);
      w.t(73, edge.ccw ? 1 : 0);
      return;
    }
    case 'ellipse': {
      w.t(72, 3);
      w.p2(10, edge.center);
      w.p2(11, edge.majorAxis);
      w.t(40, fin(edge.ratio, 1));
      const [s, e] = edgeAngles(edge.startAngle, edge.endAngle, edge.ccw);
      w.t(50, s);
      w.t(51, e);
      w.t(73, edge.ccw ? 1 : 0);
      return;
    }
    case 'spline': {
      const n = edge.controlPoints.length;
      let knots = edge.knots;
      if (knots.length !== n + edge.degree + 1) knots = clampedKnots(n, edge.degree);
      const rational = !!edge.weights && edge.weights.length === n;
      w.t(72, 4);
      w.t(94, edge.degree);
      w.t(73, rational ? 1 : 0);
      w.t(74, edge.periodic ? 1 : 0);
      w.t(95, knots.length);
      w.t(96, n);
      for (const k of knots) w.t(40, k);
      edge.controlPoints.forEach((p, i) => {
        w.p2(10, p);
        if (rational) w.t(42, edge.weights![i]!);
      });
      if (ver >= 1024) {
        const fit = edge.fitPoints ?? [];
        w.t(97, fit.length);
        for (const p of fit) w.p2(11, p);
        if (fit.length) {
          if (edge.startTangent) w.p2(12, edge.startTangent);
          if (edge.endTangent) w.p2(13, edge.endTangent);
        }
      }
      return;
    }
  }
}

function writePath(w: TagOut, p: HatchPath, mpolygon: boolean): void {
  const ctx = w.ctx;
  if (p.polyline) {
    w.t(92, p.flags | 2);
    const bulge = p.polyline.vertices.some((v) => v.bulge);
    if (mpolygon) {
      w.t(73, p.polyline.closed ? 1 : 0);
      w.t(72, bulge ? 1 : 0);
    } else {
      w.t(72, bulge ? 1 : 0);
      w.t(73, p.polyline.closed ? 1 : 0);
    }
    w.t(93, p.polyline.vertices.length);
    for (const v of p.polyline.vertices) {
      w.p2(10, v);
      if (bulge) w.t(42, v.bulge);
    }
  } else {
    w.t(92, p.flags & ~2);
    const edges = (p.edges ?? []).filter((e) => e.type !== 'spline' || e.controlPoints.length > e.degree || (e.fitPoints?.length ?? 0) >= 2);
    w.t(93, edges.length);
    for (const e of edges) writeEdge(w, e);
  }
  if (!mpolygon) {
    const src = (p.sources ?? []).map((h) => h.toUpperCase()).filter((h) => ctx.isLive(h));
    w.t(97, src.length);
    for (const h of src) w.t(330, h);
  }
}

function writePatternLines(w: TagOut, e: HatchEntity): void {
  w.t(78, e.patternLines.length);
  for (const l of e.patternLines) {
    w.deg(53, l.angle);
    w.t(43, fin(l.base.x));
    w.t(44, fin(l.base.y));
    w.t(45, fin(l.offset.x));
    w.t(46, fin(l.offset.y));
    w.t(79, l.dashes.length);
    for (const d of l.dashes) w.t(49, d);
  }
}

function writeGradient(w: TagOut, e: HatchEntity, force: boolean): void {
  const g = e.gradient;
  if (!g && !force) return;
  w.t(450, g?.enabled ? 1 : 0);
  w.t(451, 0);
  w.t(460, g?.angle ?? 0);
  w.t(461, g?.shift ?? 0);
  w.t(452, g?.singleColor ? 1 : 0);
  w.t(462, g?.tint ?? 0);
  if (!g) {
    w.t(453, 0);
    w.t(470, '');
    return;
  }
  w.t(453, 2);
  for (const [i, c] of [g.color1, g.color2].entries()) {
    w.t(463, i);
    if (c.aci > 0 && c.aci < 256) w.t(63, c.aci);
    w.t(421, (c.rgb ?? 0) & 0xffffff);
  }
  w.t(470, g.name || 'LINEAR');
}

function writeHatch(w: TagOut, e: HatchEntity): void {
  const ver = w.ctx.ver;
  const mpoly = e.type === 'MPOLYGON';
  const solid = e.solid || e.patternName.toUpperCase() === 'SOLID';
  if (mpoly) {
    w.sub('AcDbMPolygon');
    w.t(70, 1);
    w.p3(10, { x: 0, y: 0, z: fin(e.elevation) });
    w.p3(210, e.extrusion ?? { x: 0, y: 0, z: 1 });
    w.t(2, e.patternName || (solid ? 'SOLID' : ''));
    w.t(71, solid ? 1 : 0);
  } else {
    w.sub('AcDbHatch');
    w.p3(10, { x: 0, y: 0, z: fin(e.elevation) });
    w.p3(210, e.extrusion ?? { x: 0, y: 0, z: 1 });
    w.t(2, e.patternName || (solid ? 'SOLID' : 'ANSI31'));
    w.t(70, solid ? 1 : 0);
    w.t(71, e.associative ? 1 : 0);
  }
  w.t(91, e.paths.length);
  for (const p of e.paths) writePath(w, p, mpoly);
  if (mpoly) {
    w.t(76, e.patternType);
    if (!solid) {
      w.deg(52, e.patternAngle);
      w.t(41, e.patternScale || 1);
      w.t(77, e.patternDouble ? 1 : 0);
    }
    w.t(73, 0);
    if (!solid) writePatternLines(w, e);
    if (ver >= 1018) w.t(63, e.fillColor?.aci ?? 256);
    w.p2(11, { x: 0, y: 0 });
    w.t(99, 0);
    if (ver >= 1018) writeGradient(w, e, true);
    return;
  }
  w.t(75, e.hatchStyle);
  w.t(76, e.patternType);
  if (!solid) {
    w.deg(52, e.patternAngle);
    w.t(41, e.patternScale || 1);
    w.t(77, e.patternDouble ? 1 : 0);
    writePatternLines(w, e);
  }
  if (e.pixelSize) w.t(47, e.pixelSize);
  w.t(98, e.seedPoints.length);
  for (const s of e.seedPoints) w.p2(10, s);
  if (ver >= 1018) writeGradient(w, e, false);
}

function writeFace(w: TagOut, e: Extract<Entity, { type: 'SOLID' | 'TRACE' | '3DFACE' }>): void {
  if (e.type === '3DFACE') {
    w.sub('AcDbFace');
    for (let i = 0; i < 4; i++) w.p3(10 + i, e.points[i]);
    if (e.invisibleEdges) w.t(70, e.invisibleEdges);
    return;
  }
  w.sub('AcDbTrace');
  for (let i = 0; i < 4; i++) w.p3(10 + i, e.points[i]);
  thickness(w, e);
  extrusion(w, e);
}

function writeImage(w: TagOut, e: ImageEntity, h: string): void {
  const ctx = w.ctx;
  const wipe = e.type === 'WIPEOUT';
  w.sub(wipe ? 'AcDbWipeout' : 'AcDbRasterImage');
  w.t(90, 0);
  w.p3(10, e.insert);
  w.p3(11, e.uVector);
  w.p3(12, e.vVector);
  w.p2(13, e.imageSize);
  if (wipe) w.t(340, '0');
  else if (!w.h(340, e.imageDef)) w.t(340, '0');
  w.t(70, e.displayFlags);
  w.t(280, e.clipping ? 1 : 0);
  w.t(281, e.brightness);
  w.t(282, e.contrast);
  w.t(283, e.fade);
  if (wipe) w.t(360, '0');
  else w.t(360, ctx.imageReactor.get(h) ?? '0');
  let clip = e.clipBoundary;
  let type = e.clipBoundaryType;
  if (clip.length < 2) {
    clip = [
      { x: -0.5, y: -0.5 },
      { x: e.imageSize.x - 0.5, y: e.imageSize.y - 0.5 },
    ];
    type = 1;
  }
  w.t(71, type === 2 ? 2 : 1);
  w.t(91, clip.length);
  for (const p of clip) w.p2(14, p);
  if (ctx.ver >= 1024) w.t(290, e.clipInverted ? 1 : 0);
}

function writeViewport(w: TagOut, e: ViewportEntity): void {
  const ctx = w.ctx;
  const ver = ctx.ver;
  if (w.r12) {
    w.p3(10, e.center);
    w.t(40, fin(e.width));
    w.t(41, fin(e.height));
    w.t(68, e.status);
    w.t(69, e.id);
    return;
  }
  w.sub('AcDbViewport');
  w.p3(10, e.center);
  w.t(40, fin(e.width));
  w.t(41, fin(e.height));
  w.t(68, e.status);
  w.t(69, e.id);
  w.p2(12, e.viewCenter);
  w.p2(13, e.snapBase);
  w.p2(14, e.snapSpacing);
  w.p2(15, e.gridSpacing);
  w.p3(16, e.viewDirection);
  w.p3(17, e.viewTarget);
  w.t(42, e.lensLength || 50);
  w.t(43, fin(e.frontClip));
  w.t(44, fin(e.backClip));
  w.t(45, fin(e.viewHeight));
  w.deg(50, e.snapAngle);
  w.deg(51, e.twistAngle);
  w.t(72, e.circleSides || 1000);
  for (const name of e.frozenLayers) {
    const lh = ctx.layerH.get(tableKey(name));
    if (lh) w.t(341, lh);
  }
  w.t(90, e.flags);
  w.h(340, e.clipBoundary);
  w.t(1, e.styleSheet ?? '');
  w.t(281, e.renderMode);
  w.t(71, e.ucsPerViewport ? 1 : 0);
  w.t(74, 0);
  w.p3(110, e.ucsOrigin ?? { x: 0, y: 0, z: 0 });
  w.p3(111, e.ucsXAxis ?? { x: 1, y: 0, z: 0 });
  w.p3(112, e.ucsYAxis ?? { x: 0, y: 1, z: 0 });
  w.t(79, 0);
  w.t(146, 0);
  if (ver >= 1018) w.t(170, 0);
  if (ver >= 1021) {
    w.t(61, 5);
    w.t(292, 1);
    w.t(282, 1);
    w.t(141, 0);
    w.t(142, 0);
    w.t(63, 250);
    w.t(421, 3355443);
  }
}

/** R12 VIEWPORT의 보기 정보(ACAD MVIEW 확장 자료) */
function mviewXData(e: ViewportEntity): XData {
  const it: XData['items'] = [];
  const n = (code: number, value: number) => it.push({ code, value });
  it.push({ code: 1000, value: 'MVIEW' }, { code: 1002, value: '{' });
  n(1070, 16);
  it.push({ code: 1010, value: e.viewTarget }, { code: 1010, value: e.viewDirection });
  n(1040, e.twistAngle);
  n(1040, e.viewHeight);
  n(1040, e.viewCenter.x);
  n(1040, e.viewCenter.y);
  n(1040, e.lensLength || 50);
  n(1040, e.frontClip);
  n(1040, e.backClip);
  n(1070, 0);
  n(1070, e.circleSides || 1000);
  n(1070, 1);
  n(1070, 1);
  n(1070, 0);
  n(1070, 0);
  n(1070, 0);
  n(1070, 0);
  n(1040, e.snapAngle);
  n(1040, e.snapBase.x);
  n(1040, e.snapBase.y);
  n(1040, e.snapSpacing.x || 0.5);
  n(1040, e.snapSpacing.y || 0.5);
  n(1040, e.gridSpacing.x || 0.5);
  n(1040, e.gridSpacing.y || 0.5);
  n(1070, 0);
  it.push({ code: 1002, value: '{' });
  for (const l of e.frozenLayers) it.push({ code: 1003, value: l });
  it.push({ code: 1002, value: '}' }, { code: 1002, value: '}' });
  return { app: 'ACAD', items: it };
}

function writeMLine(w: TagOut, e: MLineEntity): void {
  const ctx = w.ctx;
  let sh = e.styleHandle && ctx.objByH.get(e.styleHandle.toUpperCase())?.obj.type === 'MLINESTYLE' ? e.styleHandle.toUpperCase() : undefined;
  sh ??= ctx.mlineStyleH.get(tableKey(e.styleName)) ?? ctx.mlineStandardH;
  const style = ctx.objByH.get(sh)?.obj as { name?: string; elements?: unknown[] } | undefined;
  w.sub('AcDbMline');
  w.t(2, style?.name ?? e.styleName ?? 'Standard');
  w.t(340, sh || '0');
  w.t(40, e.scale);
  w.t(70, e.justification);
  w.t(71, e.flags);
  w.t(72, e.vertices.length);
  const count = style?.elements?.length ?? e.elementCount;
  w.t(73, count);
  w.p3(10, e.startPoint);
  w.p3(210, e.normal);
  for (const v of e.vertices) {
    w.p3(11, v.position);
    w.p3(12, v.direction);
    w.p3(13, v.miter);
    for (let i = 0; i < count; i++) {
      const el = v.elements[i] ?? { params: [0, 0], fillParams: [] };
      w.t(74, el.params.length);
      for (const p of el.params) w.t(41, p);
      w.t(75, el.fillParams.length);
      for (const p of el.fillParams) w.t(42, p);
    }
  }
}

function writeUnderlay(w: TagOut, e: UnderlayEntity): void {
  w.sub('AcDbUnderlayReference');
  w.h(340, e.definition);
  w.p3(10, e.insert);
  w.t(41, fin(e.scale.x, 1));
  w.t(42, fin(e.scale.y, 1));
  w.t(43, fin(e.scale.z, 1));
  w.deg(50, e.rotation);
  extrusion(w, e);
  w.t(280, e.flags);
  w.t(281, e.contrast);
  w.t(282, e.fade);
  for (const p of e.clipBoundary) w.p2(11, p);
}

/** ACAD_TABLE: 블록 참조 부분은 모델에서, 표 자료는 원본 태그(같은 형식 계열일 때) 또는 모델 값으로 */
function writeTable(w: TagOut, e: TableEntity): void {
  const ctx = w.ctx;
  const ver = ctx.ver;
  w.sub('AcDbBlockReference');
  w.t(2, e.block);
  w.p3(10, e.insert);
  if (e.scale.x !== 1) w.t(41, e.scale.x);
  if (e.scale.y !== 1) w.t(42, e.scale.y);
  if (e.scale.z !== 1) w.t(43, e.scale.z);
  if (e.rotation) w.deg(50, e.rotation);
  extrusion(w, e);
  const style = e.tableStyle && ctx.objByH.get(e.tableStyle.toUpperCase())?.obj.type === 'TABLESTYLE' ? e.tableStyle.toUpperCase() : ctx.tableStyleStandardH;
  const blockRec = ctx.blockByKey.get(tableKey(e.block))?.recH ?? '0';
  const fam = (n: number) => (n >= 1021 ? 2 : 1);
  const rawFam = e.rawVersion ? fam(Number(e.rawVersion.slice(2))) : 0;
  if (e.raw && rawFam === fam(ver) && rawTagsValid(e.raw)) {
    const i = e.raw.findIndex((t) => t.code === 100 && String(t.value).trim() === 'AcDbTable');
    if (i >= 0) {
      let sawStyle = false;
      let sawBlock = false;
      let sawVer = false;
      for (let k = i; k < e.raw.length; k++) {
        const t = e.raw[k]!;
        if (t.code === 342 && !sawStyle) {
          sawStyle = true;
          w.t(342, style || '0');
        } else if (t.code === 343 && !sawBlock) {
          sawBlock = true;
          w.t(343, blockRec);
        } else if (t.code === 280 && k === i + 1) {
          sawVer = true;
          if (ver >= 1024) w.t(280, t.value);
        } else w.raw([t]);
        if (k === i && ver >= 1024 && e.raw[i + 1]?.code !== 280) {
          w.t(280, 0);
          sawVer = true;
        }
      }
      void sawVer;
      return;
    }
  }
  // 원본 태그가 없거나 다른 형식 계열: 셀 배치(병합·정렬·셀 서식)로 만든다(io/tablecells.ts)
  const lay = tableCellsOut(e, ctx.doc);
  w.raw(acdbTableTags(lay, { style: style || '0', blockRec, direction: e.direction, ver, styleOk: (n) => ctx.styleH.has(tableKey(n)) }));
  // 앱 표(셀 서식을 아는 표)는 잃는 것이 없다. AutoCAD 표를 다른 형식 계열로 옮기면 테두리 재지정 등이 빠지고,
  // 셀 서식을 모르는 표는 기본 셀이 된다.
  if (!lay.style && lay.rows * lay.cols > 0)
    ctx.warn('table.synthesized', lay.known ? '표(ACAD_TABLE)를 다른 형식 계열로 옮기며 병합·정렬·셀 서식만 남겼습니다(테두리 재지정 등은 빠짐, 그림 블록은 그대로).' : '표(ACAD_TABLE) 셀 서식을 알 수 없어 기본 셀로 썼습니다(그림 블록은 그대로).');
}

// ---------------------------------------------------------------------------

/** 객체 하나(딸린 레코드 포함)를 쓴다. */
export function writeEntity(s: TagSink, e: Entity, ctx: WriteContext, owner: string, paper: boolean): void {
  const w = new TagOut(s, ctx);
  const h = ctx.hOf(e);
  const r12 = w.r12;
  let type: string = e.type;
  let xdata = xdataOf(e, ctx);
  switch (e.type) {
    case 'DIMENSION':
      type = e.subtype ?? 'DIMENSION';
      break;
    case 'SPLINE':
      if (e.helix && ctx.ver >= 1021) type = 'HELIX';
      break;
    case 'UNKNOWN':
      type = e.originalType;
      break;
    case 'VIEWPORT':
      if (r12 && !(xdata ?? []).some((x) => x.app.toUpperCase() === 'ACAD' && x.items.some((i) => i.value === 'MVIEW'))) {
        xdata = [...(xdata ?? []), mviewXData(e)];
      }
      break;
  }
  ctx.countType(type);
  common(w, type, h, owner, e, paper);
  switch (e.type) {
    case 'LINE':
      w.sub('AcDbLine');
      thickness(w, e);
      w.p3(10, e.start);
      w.p3(11, e.end);
      extrusion(w, e);
      break;
    case 'POINT':
      w.sub('AcDbPoint');
      w.p3(10, e.position);
      thickness(w, e);
      extrusion(w, e);
      if (e.angle) w.deg(50, e.angle);
      break;
    case 'CIRCLE':
      w.sub('AcDbCircle');
      thickness(w, e);
      w.p3(10, e.center);
      w.t(40, fin(e.radius));
      extrusion(w, e);
      break;
    case 'ARC':
      w.sub('AcDbCircle');
      thickness(w, e);
      w.p3(10, e.center);
      w.t(40, fin(e.radius));
      extrusion(w, e);
      w.sub('AcDbArc');
      w.deg(50, e.startAngle);
      w.deg(51, e.endAngle);
      break;
    case 'ELLIPSE': {
      let major = e.majorAxis;
      let ratio = e.ratio;
      let p0 = e.startParam;
      let p1 = e.endParam;
      if (ratio > 1) {
        // 단축이 더 길면 축을 바꾼다(비율은 1 이하여야 한다).
        const n = e.extrusion ?? { x: 0, y: 0, z: 1 };
        const minor = { x: (n.y * major.z - n.z * major.y) * ratio, y: (n.z * major.x - n.x * major.z) * ratio, z: (n.x * major.y - n.y * major.x) * ratio };
        major = minor;
        ratio = 1 / ratio;
        p0 -= Math.PI / 2;
        p1 -= Math.PI / 2;
        if (p0 < 0) p0 += TAU;
        if (p1 < 0) p1 += TAU;
      }
      w.sub('AcDbEllipse');
      w.p3(10, e.center);
      w.p3(11, major);
      w.p3(210, e.extrusion ?? { x: 0, y: 0, z: 1 });
      w.t(40, Math.max(1e-6, Math.min(1, ratio)));
      w.t(41, fin(p0));
      w.t(42, fin(p1, TAU));
      break;
    }
    case 'LWPOLYLINE':
      writeLwPolyline(w, e);
      break;
    case 'POLYLINE':
      writePolylineHead(w, e);
      writeXData(w, xdata);
      writeVertices(w, e, h, paper);
      return;
    case 'SPLINE':
      writeSpline(w, e);
      break;
    case 'XLINE':
    case 'RAY':
      w.sub(e.type === 'XLINE' ? 'AcDbXline' : 'AcDbRay');
      w.p3(10, e.base);
      w.p3(11, e.direction);
      break;
    case 'TEXT':
      writeText(w, e);
      break;
    case 'ATTRIB':
    case 'ATTDEF':
      writeAttrib(w, e as AttribEntity);
      break;
    case 'MTEXT':
      writeMText(w, e);
      break;
    case 'INSERT': {
      writeInsert(w, e);
      writeXData(w, xdata);
      if (e.attribs.length) {
        for (const a of e.attribs) {
          const ah = ctx.hOf(a);
          const aw = new TagOut(s, ctx);
          ctx.countType('ATTRIB');
          common(aw, 'ATTRIB', ah, h, a, paper);
          writeAttrib(aw, { ...a, type: 'ATTRIB' });
          writeXData(aw, xdataOf(a, ctx));
        }
        seqend(w, h, e.layer, paper);
      }
      return;
    }
    case 'DIMENSION':
      writeDimension(w, e, e.block || '*D');
      break;
    case 'LEADER':
      writeLeader(w, e);
      break;
    case 'MULTILEADER':
      writeMLeader(w, e);
      break;
    case 'HATCH':
    case 'MPOLYGON':
      writeHatch(w, e);
      break;
    case 'SOLID':
    case 'TRACE':
    case '3DFACE':
      writeFace(w, e);
      break;
    case 'IMAGE':
    case 'WIPEOUT':
      writeImage(w, e, h);
      break;
    case 'VIEWPORT':
      writeViewport(w, e);
      break;
    case 'MLINE':
      writeMLine(w, e);
      break;
    case 'TOLERANCE':
      w.sub('AcDbFcf');
      w.t(3, ctx.dimStyleName(e.dimStyle));
      w.p3(10, e.insert);
      w.t(1, e.text);
      extrusion(w, e);
      w.p3(11, e.direction);
      break;
    case 'SHAPE':
      w.sub('AcDbShape');
      thickness(w, e);
      w.p3(10, e.insert);
      w.t(40, e.size || 1);
      w.t(2, e.name);
      if (e.rotation) w.deg(50, e.rotation);
      if (e.widthFactor !== 1 && e.widthFactor > 0) w.t(41, e.widthFactor);
      if (e.oblique) w.deg(51, e.oblique);
      extrusion(w, e);
      break;
    case 'ACAD_TABLE':
      writeTable(w, e);
      break;
    case 'MESH': {
      w.sub('AcDbSubDMesh');
      w.t(71, 2);
      w.t(72, 0);
      w.t(91, e.subdivision);
      w.t(92, e.vertices.length);
      for (const v of e.vertices) w.p3(10, v);
      const size = e.faces.reduce((a, f) => a + f.length + 1, 0);
      w.t(93, size);
      for (const f of e.faces) {
        w.t(90, f.length);
        for (const i of f) w.t(90, i);
      }
      w.t(94, e.edges.length);
      for (const [a, b] of e.edges) {
        w.t(90, a);
        w.t(90, b);
      }
      w.t(95, e.edges.length);
      for (let i = 0; i < e.edges.length; i++) w.t(140, 0);
      w.t(90, 0);
      break;
    }
    case 'PDFUNDERLAY':
    case 'DWFUNDERLAY':
    case 'DGNUNDERLAY':
      writeUnderlay(w, e);
      break;
    case 'UNKNOWN':
      if (e.raw) w.raw(e.raw);
      break;
    case 'OLE2FRAME':
    case 'OLEFRAME':
      break;
    default: {
      const a = e as AcisEntity;
      if (a.raw) w.raw(a.raw);
    }
  }
  writeXData(w, xdata);
}

/**
 * 객체 하나의 태그(딸린 VERTEX·ATTRIB·SEQEND 포함). 부분 저장용.
 * e는 문서의 객체(쓰기 버전에 맞춰 바꿔야 하면 바꾼 객체들을 차례로 쓴다) 또는 WriteContext가 정한 객체다.
 * owner를 주지 않으면 담은 블록의 블록 레코드 핸들을 찾는다.
 */
export function entityTags(e: Entity, ctx: WriteContext, owner?: string, paper?: boolean): RawTag[] {
  const sink = new CollectSink();
  const list = ctx.converted.get(e) ?? [e];
  for (const x of list) {
    let own = owner;
    let ps = paper;
    if (own === undefined || ps === undefined) {
      const pb = ctx.blocks.find((b) => b.entities.includes(x)) ?? ctx.blocks.find((b) => b.def.entities.includes(e));
      own ??= pb?.recH ?? ctx.model.recH;
      ps ??= pb ? pb.kind === 'active' || pb.kind === 'paper' : false;
    }
    writeEntity(sink, x, ctx, own, ps);
  }
  return sink.tags;
}
