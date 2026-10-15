/**
 * 도면층 이전(LAYERP)의 기록: 도면층 설정(켜기·동결·잠금·색·선종류·선가중치·플롯·투명도·플롯 스타일·설명·새 VP 동결)
 * 변경을 한 단계씩 되돌린다. AutoCAD처럼 이름 바꾸기·지운 도면층·새 도면층은 되돌리지 않는다
 * (이름을 바꾸면서 특성도 바꿨으면 특성만 되돌리고 이름은 그대로 둔다).
 *
 * 현재 도면층($CLAYER) 변경도 한 단계로 기록해 되돌린다.
 * 기록은 확정된 트랜잭션의 'layer'·'header'($CLAYER) 작업에서 모은다(앞 상태가 작업에 들어 있다). 도면층은 핸들로 찾고
 * (이름이 바뀌어도 따라간다), 핸들이 없으면 이름으로 찾는다.
 */
import type { CadDocument, Layer } from '../../core/model';
import { normalizeHandle, tableKey } from '../../core/model';
import type { EditOp, Transaction } from '../session';

/** LAYERP가 되돌리는 도면층 특성 */
export const LAYER_PREVIOUS_PROPS = ['off', 'frozen', 'locked', 'color', 'linetype', 'lineweight', 'plot', 'transparency', 'plotStyle', 'description', 'flags'] as const;
type Prop = (typeof LAYER_PREVIOUS_PROPS)[number];

export interface LayerPreviousStep {
  label: string;
  /** 같은 명령(트랜잭션 묶음)의 변경을 한 단계로 */
  group?: number;
  /** 도면층 열쇠(핸들 또는 `name:대문자 이름`) → 바뀌기 전 도면층 */
  before: Map<string, Layer>;
  /** 바뀌기 전 현재 도면층 이름(현재 도면층이 바뀌었을 때) */
  clayer?: string;
}

const idOf = (l: Layer): string => (l.handle ? `h:${normalizeHandle(l.handle)}` : `name:${tableKey(l.name)}`);

function sameProps(a: Layer, b: Layer): boolean {
  for (const p of LAYER_PREVIOUS_PROPS) if (JSON.stringify(a[p] ?? null) !== JSON.stringify(b[p] ?? null)) return false;
  return true;
}

/** 트랜잭션의 도면층 설정 변경(바뀌기 전 값). 새 도면층·지운 도면층은 빼고, 이름 바꾸기는 특성이 바뀐 때만 */
export function layerSettingChanges(ops: readonly EditOp[]): Map<string, Layer> {
  const out = new Map<string, Layer>();
  const removed = new Map<string, Layer>();
  const added = new Map<string, Layer>();
  for (const op of ops) {
    if (op.kind !== 'layer') continue;
    if (op.before && op.after) {
      if (!sameProps(op.before, op.after) && !out.has(idOf(op.before))) out.set(idOf(op.before), op.before);
    } else if (op.before && op.before.handle) removed.set(normalizeHandle(op.before.handle), op.before);
    else if (op.after && op.after.handle) added.set(normalizeHandle(op.after.handle), op.after);
  }
  // 이름 바꾸기: 같은 핸들이 지워지고 새로 생긴 것
  for (const [h, b] of removed) {
    const a = added.get(h);
    if (a && !sameProps(b, a) && !out.has(`h:${h}`)) out.set(`h:${h}`, b);
  }
  return out;
}

/** 도면층 이전 기록(문서 하나) */
export class LayerPreviousLog {
  private readonly steps: LayerPreviousStep[] = [];

  constructor(readonly limit = 200) {}

  /** 트랜잭션을 기록한다(도면층 설정 변경이 없으면 아무것도 하지 않는다) */
  record(tx: Transaction): boolean {
    const before = layerSettingChanges(tx.ops);
    const cl = tx.ops.find((o) => o.kind === 'header' && o.name === '$CLAYER' && o.before !== o.after);
    const clayer = cl && cl.kind === 'header' ? String(cl.before ?? '0') : undefined;
    if (!before.size && clayer === undefined) return false;
    const top = this.steps[this.steps.length - 1];
    if (tx.group !== undefined && top && top.group === tx.group) {
      // 같은 명령의 다음 단계: 처음 값을 남긴다
      for (const [k, l] of before) if (!top.before.has(k)) top.before.set(k, l);
      if (top.clayer === undefined && clayer !== undefined) top.clayer = clayer;
      return true;
    }
    const step: LayerPreviousStep = { label: tx.label, group: tx.group, before };
    if (clayer !== undefined) step.clayer = clayer;
    this.steps.push(step);
    if (this.steps.length > this.limit) this.steps.shift();
    return true;
  }

  pop(): LayerPreviousStep | undefined {
    return this.steps.pop();
  }

  clear(): void {
    this.steps.length = 0;
  }

  get size(): number {
    return this.steps.length;
  }
}

/** 지금 도면에서 그 도면층(핸들 → 이름 순으로 찾는다) */
function layerNow(doc: CadDocument, id: string, before: Layer): Layer | null {
  if (id.startsWith('h:')) {
    const h = id.slice(2);
    for (const l of doc.layers.values()) if (l.handle && normalizeHandle(l.handle) === h) return l;
    return null;
  }
  return doc.layers.get(tableKey(before.name)) ?? null;
}

/** 한 단계를 되돌리는 작업(이름은 지금 이름을 둔다). 없어진 도면층은 건너뛴다 */
export function layerPreviousOps(doc: CadDocument, step: LayerPreviousStep): EditOp[] {
  const ops: EditOp[] = [];
  for (const [id, b] of step.before) {
    const now = layerNow(doc, id, b);
    if (!now) continue;
    const after: Layer = structuredClone(now);
    for (const p of LAYER_PREVIOUS_PROPS) {
      const v = b[p as Prop];
      if (v === undefined) delete (after as unknown as Record<string, unknown>)[p];
      else (after as unknown as Record<string, unknown>)[p] = structuredClone(v);
    }
    if (JSON.stringify(after) === JSON.stringify(now)) continue;
    ops.push({ kind: 'layer', key: tableKey(now.name), before: now, after });
  }
  // 현재 도면층(있고, 되돌린 뒤 동결되지 않으면)
  if (step.clayer !== undefined) {
    const cur = doc.header.get('$CLAYER');
    const L = doc.layers.get(tableKey(step.clayer));
    const k = tableKey(step.clayer);
    let frozenAfter = L?.frozen ?? false;
    for (const o of ops) if (o.kind === 'layer' && o.key === k && o.after) frozenAfter = o.after.frozen;
    if (L && !frozenAfter && (typeof cur !== 'string' || tableKey(cur) !== tableKey(L.name))) ops.push({ kind: 'header', name: '$CLAYER', before: cur, after: L.name });
  }
  return ops;
}
