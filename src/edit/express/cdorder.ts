/**
 * CDORDER(Express Tools 색상별 그리기 순서) 계산(UI 없음).
 * 고른 객체를 색상 순서대로 다시 놓는다: 목록 위쪽 색이 앞(나중에 그려 위에 보인다).
 * 같은 색끼리는 원래 순서를 지킨다. 고른 객체 묶음은 다른 객체들의 맨 앞(F) 또는 맨 뒤(B)로 간다.
 * 색은 화면에 보이는 색(ByLayer는 도면층 색, ByBlock은 7)으로 묶는다.
 */
import type { CadColor, CadDocument, Entity } from '../../core/model';
import { tableKey } from '../../core/model';
import type { EditOp } from '../session';

/** 색 열쇠: 'aci:N' 또는 'rgb:RRGGBB' */
export function colorKey(c: CadColor): string {
  if (c.rgb !== undefined && c.aci !== 0 && c.aci !== 256) return `rgb:${(c.rgb & 0xffffff).toString(16).padStart(6, '0').toUpperCase()}`;
  return `aci:${c.aci}`;
}

/** 보이는 색의 열쇠(ByLayer → 도면층 색, ByBlock → 7) */
export function displayColorKey(e: Entity, doc: CadDocument): string {
  let c = e.color;
  if (c.aci === 256) c = doc.layers.get(tableKey(e.layer))?.color ?? { aci: 7 };
  if (c.aci === 0) c = { aci: 7 };
  return colorKey({ ...c, aci: Math.abs(c.aci) });
}

const ACI_NAME: Record<number, string> = { 1: '빨간색', 2: '노란색', 3: '초록색', 4: '하늘색', 5: '파란색', 6: '선홍색', 7: '흰색' };

/** 색 열쇠의 이름 */
export function colorKeyLabel(key: string): string {
  if (key.startsWith('rgb:')) {
    const v = parseInt(key.slice(4), 16);
    return `트루컬러 ${(v >> 16) & 255},${(v >> 8) & 255},${v & 255}`;
  }
  const n = Number(key.slice(4));
  return ACI_NAME[n] ? `${ACI_NAME[n]} (${n})` : `색상 ${n}`;
}

/** 고른 객체들의 색 열쇠(기본 순서: ACI 번호, 그다음 트루컬러) */
export function colorsOf(list: readonly Entity[], doc: CadDocument): string[] {
  const keys = [...new Set(list.map((e) => displayColorKey(e, doc)))];
  const rank = (k: string) => (k.startsWith('aci:') ? Number(k.slice(4)) : 1000 + parseInt(k.slice(4), 16) / 0x1000000);
  return keys.sort((a, b) => rank(a) - rank(b));
}

/**
 * 블록(공간) 하나의 새 순서. order = 색 열쇠 목록(위쪽이 앞). placement F = 맨 앞, B = 맨 뒤.
 * 바뀌지 않으면 null.
 */
export function cdorderList(entities: readonly Entity[], selected: ReadonlySet<string>, keyOf: (e: Entity) => string, order: readonly string[], placement: 'F' | 'B'): Entity[] | null {
  const picked = entities.filter((e) => selected.has(e.handle));
  if (!picked.length) return null;
  const rest = entities.filter((e) => !selected.has(e.handle));
  const pos = new Map(order.map((k, i) => [k, i] as const));
  // 그리는 순서: 목록 아래쪽 색부터(먼저 그린 것이 뒤에 깔린다)
  const rank = (e: Entity) => -(pos.get(keyOf(e)) ?? order.length);
  const sorted = picked.map((e, i) => ({ e, i })).sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i).map((x) => x.e);
  const next = placement === 'F' ? [...rest, ...sorted] : [...sorted, ...rest];
  return next.every((e, i) => e === entities[i]) ? null : next;
}

/**
 * 새 순서를 만드는 작업(DRAWORDER와 같은 방식): 고른 객체를 뒤에서부터 빼고, 정한 순서대로 맨 앞(F)·맨 뒤(B) 자리에 넣는다.
 * after는 cdorderList의 결과다.
 */
export function reorderOps(block: string, before: readonly Entity[], selected: ReadonlySet<string>, after: readonly Entity[], placement: 'F' | 'B'): EditOp[] {
  const ops: EditOp[] = [];
  for (let i = before.length - 1; i >= 0; i--) if (selected.has(before[i]!.handle)) ops.push({ kind: 'remove', block, entity: before[i]!, index: i });
  const n = after.filter((e) => selected.has(e.handle)).length;
  const at = placement === 'F' ? after.length - n : 0;
  for (let j = 0; j < n; j++) ops.push({ kind: 'add', block, entity: after[at + j]!, index: at + j });
  return ops;
}
