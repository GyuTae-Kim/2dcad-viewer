/**
 * 특성 팔레트에서 고칠 수 있는 항목.
 * 항목마다 값을 읽고(get) 복사본에 쓰는(set) 함수를 가진다. 여러 객체에 한 번에 적용한다.
 */
import type { AttribEntity, CadColor, CadDocument, DimensionEntity, Entity, InsertEntity, LwPolylineEntity, MLeaderEntity, MLeaderStyleObject, ToleranceEntity, Vec3 } from '../core/model';
import { tableKey } from '../core/model';
import { formatAngle, formatLength, parseAngle, parseLength, type UnitSettings } from '../core/units';
import type { EditOp } from '../edit/session';
import { cloneEntity } from '../edit/session';
import type { App } from './app';
import { colorText, lineweightText } from './inquiry';
import { followOps } from './dimassoc';
import { afterEditSolve } from './constraints-hook';
import { lwCount, lwVertices, tidyWidths, zeros } from '../core/lwpoly';
import { rawDimVars } from '../edit/dim';
import { DIM_VAR_BY_NAME, applyOverrides } from '../edit/annot/override';
import { dimensionBlockOps } from './dimcmds';

export type FieldKind = 'length' | 'angle' | 'number' | 'text' | 'multiline' | 'select' | 'color' | 'bool';

export interface Field {
  label: string;
  kind: FieldKind;
  /** select 항목 */
  options?: (doc: CadDocument) => { value: string; label: string }[];
  /** 값 읽기(doc이 있으면 스타일 값까지: 치수 재지정 항목) */
  get(e: Entity, doc?: CadDocument): unknown;
  set(e: Entity, v: unknown, doc?: CadDocument): void;
  /** 0보다 커야 하는 값 */
  positive?: boolean;
  /** 바꾸면 치수 블록을 치수 생성기로 다시 만든다 */
  regen?: boolean;
  /** 읽기 전용(측정값 등) */
  readonly?: boolean;
}

export const LINEWEIGHTS = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];

type Any = Record<string, unknown>;
const num = (v: unknown) => v as number;

// ---------------------------------------------------------------------------
// 공통(일반)
// ---------------------------------------------------------------------------

export const GENERAL_FIELDS: Field[] = [
  {
    label: '도면층',
    kind: 'select',
    options: (doc) => [...doc.layers.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko')).map((l) => ({ value: l.name, label: l.name })),
    get: (e) => e.layer,
    set: (e, v) => {
      e.layer = String(v);
    },
  },
  {
    label: '색상',
    kind: 'color',
    get: (e) => e.color,
    set: (e, v) => {
      e.color = { ...(v as CadColor) };
    },
  },
  {
    label: '선종류',
    kind: 'select',
    options: (doc) => [
      { value: 'ByLayer', label: 'ByLayer' },
      { value: 'ByBlock', label: 'ByBlock' },
      ...[...doc.linetypes.values()].filter((l) => !/^by(layer|block)$/i.test(l.name)).map((l) => ({ value: l.name, label: l.name })),
    ],
    get: (e) => e.linetype,
    set: (e, v) => {
      e.linetype = String(v);
    },
  },
  {
    label: '선종류 축척',
    kind: 'number',
    positive: true,
    get: (e) => e.ltscale,
    set: (e, v) => {
      e.ltscale = num(v);
    },
  },
  {
    label: '선가중치',
    kind: 'select',
    options: () => [
      { value: '-1', label: 'ByLayer' },
      { value: '-2', label: 'ByBlock' },
      { value: '-3', label: '기본값' },
      ...LINEWEIGHTS.map((w) => ({ value: String(w), label: lineweightText(w) })),
    ],
    get: (e) => String(e.lineweight),
    set: (e, v) => {
      e.lineweight = Number(v);
    },
  },
  {
    label: '투명도',
    kind: 'select',
    options: () => [
      { value: '-1', label: 'ByLayer' },
      { value: '-2', label: 'ByBlock' },
      ...[0, 10, 20, 30, 40, 50, 60, 70, 80, 90].map((p) => ({ value: String(Math.round(255 * (1 - p / 100))), label: String(p) })),
    ],
    get: (e) => String(e.transparency),
    set: (e, v) => {
      e.transparency = Number(v);
    },
  },
];

// ---------------------------------------------------------------------------
// 형상
// ---------------------------------------------------------------------------

function coord(label: string, path: string, axis: 'x' | 'y' | 'z'): Field {
  return {
    label,
    kind: 'length',
    get: (e) => ((e as unknown as Any)[path] as Vec3 | undefined)?.[axis],
    set: (e, v) => {
      const p = (e as unknown as Any)[path] as Vec3;
      p[axis] = num(v);
    },
  };
}

function scalar(label: string, key: string, kind: FieldKind = 'length', positive = false): Field {
  return {
    label,
    kind,
    positive,
    get: (e) => (e as unknown as Any)[key],
    set: (e, v) => {
      (e as unknown as Any)[key] = v;
    },
  };
}

/** 문자 위치: 정렬점이 있으면 그 점(AutoCAD와 같다). 바꾸면 두 점을 함께 옮긴다 */
function textPos(axis: 'x' | 'y'): Field {
  return {
    label: `위치 ${axis.toUpperCase()}`,
    kind: 'length',
    get: (e) => {
      const t = e as Entity & { insert: Vec3; alignPoint?: Vec3 };
      return (t.alignPoint ?? t.insert)[axis];
    },
    set: (e, v) => {
      const t = e as Entity & { insert: Vec3; alignPoint?: Vec3 };
      const d = num(v) - (t.alignPoint ?? t.insert)[axis];
      t.insert[axis] += d;
      if (t.alignPoint) t.alignPoint[axis] += d;
    },
  };
}

const textStyleOptions = (doc: CadDocument) =>
  [...doc.textStyles.values()].filter((s) => s.name && !(s.flags & 1)).map((s) => ({ value: s.name, label: s.name }));

/** 블록 참조를 새 위치·축척·회전으로 옮기면서 속성 문자도 같이 옮긴다 */
export function retransformInsert(e: InsertEntity, ins: Vec3, scale: Vec3, rotation: number): void {
  const o = e.insert;
  const s0 = e.scale;
  const r0 = e.rotation;
  const c0 = Math.cos(-r0);
  const n0 = Math.sin(-r0);
  const c1 = Math.cos(rotation);
  const n1 = Math.sin(rotation);
  const map = (p: Vec3): Vec3 => {
    const dx = p.x - o.x;
    const dy = p.y - o.y;
    const lx = (dx * c0 - dy * n0) / (s0.x || 1);
    const ly = (dx * n0 + dy * c0) / (s0.y || 1);
    const sx = lx * scale.x;
    const sy = ly * scale.y;
    return { x: ins.x + sx * c1 - sy * n1, y: ins.y + sx * n1 + sy * c1, z: p.z + (ins.z - o.z) };
  };
  const hs = Math.abs(scale.y / (s0.y || 1));
  for (const a of e.attribs) {
    a.insert = map(a.insert);
    if (a.alignPoint) a.alignPoint = map(a.alignPoint);
    a.height *= hs;
    a.rotation += rotation - r0;
    if (a.mtext) {
      a.mtext.insert = map(a.mtext.insert);
      a.mtext.height *= hs;
      a.mtext.rotation += rotation - r0;
      a.mtext.direction = undefined;
    }
  }
  e.insert = { ...ins };
  e.scale = { ...scale };
  e.rotation = rotation;
}

function insertField(label: string, kind: FieldKind, get: (e: InsertEntity) => number, put: (e: InsertEntity, v: number) => { ins: Vec3; scale: Vec3; rot: number }): Field {
  return {
    label,
    kind,
    get: (e) => get(e as InsertEntity),
    set: (e, v) => {
      const b = e as InsertEntity;
      const n = put(b, num(v));
      retransformInsert(b, n.ins, n.scale, n.rot);
    },
  };
}

export function geometryFields(type: string): Field[] {
  switch (type) {
    case 'LINE':
      return [coord('시작 X', 'start', 'x'), coord('시작 Y', 'start', 'y'), coord('시작 Z', 'start', 'z'), coord('끝 X', 'end', 'x'), coord('끝 Y', 'end', 'y'), coord('끝 Z', 'end', 'z')];
    case 'CIRCLE':
      return [
        coord('중심 X', 'center', 'x'),
        coord('중심 Y', 'center', 'y'),
        scalar('반지름', 'radius', 'length', true),
        { label: '지름', kind: 'length', positive: true, get: (e) => num((e as unknown as Any).radius) * 2, set: (e, v) => ((e as unknown as Any).radius = num(v) / 2) },
      ];
    case 'ARC':
      return [coord('중심 X', 'center', 'x'), coord('중심 Y', 'center', 'y'), scalar('반지름', 'radius', 'length', true), scalar('시작 각도', 'startAngle', 'angle'), scalar('끝 각도', 'endAngle', 'angle')];
    case 'ELLIPSE':
      return [
        coord('중심 X', 'center', 'x'),
        coord('중심 Y', 'center', 'y'),
        {
          label: '장축 반지름',
          kind: 'length',
          positive: true,
          get: (e) => {
            const m = (e as unknown as { majorAxis: Vec3 }).majorAxis;
            return Math.hypot(m.x, m.y, m.z);
          },
          set: (e, v) => {
            const m = (e as unknown as { majorAxis: Vec3 }).majorAxis;
            const l = Math.hypot(m.x, m.y, m.z) || 1;
            const k = num(v) / l;
            m.x *= k;
            m.y *= k;
            m.z *= k;
          },
        },
        { ...scalar('반지름 비율', 'ratio', 'number', true), set: (e, v) => ((e as unknown as Any).ratio = Math.min(1, num(v))) },
      ];
    case 'POINT':
      return [coord('위치 X', 'position', 'x'), coord('위치 Y', 'position', 'y'), coord('위치 Z', 'position', 'z')];
    case 'LWPOLYLINE':
      return [
        { label: '닫힘', kind: 'bool', get: (e) => (e as unknown as Any).closed, set: (e, v) => ((e as unknown as Any).closed = !!v) },
        {
          label: '전역 폭',
          kind: 'length',
          get: (e) => {
            const p = e as LwPolylineEntity;
            const vs = lwVertices(p);
            const w = vs[0]?.startWidth ?? p.constantWidth;
            return vs.every((x) => x.startWidth === w && x.endWidth === w) ? (w || p.constantWidth) : undefined;
          },
          set: (e, v) => {
            const p = e as LwPolylineEntity;
            p.constantWidth = Math.max(0, num(v));
            // 정점 폭도 모두 전역 폭으로(0이면 정점 폭 없음)
            p.widths = tidyWidths(zeros(lwCount(p) * 2).fill(p.constantWidth));
          },
        },
        scalar('고도', 'elevation'),
        { label: '선종류 생성', kind: 'bool', get: (e) => (e as unknown as Any).plinegen, set: (e, v) => ((e as unknown as Any).plinegen = !!v) },
      ];
    case 'TEXT':
    case 'ATTDEF':
      return [
        { label: '내용', kind: 'text', get: (e) => (e as unknown as Any).text, set: (e, v) => ((e as unknown as Any).text = String(v)) },
        { label: '문자 스타일', kind: 'select', options: textStyleOptions, get: (e) => (e as unknown as Any).style, set: (e, v) => ((e as unknown as Any).style = String(v)) },
        scalar('높이', 'height', 'length', true),
        scalar('회전', 'rotation', 'angle'),
        scalar('폭 비율', 'widthFactor', 'number', true),
        scalar('기울기', 'oblique', 'angle'),
        textPos('x'),
        textPos('y'),
      ];
    case 'MTEXT':
      return [
        {
          label: '내용',
          kind: 'multiline',
          get: (e) => String((e as unknown as Any).text).replace(/\\P/g, '\n'),
          set: (e, v) => ((e as unknown as Any).text = String(v).replace(/\r?\n/g, '\\P')),
        },
        { label: '문자 스타일', kind: 'select', options: textStyleOptions, get: (e) => (e as unknown as Any).style, set: (e, v) => ((e as unknown as Any).style = String(v)) },
        scalar('높이', 'height', 'length', true),
        {
          label: '회전',
          kind: 'angle',
          get: (e) => {
            const m = e as Entity & { direction?: Vec3; rotation: number };
            return m.direction ? Math.atan2(m.direction.y, m.direction.x) : m.rotation;
          },
          set: (e, v) => {
            const m = e as Entity & { direction?: Vec3; rotation: number };
            m.direction = undefined;
            m.rotation = num(v);
          },
        },
        scalar('너비', 'width'),
        scalar('줄 간격 비율', 'lineSpacingFactor', 'number', true),
        {
          label: '자리맞춤',
          kind: 'select',
          options: () => ['위 왼쪽', '위 중앙', '위 오른쪽', '중간 왼쪽', '중간 중앙', '중간 오른쪽', '아래 왼쪽', '아래 중앙', '아래 오른쪽'].map((l, i) => ({ value: String(i + 1), label: l })),
          get: (e) => String((e as unknown as Any).attachment),
          set: (e, v) => ((e as unknown as Any).attachment = Number(v)),
        },
        coord('위치 X', 'insert', 'x'),
        coord('위치 Y', 'insert', 'y'),
      ];
    case 'INSERT':
      return [
        insertField('위치 X', 'length', (e) => e.insert.x, (e, v) => ({ ins: { ...e.insert, x: v }, scale: e.scale, rot: e.rotation })),
        insertField('위치 Y', 'length', (e) => e.insert.y, (e, v) => ({ ins: { ...e.insert, y: v }, scale: e.scale, rot: e.rotation })),
        insertField('축척 X', 'number', (e) => e.scale.x, (e, v) => ({ ins: e.insert, scale: { ...e.scale, x: v || e.scale.x }, rot: e.rotation })),
        insertField('축척 Y', 'number', (e) => e.scale.y, (e, v) => ({ ins: e.insert, scale: { ...e.scale, y: v || e.scale.y }, rot: e.rotation })),
        insertField('축척 Z', 'number', (e) => e.scale.z, (e, v) => ({ ins: e.insert, scale: { ...e.scale, z: v || e.scale.z }, rot: e.rotation })),
        insertField('회전', 'angle', (e) => e.rotation, (e, v) => ({ ins: e.insert, scale: e.scale, rot: v })),
      ];
    case 'DIMENSION':
      return DIMENSION_FIELDS;
    case 'MULTILEADER':
      return MLEADER_FIELDS;
    case 'TOLERANCE':
      return TOLERANCE_FIELDS;
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// 치수·다중 지시선·공차(AutoCAD 특성 팔레트의 기타·선 및 화살표·문자·맞춤 범주에서 자주 쓰는 것)
// ---------------------------------------------------------------------------

const dimStyleOptions = (doc: CadDocument) => [...doc.dimStyles.values()].filter((s) => s.name && !s.name.includes('|')).sort((a, b) => a.name.localeCompare(b.name)).map((s) => ({ value: s.name, label: s.name }));

/** 치수 변수 재지정 항목(값은 스타일 값 + 재지정) */
function dimVarField(label: string, name: string, kind: FieldKind = 'length'): Field {
  const code = DIM_VAR_BY_NAME.get(name)!;
  return {
    label,
    kind,
    positive: true,
    regen: true,
    get: (e, doc) => {
      const ov = (e as DimensionEntity).overrides?.[code];
      if (ov !== undefined) return Number(ov);
      if (!doc) return undefined;
      try {
        return Number(rawDimVars(doc, e as DimensionEntity)[name]);
      } catch {
        return undefined;
      }
    },
    set: (e, v) => {
      Object.assign(e, applyOverrides(e as DimensionEntity, { [code]: num(v) }));
    },
  };
}

export const DIMENSION_FIELDS: Field[] = [
  { label: '치수 스타일', kind: 'select', regen: true, options: dimStyleOptions, get: (e) => (e as DimensionEntity).dimStyle, set: (e, v) => ((e as DimensionEntity).dimStyle = String(v)) },
  {
    label: '문자 재지정',
    kind: 'text',
    regen: true,
    get: (e) => (e as DimensionEntity).text,
    set: (e, v) => {
      const t = String(v);
      (e as DimensionEntity).text = t === '<>' ? '' : t;
    },
  },
  { label: '측정값', kind: 'number', readonly: true, get: (e) => (e as DimensionEntity).measurement, set: () => undefined },
  dimVarField('문자 높이', 'DIMTXT'),
  dimVarField('화살표 크기', 'DIMASZ'),
  dimVarField('치수 축척 전체', 'DIMSCALE', 'number'),
  { label: '문자 회전', kind: 'angle', regen: true, get: (e) => (e as DimensionEntity).textRotation || 0, set: (e, v) => ((e as DimensionEntity).textRotation = num(v)) },
];

const mleaderStyles = (doc: CadDocument) => [...doc.objects.values()].filter((o): o is MLeaderStyleObject => o.type === 'MLEADERSTYLE');

/** 연결선 길이를 바꾸고 내용을 그만큼 옮긴다(연결 점은 그대로) */
function setDogleg(e: MLeaderEntity, len: number, on: boolean): void {
  const ctx = e.context;
  const first = ctx.leaders[0];
  const old = e.landing && first?.hasDogleg ? (first.doglegLength ?? e.doglegLength) : 0;
  const next = on ? Math.max(0, len) : 0;
  const dv = first?.doglegVector ?? { x: 1, y: 0, z: 0 };
  const d = next - old;
  const mv = (p: Vec3): Vec3 => ({ x: p.x + dv.x * d, y: p.y + dv.y * d, z: p.z });
  if (ctx.leaders.length <= 1 && d) {
    ctx.contentBase = mv(ctx.contentBase);
    ctx.basePoint = mv(ctx.basePoint);
    if (ctx.text) ctx.text.location = mv(ctx.text.location);
    if (ctx.block) ctx.block.location = mv(ctx.block.location);
  }
  e.landing = on;
  e.dogleg = on;
  e.doglegLength = on ? len : e.doglegLength;
  for (const ld of ctx.leaders) {
    ld.hasDogleg = on;
    ld.doglegLength = next;
  }
}

export const MLEADER_FIELDS: Field[] = [
  {
    label: '다중 지시선 스타일',
    kind: 'select',
    options: (doc) => mleaderStyles(doc).map((s) => ({ value: s.handle, label: s.name })),
    get: (e) => (e as MLeaderEntity).styleHandle ?? '',
    set: (e, v) => ((e as MLeaderEntity).styleHandle = String(v)),
  },
  {
    label: '내용',
    kind: 'multiline',
    get: (e) => {
      const m = e as MLeaderEntity;
      return m.contentType === 2 && m.context.text ? m.context.text.text.replace(/\\P/g, '\n') : undefined;
    },
    set: (e, v) => {
      const m = e as MLeaderEntity;
      if (m.contentType === 2 && m.context.text) m.context.text.text = String(v).replace(/\r?\n/g, '\\P');
    },
  },
  {
    label: '문자 높이',
    kind: 'length',
    positive: true,
    get: (e) => ((e as MLeaderEntity).contentType === 2 ? (e as MLeaderEntity).context.textHeight : undefined),
    set: (e, v) => {
      const m = e as MLeaderEntity;
      if (m.contentType === 2) m.context.textHeight = num(v);
    },
  },
  {
    label: '화살촉 크기',
    kind: 'length',
    positive: true,
    get: (e) => (e as MLeaderEntity).arrowSize,
    set: (e, v) => {
      const m = e as MLeaderEntity;
      m.arrowSize = num(v);
      m.context.arrowSize = num(v);
    },
  },
  {
    label: '연결선',
    kind: 'bool',
    get: (e) => (e as MLeaderEntity).landing,
    set: (e, v) => {
      const m = e as MLeaderEntity;
      setDogleg(m, m.doglegLength > 0 ? m.doglegLength : m.context.textHeight * 2, !!v);
    },
  },
  {
    label: '연결선 거리',
    kind: 'length',
    get: (e) => ((e as MLeaderEntity).landing ? ((e as MLeaderEntity).context.leaders[0]?.doglegLength ?? (e as MLeaderEntity).doglegLength) : undefined),
    set: (e, v) => {
      const m = e as MLeaderEntity;
      setDogleg(m, num(v), true);
    },
  },
];

export const TOLERANCE_FIELDS: Field[] = [
  { label: '치수 스타일', kind: 'select', options: dimStyleOptions, get: (e) => (e as ToleranceEntity).dimStyle, set: (e, v) => ((e as ToleranceEntity).dimStyle = String(v)) },
  { label: '공차 문자', kind: 'text', get: (e) => (e as ToleranceEntity).text, set: (e, v) => ((e as ToleranceEntity).text = String(v)) },
];

/** 블록 참조의 속성 값 항목(태그별) */
export function attribFields(e: InsertEntity): Field[] {
  return e.attribs
    .filter((a) => !(a.attFlags & 2))
    .map((a, i) => ({
      label: a.tag || `속성 ${i + 1}`,
      kind: (a.mtext ? 'multiline' : 'text') as FieldKind,
      get: (x: Entity) => {
        const at = findAttrib(x as InsertEntity, a.tag, i);
        return at?.mtext ? at.mtext.text.replace(/\\P/g, '\n') : at?.text;
      },
      set: (x: Entity, v: unknown) => {
        const at = findAttrib(x as InsertEntity, a.tag, i);
        if (!at) return;
        if (at.mtext) at.mtext.text = String(v).replace(/\r?\n/g, '\\P');
        at.text = String(v).replace(/\r?\n/g, ' ');
      },
    }));
}

function findAttrib(e: InsertEntity, tag: string, i: number): AttribEntity | undefined {
  const vis = e.attribs.filter((a) => !(a.attFlags & 2));
  return vis.find((a) => a.tag === tag) ?? vis[i];
}

// ---------------------------------------------------------------------------
// 표시·읽기·적용
// ---------------------------------------------------------------------------

/** 객체들의 값(모두 같으면 그 값, 다르면 undefined, 해당 없음이면 null) */
export function commonValue(field: Field, list: Entity[], doc?: CadDocument): { value: unknown; varies: boolean } {
  let first: unknown;
  let has = false;
  for (const e of list) {
    const v = field.get(e, doc);
    if (!has) {
      first = v;
      has = true;
    } else if (JSON.stringify(v) !== JSON.stringify(first)) return { value: undefined, varies: true };
  }
  return { value: first, varies: false };
}

export function formatValue(field: Field, v: unknown, u: UnitSettings): string {
  if (v === undefined || v === null) return '';
  switch (field.kind) {
    case 'length':
      return formatLength(num(v), u);
    case 'angle':
      return formatAngle(num(v), u);
    case 'number':
      return String(+num(v).toFixed(6));
    case 'color':
      return colorText(v as CadColor);
    case 'bool':
      return v ? '예' : '아니오';
    default:
      return String(v);
  }
}

/** 입력 글자를 값으로(잘못되면 오류 문장) */
export function parseValue(field: Field, text: string, u: UnitSettings): { value: unknown } | { error: string } {
  switch (field.kind) {
    case 'length':
    case 'number': {
      const v = field.kind === 'length' ? parseLength(text) : Number(text.trim());
      if (v === null || !Number.isFinite(v) || text.trim() === '') return { error: '숫자를 입력하십시오.' };
      if (field.positive && v <= 0) return { error: '0보다 큰 값을 입력하십시오.' };
      return { value: v };
    }
    case 'angle': {
      const v = parseAngle(text, u.aunits);
      if (v === null) return { error: '각도를 입력하십시오.' };
      return { value: v };
    }
    default:
      return { value: text };
  }
}

/** 고른 객체에 항목 값을 적용한다(바뀐 객체만 명령 하나로) */
export function applyField(app: App, handles: string[], field: Field, value: unknown, applies: (e: Entity) => boolean = () => true): number {
  const st = app.active;
  if (!st) return 0;
  const ops: EditOp[] = [];
  const locked = lockedLayers(st.doc);
  let skipped = 0;
  for (const h of handles) {
    const e = st.doc.entityIndex.get(h);
    if (!e || !applies(e)) continue;
    if (locked.has(tableKey(e.layer))) {
      skipped++;
      continue;
    }
    const block = st.session.ownerOf(h);
    if (!block) continue;
    if (field.readonly) continue;
    const c = cloneEntity(e);
    field.set(c, value, st.doc);
    if (JSON.stringify(c) === JSON.stringify(e)) continue;
    ops.push({ kind: 'modify', block, before: e, after: c });
  }
  if (skipped) app.cmd.print(`잠긴 도면층의 객체 ${skipped}개는 바꾸지 않았습니다.`);
  if (ops.length) {
    // 파라메트릭 구속: 이어진 객체가 따라오고, 맞출 수 없으면 바꾸지 않는다(modify 작업의 after는 제자리에서 바뀐다)
    const cs = afterEditSolve(st, ops, 'PROPERTIES');
    if (!cs.ok) {
      app.cmd.print(cs.message!, 'err');
      return 0;
    }
    ops.push(...cs.extra);
    // 형상을 바꾸면 연관 치수가 따라간다
    const f = followOps(st, new Map(ops.flatMap((o) => (o.kind === 'modify' ? [[o.before.handle, o.after] as const] : []))));
    for (const o of ops) if (o.kind === 'modify') o.after = f.patched.get(o.before.handle) ?? o.after;
    ops.push(...f.ops);
    // 치수 모양을 바꾸는 값: 치수 블록을 치수 생성기로 다시 만든다(블록 작업이 먼저)
    if (field.regen) {
      const extra = new Set<string>();
      const blockOps: EditOp[] = [];
      for (const o of ops) {
        if (o.kind !== 'modify' || o.after.type !== 'DIMENSION') continue;
        try {
          blockOps.push(...dimensionBlockOps(st, o.after, true, extra));
        } catch {
          /* 생성기가 못 다루는 치수는 정의만 바꾼다 */
        }
      }
      ops.unshift(...blockOps);
    }
    st.session.commit({ label: 'PROPERTIES', ops });
  }
  return ops.length;
}

export function lockedLayers(doc: CadDocument): Set<string> {
  const s = new Set<string>();
  for (const [k, l] of doc.layers) if (l.locked) s.add(k);
  return s;
}
