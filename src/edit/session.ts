/**
 * 편집 세션: 문서에 변경을 적용하고 되돌린다(U·REDO).
 * 메인 스레드와 엔진 워커가 같은 변경을 같은 순서로 적용해 두 문서를 맞춘다.
 *
 * 변경 = 작업(op) 목록. 각 작업은 앞뒤 상태를 모두 담아 되돌리기가 그대로 반대 작업이다.
 */
import type { BlockDef, BlockRecord, CadDocument, CadObject, Entity, HeaderValue, Layer, Layout, LayoutObject, Linetype, TableHead, TableRecordBase, TextStyle, DimStyle, UcsRecord, ViewRecord, VPortRecord } from '../core/model';
import { tableKey, normalizeHandle } from '../core/model';

export type EditOp =
  /** 블록(공간) block의 index 자리에 객체를 넣는다(index 없으면 끝) */
  | { kind: 'add'; block: string; entity: Entity; index?: number }
  /** 블록에서 객체를 뺀다(되돌릴 때 같은 자리에 넣는다) */
  | { kind: 'remove'; block: string; entity: Entity; index: number }
  /** 같은 핸들의 객체를 바꾼다 */
  | { kind: 'modify'; block: string; before: Entity; after: Entity }
  | { kind: 'layer'; key: string; before: Layer | null; after: Layer | null }
  | { kind: 'linetype'; key: string; before: Linetype | null; after: Linetype | null }
  | { kind: 'textStyle'; key: string; before: TextStyle | null; after: TextStyle | null }
  | { kind: 'dimStyle'; key: string; before: DimStyle | null; after: DimStyle | null }
  /** 명명된 뷰(VIEW 표). key = 이름(대문자) */
  | { kind: 'view'; key: string; before: ViewRecord | null; after: ViewRecord | null }
  /** 이름 붙은 UCS(UCS 표). key = 이름(대문자) */
  | { kind: 'ucs'; key: string; before: UcsRecord | null; after: UcsRecord | null }
  /** 뷰포트 표 전체(타일 뷰포트 *ACTIVE와 이름 있는 구성) */
  | { kind: 'vports'; before: VPortRecord[]; after: VPortRecord[] }
  | { kind: 'blockDef'; key: string; before: BlockDef | null; after: BlockDef | null }
  | { kind: 'blockRecord'; key: string; before: BlockRecord | null; after: BlockRecord | null }
  /** 객체(사전·배치·이미지 정의 등). key = 핸들 */
  | { kind: 'object'; key: string; before: CadObject | null; after: CadObject | null }
  | { kind: 'header'; name: string; before: HeaderValue | undefined; after: HeaderValue | undefined }
  /** 배치(모형·종이 공간 탭). key = 배치 블록 이름(대문자). 같은 핸들의 LAYOUT 객체도 맞춘다 */
  | { kind: 'layout'; key: string; before: Layout | null; after: Layout | null }
  /** 표 머리(TABLE 제어 객체: 확장 사전 등). key = 표 이름(LAYER …) */
  | { kind: 'tableHead'; key: string; before: TableHead | null; after: TableHead | null }
  /** 등록한 앱 이름(APPID 표: regapp·확장 데이터). key = 이름(대문자) */
  | { kind: 'appId'; key: string; before: TableRecordBase | null; after: TableRecordBase | null };

export interface Transaction {
  /** 명령 이름(명령 취소 메시지용) */
  label: string;
  ops: EditOp[];
  /** 같은 묶음 번호의 연속 트랜잭션은 명령 취소 때 하나로 되돌린다(명령 하나 안의 여러 단계) */
  group?: number;
  /** 그리기 순서처럼 덧그림으로 바로 보일 수 없는 변경: 곧바로 다시 그린다 */
  rebuildNow?: boolean;
}

/** 변경이 화면에 미치는 범위 */
export interface ChangeSummary {
  /** 공간 블록 키(대문자) → 바뀐 핸들(추가·삭제·수정) */
  spaces: Map<string, { removed: Set<string>; changed: Entity[] }>;
  /** 블록 정의가 바뀌었으면(블록 참조 다시 그리기 필요) */
  blocksChanged: boolean;
  /** 선종류·문자 스타일·치수 스타일이 바뀌었거나 도면층이 생기고 없어졌으면(다시 그리기 필요) */
  tablesChanged: boolean;
  /** 도면층 상태(켜기·동결·색 등)가 바뀌었으면(스타일 표만 다시 만들면 된다) */
  layersChanged: boolean;
  /** 배치가 생기거나 없어지거나 바뀌었으면(배치 탭·용지) */
  layoutsChanged?: boolean;
}

function invert(op: EditOp): EditOp {
  switch (op.kind) {
    case 'add':
      return { kind: 'remove', block: op.block, entity: op.entity, index: op.index ?? -1 };
    case 'remove':
      return { kind: 'add', block: op.block, entity: op.entity, index: op.index };
    case 'modify':
      return { kind: 'modify', block: op.block, before: op.after, after: op.before };
    case 'header':
      return { kind: 'header', name: op.name, before: op.after, after: op.before };
    default:
      return { ...op, before: op.after, after: op.before } as EditOp;
  }
}

export function inverseTransaction(tx: Transaction): Transaction {
  return { label: tx.label, ops: tx.ops.map(invert).reverse(), rebuildNow: tx.rebuildNow };
}

function indexEntity(doc: CadDocument, e: Entity, on: boolean): void {
  if (on) {
    if (e.handle) doc.entityIndex.set(e.handle, e);
    if (e.type === 'INSERT') for (const a of e.attribs) if (a.handle) doc.entityIndex.set(a.handle, a);
  } else {
    if (e.handle) doc.entityIndex.delete(e.handle);
    if (e.type === 'INSERT') for (const a of e.attribs) if (a.handle) doc.entityIndex.delete(a.handle);
  }
}

/** 변경 하나를 문서에 적용한다(되돌릴 때는 inverse를 적용한다) */
export function applyOps(doc: CadDocument, ops: readonly EditOp[], summary?: ChangeSummary): void {
  const space = (key: string) => {
    if (!summary) return null;
    // 블록 정의 안의 객체가 바뀌면 그 블록을 참조하는 곳을 다시 그려야 한다(블록 편집기에서는 그 블록도 공간처럼 덧그린다)
    if (!isLayoutBlock(key)) summary.blocksChanged = true;
    let s = summary.spaces.get(key);
    if (!s) {
      s = { removed: new Set(), changed: [] };
      summary.spaces.set(key, s);
    }
    return s;
  };
  for (const op of ops) {
    switch (op.kind) {
      case 'add': {
        const b = doc.blocks.get(op.block);
        if (!b) throw new Error(`블록이 없습니다: ${op.block}`);
        const i = op.index === undefined || op.index < 0 || op.index > b.entities.length ? b.entities.length : op.index;
        b.entities.splice(i, 0, op.entity);
        indexEntity(doc, op.entity, true);
        space(op.block)?.changed.push(op.entity);
        break;
      }
      case 'remove': {
        const b = doc.blocks.get(op.block);
        if (!b) break;
        let i = op.index >= 0 && b.entities[op.index]?.handle === op.entity.handle ? op.index : b.entities.findIndex((e) => e.handle === op.entity.handle);
        if (i < 0) i = b.entities.indexOf(op.entity);
        if (i >= 0) b.entities.splice(i, 1);
        indexEntity(doc, op.entity, false);
        space(op.block)?.removed.add(op.entity.handle);
        break;
      }
      case 'modify': {
        const b = doc.blocks.get(op.block);
        if (!b) break;
        const i = b.entities.findIndex((e) => e.handle === op.before.handle);
        if (i >= 0) b.entities[i] = op.after;
        indexEntity(doc, op.before, false);
        indexEntity(doc, op.after, true);
        const s = space(op.block);
        if (s) {
          s.removed.add(op.before.handle);
          s.changed.push(op.after);
        }
        break;
      }
      case 'layer':
        if (op.after) doc.layers.set(op.key, op.after);
        else doc.layers.delete(op.key);
        if (summary) {
          summary.layersChanged = true;
          // 선종류가 바뀌거나 도면층이 생기고 없어지면 선 무늬를 다시 만들어야 한다
          if (!op.before || !op.after || op.before.linetype !== op.after.linetype) summary.tablesChanged = true;
        }
        break;
      case 'linetype':
        if (op.after) doc.linetypes.set(op.key, op.after);
        else doc.linetypes.delete(op.key);
        if (summary) summary.tablesChanged = true;
        break;
      case 'textStyle':
        if (op.after) doc.textStyles.set(op.key, op.after);
        else doc.textStyles.delete(op.key);
        if (summary) summary.tablesChanged = true;
        break;
      case 'dimStyle':
        if (op.after) doc.dimStyles.set(op.key, op.after);
        else doc.dimStyles.delete(op.key);
        if (summary) summary.tablesChanged = true;
        break;
      case 'view':
        if (op.after) doc.views.set(op.key, op.after);
        else doc.views.delete(op.key);
        break;
      case 'ucs':
        if (op.after) doc.ucs.set(op.key, op.after);
        else doc.ucs.delete(op.key);
        break;
      case 'vports':
        doc.vports.splice(0, doc.vports.length, ...op.after);
        break;
      case 'blockDef': {
        if (op.before) for (const e of op.before.entities) indexEntity(doc, e, false);
        if (op.after) {
          doc.blocks.set(op.key, op.after);
          for (const e of op.after.entities) indexEntity(doc, e, true);
        } else doc.blocks.delete(op.key);
        if (summary) summary.blocksChanged = true;
        break;
      }
      case 'blockRecord':
        if (op.after) doc.blockRecords.set(op.key, op.after);
        else doc.blockRecords.delete(op.key);
        break;
      case 'object':
        if (op.after) doc.objects.set(op.key, op.after);
        else doc.objects.delete(op.key);
        break;
      case 'tableHead':
        if (op.after) (doc.tableHeads ??= new Map()).set(op.key, op.after);
        else doc.tableHeads?.delete(op.key);
        break;
      case 'appId':
        if (op.after) doc.appIds.set(op.key, op.after);
        else doc.appIds.delete(op.key);
        break;
      case 'header':
        if (op.after === undefined) doc.header.delete(op.name);
        else doc.header.set(op.name, op.after);
        break;
      case 'layout': {
        const i = doc.layouts.findIndex((l) => tableKey(l.blockName) === op.key);
        if (op.after) {
          if (i >= 0) doc.layouts[i] = op.after;
          else doc.layouts.push(op.after);
          const obj = doc.objects.get(op.after.handle);
          if (obj?.type === 'LAYOUT') doc.objects.set(op.after.handle, { ...(obj as LayoutObject), layout: op.after });
        } else if (i >= 0) doc.layouts.splice(i, 1);
        doc.layouts.sort((a, b) => a.tabOrder - b.tabOrder);
        if (summary) summary.layoutsChanged = true;
        break;
      }
    }
  }
}

/** 모형·배치 공간 블록인지 */
export function isLayoutBlock(key: string): boolean {
  return /^\*(MODEL|PAPER)_SPACE/i.test(key);
}

export function emptySummary(): ChangeSummary {
  return { spaces: new Map(), blocksChanged: false, tablesChanged: false, layersChanged: false };
}

/** 객체가 들어 있는 블록 키 */
export function ownerBlockKey(doc: CadDocument, handle: string): string | null {
  for (const [k, b] of doc.blocks) if (b.entities.some((e) => e.handle === handle)) return k;
  return null;
}

/**
 * 편집 세션: 명령 하나 = 트랜잭션 하나. 되돌리기·다시 하기 목록을 가진다.
 */
export class EditSession {
  private readonly undoStack: Transaction[] = [];
  private readonly redoStack: Transaction[] = [];
  /** 저장한 뒤 바뀌었는지 */
  dirty = false;
  private savedDepth = 0;
  private ownerCache: Map<string, string> | null = null;

  constructor(
    readonly doc: CadDocument,
    /** 문서에 적용된 변경을 다른 쪽(화면·워커)에 알린다 */
    private readonly onApply: (tx: Transaction, summary: ChangeSummary) => void,
  ) {}

  /** 새 핸들($HANDSEED에서 하나씩) */
  newHandle(): string {
    const seed = this.doc.header.get('$HANDSEED');
    let next = 0n;
    try {
      next = BigInt('0x' + (typeof seed === 'string' && seed ? seed : '0'));
    } catch {
      next = 0n;
    }
    // 이미 쓰인 핸들과 겹치지 않게 한다
    if (next === 0n || this.doc.entityIndex.has(normalizeHandle(next.toString(16))) || this.doc.objects.has(normalizeHandle(next.toString(16)))) {
      let max = 0n;
      for (const h of this.doc.entityIndex.keys()) {
        try {
          const v = BigInt('0x' + h);
          if (v > max) max = v;
        } catch {
          /* 무시 */
        }
      }
      for (const h of this.doc.objects.keys()) {
        try {
          const v = BigInt('0x' + h);
          if (v > max) max = v;
        } catch {
          /* 무시 */
        }
      }
      for (const b of this.doc.blocks.values()) {
        for (const h of [b.handle, b.recordHandle, b.endHandle ?? '']) {
          if (!h) continue;
          try {
            const v = BigInt('0x' + h);
            if (v > max) max = v;
          } catch {
            /* 무시 */
          }
        }
      }
      if (next <= max) next = max + 1n;
    }
    const h = normalizeHandle(next.toString(16));
    this.doc.header.set('$HANDSEED', normalizeHandle((next + 1n).toString(16)));
    return h;
  }

  /** 블록 키(공간) */
  ownerOf(handle: string): string | null {
    if (!this.ownerCache) {
      this.ownerCache = new Map();
      for (const [k, b] of this.doc.blocks) for (const e of b.entities) if (e.handle) this.ownerCache.set(e.handle, k);
    }
    let k = this.ownerCache.get(handle);
    if (k && this.doc.blocks.get(k)?.entities.some((e) => e.handle === handle)) return k;
    k = ownerBlockKey(this.doc, handle) ?? undefined;
    if (k) this.ownerCache.set(handle, k);
    return k ?? null;
  }

  /** 커밋 직전에 트랜잭션을 고치는 고리(주석 축척: 새 주석 객체에 축척 레코드 붙이기 등) */
  beforeCommit: ((tx: Transaction) => Transaction) | null = null;
  /** 커밋 뒤(적용·알림 다음) 부르는 고리(도면층 이전 기록, 연관 배열 경로 따라가기 등). 여기서 다시 커밋해도 된다 */
  afterCommit: ((tx: Transaction) => void) | null = null;

  commit(tx: Transaction): void {
    if (this.beforeCommit && tx.ops.length) tx = this.beforeCommit(tx);
    if (!tx.ops.length) return;
    const summary = emptySummary();
    applyOps(this.doc, tx.ops, summary);
    for (const op of tx.ops) if ((op.kind === 'add' || op.kind === 'modify') && this.ownerCache) this.ownerCache.set(op.kind === 'add' ? op.entity.handle : op.after.handle, op.block);
    const top = this.undoStack[this.undoStack.length - 1];
    if (tx.group !== undefined && top && top.group === tx.group) top.ops.push(...tx.ops);
    else this.undoStack.push({ ...tx, ops: [...tx.ops] });
    if (this.undoStack.length > 500) this.undoStack.shift();
    this.redoStack.length = 0;
    this.dirty = true;
    this.onApply(tx, summary);
    this.afterCommit?.(tx);
  }

  /** 명령 안에서 마지막 단계만 되돌린다(LINE의 U 옵션 등). 되돌린 작업 수를 돌려준다 */
  undoLastStep(group: number, count: number): number {
    const top = this.undoStack[this.undoStack.length - 1];
    if (!top || top.group !== group || !count) return 0;
    const n = Math.min(count, top.ops.length);
    const ops = top.ops.splice(top.ops.length - n, n);
    if (!top.ops.length) this.undoStack.pop();
    const inv = inverseTransaction({ label: top.label, ops });
    const summary = emptySummary();
    applyOps(this.doc, inv.ops, summary);
    this.ownerCache = null;
    this.onApply(inv, summary);
    return n;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): Transaction | null {
    const tx = this.undoStack.pop();
    if (!tx) return null;
    const inv = inverseTransaction(tx);
    const summary = emptySummary();
    applyOps(this.doc, inv.ops, summary);
    this.redoStack.push(tx);
    this.dirty = this.undoStack.length !== this.savedDepth;
    this.ownerCache = null;
    this.onApply(inv, summary);
    return tx;
  }

  redo(): Transaction | null {
    const tx = this.redoStack.pop();
    if (!tx) return null;
    const summary = emptySummary();
    applyOps(this.doc, tx.ops, summary);
    this.undoStack.push(tx);
    this.dirty = this.undoStack.length !== this.savedDepth;
    this.ownerCache = null;
    this.onApply(tx, summary);
    return tx;
  }

  /** depth(앞서 읽은 깊이) 뒤에 쌓인 명령 취소 항목을 하나로 합친다(스크립트 한 번 = 명령 취소 한 번). 합친 항목 수 */
  squashUndo(depth: number, label: string): number {
    const from = Math.max(0, Math.min(depth, this.undoStack.length));
    const n = this.undoStack.length - from;
    if (n < 2) return n;
    const items = this.undoStack.splice(from, n);
    const tx: Transaction = { label, ops: items.flatMap((t) => t.ops) };
    if (items.some((t) => t.rebuildNow)) tx.rebuildNow = true;
    this.undoStack.push(tx);
    if (this.savedDepth === from + n) this.savedDepth = from + 1;
    else if (this.savedDepth > from) this.savedDepth = -1;
    return n;
  }

  /** 명령 취소 기록 깊이(블록 편집기에서 변경을 버릴 때 쓴다) */
  get depth(): number {
    return this.undoStack.length;
  }

  markSaved(): void {
    this.savedDepth = this.undoStack.length;
    this.dirty = false;
  }
}

/** 객체를 깊이 복사한다(편집 전 상태 보관용) */
export function cloneEntity<T extends Entity>(e: T): T {
  return structuredClone(e);
}

export { tableKey };
