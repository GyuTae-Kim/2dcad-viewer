/**
 * 외부 참조 결합(BIND, UI 없음): 외부 참조 블록을 참조 도면의 모형 공간 객체를 담은 보통 블록으로 바꾸는 작업.
 * 이름 있는 객체는 `XREF$0$이름`으로 들어오고(도면층 상태는 호스트의 `XREF|도면층` 재지정), 호스트의 외부 참조 의존 기호
 * (`XREF|이름`)는 지운다. 전송(ETRANSMIT)의 "외부 참조를 결합으로 바꾸기"가 패키지의 도면 사본에만 쓴다.
 * 한계: 참조 도면 안의 외부 참조(중첩)는 결합 블록에 넣지 않는다. 핸들로 다른 객체를 가리키는 객체(다중 지시선·이미지 등)도 넣지 않는다.
 */
import type { CadDocument, Entity } from '../../core/model';
import { MODEL_SPACE, tableKey } from '../../core/model';
import type { EditOp } from '../session';
import { bindMapper, createImporter } from './names';
import { extendBlocks } from './workset';

export interface BindResult {
  ops: EditOp[];
  /** 결합 블록에 넣은 객체 수 */
  entities: number;
  /** 옮길 수 없어 뺀 객체 수 */
  skipped: number;
  /** 넣지 않은 중첩 외부 참조 수 */
  nested: number;
}

export function bindXrefOps(host: CadDocument, blockKey: string, xdoc: CadDocument, newHandle: () => string): BindResult | null {
  const key = tableKey(blockKey);
  const def = host.blocks.get(key);
  if (!def || !(def.flags & 4)) return null;
  const xname = def.name;
  const imp = createImporter(extendBlocks(xdoc), host, bindMapper(host, xname), newHandle, {
    layerFrom: (s) => host.layers.get(tableKey(`${xname}|${s}`)),
  });
  const ents: Entity[] = [];
  let skipped = 0;
  let nested = 0;
  for (const e of xdoc.blocks.get(MODEL_SPACE)?.entities ?? []) {
    if (e.type === 'INSERT' && (xdoc.blocks.get(tableKey(e.block))?.flags ?? 0) & 4) {
      nested++;
      continue;
    }
    const c = imp.entity(e);
    if (!c) {
      skipped++;
      continue;
    }
    c.owner = def.recordHandle;
    if (c.type === 'INSERT') for (const a of c.attribs) a.owner = c.handle;
    ents.push(c);
  }
  const ops: EditOp[] = [...imp.ops];
  const dep = `${tableKey(xname)}|`;
  for (const [k, l] of host.layers) if (k.startsWith(dep)) ops.push({ kind: 'layer', key: k, before: l, after: null });
  for (const [k, l] of host.linetypes) if (k.startsWith(dep)) ops.push({ kind: 'linetype', key: k, before: l, after: null });
  for (const [k, s] of host.textStyles) if (k.startsWith(dep)) ops.push({ kind: 'textStyle', key: k, before: s, after: null });
  for (const [k, s] of host.dimStyles) if (k.startsWith(dep)) ops.push({ kind: 'dimStyle', key: k, before: s, after: null });
  for (const [k, b] of host.blocks)
    if (k.startsWith(dep)) {
      ops.push({ kind: 'blockDef', key: k, before: b, after: null });
      const r = host.blockRecords.get(k);
      if (r) ops.push({ kind: 'blockRecord', key: k, before: r, after: null });
    }
  ops.push({ kind: 'blockDef', key, before: def, after: { ...def, flags: def.flags & ~(4 | 8 | 16 | 32 | 64), xrefPath: undefined, entities: ents } });
  return { ops, entities: ents.length, skipped, nested };
}
