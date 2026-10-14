/** 편집 결과 형식 */
import type { BlockDef, CadDocument, Entity, Vec2 } from '../../core/model';

export interface EditResult {
  /** 새 객체(핸들 '' — 호출한 쪽이 붙인다) */
  add?: Entity[];
  /** 핸들을 유지한 채 바뀐 객체 */
  replace?: Entity[];
  /** 지울 핸들 */
  remove?: string[];
  /** 새로 만들었거나 바꾼 블록 정의(예: 익명 치수 블록) */
  blocks?: BlockDef[];
  /** 결과가 없거나 근사했을 때의 AutoCAD식 안내 */
  message?: string;
}

export type GripKind = 'end' | 'mid' | 'cen' | 'qua' | 'ins' | 'vertex' | 'ctrl' | 'fit' | 'text';

export interface GripPoint {
  id: string;
  point: Vec2;
  kind: GripKind;
}

export interface TransformOptions {
  /** MIRRTEXT = 1: 문자도 거울상으로(기본 거짓 = 읽을 수 있게) */
  mirrorText?: boolean;
  /** MIRRHATCH = 1: 해치 무늬도 대칭(기본 거짓 = 무늬 방향 유지) */
  mirrorHatch?: boolean;
  /** Z 이동 */
  dz?: number;
  /** 내부용: MTEXT까지 정확한 거울상(분해) */
  exact?: boolean;
}

export const MSG = {
  noIntersect: '객체가 모서리와 교차하지 않습니다.',
  noEdge: '그 방향에는 모서리가 없습니다.',
  cannotTrim: '이 객체는 자를 수 없습니다.',
  cannotExtend: '이 객체는 연장할 수 없습니다.',
  cannotOffset: '해당 객체를 간격띄우기할 수 없습니다.',
  offsetDistance: '해당 거리로 간격띄우기할 수 없습니다.',
  cannotFillet: '이 객체는 모깎기할 수 없습니다.',
  cannotChamfer: '이 객체는 모따기할 수 없습니다.',
  radiusTooLarge: '반지름이 너무 큽니다.',
  distanceTooLarge: '거리가 너무 큽니다.',
  parallel: '선이 평행합니다.',
  cannotBreak: '이 객체는 끊을 수 없습니다.',
  fullCircle: '호는 360도가 될 수 없습니다.',
  cannotJoin: '결합할 수 있는 객체가 없습니다.',
  cannotLengthen: '이 객체는 길이를 조정할 수 없습니다.',
  tooShort: '길이가 너무 짧습니다.',
  arcTooLong: '호의 길이가 원 둘레보다 길 수 없습니다.',
  ellipseTooLong: '타원형 호의 길이가 타원 둘레보다 길 수 없습니다.',
  cannotExplode: '이 객체는 분해할 수 없습니다.',
  cannotTransform: '이 객체는 변환할 수 없습니다.',
  acis: 'ACIS 객체(영역·3D 솔리드·곡면)는 변환할 수 없습니다.',
  shear: '블록 참조는 기울이기 변환을 할 수 없어 가장 가까운 축척·회전으로 바꿨습니다.',
  noCurve: '곡선 객체가 아닙니다.',
  cannotReverse: '이 객체는 방향을 바꿀 수 없습니다.',
  differentPlines: '같은 폴리선의 인접한 세그먼트가 아닙니다.',
  notEndSegment: '폴리선의 끝 세그먼트만 모깎기·모따기할 수 있습니다.',
} as const;

/** 결과 합치기 */
export function mergeResults(list: readonly EditResult[]): EditResult {
  const out: EditResult = {};
  for (const r of list) {
    if (r.add?.length) (out.add ??= []).push(...r.add);
    if (r.replace?.length) (out.replace ??= []).push(...r.replace);
    if (r.remove?.length) (out.remove ??= []).push(...r.remove);
    if (r.blocks?.length) (out.blocks ??= []).push(...r.blocks);
    if (r.message && !out.message) out.message = r.message;
  }
  return out;
}

/** 익명 블록 이름(*D, *T …)을 문서마다 겹치지 않게 고른다 */
const blockCounters = new WeakMap<CadDocument, Map<string, number>>();

export function allocBlockName(doc: CadDocument, prefix: string): string {
  let m = blockCounters.get(doc);
  if (!m) {
    m = new Map();
    blockCounters.set(doc, m);
  }
  let n = m.get(prefix);
  if (n === undefined) {
    n = 0;
    const re = new RegExp('^' + prefix.replace(/[*]/g, '\\*') + '(\\d+)$', 'i');
    for (const k of doc.blocks.keys()) {
      const mm = re.exec(k);
      if (mm) n = Math.max(n, Number(mm[1]));
    }
  }
  let name: string;
  do {
    n++;
    name = `${prefix}${n}`;
  } while (doc.blocks.has(name.toUpperCase()));
  m.set(prefix, n);
  return name;
}
