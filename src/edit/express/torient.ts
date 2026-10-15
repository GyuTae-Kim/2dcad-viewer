/**
 * TORIENT(Express Tools 문자 방향 바꾸기) 계산(UI 없음).
 * 가장 읽기 쉽게: 문자 방향이 (90°, 270°]이면 180° 돌려 (-90°, 90°] 안으로(왼쪽 → 오른쪽 또는 아래 → 위로 읽힌다).
 * 새 각도: 모든 문자의 방향을 그 각도로.
 * 문자는 상자 가운데를 축으로 돌려 같은 자리에 남는다. 블록 참조는 그 속성들을 돌린다.
 */
import type { AttribEntity, CadDocument, Entity, InsertEntity } from '../../core/model';
import { affRotate, TAU } from '../geom/math';
import { transformEntity } from '../geom/transform';
import { isTextLike } from '../geom/textjust';
import { textAngle, textBox } from './textbox';

const EPS = 1e-9;

/** [0, 2π)로 */
export function normalizeAngle(a: number): number {
  let r = a % TAU;
  if (r < 0) r += TAU;
  if (TAU - r < EPS) r = 0;
  return r;
}

/** 가장 읽기 쉬운 방향([0, 2π)): (90°, 270°]는 180°를 뺀다 */
export function readableAngle(a: number): number {
  const r = normalizeAngle(a);
  if (r > Math.PI / 2 + EPS && r <= (3 * Math.PI) / 2 + EPS) return normalizeAngle(r - Math.PI);
  return r;
}

/** 이미 읽기 쉬운 방향인지 */
export function isReadable(a: number): boolean {
  return Math.abs(readableAngle(a) - normalizeAngle(a)) < EPS;
}

/** TORIENT를 받는 객체 */
export function isOrientTarget(e: Entity): boolean {
  if (isTextLike(e) || e.type === 'MTEXT') return true;
  return e.type === 'INSERT' && e.attribs.length > 0;
}

/** 새 방향(target = 'readable' 또는 WCS 각도) */
function wanted(a: number, target: number | 'readable'): number {
  return target === 'readable' ? readableAngle(a) : normalizeAngle(target);
}

/** 문자 하나를 돌린 결과(바뀌지 않으면 null) */
function orientText<T extends Entity>(e: T, target: number | 'readable', doc: CadDocument): T | null {
  const a = textAngle(e);
  if (a === null) return null;
  const b = wanted(a, target);
  let delta = b - normalizeAngle(a);
  if (Math.abs(delta) < EPS || Math.abs(Math.abs(delta) - TAU) < EPS) return null;
  if (delta > Math.PI) delta -= TAU;
  if (delta < -Math.PI) delta += TAU;
  const box = textBox(e, doc);
  if (!box) return null;
  const r = transformEntity(e, affRotate(delta, box.c), doc, { mirrorText: true });
  const out = (r.replace?.[0] ?? r.add?.[0]) as T | undefined;
  if (!out) return null;
  out.handle = e.handle;
  return out;
}

/** 객체 하나에 TORIENT를 적용한다(바뀌지 않으면 null) */
export function orientEntity(e: Entity, target: number | 'readable', doc: CadDocument): Entity | null {
  if (e.type === 'INSERT') {
    const ins = e as InsertEntity;
    let changed = false;
    const attribs = ins.attribs.map((a) => {
      const n = orientText(a as Entity, target, doc) as AttribEntity | null;
      if (n) {
        changed = true;
        return n;
      }
      return structuredClone(a);
    });
    return changed ? { ...structuredClone(ins), attribs } : null;
  }
  if (isTextLike(e) || e.type === 'MTEXT') return orientText(e, target, doc);
  return null;
}
