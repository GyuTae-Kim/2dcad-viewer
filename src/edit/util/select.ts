/**
 * 특성으로 고르기(UI 없음): QSELECT·FILTER의 특성 값과 비교, SELECTSIMILAR의 "같은 객체" 판정.
 */
import type { CadColor, CadDocument, Entity } from '../../core/model';
import { tableKey } from '../../core/model';
import { plainText, TYPE_NAMES } from '../../app/inquiry';
import { hasWildcard, wcmatch } from './wildcard';

export type PropKind = 'name' | 'text' | 'number' | 'color' | 'lineweight' | 'transparency';

export interface PropDef {
  key: string;
  label: string;
  kind: PropKind;
  /** 이 특성이 있는 객체 종류(없으면 모든 객체) */
  types?: readonly string[];
}

const TEXTS = ['TEXT', 'MTEXT', 'ATTRIB', 'ATTDEF'] as const;

export const PROPS: readonly PropDef[] = [
  { key: 'color', label: '색상', kind: 'color' },
  { key: 'layer', label: '도면층', kind: 'name' },
  { key: 'linetype', label: '선종류', kind: 'name' },
  { key: 'ltscale', label: '선종류 축척', kind: 'number' },
  { key: 'lineweight', label: '선가중치', kind: 'lineweight' },
  { key: 'transparency', label: '투명도', kind: 'transparency' },
  { key: 'thickness', label: '두께', kind: 'number' },
  { key: 'blockName', label: '블록 이름', kind: 'name', types: ['INSERT'] },
  { key: 'tag', label: '속성 태그', kind: 'name', types: ['ATTRIB', 'ATTDEF'] },
  { key: 'textStyle', label: '문자 스타일', kind: 'name', types: TEXTS },
  { key: 'textValue', label: '문자 값', kind: 'text', types: TEXTS },
  { key: 'textHeight', label: '문자 높이', kind: 'number', types: TEXTS },
  { key: 'rotation', label: '회전', kind: 'number', types: [...TEXTS, 'INSERT', 'SHAPE'] },
  { key: 'dimStyle', label: '치수 스타일', kind: 'name', types: ['DIMENSION', 'LEADER', 'TOLERANCE'] },
  { key: 'hatchPattern', label: '해치 패턴 이름', kind: 'name', types: ['HATCH', 'MPOLYGON'] },
  { key: 'radius', label: '반지름', kind: 'number', types: ['CIRCLE', 'ARC'] },
  { key: 'length', label: '길이', kind: 'number', types: ['LINE'] },
  { key: 'x', label: '위치 X', kind: 'number' },
  { key: 'y', label: '위치 Y', kind: 'number' },
];

export function propDef(key: string): PropDef | undefined {
  return PROPS.find((p) => p.key === key);
}

/** 객체 종류의 한국어 이름 */
export function typeLabel(type: string): string {
  return TYPE_NAMES[type] ?? type;
}

/** 대표 점(삽입점·중심·시작점) */
function anchor(e: Entity): { x: number; y: number } | null {
  switch (e.type) {
    case 'LINE':
      return e.start;
    case 'POINT':
      return e.position;
    case 'CIRCLE':
    case 'ARC':
    case 'ELLIPSE':
      return e.center;
    case 'LWPOLYLINE':
      return e.vertices[0] ?? null;
    case 'POLYLINE':
      return e.vertices[0]?.location ?? null;
    case 'TEXT':
    case 'ATTRIB':
    case 'ATTDEF':
    case 'MTEXT':
    case 'INSERT':
    case 'SHAPE':
    case 'TOLERANCE':
    case 'IMAGE':
    case 'WIPEOUT':
    case 'ACAD_TABLE':
      return e.insert;
    case 'VIEWPORT':
      return e.center;
    case 'SPLINE':
      return e.controlPoints[0] ?? e.fitPoints[0] ?? null;
    case 'XLINE':
    case 'RAY':
      return e.base;
    case 'DIMENSION':
      return e.textMid;
    case 'LEADER':
      return e.vertices[0] ?? null;
    default:
      return null;
  }
}

export type PropValue = string | number | CadColor;

/** 객체의 특성 값(없으면 null). 각도는 도, 선가중치는 1/100 mm, 투명도는 % 또는 'ByLayer'·'ByBlock' */
export function propValue(e: Entity, key: string): PropValue | null {
  const d = propDef(key);
  if (d?.types && !d.types.includes(e.type)) return null;
  switch (key) {
    case 'color':
      return e.color;
    case 'layer':
      return e.layer;
    case 'linetype':
      return e.linetype || 'ByLayer';
    case 'ltscale':
      return e.ltscale ?? 1;
    case 'lineweight':
      return e.lineweight;
    case 'transparency':
      if (e.transparency === -1) return 'ByLayer';
      if (e.transparency === -2) return 'ByBlock';
      return Math.round(((255 - e.transparency) * 100) / 255);
    case 'thickness':
      return e.thickness ?? 0;
    case 'blockName':
      return e.type === 'INSERT' ? e.block : null;
    case 'tag':
      return e.type === 'ATTRIB' || e.type === 'ATTDEF' ? ((e as { tag?: string }).tag ?? null) : null;
    case 'textStyle':
      return 'style' in e ? (e as { style: string }).style : null;
    case 'textValue':
      if (e.type === 'MTEXT') return plainText(e.text);
      if (e.type === 'TEXT' || e.type === 'ATTRIB' || e.type === 'ATTDEF') {
        const m = (e as { mtext?: { text: string } }).mtext;
        return m ? plainText(m.text) : e.text;
      }
      return null;
    case 'textHeight':
      return 'height' in e ? (e as { height: number }).height : null;
    case 'rotation': {
      let r: number | null = null;
      if (e.type === 'MTEXT') r = e.direction ? Math.atan2(e.direction.y, e.direction.x) : e.rotation;
      else if ('rotation' in e) r = (e as { rotation: number }).rotation;
      if (r === null) return null;
      let deg = (r * 180) / Math.PI;
      deg = ((deg % 360) + 360) % 360;
      return deg;
    }
    case 'dimStyle':
      return 'dimStyle' in e ? (e as { dimStyle: string }).dimStyle : null;
    case 'hatchPattern':
      return e.type === 'HATCH' || e.type === 'MPOLYGON' ? (e.solid ? 'SOLID' : e.patternName) : null;
    case 'radius':
      return e.type === 'CIRCLE' || e.type === 'ARC' ? e.radius : null;
    case 'length':
      return e.type === 'LINE' ? Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y, e.end.z - e.start.z) : null;
    case 'x':
      return anchor(e)?.x ?? null;
    case 'y':
      return anchor(e)?.y ?? null;
  }
  return null;
}

/** 비교 연산자. eq·ne는 이름이면 와일드카드도 받는다. wild = 와일드카드 일치, any = 아무 값(특성만 있으면), all = 모두 */
export type CompareOp = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'wild' | 'any' | 'all';

export const OP_LABELS: Record<CompareOp, string> = {
  eq: '= 같음',
  ne: '<> 같지 않음',
  lt: '< 보다 작음',
  le: '<= 작거나 같음',
  gt: '> 보다 큼',
  ge: '>= 크거나 같음',
  wild: '* 와일드카드 일치',
  any: '* 아무 값',
  all: '모두 선택',
};

const COLOR_NAMES: Record<string, number> = {
  red: 1,
  빨간색: 1,
  빨강: 1,
  yellow: 2,
  노란색: 2,
  노랑: 2,
  green: 3,
  초록색: 3,
  녹색: 3,
  cyan: 4,
  하늘색: 4,
  청록색: 4,
  blue: 5,
  파란색: 5,
  파랑: 5,
  magenta: 6,
  선홍색: 6,
  자홍색: 6,
  white: 7,
  흰색: 7,
  black: 7,
};

/** 색 입력(ByLayer·ByBlock·색 번호·이름·R,G,B) */
export function parseColor(s: string): CadColor | null {
  const t = s.trim().toLowerCase();
  if (t === 'bylayer' || t === '도면층별') return { aci: 256 };
  if (t === 'byblock' || t === '블록별') return { aci: 0 };
  if (COLOR_NAMES[t] !== undefined) return { aci: COLOR_NAMES[t]! };
  const m = /^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/.exec(t);
  if (m) {
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (r > 255 || g > 255 || b > 255) return null;
    return { aci: 7, rgb: (r << 16) | (g << 8) | b };
  }
  if (/^\d{1,3}$/.test(t)) {
    const n = Number(t);
    if (n >= 1 && n <= 255) return { aci: n };
  }
  return null;
}

export function colorText(c: CadColor): string {
  if (c.rgb !== undefined && c.aci !== 0 && c.aci !== 256) return `${(c.rgb >> 16) & 255},${(c.rgb >> 8) & 255},${c.rgb & 255}`;
  if (c.aci === 256) return 'ByLayer';
  if (c.aci === 0) return 'ByBlock';
  return String(c.aci);
}

/** 선가중치 입력(mm 또는 ByLayer·ByBlock·기본값) → 1/100 mm 또는 −1·−2·−3 */
export function parseLineweight(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (t === 'bylayer' || t === '도면층별') return -1;
  if (t === 'byblock' || t === '블록별') return -2;
  if (t === 'default' || t === '기본값') return -3;
  const v = Number(t.replace(/mm$/, ''));
  if (!Number.isFinite(v) || v < 0 || v > 2.11) return null;
  return Math.round(v * 100);
}

export function lineweightText(lw: number): string {
  if (lw === -1) return 'ByLayer';
  if (lw === -2) return 'ByBlock';
  if (lw === -3) return '기본값';
  return `${(lw / 100).toFixed(2)} mm`;
}

function cmpNum(a: number, b: number, op: CompareOp): boolean {
  const tol = 1e-6 * Math.max(1, Math.abs(b));
  switch (op) {
    case 'eq':
      return Math.abs(a - b) <= tol;
    case 'ne':
      return Math.abs(a - b) > tol;
    case 'lt':
      return a < b - tol;
    case 'le':
      return a <= b + tol;
    case 'gt':
      return a > b + tol;
    case 'ge':
      return a >= b - tol;
    default:
      return false;
  }
}

function sameColor(a: CadColor, b: CadColor): boolean {
  if (b.rgb !== undefined) return a.rgb === b.rgb && a.aci !== 0 && a.aci !== 256;
  if (b.aci === 0 || b.aci === 256) return a.aci === b.aci;
  return a.aci === b.aci && a.rgb === undefined;
}

/** 값 입력이 그 특성에 맞는지(틀리면 까닭) */
export function valueProblem(key: string, op: CompareOp, value: string): string | null {
  if (op === 'any' || op === 'all') return null;
  const d = propDef(key);
  if (!d) return key === 'type' ? null : '특성을 고르십시오.';
  switch (d.kind) {
    case 'number':
      return Number.isFinite(Number(value.trim())) && value.trim() !== '' ? null : '수를 입력하십시오.';
    case 'color':
      if (op !== 'eq' && op !== 'ne' && /^\d+$/.test(value.trim())) return null;
      return parseColor(value) ? null : '색은 ByLayer, ByBlock, 1–255, 색 이름 또는 R,G,B로 입력하십시오.';
    case 'lineweight':
      return parseLineweight(value) !== null ? null : '선가중치는 mm 값(0–2.11) 또는 ByLayer·ByBlock·기본값으로 입력하십시오.';
    case 'transparency': {
      const t = value.trim().toLowerCase();
      if (t === 'bylayer' || t === 'byblock' || t === '도면층별' || t === '블록별') return op === 'eq' || op === 'ne' ? null : '= 또는 <>로만 비교할 수 있습니다.';
      const n = Number(t);
      return Number.isFinite(n) && n >= 0 && n <= 90 ? null : '투명도는 0–90 또는 ByLayer·ByBlock으로 입력하십시오.';
    }
    default:
      return null;
  }
}

/** 객체 하나가 조건을 만족하는지. 특성이 없는 객체는 거짓 */
export function testProp(e: Entity, key: string, op: CompareOp, value: string): boolean {
  if (op === 'all') return true;
  if (key === 'type') {
    const ok = e.type.toUpperCase() === value.trim().toUpperCase() || typeLabel(e.type) === value.trim();
    return op === 'ne' ? !ok : op === 'any' ? true : ok;
  }
  const d = propDef(key);
  const v = propValue(e, key);
  if (!d || v === null) return false;
  if (op === 'any') return true;
  switch (d.kind) {
    case 'name':
    case 'text': {
      const s = String(v);
      if (op === 'wild' || ((op === 'eq' || op === 'ne') && d.kind === 'name' && hasWildcard(value))) {
        const m = wcmatch(s, value, true);
        return op === 'ne' ? !m : m;
      }
      const a = d.kind === 'name' ? tableKey(s) : s;
      const b = d.kind === 'name' ? tableKey(value.trim()) : value;
      if (op === 'eq') return a === b;
      if (op === 'ne') return a !== b;
      const c = a.localeCompare(b, 'ko');
      return op === 'lt' ? c < 0 : op === 'le' ? c <= 0 : op === 'gt' ? c > 0 : op === 'ge' ? c >= 0 : false;
    }
    case 'number': {
      if (op === 'wild') return wcmatch(String(+(v as number).toFixed(6)), value);
      return cmpNum(v as number, Number(value), op);
    }
    case 'color': {
      const c = v as CadColor;
      if (op === 'eq' || op === 'ne') {
        const want = parseColor(value);
        if (!want) return false;
        const m = sameColor(c, want);
        return op === 'eq' ? m : !m;
      }
      if (op === 'wild') return wcmatch(colorText(c), value);
      if (c.rgb !== undefined || c.aci === 0 || c.aci === 256) return false;
      return cmpNum(c.aci, Number(parseColor(value)?.aci ?? value), op);
    }
    case 'lineweight': {
      const want = parseLineweight(value);
      if (want === null) return false;
      const lw = v as number;
      if (op === 'eq') return lw === want;
      if (op === 'ne') return lw !== want;
      if (op === 'wild') return wcmatch(lineweightText(lw), value);
      if (lw < 0 || want < 0) return false;
      return cmpNum(lw, want, op);
    }
    case 'transparency': {
      const t = value.trim().toLowerCase();
      const special = t === 'bylayer' || t === '도면층별' ? 'ByLayer' : t === 'byblock' || t === '블록별' ? 'ByBlock' : null;
      if (special) return op === 'eq' ? v === special : op === 'ne' ? v !== special : false;
      if (typeof v !== 'number') return op === 'ne';
      return cmpNum(v, Number(t), op);
    }
  }
}

export interface QuickSelectCriteria {
  /** 객체 종류(DXF 이름). 빈 배열이면 모든 종류(다중) */
  types: string[];
  /** 특성 키(PROPS) — 'all' 연산자면 무시 */
  prop: string;
  op: CompareOp;
  value: string;
  /** 참: 조건에 맞는 것, 거짓: 맞지 않는 것(새 선택 세트에서 제외) */
  include: boolean;
}

/** QSELECT: 범위(핸들) 안에서 조건으로 고른다 */
export function quickSelect(doc: CadDocument, scope: readonly string[], c: QuickSelectCriteria): string[] {
  const types = new Set(c.types.map((t) => t.toUpperCase()));
  const hit = (e: Entity) => (!types.size || types.has(e.type)) && testProp(e, c.prop, c.op, c.value);
  const out: string[] = [];
  for (const h of scope) {
    const e = doc.entityIndex.get(h);
    if (!e) continue;
    if (hit(e) === c.include) out.push(h);
  }
  return out;
}

export interface FilterRow {
  /** 'type'(객체 유형) 또는 PROPS 키 */
  prop: string;
  op: CompareOp;
  value: string;
}

/** FILTER: 모든 행을 통과해야 한다(묵시적 AND) */
export function passesFilter(e: Entity, rows: readonly FilterRow[]): boolean {
  return rows.every((r) => testProp(e, r.prop, r.op, r.value));
}

/** 행을 한 줄 글로(필터 목록 표시) */
export function filterRowText(r: FilterRow): string {
  const op = { eq: '=', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=', wild: '=', any: '*', all: '*' }[r.op];
  if (r.prop === 'type') return `객체 ${op} ${typeLabel(r.value.toUpperCase())}`;
  const d = propDef(r.prop);
  return `${d?.label ?? r.prop} ${op} ${r.op === 'any' ? '' : r.value}`.trim();
}

// ---------------------------------------------------------------------------
// SELECTSIMILAR
// ---------------------------------------------------------------------------

/** SELECTSIMILARMODE 비트 */
export const SIMILAR_BITS: readonly { bit: number; label: string }[] = [
  { bit: 1, label: '색상' },
  { bit: 2, label: '도면층' },
  { bit: 4, label: '선종류' },
  { bit: 8, label: '선종류 축척' },
  { bit: 16, label: '선가중치' },
  { bit: 32, label: '플롯 스타일' },
  { bit: 64, label: '객체 스타일' },
  { bit: 128, label: '이름' },
];

export const SELECTSIMILARMODE_DEFAULT = 130;

/** 객체 스타일(문자·치수·여러 줄·다중 지시선·표 스타일) */
function styleOf(e: Entity): string {
  switch (e.type) {
    case 'TEXT':
    case 'MTEXT':
    case 'ATTRIB':
    case 'ATTDEF':
      return tableKey(e.style);
    case 'DIMENSION':
    case 'LEADER':
    case 'TOLERANCE':
      return tableKey(e.dimStyle);
    case 'MLINE':
      return tableKey(e.styleName);
    case 'MULTILEADER':
      return e.styleHandle ?? '';
    case 'ACAD_TABLE':
      return e.tableStyle ?? '';
    default:
      return '';
  }
}

/** 이름(블록·외부 참조·이미지·해치 패턴·쉐이프) */
function nameOf(e: Entity): string {
  switch (e.type) {
    case 'INSERT':
      return tableKey(e.block);
    case 'IMAGE':
      return e.imageDef ?? '';
    case 'HATCH':
    case 'MPOLYGON':
      return e.solid ? 'SOLID' : tableKey(e.patternName);
    case 'SHAPE':
      return tableKey(e.name);
    case 'PDFUNDERLAY':
    case 'DWFUNDERLAY':
    case 'DGNUNDERLAY':
      return e.definition ?? '';
    default:
      return '';
  }
}

/** 같은 열쇠면 "비슷한" 객체다(종류는 늘 같아야 한다) */
export function similarKey(e: Entity, mode: number): string {
  const parts: string[] = [e.type === 'POLYLINE' ? `POLYLINE:${e.kind}` : e.type];
  if (mode & 1) parts.push(`c${e.color.aci}:${e.color.rgb ?? ''}`);
  if (mode & 2) parts.push(`l${tableKey(e.layer)}`);
  if (mode & 4) parts.push(`t${tableKey(e.linetype || 'BYLAYER')}`);
  if (mode & 8) parts.push(`s${+(e.ltscale ?? 1).toFixed(9)}`);
  if (mode & 16) parts.push(`w${e.lineweight}`);
  if (mode & 32) parts.push(`p${e.plotStyle ?? ''}`);
  if (mode & 64) parts.push(`y${styleOf(e)}`);
  if (mode & 128) parts.push(`n${nameOf(e)}`);
  return parts.join('|');
}

/** 기준 객체들과 비슷한 객체(후보 중) */
export function selectSimilar(doc: CadDocument, refs: readonly string[], candidates: readonly string[], mode: number): string[] {
  const keys = new Set<string>();
  for (const h of refs) {
    const e = doc.entityIndex.get(h);
    if (e) keys.add(similarKey(e, mode));
  }
  if (!keys.size) return [];
  return candidates.filter((h) => {
    const e = doc.entityIndex.get(h);
    return !!e && keys.has(similarKey(e, mode));
  });
}
