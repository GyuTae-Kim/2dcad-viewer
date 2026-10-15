/**
 * 외부 참조 비교(XCOMPARE) 계산(DOM 없음): 참조 파일의 이전 버전과 지금 버전의 차이 분류,
 * 호스트 도면에 놓인 자리(외부 참조 블록 참조)로 옮긴 상자, 명령행 요약.
 *
 * 비교 자체는 도면 비교(COMPARE)의 엔진(compareDrawings)을 쓴다: 지금 버전 = "현재", 이전 버전 = "비교".
 */
import type { CadDocument, Entity, InsertEntity } from '../../core/model';
import { MODEL_SPACE, tableKey } from '../../core/model';
import { type Box, type CompareOptions, compareDrawings, spaceEntities } from '../compare';
import { entityBounds } from '../geom/query';

export type Affine = [number, number, number, number, number, number];

/** 참조 파일 두 버전의 차이 */
export interface XrefDiff {
  /** 지금 버전에만 있는 객체(새로 생겼거나 바뀐 것) — COMPARECOLOR1 */
  onlyNew: string[];
  /** 이전 버전에만 있는 객체(지웠거나 바뀌기 전의 것) — COMPARECOLOR2 */
  onlyOld: string[];
  /** 지금 버전에서 차이 없는 객체(문자·해치 필터로 비교하지 않은 것 포함) — COMPARECOLORCOMMON */
  commonNew: string[];
  /** 같은 계보에서 핸들이 같고 바뀐 쌍 [지금, 이전] */
  modified: [string, string][];
  /** 새로 생긴 것(바뀐 쌍 제외) */
  added: string[];
  /** 지운 것(바뀐 쌍 제외) */
  removed: string[];
  /** 차이 없는 쌍 수 */
  same: number;
  sameLineage: boolean;
  /** 비교하지 않은 객체 수(문자·해치 필터) */
  filtered: number;
}

/** 이전 버전(prev)과 지금 버전(cur)의 모형 공간을 비교해 나눈다 */
export function diffXrefVersions(prev: CadDocument, cur: CadDocument, opt: CompareOptions): XrefDiff {
  const r = compareDrawings(cur, prev, opt);
  const newOnly = new Set(r.onlyCurrent);
  const modNew = new Set(r.modified.map((m) => m[0]));
  const modOld = new Set(r.modified.map((m) => m[1]));
  const commonNew = spaceEntities(cur)
    .filter((e) => e.type !== 'VIEWPORT' && !newOnly.has(e.handle))
    .map((e) => e.handle);
  return {
    onlyNew: r.onlyCurrent,
    onlyOld: r.onlyCompare,
    commonNew,
    modified: r.modified,
    added: r.onlyCurrent.filter((h) => !modNew.has(h)),
    removed: r.onlyCompare.filter((h) => !modOld.has(h)),
    same: r.common,
    sameLineage: r.sameLineage,
    filtered: r.filtered.current + r.filtered.compare,
  };
}

/** 두 버전이 같은지(다시 로드할 때 알림을 띄울지) */
export function xrefChanged(d: XrefDiff): boolean {
  return d.onlyNew.length > 0 || d.onlyOld.length > 0;
}

/** 호스트 모형 공간의 그 외부 참조 블록 참조(최상위) */
export function xrefInserts(host: CadDocument, blockKey: string, space = MODEL_SPACE): InsertEntity[] {
  const key = tableKey(blockKey);
  return (host.blocks.get(tableKey(space))?.entities ?? []).filter((e): e is InsertEntity => e.type === 'INSERT' && tableKey(e.block) === key);
}

/** 호스트 도면의 외부 참조 블록 이름들(대문자 키) */
export function xrefBlockKeys(host: CadDocument): string[] {
  const out: string[] = [];
  for (const [k, b] of host.blocks) if (b.flags & 4) out.push(k);
  return out;
}

/** 블록 참조 행렬(블록 좌표 → WCS, 2D). 돌출 방향이 −Z면 X를 뒤집는다(임의 축 규칙) */
export function placementMatrix(basePoint: { x: number; y: number }, ins: Pick<InsertEntity, 'insert' | 'scale' | 'rotation' | 'extrusion'>): Affine {
  const c = Math.cos(ins.rotation);
  const s = Math.sin(ins.rotation);
  const sx = ins.scale.x;
  const sy = ins.scale.y;
  // OCS: T(insert)·R(rot)·S(sx, sy)·T(−base)
  const a = c * sx;
  const b = s * sx;
  const cc = -s * sy;
  const d = c * sy;
  const e = ins.insert.x - (a * basePoint.x + cc * basePoint.y);
  const f = ins.insert.y - (b * basePoint.x + d * basePoint.y);
  const m: Affine = [a, b, cc, d, e, f];
  const z = ins.extrusion?.z ?? 1;
  if (z < 0 && Math.abs(ins.extrusion?.x ?? 0) < 1e-9 && Math.abs(ins.extrusion?.y ?? 0) < 1e-9) return [-m[0], m[1], -m[2], m[3], -m[4], m[5]];
  return m;
}

export function applyAffine(m: Affine, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** 상자를 행렬로 옮긴 상자(네 구석의 범위) */
export function placeBox(b: Box, m: Affine): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of [
    [b.minX, b.minY],
    [b.maxX, b.minY],
    [b.maxX, b.maxY],
    [b.minX, b.maxY],
  ] as const) {
    const p = applyAffine(m, x, y);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/** 객체 상자(참조 파일 좌표). 계산할 수 없으면 null */
export function entityBox(e: Entity, doc: CadDocument): Box | null {
  try {
    const b = entityBounds(e, doc);
    return b && Number.isFinite(b.minX) && b.minX <= b.maxX && b.minY <= b.maxY ? { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY } : null;
  } catch {
    return null;
  }
}

/**
 * 차이 객체의 상자를 모든 자리로 옮긴다(변경 세트·구름은 이 상자들로 만든다).
 * 결과 순서: 자리마다 [지금 버전에만 …, 이전 버전에만 …]
 */
export function placedDiffBoxes(diff: Pick<XrefDiff, 'onlyNew' | 'onlyOld'>, cur: CadDocument, prev: CadDocument, placements: readonly Affine[]): (Box | null)[] {
  const local = [...diff.onlyNew.map((h) => [h, cur] as const), ...diff.onlyOld.map((h) => [h, prev] as const)].map(([h, doc]) => {
    const e = doc.entityIndex.get(h);
    return e ? entityBox(e, doc) : null;
  });
  const out: (Box | null)[] = [];
  for (const m of placements) for (const b of local) out.push(b ? placeBox(b, m) : null);
  return out;
}

/** 명령행 요약(한국어판 문구) */
export function xcompareSummary(d: Pick<XrefDiff, 'onlyNew' | 'onlyOld'>, sets: number): string {
  return `현재 외부 참조에서만 ${d.onlyNew.length}개, 현재 외부 참조에 없음 ${d.onlyOld.length}개, 변경 세트 ${sets}개.`;
}

/**
 * 호스트 객체 흐리게(XCOMPARECOLORMODE 1): 스타일 자료의 색을 회색조로 바꾸고 배경 쪽으로 섞는다(사본).
 * 항목마다 8칸(r, g, b, a, 선가중치, 보임, …). fade는 배경과 섞는 비율(0~1).
 */
export function fadeStyles(data: Float32Array, bg: number, fade = 0.55, gray = true): Float32Array {
  const out = new Float32Array(data);
  const br = ((bg >> 16) & 255) / 255;
  const bgG = ((bg >> 8) & 255) / 255;
  const bb = (bg & 255) / 255;
  for (let o = 0; o + 7 < out.length; o += 8) {
    let r = out[o]!;
    let g = out[o + 1]!;
    let b = out[o + 2]!;
    if (gray) r = g = b = 0.299 * r + 0.587 * g + 0.114 * b;
    out[o] = r + (br - r) * fade;
    out[o + 1] = g + (bgG - g) * fade;
    out[o + 2] = b + (bb - b) * fade;
  }
  return out;
}
