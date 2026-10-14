/**
 * 무늬 정의 → HATCH 무늬 줄(DXF 53·43·44·45·46·49 규약).
 * 저장 값은 해치 축척·각도가 이미 적용된 값이다.
 * - 각도 = 정의 각도 + 해치 각도
 * - 원점 = 해치 원점 + R(해치 각도)·(x, y)·k
 * - 이동 = R(선 각도)·(dx, dy)·k (선 방향 기준 값을 평면 방향으로 돌린다)
 * - 대시 = 대시·k
 * k = 축척 × 단위(미터법 도면의 인치 무늬는 25.4)
 */
import type { HatchPatternLine, Vec2 } from '../../core/model';
import type { PatternDef } from './patterns';

export interface PatternLineOptions {
  /** 미터법 도면(MEASUREMENT = 1): 인치로 정의한 무늬를 mm로(×25.4). ISO 무늬는 이미 mm다 */
  metric?: boolean;
  /** 해치 원점(HPORIGIN) */
  origin?: Vec2;
}

const DEG = Math.PI / 180;

/** 무늬 정의의 단위 배율 */
export function patternUnit(def: PatternDef, metric: boolean | undefined): number {
  return metric && def.kind !== 'iso' ? 25.4 : 1;
}

function rot(x: number, y: number, a: number): Vec2 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: x * c - y * s, y: x * s + y * c };
}

function tidy(v: number): number {
  return Math.abs(v) < 1e-14 ? 0 : v;
}

/** 무늬 정의 → HATCH patternLines(축척·각도·이중 적용, 미터법이면 인치 무늬를 mm로) */
export function patternLines(def: PatternDef, scale: number, angle: number, double?: boolean, opt: PatternLineOptions = {}): HatchPatternLine[] {
  const k = (scale || 1) * patternUnit(def, opt.metric);
  const o = opt.origin ?? { x: 0, y: 0 };
  const out: HatchPatternLine[] = [];
  const add = (extra: number) => {
    for (const l of def.lines) {
      const a = l.angle * DEG + angle + extra;
      const b = rot(l.x * k, l.y * k, angle + extra);
      const off = rot(l.dx * k, l.dy * k, a);
      out.push({
        angle: normAngle(a),
        base: { x: tidy(o.x + b.x), y: tidy(o.y + b.y) },
        offset: { x: tidy(off.x), y: tidy(off.y) },
        dashes: l.dashes.map((d) => d * k),
      });
    }
  };
  add(0);
  if (double) add(Math.PI / 2);
  return out;
}

/** 사용자 정의 무늬(patternType 0): 간격·각도·이중 */
export function userPatternLines(spacing: number, angle: number, double: boolean, origin?: Vec2): HatchPatternLine[] {
  const s = spacing || 1;
  const o = origin ?? { x: 0, y: 0 };
  const one = (a: number): HatchPatternLine => ({
    angle: normAngle(a),
    base: { x: o.x, y: o.y },
    offset: { x: tidy(-Math.sin(a) * s), y: tidy(Math.cos(a) * s) },
    dashes: [],
  });
  return double ? [one(angle), one(angle + Math.PI / 2)] : [one(angle)];
}

function normAngle(a: number): number {
  const t = Math.PI * 2;
  let r = a % t;
  if (r < 0) r += t;
  if (Math.abs(r - t) < 1e-12) r = 0;
  return r;
}
