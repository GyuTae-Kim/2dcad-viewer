/**
 * DWG 쓰기 검증용 비교: 원본 문서 ↔ readDwg(writeDwg(원본)).
 * 버전 차이로 생기는 알려진 손실과 읽기 정규화만 걸러 내고 나머지는 모두 비교한다.
 *
 * 알려진 차이(근거)
 * - 원본 자료만 있는 도형·객체(ACIS, 프록시, 동적 블록 객체 등)는 원본과 같은 버전이 아니면 쓰지 않는다.
 * - ACAD_TABLE은 원본과 다른 버전이면 그림 블록(*T)의 블록 참조로 쓴다.
 * - R2000은 트루컬러·색상표 색·투명도·MTEXT 배경이 없다. R2007 이전은 MTEXT 정의 높이, R2018 이전은 단 정보가 없다.
 * - R2007 이전 코드 페이지로 쓸 수 없는 글자는 \U+XXXX가 된다(코드 페이지를 바꿔 쓸 수 있으면 바꾼다).
 * - 읽기 정규화: 선종류 BYLAYER·BYBLOCK·CONTINUOUS 대소문자, SPLINE 플래그(평면·선형 판정), MTEXT 방향·회전,
 *   DXF에서 읽은 LEADER 걸이선 점.
 */
import type { CadColor, CadDocument, Entity } from '../../src/core/model';
import { decodeCadEscapes } from '../../src/core/codepage';
import { nearestAci } from '../../src/io/dwg/color';

const ACIS = new Set(['REGION', '3DSOLID', 'BODY', 'SURFACE', 'PLANESURFACE', 'EXTRUDEDSURFACE', 'LOFTEDSURFACE', 'REVOLVEDSURFACE', 'SWEPTSURFACE', 'NURBSURFACE']);

/** 버전이 다르면 빠지는 도형 */
export function droppable(e: Entity, sameVersion: boolean): boolean {
  if (sameVersion && e.dwgRaw) return false;
  return e.type === 'UNKNOWN' || ACIS.has(e.type) || e.type === 'OLE2FRAME' || e.type === 'OLEFRAME';
}

const SKIP = new Set(['dwgRaw', 'graphics', 'xdict', 'reactors', 'owner', 'raw', 'rawVersion', 'paperSpace', 'handle', 'hyperlink', 'xdata', 'imageDefReactor']);

const norm = (v: string) => decodeCadEscapes(v).replace(/[\x00-\x1f]/g, (c) => '^' + String.fromCharCode(c.charCodeAt(0) + 64));
const CI = new Set(['linetype', 'style', 'dimStyle', 'styleName', 'layer', 'block']);

function diff(e: unknown, a: unknown, path: string, skip: (k: string, sub: string) => boolean, out: string[]): void {
  if (out.length > 30) return;
  if (typeof e === 'number' && typeof a === 'number') {
    if (Math.abs(e - a) > 1e-9 * Math.max(1, Math.abs(e)) && !(Number.isNaN(e) && Number.isNaN(a))) out.push(`${path}: ${e} → ${a}`);
    return;
  }
  if (e instanceof Map) e = Object.fromEntries(e);
  if (a instanceof Map) a = Object.fromEntries(a);
  if (e instanceof Uint8Array || a instanceof Uint8Array) return;
  if (Array.isArray(e)) {
    if (!Array.isArray(a) || a.length !== e.length) {
      out.push(`${path}: 길이 ${e.length} → ${Array.isArray(a) ? a.length : typeof a}`);
      return;
    }
    e.forEach((x, i) => diff(x, a[i], `${path}[${i}]`, skip, out));
    return;
  }
  if (e && typeof e === 'object') {
    if (!a || typeof a !== 'object') {
      out.push(`${path}: 객체 → ${typeof a}`);
      return;
    }
    const eo = e as Record<string, unknown>;
    const ao = a as Record<string, unknown>;
    for (const k of new Set([...Object.keys(eo), ...Object.keys(ao)])) {
      const sub = `${path}.${k}`;
      if (skip(k, sub)) continue;
      if (eo[k] === undefined || ao[k] === undefined) {
        if (eo[k] === undefined && ao[k] === undefined) continue;
        // 기본값과 같은 빈 값은 같다고 본다
        const v = eo[k] ?? ao[k];
        if (v === false || v === 0 || v === '' || (Array.isArray(v) && !v.length)) continue;
        // 원본 버전에 없던 값(R2010+ 지시선 선 색 등)이 새로 생긴 것은 허용한다
        if (eo[k] === undefined && skip('+' + k, sub)) continue;
        out.push(`${sub}: ${JSON.stringify(eo[k])?.slice(0, 80)} → ${JSON.stringify(ao[k])?.slice(0, 80)}`);
        continue;
      }
      if (CI.has(k) && typeof eo[k] === 'string' && typeof ao[k] === 'string') {
        if (norm(eo[k] as string).toUpperCase() !== norm(ao[k] as string).toUpperCase()) out.push(`${sub}: ${JSON.stringify(eo[k])} → ${JSON.stringify(ao[k])}`);
        continue;
      }
      diff(eo[k], ao[k], sub, skip, out);
    }
    return;
  }
  if (typeof e === 'string' && typeof a === 'string' ? norm(e) !== norm(a) : e !== a) out.push(`${path}: ${JSON.stringify(e)?.slice(0, 80)} → ${JSON.stringify(a)?.slice(0, 80)}`);
}

export interface CompareOptions {
  /** 쓴 버전 번호(1015 …) */
  ver: number;
  /** 원본이 같은 버전의 DWG인지(원본 본문을 되쓴다) */
  sameVersion: boolean;
  /** 원본이 DXF인지 */
  fromDxf: boolean;
}

/** 색 비교 정규화(버전에 따라 남는 것만) */
function fixColor(c: CadColor | undefined, ver: number, _back: boolean): CadColor | undefined {
  if (!c) return c;
  // 색상표 색은 이름으로 비교한다(RGB는 DBCOLOR에서 오고 ACI는 근사값)
  if (c.name && ver >= 1018) return { aci: -1, name: c.name };
  if (c.rgb !== undefined) {
    // 트루컬러의 ACI는 근사값이다(표 레코드 CMC는 ACI 칸이 0): R2004+는 RGB만, R2000은 ACI만 남는다
    if (ver >= 1018) return { aci: -1, rgb: c.rgb };
    return { aci: c.aci >= 1 && c.aci <= 255 ? c.aci : nearestAci(c.rgb) };
  }
  return { aci: c.aci };
}

function colorPaths(o: unknown, ver: number, back = false): unknown {
  if (Array.isArray(o)) return o.map((x) => colorPaths(x, ver, back));
  if (o instanceof Map || o instanceof Uint8Array || !o || typeof o !== 'object') return o;
  const r: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && 'aci' in (v as object) && typeof (v as CadColor).aci === 'number') r[k] = fixColor(v as CadColor, ver, back);
    else if (k === 'heights' && Array.isArray(v)) r[k] = v.map((x) => Math.max(0, Number(x)));
    else r[k] = colorPaths(v, ver, back);
  }
  return r;
}

/** 도형 하나 비교 */
export function compareEntity(e: Entity, a: Entity, o: CompareOptions): string[] {
  const out: string[] = [];
  const ver = o.ver;
  const t = e.type;
  const skipType = new Set<string>();
  if (ver < 1018) {
    skipType.add('transparency');
    skipType.add('backgroundFlags');
    skipType.add('backgroundColor');
    skipType.add('backgroundScale');
    skipType.add('gradient');
  }
  if (ver < 1021) {
    skipType.add('rectHeight');
    skipType.add('lockPosition');
  }
  if (ver < 1024) skipType.add('clipInverted');
  if (ver < 1032) skipType.add('columns');
  if (t === 'SPLINE') {
    skipType.add('flags');
    skipType.add('normal');
  }
  if (t === 'MTEXT' || (t as string) === 'ATTRIB' || (t as string) === 'ATTDEF') {
    skipType.add('direction');
    skipType.add('rotation_mtext');
  }
  if (t === 'MTEXT') skipType.add('rotation');
  // 원본에 없던 기본값이 생기는 것(DXF에 없는 LEADER 방향·간격, R14·DXF 뷰포트 UCS)
  for (const k of ['horizontalDirection', 'blockOffset', 'annotationOffset', 'ucsOrigin', 'ucsXAxis', 'ucsYAxis', 'styleSheet', 'styleHandle']) skipType.add('+' + k);
  if (t === 'SHAPE' && o.fromDxf) {
    // DWG는 쉐이프 번호만 가진다(이름은 SHX 파일이 있어야 안다)
    skipType.add('name');
    skipType.add('styleHandle');
    skipType.add('shapeNumber');
  }
  if (t === 'VIEWPORT' && o.fromDxf) {
    // 읽기가 배치마다 쌓인 순서로 번호를 다시 매긴다
    skipType.add('id');
    skipType.add('status');
  }
  if (t === 'LEADER' && o.fromDxf) {
    skipType.add('vertices');
    skipType.add('hookline');
  }
  if (t === 'LEADER') {
    // R2010+는 글 상자 크기를 주석 MTEXT 범위로 쓴다(주석이 없으면 0)
    if (ver >= 1024) {
      skipType.add('textHeight');
      skipType.add('textWidth');
    }
  }
  if (t === 'MULTILEADER') skipType.add('+color');
  if (t === 'MULTILEADER' && !o.sameVersion) {
    skipType.add('props');
    if (ver < 1024) {
      skipType.add('attachmentDirection');
      skipType.add('color');
    }
  }
  if (t === 'HATCH' && ver < 1024) skipType.add('fitPoints');
  if (t === 'DIMENSION') skipType.add('overrides');
  if (t === 'HATCH' && o.fromDxf) skipType.add('pixelSize');
  if (o.fromDxf) {
    skipType.add('props');
    skipType.add('generation');
    skipType.add('mtext');
    skipType.add('imageDef');
  }
  // MTEXT·ATTDEF의 끼워 넣은 MTEXT는 R2018만
  if (ver < 1032) skipType.add('mtext');
  // 다른 버전으로 쓰면 원본 자료만 있는 재질 객체가 빠진다
  if (!o.sameVersion) skipType.add('material');
  const ce = colorPaths(e, ver);
  const ca = colorPaths(a, ver, true);
  diff(ce, ca, `${t}:${e.handle}`, (k, sub) => SKIP.has(k) || skipType.has(k) || (k === 'startTangent' && t === 'SPLINE') || (k === 'endTangent' && t === 'SPLINE') || sub.endsWith('.textHeight_none'), out);
  return out;
}

/** 문서 비교: 블록·도형·표 */
export function compareDocs(src: CadDocument, back: CadDocument, o: CompareOptions): string[] {
  const out: string[] = [];
  // 표: 이름이 모두 있어야 한다(쓰기가 더 만들 수는 있다)
  const names = (m: Map<string, { name: string }>) => new Set([...m.values()].map((x) => norm(x.name).toUpperCase()));
  for (const [what, a, b] of [
    ['도면층', src.layers, back.layers],
    ['선종류', src.linetypes, back.linetypes],
    ['문자 스타일', src.textStyles, back.textStyles],
    ['치수 스타일', src.dimStyles, back.dimStyles],
    ['블록', src.blocks, back.blocks],
  ] as [string, Map<string, { name: string }>, Map<string, { name: string }>][]) {
    const nb = names(b);
    for (const x of a.values()) {
      if (!x.name || nb.has(norm(x.name).toUpperCase())) continue;
      if (what === '블록') {
        const tn = src.blockRecords.get(x.name.toUpperCase())?.xdata?.find((d) => d.app.toUpperCase() === 'ACDBDYNAMICBLOCKTRUENAME')?.items.find((i) => i.code === 1000)?.value;
        if (typeof tn === 'string' && nb.has(tn.toUpperCase())) continue;
      }
      out.push(`${what} ${x.name} 없음`);
    }
  }
  // 도면층 속성
  for (const l of src.layers.values()) {
    const b = [...back.layers.values()].find((x) => norm(x.name).toUpperCase() === norm(l.name).toUpperCase());
    if (!b) continue;
    const d: string[] = [];
    diff(colorPaths({ ...l, xdata: undefined, handle: undefined, plotStyle: undefined, xdict: undefined, transparency: o.ver >= 1018 ? l.transparency : undefined, flags: l.flags & ~64 }, o.ver), colorPaths({ ...b, xdata: undefined, handle: undefined, plotStyle: undefined, xdict: undefined, transparency: o.ver >= 1018 ? b.transparency : undefined, flags: b.flags & ~64 }, o.ver, true), `LAYER:${l.name}`, (k) => k === 'description' && o.ver < 1018, d);
    out.push(...d);
  }
  // 배치
  const lb = new Map(back.layouts.map((l) => [norm(l.name).toUpperCase(), l]));
  for (const l of src.layouts) {
    const b = lb.get(norm(l.name).toUpperCase());
    if (!b) {
      out.push(`배치 ${l.name} 없음`);
      continue;
    }
    if (b.blockName.toUpperCase() !== l.blockName.toUpperCase()) out.push(`배치 ${l.name} 블록 ${l.blockName} → ${b.blockName}`);
  }
  // 도형(핸들로 맞춘다)
  for (const [key, blk] of src.blocks) {
    let bb = back.blocks.get(key);
    if (!bb) {
      // 읽기 정규화: AcDbDynamicBlockTrueName 확장 자료가 있는 *U 블록은 본래 이름으로 읽는다
      const tn = src.blockRecords.get(key)?.xdata?.find((x) => x.app.toUpperCase() === 'ACDBDYNAMICBLOCKTRUENAME')?.items.find((i) => i.code === 1000)?.value;
      if (typeof tn === 'string') bb = back.blocks.get(tn.toUpperCase());
    }
    if (!bb) continue;
    const backHandles = new Map(bb.entities.map((x) => [x.handle, x]));
    for (const e of blk.entities) {
      const a = backHandles.get(e.handle);
      if (!a) {
        if (droppable(e, o.sameVersion)) continue;
        out.push(`${key}: ${e.type}:${e.handle} 없음`);
        continue;
      }
      if (e.type === 'ACAD_TABLE' && a.type === 'INSERT' && !o.sameVersion) {
        if (a.block !== e.block) out.push(`ACAD_TABLE:${e.handle} 블록 ${e.block} → ${a.block}`);
        continue;
      }
      if (e.type !== a.type && !((e.type as string) === 'MPOLYGON' && a.type === 'HATCH')) {
        out.push(`${e.type}:${e.handle} 종류 → ${a.type}`);
        continue;
      }
      out.push(...compareEntity(e, a, o));
    }
    // 그리는 순서(남은 도형끼리)
    const order = blk.entities.map((x) => x.handle).filter((h) => backHandles.has(h));
    const border = bb.entities.map((x) => x.handle).filter((h) => order.includes(h));
    if (order.join() !== border.join()) out.push(`${key}: 도형 순서가 다름`);
  }
  return out;
}
