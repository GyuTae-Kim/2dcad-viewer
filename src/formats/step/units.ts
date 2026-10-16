/**
 * 표현 맥락(GEOMETRIC_REPRESENTATION_CONTEXT 복합 인스턴스)의 단위: 길이(밀리미터 배율), 평면각(라디안 배율), 불확실도.
 * SI_UNIT(접두어·이름), CONVERSION_BASED_UNIT(이름, 환산 측정값)을 따라간다.
 */
import { enumOf, isA, num, partOf, refId, refList, StepTyped, text, type StepEntity, type StepFile } from './part21';

const PREFIX: Record<string, number> = {
  EXA: 1e18,
  PETA: 1e15,
  TERA: 1e12,
  GIGA: 1e9,
  MEGA: 1e6,
  KILO: 1e3,
  HECTO: 1e2,
  DECA: 1e1,
  DECI: 1e-1,
  CENTI: 1e-2,
  MILLI: 1e-3,
  MICRO: 1e-6,
  NANO: 1e-9,
  PICO: 1e-12,
  FEMTO: 1e-15,
  ATTO: 1e-18,
};

export interface ContextUnits {
  /** 길이 1단위 = 몇 mm */
  lengthMm: number;
  /** 평면각 1단위 = 몇 라디안 */
  angleRad: number;
  /** 길이 단위 이름(사람용) */
  lengthName: string;
  /** 거리 불확실도(모형 단위), 없으면 NaN */
  uncertainty: number;
  /** 단위를 찾았는지 */
  known: boolean;
}

export const DEFAULT_UNITS: ContextUnits = { lengthMm: 1, angleRad: 1, lengthName: 'mm', uncertainty: NaN, known: false };

/** 단위 개체 → (종류, SI 기본 단위 기준 배율, 이름) */
function unitFactor(f: StepFile, id: number, depth = 0): { kind: 'length' | 'angle' | 'other'; factor: number; name: string } | null {
  if (depth > 8) return null;
  const e = f.get(id);
  if (!e) return null;
  const kind: 'length' | 'angle' | 'other' = isA(e, 'LENGTH_UNIT') ? 'length' : isA(e, 'PLANE_ANGLE_UNIT') ? 'angle' : 'other';
  const si = e.parts ? partOf(e, 'SI_UNIT') : e.type === 'SI_UNIT' ? { type: 'SI_UNIT', args: e.args } : undefined;
  if (si) {
    const n = si.args.length;
    const prefix = enumOf(si.args[n - 2]);
    const name = enumOf(si.args[n - 1]);
    const p = prefix ? (PREFIX[prefix] ?? 1) : 1;
    const k: 'length' | 'angle' | 'other' = kind !== 'other' ? kind : name === 'METRE' ? 'length' : name === 'RADIAN' ? 'angle' : 'other';
    return { kind: k, factor: p, name: (prefix ? prefix.toLowerCase() : '') + name.toLowerCase() };
  }
  const cb = e.parts ? partOf(e, 'CONVERSION_BASED_UNIT') : e.type === 'CONVERSION_BASED_UNIT' ? { type: e.type, args: e.args.slice(-2) } : undefined;
  if (cb) {
    const name = text(cb.args[0]);
    const m = f.get(refId(cb.args[1]));
    if (!m) return null;
    const { value, unit } = measureWithUnit(m);
    const base = unit ? unitFactor(f, unit, depth + 1) : null;
    const k: 'length' | 'angle' | 'other' = kind !== 'other' ? kind : (base?.kind ?? 'other');
    return { kind: k, factor: value * (base?.factor ?? 1), name: name.toLowerCase() };
  }
  return null;
}

/** *_MEASURE_WITH_UNIT(값, 단위) — 단순·복합 둘 다 */
function measureWithUnit(m: StepEntity): { value: number; unit: number } {
  const args = m.parts ? (partOf(m, 'MEASURE_WITH_UNIT')?.args ?? []) : m.args;
  const v = args[0];
  return { value: v instanceof StepTyped ? num(v.value, 1) : num(v, 1), unit: refId(args[1]) };
}

/** 표현 맥락 번호 → 단위 */
export function contextUnits(f: StepFile, ctxId: number): ContextUnits {
  const e = f.get(ctxId);
  if (!e) return DEFAULT_UNITS;
  const out: ContextUnits = { ...DEFAULT_UNITS };
  const ua = e.parts ? partOf(e, 'GLOBAL_UNIT_ASSIGNED_CONTEXT') : e.type === 'GLOBAL_UNIT_ASSIGNED_CONTEXT' ? { type: e.type, args: e.args.slice(-1) } : undefined;
  if (ua) {
    for (const uid of refList(ua.args[0])) {
      const u = unitFactor(f, uid);
      if (!u) continue;
      if (u.kind === 'length') {
        out.lengthMm = u.factor * 1000;
        out.lengthName = u.name;
        out.known = true;
      } else if (u.kind === 'angle') out.angleRad = u.factor;
    }
  }
  const unc = e.parts ? partOf(e, 'GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT') : undefined;
  if (unc) {
    for (const id of refList(unc.args[0])) {
      const m = f.get(id);
      if (!m) continue;
      const { value } = measureWithUnit(m);
      if (value > 0 && (Number.isNaN(out.uncertainty) || value < out.uncertainty)) out.uncertainty = value;
    }
  }
  return out;
}

/** 길이 배율(mm) → 장면 단위 이름 */
export function sceneUnitOf(mm: number): 'mm' | 'inch' | 'm' {
  if (Math.abs(mm - 25.4) < 1e-6 || Math.abs(mm - 304.8) < 1e-4) return 'inch';
  if (Math.abs(mm - 1000) < 1e-6) return 'm';
  return 'mm';
}

/** 장면 단위 이름 → mm 배율 */
export function sceneUnitMm(u: 'mm' | 'inch' | 'm'): number {
  return u === 'inch' ? 25.4 : u === 'm' ? 1000 : 1;
}
