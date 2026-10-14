/**
 * 표·테이블 스타일 편집 작업(EditOp) 만들기. 문서는 바꾸지 않는다(세션이 적용한다).
 * newHandle은 세션의 핸들 발급기다.
 */
import type { BlockDef, BlockRecord, CadDocument, DictionaryObject, EntityBase, GenericObject, InsertEntity, TableEntity, Vec3 } from '../../core/model';
import { tableKey } from '../../core/model';
import type { EditOp } from '../session';
import { type TableStyle, docVersionNumber, listTableStyles, tableStyleDictionary, tableStyleRaw } from './style';
import type { TableData } from './model';
import { blockSharedBy, insertToTable, newTableBlock, newTableEntity, nextTableBlockName } from './build';
import { applyTableData, tableFromEntity } from './entity';
import { tableBlockEntities } from './geometry';

type NewHandle = () => string;

/** 그림 블록 정의·레코드 작업(reuse가 있으면 그 블록을 바꾼다) */
function blockOps(doc: CadDocument, nh: NewHandle, name: string, t: TableData, style: TableStyle, reuse: BlockDef | null): EditOp[] {
  const key = tableKey(name);
  const ops: EditOp[] = [];
  let recordHandle = reuse?.recordHandle || doc.blockRecords.get(key)?.handle;
  if (!recordHandle) {
    recordHandle = nh();
    const rec: BlockRecord = { name, handle: recordHandle, flags: 1, insertUnits: 0, explodable: true, scalable: true };
    ops.push({ kind: 'blockRecord', key, before: null, after: rec });
  }
  const def = newTableBlock(name, t, style);
  def.handle = reuse?.handle || nh();
  def.endHandle = reuse?.endHandle || nh();
  def.recordHandle = recordHandle;
  for (const e of def.entities) {
    e.handle = nh();
    e.owner = recordHandle;
  }
  ops.push({ kind: 'blockDef', key, before: reuse ?? doc.blocks.get(key) ?? null, after: def });
  return ops;
}

export interface AddTableParams {
  space: string;
  data: TableData;
  style: TableStyle;
  styleHandle?: string;
  insert: Vec3;
  rotation?: number;
  props: Omit<EntityBase, 'type' | 'handle'>;
}

/** 새 표: 블록 정의 + 표 객체 */
export function addTableOps(doc: CadDocument, nh: NewHandle, p: AddTableParams): { ops: EditOp[]; table: TableEntity } {
  const name = nextTableBlockName(doc);
  const ops = blockOps(doc, nh, name, p.data, p.style, null);
  const table = newTableEntity(p.data, { insert: p.insert, rotation: p.rotation, blockName: name, props: p.props, styleHandle: p.styleHandle });
  table.handle = nh();
  const space = doc.blocks.get(tableKey(p.space));
  if (space?.recordHandle) table.owner = space.recordHandle;
  if (/^\*PAPER_SPACE/i.test(p.space)) table.paperSpace = true;
  ops.push({ kind: 'add', block: tableKey(p.space), entity: table });
  return { ops, table };
}

/**
 * 표를 새 정의로 바꾼다. 그림 블록을 이 표만 쓰면 그 블록을 고치고, 다른 객체도 쓰면 새 블록을 만든다.
 * 표 확장 자료가 있는 블록 참조는 표 객체로 되돌린다.
 */
export function updateTableOps(
  doc: CadDocument,
  nh: NewHandle,
  before: TableEntity | InsertEntity,
  space: string,
  t: TableData,
  style: TableStyle,
  styleHandle: string | undefined,
  taken: Set<string> = new Set(),
): { ops: EditOp[]; table: TableEntity } {
  const shared = blockSharedBy(doc, before.block, before.handle);
  const own = shared ? null : (doc.blocks.get(tableKey(before.block)) ?? null);
  const name = own ? own.name : nextTableBlockName(doc, taken);
  taken.add(name.toUpperCase());
  const ops = blockOps(doc, nh, name, t, style, own);
  let after: TableEntity = before.type === 'ACAD_TABLE' ? applyTableData(before, t, styleHandle) : insertToTable(before, t, styleHandle);
  after = { ...after, block: name };
  ops.push({ kind: 'modify', block: tableKey(space), before, after });
  return { ops, table: after };
}

// ---------------------------------------------------------------------------
// 테이블 스타일
// ---------------------------------------------------------------------------

function cloneDict(d: DictionaryObject): DictionaryObject {
  return { ...d, entries: new Map(d.entries) };
}

/** ACAD_TABLESTYLE 사전(없으면 만드는 작업과 함께) */
function ensureStyleDict(doc: CadDocument, nh: NewHandle, ops: EditOp[]): DictionaryObject | null {
  const d = tableStyleDictionary(doc);
  if (d) return d;
  const rootH = doc.rootDictionary;
  const root = rootH ? doc.objects.get(rootH) : undefined;
  if (!root || (root.type !== 'DICTIONARY' && root.type !== 'ACDBDICTIONARYWDFLT')) return null;
  const nd: DictionaryObject = { type: 'DICTIONARY', handle: nh(), owner: root.handle, reactors: [root.handle], entries: new Map(), hardOwner: false, cloning: 1 };
  const nr = cloneDict(root as DictionaryObject);
  nr.entries.set('ACAD_TABLESTYLE', nd.handle);
  ops.push({ kind: 'object', key: nd.handle, before: null, after: nd }, { kind: 'object', key: root.handle, before: root, after: nr });
  return nd;
}

/** 새 테이블 스타일 또는 바꾼 스타일(handle이 있으면 그 스타일). 사전 항목 이름 = 스타일 이름 */
export function saveTableStyleOps(doc: CadDocument, nh: NewHandle, s: TableStyle, handle?: string): { ops: EditOp[]; handle: string } {
  const ops: EditOp[] = [];
  const raw = tableStyleRaw(s, docVersionNumber(doc));
  if (handle) {
    const before = doc.objects.get(handle);
    if (!before) throw new Error('테이블 스타일이 없습니다.');
    const after: GenericObject = { ...(before as GenericObject), raw };
    delete after.dwgRaw;
    ops.push({ kind: 'object', key: handle, before, after });
    // 이름이 바뀌었으면 사전 항목도
    const dict = tableStyleDictionary(doc);
    if (dict) {
      const old = [...dict.entries].find(([, h]) => h === handle)?.[0];
      if (old !== undefined && old !== s.name) {
        const nd = cloneDict(dict);
        const entries = [...nd.entries].map(([k, h]) => (h === handle ? [s.name, h] : [k, h]) as [string, string]);
        nd.entries = new Map(entries);
        ops.push({ kind: 'object', key: dict.handle, before: dict, after: nd });
      }
    }
    return { ops, handle };
  }
  const dict = ensureStyleDict(doc, nh, ops);
  const h = nh();
  const obj: GenericObject = { type: 'TABLESTYLE', handle: h, owner: dict?.handle, reactors: dict ? [dict.handle] : undefined, raw };
  ops.push({ kind: 'object', key: h, before: null, after: obj });
  if (dict) {
    // 방금 만든 사전이면 그 작업의 after를 고친다
    const made = ops.find((o) => o.kind === 'object' && o.key === dict.handle && o.before === null);
    if (made && made.kind === 'object') (made.after as DictionaryObject).entries.set(s.name, h);
    else {
      const nd = cloneDict(dict);
      nd.entries.set(s.name, h);
      ops.push({ kind: 'object', key: dict.handle, before: dict, after: nd });
    }
  }
  return { ops, handle: h };
}

/** 이 스타일을 쓰는 표(핸들이 같거나, 스타일이 없는 표는 Standard). unstyled면 스타일이 없는 표도 */
export function tablesUsingStyle(doc: CadDocument, handle: string, unstyled = false): { space: string; table: TableEntity }[] {
  const out: { space: string; table: TableEntity }[] = [];
  const list = listTableStyles(doc);
  const std = list.find((s) => tableKey(s.name) === 'STANDARD')?.handle;
  for (const [k, b] of doc.blocks)
    for (const e of b.entities) {
      if (e.type !== 'ACAD_TABLE') continue;
      const h = e.tableStyle?.toUpperCase() ?? std;
      if (h === handle || (unstyled && !e.tableStyle)) out.push({ space: k, table: e });
    }
  return out;
}

export function deleteTableStyleOps(doc: CadDocument, handle: string): EditOp[] {
  const ops: EditOp[] = [];
  const obj = doc.objects.get(handle);
  if (!obj) return ops;
  ops.push({ kind: 'object', key: handle, before: obj, after: null });
  const dict = tableStyleDictionary(doc);
  if (dict && [...dict.entries.values()].includes(handle)) {
    const nd = cloneDict(dict);
    for (const [k, h] of dict.entries) if (h === handle) nd.entries.delete(k);
    ops.push({ kind: 'object', key: dict.handle, before: dict, after: nd });
  }
  return ops;
}

/** 스타일이 바뀐 뒤 그 스타일의 표를 다시 그린다(표 정의는 그대로, 행 높이는 문자에 맞추지 않는다) */
export function restyleTablesOps(doc: CadDocument, nh: NewHandle, handle: string, style: TableStyle, unstyled = false): EditOp[] {
  const ops: EditOp[] = [];
  const taken = new Set<string>();
  for (const { space, table } of tablesUsingStyle(doc, handle, unstyled)) {
    const rt = tableFromEntity(table, doc);
    if (!rt) continue;
    ops.push(...updateTableOps(doc, nh, table, space, rt.data, style, handle, taken).ops);
  }
  return ops;
}

/** 미리보기용: 표 좌표 격자선 */
export function previewSegments(t: TableData, style: TableStyle): number[][] {
  return tableBlockEntities(t, style, { noText: true }).flatMap((e) => (e.type === 'LINE' ? [[e.start.x, e.start.y, e.end.x, e.end.y]] : []));
}
