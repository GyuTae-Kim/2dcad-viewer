/**
 * GATTE(Express Tools 전역 속성 편집) 계산(UI 없음).
 * 블록 이름과 속성 태그를 고르면 그 블록의 모든 참조(공간과 다른 블록 정의 안까지, 동적 블록의 익명 참조 포함)에서
 * 그 태그 속성의 값을 한꺼번에 바꾼다.
 */
import type { AttribEntity, CadDocument, InsertEntity } from '../../core/model';
import { tableKey } from '../../core/model';
import { definitionName } from '../dynblock/reference';
import { attdefsOf } from '../util/blockutil';
import { withAttributeValue } from '../textools/attipedit';

/** 블록 참조가 가리키는 블록 이름(동적 블록의 익명 참조는 정의 이름) */
export function referenceName(doc: CadDocument, ins: InsertEntity): string {
  try {
    return definitionName(doc, ins) ?? ins.block;
  } catch {
    return ins.block;
  }
}

/** 블록이 아는 태그(정의의 속성 정의 순서, 참조에만 있는 태그는 뒤에) */
export function knownTags(doc: CadDocument, blockName: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (t: string) => {
    const k = t.toUpperCase();
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  const def = doc.blocks.get(tableKey(blockName));
  if (def) for (const a of attdefsOf(def)) add(a.tag);
  for (const { entity } of referencesOf(doc, blockName)) for (const a of entity.attribs) add(a.tag);
  return out;
}

/** 블록 이름의 모든 참조(어느 블록·공간에 있는지와 함께) */
export function referencesOf(doc: CadDocument, blockName: string): { block: string; entity: InsertEntity }[] {
  const k = tableKey(blockName);
  const out: { block: string; entity: InsertEntity }[] = [];
  for (const [bk, b] of doc.blocks)
    for (const e of b.entities) if (e.type === 'INSERT' && (tableKey(e.block) === k || tableKey(referenceName(doc, e)) === k)) out.push({ block: bk, entity: e });
  return out;
}

export interface GatteChange {
  block: string;
  before: InsertEntity;
  after: InsertEntity;
}

/** 참조들에서 태그 속성 값을 바꾼다(태그 대소문자 무시). 이미 같은 값이면 빼고, 찾은 속성 수도 돌려준다 */
export function gatteChanges(refs: readonly { block: string; entity: InsertEntity }[], tag: string, value: string): { changes: GatteChange[]; found: number } {
  const T = tag.toUpperCase();
  const changes: GatteChange[] = [];
  let found = 0;
  for (const r of refs) {
    let cur: InsertEntity = r.entity;
    const hits = cur.attribs.filter((a: AttribEntity) => a.tag.toUpperCase() === T);
    found += hits.length;
    for (const a of hits) cur = withAttributeValue(cur, a.handle, value) ?? cur;
    if (cur !== r.entity) changes.push({ block: r.block, before: r.entity, after: structuredClone(cur) });
  }
  return { changes, found };
}
