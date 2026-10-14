/**
 * COPYTOLAYER의 순수 함수: 복사본을 대상 도면층으로 옮긴다.
 * 블록 참조의 속성은 참조와 같은 도면층에 있던 것만 함께 옮긴다(다른 도면층에 둔 속성은 그대로).
 */
import type { Entity } from '../../core/model';
import { tableKey } from '../../core/model';

/** 복사본(핸들 없는 새 객체)의 도면층을 바꾼다(제자리) */
export function moveCopyToLayer(e: Entity, layer: string): Entity {
  const was = tableKey(e.layer);
  e.layer = layer;
  if (e.type === 'INSERT') for (const a of e.attribs) if (tableKey(a.layer) === was) a.layer = layer;
  return e;
}

/** 대상 도면층 이름 문제(없으면 null) */
export function targetLayerProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return '도면층 이름이 비어 있습니다.';
  if (n.includes('|')) return '외부 참조 종속 도면층으로는 복사할 수 없습니다.';
  if (/[<>/\\":;?*,=`]/.test(n)) return '이름에 < > / \\ " : ; ? * | , = ` 문자는 쓸 수 없습니다.';
  if (n.length > 255) return '이름이 너무 깁니다.';
  return null;
}
