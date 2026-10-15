/**
 * SSX·GETSEL(Express Tools 선택 도구) 계산(UI 없음).
 *
 * SSX: 기준 객체의 특성으로 필터를 만들고(객체 유형·도면층·색상·선종류·두께·문자 스타일·블록 이름·돌출 방향),
 * 항목을 더하거나 빼거나 바꾼 뒤 모든 객체 중 필터를 모두 통과하는 것을 고른다.
 * 이름(도면층·선종류·스타일·블록·유형)은 와일드카드(* ? # @ . ~ [ ] ,)를 받는다(대소문자 무시).
 * GETSEL: 도면층과 객체 유형(각각 * = 모두)으로 고른다.
 */
import type { CadColor, CadDocument, Entity, Vec3 } from '../../core/model';
import { tableKey } from '../../core/model';
import { colorText, parseColor, typeLabel } from '../util/select';
import { hasWildcard, wcmatch } from '../util/wildcard';

export type SsxKey = 'type' | 'layer' | 'color' | 'linetype' | 'thickness' | 'style' | 'block' | 'vector';

export interface SsxFilter {
  /** 객체 유형(DXF 이름, 와일드카드 가능) */
  type?: string;
  layer?: string;
  color?: CadColor;
  linetype?: string;
  thickness?: number;
  /** 문자 스타일(문자·여러 줄 문자·속성·원호 정렬 문자) */
  style?: string;
  /** 블록 이름(블록 참조) */
  block?: string;
  /** 돌출 방향(210) */
  vector?: Vec3;
}

export const SSX_LABEL: Record<SsxKey, string> = {
  type: '객체',
  layer: '도면층',
  color: '색상',
  linetype: '선종류',
  thickness: '두께',
  style: '스타일',
  block: '블록 이름',
  vector: '벡터',
};

/** 객체 유형 이름(POLYLINE은 2D·3D 구별 없이 같은 이름) */
export function ssxTypeName(e: Entity): string {
  return e.type === 'UNKNOWN' ? e.originalType : e.type;
}

function textStyleOf(e: Entity): string | undefined {
  switch (e.type) {
    case 'TEXT':
    case 'MTEXT':
    case 'ATTDEF':
    case 'ATTRIB':
    case 'ARCALIGNEDTEXT':
      return e.style;
    default:
      return undefined;
  }
}

const Z: Vec3 = { x: 0, y: 0, z: 1 };

/** 기준 객체의 필터(AutoCAD SSX처럼 객체에 있는 값만) */
export function ssxFilterOf(e: Entity): SsxFilter {
  const f: SsxFilter = { type: ssxTypeName(e), layer: e.layer };
  // 색·선종류는 ByLayer가 아닐 때만(객체에 적힌 값만 필터가 된다)
  if (e.color.aci !== 256) f.color = { ...e.color };
  if (e.linetype && tableKey(e.linetype) !== 'BYLAYER') f.linetype = e.linetype;
  if (e.thickness) f.thickness = e.thickness;
  const st = textStyleOf(e);
  if (st !== undefined) f.style = st;
  if (e.type === 'INSERT') f.block = e.block;
  if (e.extrusion && (Math.abs(e.extrusion.x) > 1e-12 || Math.abs(e.extrusion.y) > 1e-12 || e.extrusion.z < 0)) f.vector = { ...e.extrusion };
  return f;
}

const nameMatch = (value: string | undefined, pattern: string): boolean => {
  const v = value ?? '';
  if (hasWildcard(pattern)) return wcmatch(v, pattern);
  return tableKey(v) === tableKey(pattern);
};

function sameColor(a: CadColor, b: CadColor): boolean {
  if (a.rgb !== undefined || b.rgb !== undefined) return a.rgb === b.rgb && (a.rgb !== undefined || a.aci === b.aci);
  return a.aci === b.aci;
}

/** 필터를 모두 통과하는지 */
export function ssxMatch(e: Entity, f: SsxFilter): boolean {
  if (f.type !== undefined && !nameMatch(ssxTypeName(e), f.type)) return false;
  if (f.layer !== undefined && !nameMatch(e.layer, f.layer)) return false;
  if (f.color && !sameColor(e.color, f.color)) return false;
  if (f.linetype !== undefined && !nameMatch(e.linetype || 'ByLayer', f.linetype)) return false;
  if (f.thickness !== undefined && Math.abs((e.thickness ?? 0) - f.thickness) > 1e-9 * Math.max(1, Math.abs(f.thickness))) return false;
  if (f.style !== undefined) {
    const st = textStyleOf(e);
    if (st === undefined || !nameMatch(st, f.style)) return false;
  }
  if (f.block !== undefined && (e.type !== 'INSERT' || !nameMatch(e.block, f.block))) return false;
  if (f.vector) {
    const v = e.extrusion ?? Z;
    if (Math.abs(v.x - f.vector.x) > 1e-9 || Math.abs(v.y - f.vector.y) > 1e-9 || Math.abs(v.z - f.vector.z) > 1e-9) return false;
  }
  return true;
}

/** 필터를 고르는 객체 목록에 적용 */
export function ssxSelect(list: readonly Entity[], f: SsxFilter): string[] {
  return list.filter((e) => ssxMatch(e, f)).map((e) => e.handle);
}

/** 필터 내용 줄(명령행 표시) */
export function ssxFilterLines(f: SsxFilter): string[] {
  const out: string[] = [];
  if (f.type !== undefined) out.push(`${SSX_LABEL.type} = ${f.type}${hasWildcard(f.type) ? '' : ` (${typeLabel(f.type)})`}`);
  if (f.layer !== undefined) out.push(`${SSX_LABEL.layer} = ${f.layer}`);
  if (f.color) out.push(`${SSX_LABEL.color} = ${colorText(f.color)}`);
  if (f.linetype !== undefined) out.push(`${SSX_LABEL.linetype} = ${f.linetype}`);
  if (f.thickness !== undefined) out.push(`${SSX_LABEL.thickness} = ${f.thickness}`);
  if (f.style !== undefined) out.push(`${SSX_LABEL.style} = ${f.style}`);
  if (f.block !== undefined) out.push(`${SSX_LABEL.block} = ${f.block}`);
  if (f.vector) out.push(`${SSX_LABEL.vector} = ${f.vector.x},${f.vector.y},${f.vector.z}`);
  return out;
}

/** 필터 항목 값을 입력 문자열로 바꾼다. 빈 문자열이면 그 항목을 뺀다. 틀린 값이면 안내 문구 */
export function ssxSetValue(f: SsxFilter, key: SsxKey, text: string): SsxFilter | string {
  const t = text.trim();
  const next: SsxFilter = { ...f };
  if (!t) {
    delete next[key];
    return next;
  }
  switch (key) {
    case 'type':
      next.type = t.toUpperCase();
      return next;
    case 'layer':
    case 'linetype':
    case 'style':
    case 'block':
      next[key] = t;
      return next;
    case 'color': {
      const c = parseColor(t.replace(/^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})$/, '$1,$2,$3'));
      if (!c) return '색상 번호(1~255), 색상 이름(빨간색·red …), ByLayer, ByBlock 또는 트루컬러 R G B(예: 255 128 0)를 입력하십시오.';
      next.color = c;
      return next;
    }
    case 'thickness': {
      const v = Number(t);
      if (!Number.isFinite(v)) return '숫자를 입력하십시오.';
      next.thickness = v;
      return next;
    }
    case 'vector': {
      const parts = t.split(/[\s,]+/).filter(Boolean).map(Number);
      if (parts.length !== 3 || parts.some((x) => !Number.isFinite(x))) return '돌출 방향을 x y z로 입력하십시오(예: 0 0 1).';
      const v = { x: parts[0]!, y: parts[1]!, z: parts[2]! };
      const l = Math.hypot(v.x, v.y, v.z);
      if (!(l > 0)) return '길이가 0인 방향은 쓸 수 없습니다.';
      next.vector = { x: v.x / l, y: v.y / l, z: v.z / l };
      return next;
    }
  }
}

/** 필터 항목의 지금 값(프롬프트 기본값) */
export function ssxValueText(f: SsxFilter, key: SsxKey): string {
  switch (key) {
    case 'color':
      return f.color ? colorText(f.color) : '';
    case 'thickness':
      return f.thickness !== undefined ? String(f.thickness) : '';
    case 'vector':
      return f.vector ? `${f.vector.x} ${f.vector.y} ${f.vector.z}` : '';
    default:
      return f[key] ?? '';
  }
}

/** GETSEL: 도면층(이름·와일드카드, '*' = 모두)과 객체 유형('*' = 모두)으로 고른다 */
export function getselSelect(list: readonly Entity[], layer: string, type: string): string[] {
  const allLayers = !layer || layer === '*';
  const allTypes = !type || type === '*';
  return list
    .filter((e) => (allLayers || nameMatch(e.layer, layer)) && (allTypes || nameMatch(ssxTypeName(e), type)))
    .map((e) => e.handle);
}

/** 문서의 공간 하나에서 고를 수 있는 객체(보이는 도면층·잠기지 않은 것은 호출한 쪽이 거른다) */
export function spaceEntities(doc: CadDocument, space: string): Entity[] {
  return doc.blocks.get(space)?.entities ?? [];
}
