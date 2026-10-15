/**
 * 치수 화살촉: 기본(닫고 채움)은 SOLID, 그 밖은 화살촉 블록 INSERT(크기 = DIMASZ, 회전 = 화살 방향).
 * 도면에 없는 AutoCAD 기본 화살촉 블록은 내용을 만들어 Out.arrowBlocks에 담는다.
 */
import { type Entity, type LwVertex, entityDefaults, tableKey } from '../../core/model';
import type { Out } from './builder';
import { type P, add, ang, madd, mul, perp, sub } from './vec';
import { packLw } from '../../core/lwpoly';

/** AutoCAD 기본 화살촉 이름(블록 이름 철자) */
const BUILTIN = [
  '_ClosedFilled',
  '_ClosedBlank',
  '_Closed',
  '_Dot',
  '_ArchTick',
  '_Oblique',
  '_Open',
  '_Origin',
  '_Origin2',
  '_Open90',
  '_Open30',
  '_DotSmall',
  '_DotBlank',
  '_Small',
  '_BoxBlank',
  '_BoxFilled',
  '_DatumBlank',
  '_DatumFilled',
  '_Integral',
  '_None',
];
const BUILTIN_KEY = new Map(BUILTIN.map((n) => [n.slice(1).toUpperCase(), n]));

/** 치수선을 화살 끝에서 잘라내지 않는 화살촉(눈금·작은 점) */
const ORIGIN_ZERO = new Set(['_ArchTick', '_Oblique', '_DotSmall', '_Small', '_Integral', '_None']);
/** 치수선 연장(DIMDLE)이 적용되는 눈금형 */
const TICKS = new Set(['_ArchTick', '_Oblique', '_Integral', '_None']);

export interface ArrowKind {
  /** 'solid' 기본 채움, 'tick' DIMTSZ 사선, 'block' 블록 참조, 'none' 그리지 않음 */
  type: 'solid' | 'tick' | 'block' | 'none';
  /** 블록 이름(도면 철자) */
  block: string;
  /** 치수선을 끝에서 잘라 낼 길이 */
  trim: number;
  /** DIMDLE 적용 */
  tick: boolean;
  /** 화살촉 길이(맞춤 계산용) */
  size: number;
}

/** 화살촉 이름 → 종류 */
export function arrowKind(o: Out, name: string): ArrowKind {
  const v = o.v;
  if (v.tsz > 0) return { type: 'tick', block: '', trim: 0, tick: true, size: v.tsz };
  const asz = v.asz;
  const raw = name.trim();
  if (!raw || raw === '.') return { type: 'solid', block: '', trim: asz, tick: false, size: asz };
  const key = raw.replace(/^_/, '').toUpperCase();
  const builtin = BUILTIN_KEY.get(key);
  const existing = o.doc.blocks.get(tableKey(raw)) ?? (builtin ? o.doc.blocks.get(tableKey(builtin)) : undefined);
  if (builtin === '_ClosedFilled' && !existing) return { type: 'solid', block: '', trim: asz, tick: false, size: asz };
  if (builtin === '_None') return { type: 'none', block: existing?.name ?? builtin, trim: 0, tick: true, size: asz };
  if (builtin) {
    const blockName = existing?.name ?? builtin;
    if (!existing && !o.arrowBlocks.has(builtin)) o.arrowBlocks.set(builtin, builtinArrowBlock(builtin));
    const zero = ORIGIN_ZERO.has(builtin);
    return { type: 'block', block: blockName, trim: zero ? 0 : asz, tick: TICKS.has(builtin), size: asz };
  }
  if (existing) return { type: 'block', block: existing.name, trim: asz, tick: false, size: asz };
  o.warn('dimension.arrow_block_missing');
  return { type: 'solid', block: '', trim: asz, tick: false, size: asz };
}

/**
 * 화살촉 하나. tip = 끝, d = 화살 방향(단위, 몸통 → 끝).
 * side: SOLID 첫 꼭짓점 쪽 법선(AutoCAD 순서와 같게 맞추는 용도).
 */
export function drawArrow(o: Out, k: ArrowKind, tip: P, d: P, side: P): void {
  const v = o.v;
  if (k.type === 'none') return;
  if (k.type === 'tick') {
    // 사선 눈금: 치수선 방향 기준 45°, 반 길이 DIMTSZ
    const a = mul(add(d, perp(d)), v.tsz);
    o.line(sub(tip, a), add(tip, a), o.dimLineProps());
    return;
  }
  if (k.type === 'solid') {
    const base = madd(tip, d, -v.asz);
    const w = v.asz / 6;
    o.solid([madd(base, side, w), madd(base, side, -w), tip, tip], o.solidProps());
    return;
  }
  o.insert(k.block, tip, v.asz, ang(d), o.arrowProps());
}

// ---------------------------------------------------------------------------
// 기본 화살촉 블록 내용(크기 1, 끝 = 원점, +X 방향)
// ---------------------------------------------------------------------------

function ent<T extends Entity['type']>(type: T, extra: Record<string, unknown>): Entity {
  return { ...entityDefaults(), color: { aci: 0 }, lineweight: -2, type, ...extra } as unknown as Entity;
}
const v3 = (x: number, y: number) => ({ x, y, z: 0 });
const L = (x0: number, y0: number, x1: number, y1: number) => ent('LINE', { start: v3(x0, y0), end: v3(x1, y1) });
const C = (r: number) => ent('CIRCLE', { center: v3(0, 0), radius: r });
const S = (a: [number, number], b: [number, number], c: [number, number], d: [number, number]) =>
  ent('SOLID', { points: [v3(...a), v3(...b), v3(...c), v3(...d)], invisibleEdges: 0 });
const lw = (pts: [number, number, number?][], closed: boolean, width: number) =>
  ent('LWPOLYLINE', {
    ...packLw(pts.map(([x, y, bulge]): LwVertex => ({ x, y, bulge: bulge ?? 0, startWidth: 0, endWidth: 0 }))),
    closed,
    plinegen: false,
    constantWidth: width,
    elevation: 0,
    lineweight: -1,
  });
/** 채운 원(도넛): 바깥 반지름 r */
const dot = (r: number) => lw([[-r / 2, 0, 1], [r / 2, 0, 1]], true, r);
const S6 = 1 / 6;
const T15 = Math.tan(Math.PI / 12);
const stub = () => L(-0.5, 0, -1, 0);

/** AutoCAD 기본 화살촉 블록 내용(도면에 없을 때 만들 것) */
export function builtinArrowBlock(name: string): Entity[] {
  switch (name) {
    case '_ClosedFilled':
      return [S([-1, S6], [-1, -S6], [0, 0], [0, 0])];
    case '_ClosedBlank':
      return [L(-1, S6, 0, 0), L(0, 0, -1, -S6), L(-1, S6, -1, -S6)];
    case '_Closed':
      return [L(-1, S6, 0, 0), L(0, 0, -1, -S6), L(-1, S6, -1, -S6), L(-1, 0, 0, 0)];
    case '_Dot':
      return [dot(0.5), stub()];
    case '_DotSmall':
      return [dot(1 / 16)];
    case '_DotBlank':
      return [C(0.5), stub()];
    case '_Small':
      return [C(1 / 16)];
    case '_Origin':
      return [C(0.5), L(0, 0, -1, 0)];
    case '_Origin2':
      return [C(0.5), C(0.25), L(-0.5, 0, -1, 0)];
    case '_Open':
      return [L(-1, S6, 0, 0), L(0, 0, -1, -S6), L(-1, 0, 0, 0)];
    case '_Open90':
      return [L(-0.5, 0.5, 0, 0), L(0, 0, -0.5, -0.5), L(-1, 0, 0, 0)];
    case '_Open30':
      return [L(-1, T15, 0, 0), L(0, 0, -1, -T15), L(-1, 0, 0, 0)];
    case '_ArchTick':
      return [lw([[-0.5, -0.5], [0.5, 0.5]], false, 0.15)];
    case '_Oblique':
      return [L(-0.5, -0.5, 0.5, 0.5)];
    case '_BoxBlank':
      return [L(-0.5, -0.5, 0.5, -0.5), L(0.5, -0.5, 0.5, 0.5), L(0.5, 0.5, -0.5, 0.5), L(-0.5, 0.5, -0.5, -0.5), stub()];
    case '_BoxFilled':
      return [S([-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]), stub()];
    case '_DatumBlank':
      return [L(0, 0.5, -1, 0), L(-1, 0, 0, -0.5), L(0, -0.5, 0, 0.5)];
    case '_DatumFilled':
      return [S([0, 0.5], [0, -0.5], [-1, 0], [-1, 0])];
    case '_Integral': {
      // 적분 기호 모양 두 호
      return [
        ent('ARC', { center: v3(0.444, -0.092), radius: 0.454, startAngle: (101.3 * Math.PI) / 180, endAngle: (167.6 * Math.PI) / 180 }),
        ent('ARC', { center: v3(-0.444, 0.092), radius: 0.454, startAngle: (-78.7 * Math.PI) / 180, endAngle: (-12.4 * Math.PI) / 180 }),
      ];
    }
    default:
      return [];
  }
}

