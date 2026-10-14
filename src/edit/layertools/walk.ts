/**
 * 도면층 탐색(LAYWALK)의 순수 함수: 필터, 참조되지 않은 도면층, 보일 도면층, 소거.
 * 화면 표시만 바꾸는 부분은 src/app/laywalk.ts가 한다.
 */
import type { CadDocument } from '../../core/model';
import { tableKey } from '../../core/model';
import type { EditOp } from '../session';
import { wcmatch } from '../util/wildcard';

/** 필터(와일드카드, 쉼표로 여러 개)에 맞는 이름. 비었거나 `*`이면 모두 */
export function filterLayerNames(names: readonly string[], filter: string): string[] {
  const f = filter.trim();
  if (!f || f === '*') return [...names];
  return names.filter((n) => wcmatch(n, f));
}

/** 도면층별 객체 수(모든 공간·블록 정의, 블록 참조의 속성 포함). 열쇠는 대문자 이름 */
export function layerObjectCounts(doc: CadDocument): Map<string, number> {
  const out = new Map<string, number>();
  const add = (n: string) => {
    const k = tableKey(n);
    out.set(k, (out.get(k) ?? 0) + 1);
  };
  for (const b of doc.blocks.values()) {
    if (b.flags & 4) continue;
    for (const e of b.entities) {
      add(e.layer);
      if (e.type === 'INSERT') for (const a of e.attribs) add(a.layer);
    }
  }
  return out;
}

/** 소거할 수 없으면 까닭 */
export function cannotPurgeLayer(doc: CadDocument, name: string, current: string, counts = layerObjectCounts(doc)): string | null {
  const k = tableKey(name);
  if (k === '0') return '도면층 0은 소거할 수 없습니다.';
  if (k === 'DEFPOINTS') return 'Defpoints 도면층은 소거할 수 없습니다.';
  if (k === tableKey(current)) return '현재 도면층은 소거할 수 없습니다.';
  if (k.includes('|') || (doc.layers.get(k)?.flags ?? 0) & 16) return '외부 참조 종속 도면층은 소거할 수 없습니다.';
  if ((counts.get(k) ?? 0) > 0) return '객체가 있는 도면층은 소거할 수 없습니다.';
  return null;
}

/** 참조되지 않은(소거할 수 있는) 도면층 이름 */
export function unreferencedLayers(doc: CadDocument, current: string): string[] {
  const counts = layerObjectCounts(doc);
  return [...doc.layers.values()].filter((l) => !cannotPurgeLayer(doc, l.name, current, counts)).map((l) => l.name);
}

/** 화면에 보일 도면층(대문자): 고른 것과 선택 유지한 것 */
export function walkVisibleKeys(selected: Iterable<string>, held: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const n of selected) out.add(tableKey(n));
  for (const n of held) out.add(tableKey(n));
  return out;
}

/** 고른 도면층 가운데 소거할 수 있는 것을 지우는 작업 */
export function purgeLayersOps(doc: CadDocument, names: readonly string[], current: string): { ops: EditOp[]; purged: string[]; refused: { name: string; reason: string }[] } {
  const counts = layerObjectCounts(doc);
  const ops: EditOp[] = [];
  const purged: string[] = [];
  const refused: { name: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    const k = tableKey(n);
    if (seen.has(k)) continue;
    seen.add(k);
    const before = doc.layers.get(k);
    if (!before) continue;
    const why = cannotPurgeLayer(doc, n, current, counts);
    if (why) {
      refused.push({ name: before.name, reason: why });
      continue;
    }
    ops.push({ kind: 'layer', key: k, before, after: null });
    purged.push(before.name);
  }
  return { ops, purged, refused };
}

/** 종료 시 복원을 끈 채 닫을 때: 보이는 도면층은 켜고(동결 해제) 나머지는 끄는 패치(바뀌는 것만) */
export function walkKeepPatches(doc: CadDocument, visible: ReadonlySet<string>): [string, { off: boolean; frozen?: boolean }][] {
  const out: [string, { off: boolean; frozen?: boolean }][] = [];
  for (const l of doc.layers.values()) {
    const show = visible.has(tableKey(l.name));
    if (show && (l.off || l.frozen)) out.push([l.name, { off: false, frozen: false }]);
    else if (!show && !l.off) out.push([l.name, { off: true }]);
  }
  return out;
}
