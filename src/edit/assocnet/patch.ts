/**
 * 연관 망 객체를 고치는 편집 작업 모음(이미 있는 작업 위에 겹쳐 쓴다).
 * 같은 트랜잭션 안의 앞선 작업이 바꾼 객체는 그 결과(after)를 보고 고치며, 같은 객체를 두 번 바꾸지 않고 한 작업으로 합친다.
 */
import type { CadDocument, CadObject, Entity, GenericObject, RawTag } from '../../core/model';
import { normalizeHandle } from '../../core/model';
import type { EditOp } from '../session';

export class AssocPatch {
  readonly ops: EditOp[];
  constructor(
    readonly doc: CadDocument,
    ops: readonly EditOp[] = [],
  ) {
    this.ops = [...ops];
  }

  private objOp(h: string): Extract<EditOp, { kind: 'object' }> | undefined {
    const k = normalizeHandle(h);
    for (let i = this.ops.length - 1; i >= 0; i--) {
      const op = this.ops[i]!;
      if (op.kind === 'object' && normalizeHandle(op.key) === k) return op;
    }
    return undefined;
  }

  /** 지금(앞선 작업을 반영한) 객체 */
  obj(h: string | undefined): CadObject | undefined {
    if (!h) return undefined;
    const op = this.objOp(h);
    if (op) return op.after ?? undefined;
    return this.doc.objects.get(normalizeHandle(h));
  }

  /** 지금 객체의 원본 태그를 바꾼다 */
  setRaw(h: string, raw: RawTag[]): void {
    const cur = this.obj(h) as GenericObject | undefined;
    if (!cur) return;
    const after = { ...cur, raw } as GenericObject;
    delete after.dwgRaw;
    this.setObj(h, after);
  }

  setObj(h: string, after: CadObject | null): void {
    const op = this.objOp(h);
    if (op) {
      op.after = after;
      return;
    }
    const k = normalizeHandle(h);
    const before = this.doc.objects.get(k) ?? null;
    if (!before && !after) return;
    this.ops.push({ kind: 'object', key: k, before, after });
  }

  deleteObj(h: string | undefined): void {
    if (!h || !this.obj(h)) return;
    this.setObj(h, null);
  }

  /** 엔티티가 이 작업 모음에서 지워지는지 */
  entityRemoved(h: string): boolean {
    const k = normalizeHandle(h);
    let removed = false;
    for (const op of this.ops) {
      if (op.kind === 'remove' && op.entity.handle === k) removed = true;
      else if (op.kind === 'add' && op.entity.handle === k) removed = false;
    }
    return removed;
  }

  /** 지금(작업을 반영한) 엔티티 */
  entity(h: string): Entity | undefined {
    const k = normalizeHandle(h);
    let e = this.doc.entityIndex.get(k);
    for (const op of this.ops) {
      if (op.kind === 'modify' && op.after.handle === k) e = op.after;
      else if (op.kind === 'add' && op.entity.handle === k) e = op.entity;
      else if (op.kind === 'remove' && op.entity.handle === k) e = undefined;
    }
    return e;
  }

  /** 엔티티를 지운다(이미 지웠으면 그대로) */
  removeEntity(h: string): void {
    const k = normalizeHandle(h);
    if (this.entityRemoved(k)) return;
    for (const [bk, b] of this.doc.blocks) {
      const i = b.entities.findIndex((e) => e.handle === k);
      if (i >= 0) {
        this.ops.push({ kind: 'remove', block: bk, entity: this.entity(k) ?? b.entities[i]!, index: i });
        return;
      }
    }
  }

  /** 엔티티를 바꾼다(앞선 수정 작업이 있으면 그 결과를 바꾼다) */
  modifyEntity(after: Entity): void {
    const k = after.handle;
    for (let i = this.ops.length - 1; i >= 0; i--) {
      const op = this.ops[i]!;
      if (op.kind === 'modify' && op.after.handle === k) {
        op.after = after;
        return;
      }
    }
    for (const [bk, b] of this.doc.blocks) {
      const before = b.entities.find((e) => e.handle === k);
      if (before) {
        this.ops.push({ kind: 'modify', block: bk, before, after });
        return;
      }
    }
  }
}
