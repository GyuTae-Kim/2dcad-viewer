/**
 * 이 앱의 연관 배열 기록: 배열 참조(INSERT)의 확장 자료 OPENCAD_ARRAY.
 *   1070 기록 판(1)
 *   1000 종류("RECT" | "POLAR" | "PATH")
 *   1005 원본 블록 레코드 핸들
 *   1005 경로 곡선 핸들(경로 배열이고 연관이 살아 있을 때만)
 *   1000 … 매개변수·지운 항목·대체 항목(ASCII JSON, 250자씩 나눔)
 * AutoCAD는 이 기록을 모른다 — AutoCAD에서는 익명 블록 참조(항목은 그대로 보인다)로 보인다.
 * AutoCAD가 만든 연관 배열은 AutoCAD 기록(acad.ts)을 고쳐 쓰고, 이 기록도 함께 남긴다(DWG로 저장하면 AutoCAD 기록이 빠질 수 있다).
 */
import type { CadDocument, XData, XDataItem } from '../../core/model';
import { normalizeHandle, tableKey } from '../../core/model';
import type { ArrayKind, ArrayParams, ArrayState, CachedPiece } from './types';

export const ARRAY_APP = 'OPENCAD_ARRAY';
const VERSION = 1;
const KINDS: Record<ArrayKind, string> = { rect: 'RECT', polar: 'POLAR', path: 'PATH' };

const asciiJson = (v: unknown): string => JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

/** 블록 이름 → 블록 레코드 핸들 */
function recordHandle(doc: CadDocument, name: string): string {
  return doc.blockRecords.get(tableKey(name))?.handle ?? doc.blocks.get(tableKey(name))?.recordHandle ?? '';
}

/** 블록 레코드 핸들 → 블록 이름 */
export function blockNameOfRecord(doc: CadDocument, handle: string): string | null {
  const h = normalizeHandle(handle);
  for (const r of doc.blockRecords.values()) if (normalizeHandle(r.handle) === h) return r.name;
  for (const b of doc.blocks.values()) if (b.recordHandle && normalizeHandle(b.recordHandle) === h) return b.name;
  return null;
}

/** 상태 → 확장 자료(블록은 레코드 핸들로) */
export function encodeRecord(doc: CadDocument, s: ArrayState): XData {
  const p = s.params;
  const { kind: _k, ...rest } = p as ArrayParams & { path?: string | null };
  void _k;
  const body: Record<string, unknown> = { ...rest };
  delete body.path;
  body.removed = [...s.removed];
  const rep: Record<string, string> = {};
  for (const [k, b] of s.replaced) rep[k] = recordHandle(doc, b) || b;
  body.replaced = rep;
  const json = asciiJson(body);
  const items: XDataItem[] = [
    { code: 1070, value: VERSION },
    { code: 1000, value: KINDS[p.kind] },
    { code: 1005, value: recordHandle(doc, s.source) || '0' },
  ];
  if (p.kind === 'path' && p.path) items.push({ code: 1005, value: p.path });
  for (let i = 0; i < json.length; i += 250) items.push({ code: 1000, value: json.slice(i, i + 250) });
  return { app: ARRAY_APP, items };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPt = (v: unknown): v is { x: number; y: number } => !!v && typeof v === 'object' && isNum((v as { x: unknown }).x) && isNum((v as { y: unknown }).y);

function validPiece(c: unknown): c is CachedPiece {
  if (!c || typeof c !== 'object') return false;
  const o = c as Record<string, unknown>;
  if (o.k === 'line') return isPt(o.a) && isPt(o.b);
  if (o.k === 'arc') return isPt(o.c) && isNum(o.r) && isNum(o.a0) && isNum(o.sw);
  if (o.k === 'nurbs') {
    const knots = o.knots;
    const ctrl = o.ctrl;
    if (!isNum(o.degree) || !Array.isArray(knots) || !Array.isArray(ctrl) || !knots.every(isNum) || !ctrl.every(isPt)) return false;
    if (knots.length !== ctrl.length + (o.degree as number) + 1) return false;
    return o.weights === undefined || (Array.isArray(o.weights) && o.weights.length === ctrl.length && o.weights.every(isNum));
  }
  return false;
}

/** 확장 자료 → 상태(블록이 없거나 값이 깨졌으면 null) */
export function decodeRecord(doc: CadDocument, xd: XData | undefined): ArrayState | null {
  if (!xd || xd.app.toUpperCase() !== ARRAY_APP) return null;
  const it = xd.items;
  if (it[0]?.code !== 1070 || Number(it[0].value) !== VERSION) return null;
  const kindTxt = String(it[1]?.value ?? '');
  const kind = (Object.keys(KINDS) as ArrayKind[]).find((k) => KINDS[k] === kindTxt);
  if (!kind) return null;
  const handles: string[] = [];
  let i = 2;
  while (i < it.length && it[i]!.code === 1005) handles.push(String(it[i++]!.value));
  let json = '';
  for (; i < it.length; i++) if (it[i]!.code === 1000) json += String(it[i]!.value);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  const source = handles[0] ? blockNameOfRecord(doc, handles[0]) : null;
  if (!source) return null;
  const num = (k: string, d: number): number => (isNum(body[k]) ? (body[k] as number) : d);
  const common = {
    base: isPt(body.base) ? { x: body.base.x, y: body.base.y } : { x: 0, y: 0 },
    rows: Math.max(1, Math.round(num('rows', 1))),
    rowSpacing: num('rowSpacing', 1),
    rowElevation: num('rowElevation', 0),
    levels: Math.max(1, Math.round(num('levels', 1))),
    levelSpacing: num('levelSpacing', 1),
  };
  let params: ArrayParams;
  if (kind === 'rect') {
    params = {
      kind,
      ...common,
      origin: isPt(body.origin) ? { x: body.origin.x, y: body.origin.y } : { x: 0, y: 0 },
      columns: Math.max(1, Math.round(num('columns', 1))),
      columnSpacing: num('columnSpacing', 1),
      axesAngle: num('axesAngle', Math.PI / 2),
    };
  } else if (kind === 'polar') {
    params = {
      kind,
      ...common,
      center: isPt(body.center) ? { x: body.center.x, y: body.center.y } : { x: 0, y: 0 },
      items: Math.max(1, Math.round(num('items', 1))),
      itemAngle: num('itemAngle', 0),
      fillAngle: num('fillAngle', Math.PI * 2),
      startAngle: num('startAngle', 0),
      radius: num('radius', 0),
      rotateItems: body.rotateItems !== false,
    };
  } else {
    const fb = Array.isArray(body.fallback) ? (body.fallback as unknown[]).filter(validPiece) : [];
    params = {
      kind,
      ...common,
      method: body.method === 'divide' ? 'divide' : 'measure',
      items: Math.max(1, Math.round(num('items', 1))),
      spacing: num('spacing', 1),
      align: body.align !== false,
      zDir: body.zDir !== false,
      reverse: body.reverse === true,
      ...(isNum(body.tangentRef) ? { tangentRef: body.tangentRef as number } : {}),
      path: handles[1] ? normalizeHandle(handles[1]) : null,
      ...(fb.length ? { fallback: fb } : {}),
    };
  }
  const removed = new Set<string>(Array.isArray(body.removed) ? (body.removed as unknown[]).filter((x): x is string => typeof x === 'string') : []);
  const replaced = new Map<string, string>();
  if (body.replaced && typeof body.replaced === 'object')
    for (const [k, v] of Object.entries(body.replaced as Record<string, unknown>)) {
      if (typeof v !== 'string') continue;
      const name = blockNameOfRecord(doc, v) ?? (doc.blocks.has(tableKey(v)) ? doc.blocks.get(tableKey(v))!.name : null);
      if (name) replaced.set(k, name);
    }
  return { params, source, removed, replaced };
}

/** 객체의 확장 자료에서 이 앱의 배열 기록 */
export function recordOf(xdata: readonly XData[] | undefined): XData | undefined {
  return xdata?.find((x) => x.app.toUpperCase() === ARRAY_APP);
}

/** 확장 자료 목록에서 배열 기록을 바꾼다(null = 지운다) */
export function withRecord(xdata: readonly XData[] | undefined, rec: XData | null): XData[] | undefined {
  const rest = (xdata ?? []).filter((x) => x.app.toUpperCase() !== ARRAY_APP);
  if (rec) rest.push(rec);
  return rest.length ? rest : undefined;
}
