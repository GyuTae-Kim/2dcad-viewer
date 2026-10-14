/**
 * 새 표 객체와 그림 블록(*T)을 만든다(핸들은 부르는 쪽이 붙인다).
 */
import type { BlockDef, CadDocument, Entity, EntityBase, InsertEntity, TableEntity, Vec3 } from '../../core/model';
import { entityDefaults, tableKey } from '../../core/model';
import type { TableStyle } from './style';
import type { TableData } from './model';
import { tableBlockEntities } from './geometry';
import { applyTableData } from './entity';

/** 아직 쓰이지 않은 익명 표 블록 이름(*T1, *T2 …) */
export function nextTableBlockName(doc: CadDocument, taken: ReadonlySet<string> = new Set()): string {
  let max = 0;
  for (const k of doc.blocks.keys()) {
    const m = /^\*T(\d+)$/i.exec(k);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = max + 1;
  while (doc.blocks.has(`*T${n}`) || taken.has(`*T${n}`)) n++;
  return `*T${n}`;
}

export interface NewTableParams {
  insert: Vec3;
  rotation?: number;
  blockName: string;
  props?: Partial<Omit<EntityBase, 'type' | 'handle'>>;
  styleHandle?: string;
}

/** 표 객체(블록 이름만 가리킨다) */
export function newTableEntity(t: TableData, p: NewTableParams): TableEntity {
  const rot = p.rotation ?? 0;
  const e: TableEntity = {
    ...entityDefaults(),
    ...(p.props ?? {}),
    type: 'ACAD_TABLE',
    handle: '',
    block: p.blockName,
    insert: { ...p.insert },
    direction: { x: Math.cos(rot), y: Math.sin(rot), z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    rotation: rot,
    rows: t.rows,
    columns: t.cols,
    rowHeights: [],
    columnWidths: [],
  };
  return applyTableData(e, t, p.styleHandle);
}

/** 그림 블록 정의(핸들 없음, 익명 플래그 1) */
export function newTableBlock(name: string, t: TableData, style: TableStyle): BlockDef {
  return { name, handle: '', recordHandle: '', basePoint: { x: 0, y: 0, z: 0 }, flags: 1, entities: tableBlockEntities(t, style) };
}

/** 표 그림 블록을 다른 객체도 쓰는지(쓰면 고칠 때 새 블록을 만든다) */
export function blockSharedBy(doc: CadDocument, blockName: string, self: string): boolean {
  const key = tableKey(blockName);
  for (const b of doc.blocks.values())
    for (const e of b.entities) {
      if (e.handle === self) continue;
      if ((e.type === 'ACAD_TABLE' || e.type === 'INSERT') && tableKey(e.block) === key) return true;
    }
  return false;
}

/** 표 확장 자료가 있는 블록 참조(DWG로 저장했다 연 표)를 다시 표 객체로 */
export function insertToTable(ins: InsertEntity, t: TableData, styleHandle: string | undefined): TableEntity {
  const { attribs: _a, columnCount: _c, rowCount: _r, columnSpacing: _cs, rowSpacing: _rs, ...rest } = ins;
  void _a;
  void _c;
  void _r;
  void _cs;
  void _rs;
  const rot = ins.rotation;
  const e: TableEntity = {
    ...(rest as Omit<InsertEntity, 'type' | 'attribs' | 'columnCount' | 'rowCount' | 'columnSpacing' | 'rowSpacing'>),
    type: 'ACAD_TABLE',
    direction: { x: Math.cos(rot), y: Math.sin(rot), z: 0 },
    rows: t.rows,
    columns: t.cols,
    rowHeights: [],
    columnWidths: [],
  } as TableEntity;
  return applyTableData(e, t, styleHandle);
}

export type { Entity };
