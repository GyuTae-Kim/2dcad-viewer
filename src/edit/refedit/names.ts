/**
 * 다른 도면의 객체를 이 도면으로 옮길 때의 이름 있는 객체(도면층·선종류·문자 스타일·치수 스타일·블록) 맞추기(UI 없음).
 * 참조 편집(외부 참조 → 현재 도면, 저장할 때 반대로)과 전송(ETRANSMIT)의 외부 참조 결합이 쓴다.
 *
 * - 이름은 NameMapper가 정한다: 결합·고유 이름이면 `XREF$0$이름`, 아니면 그대로.
 * - 받는 도면에 같은 이름이 있으면 받는 도면의 정의가 이긴다(AutoCAD와 같다). 없으면 보내는 도면의 정의를 복사해 만든다.
 * - 핸들로 다른 객체를 가리키는 객체(다중 지시선·여러 줄·표·이미지·언더레이·OLE·뷰포트·프록시 등)는 옮기지 않는다.
 */
import type { AttribEntity, BlockDef, BlockRecord, CadDocument, DimStyle, Entity, Layer, Linetype, TextStyle, XData } from '../../core/model';
import { normalizeHandle, tableKey } from '../../core/model';
import type { EditOp } from '../session';

export type NameKind = 'layer' | 'linetype' | 'textStyle' | 'dimStyle' | 'block';
export type NameMapper = (kind: NameKind, name: string) => string;

/** 어느 도면에서나 같은 뜻인 이름(옮기지 않는다) */
export function isFixedName(kind: NameKind, name: string): boolean {
  const k = tableKey(name);
  if (kind === 'layer') return k === '0' || k === 'DEFPOINTS';
  if (kind === 'linetype') return k === 'BYLAYER' || k === 'BYBLOCK' || k === 'CONTINUOUS' || k === '';
  return false;
}

/** 다른 도면으로 옮길 수 있는 객체인지(핸들로 다른 객체를 가리키지 않는 것) */
export function canCrossDocs(e: Entity): boolean {
  switch (e.type) {
    case 'LINE':
    case 'POINT':
    case 'CIRCLE':
    case 'ARC':
    case 'ELLIPSE':
    case 'LWPOLYLINE':
    case 'POLYLINE':
    case 'SPLINE':
    case 'XLINE':
    case 'RAY':
    case 'TEXT':
    case 'ATTDEF':
    case 'ATTRIB':
    case 'MTEXT':
    case 'INSERT':
    case 'DIMENSION':
    case 'LEADER':
    case 'TOLERANCE':
    case 'HATCH':
    case 'SOLID':
    case 'TRACE':
    case '3DFACE':
      return true;
    default:
      return false;
  }
}

function tableOf(doc: CadDocument, kind: NameKind): Map<string, unknown> {
  switch (kind) {
    case 'layer':
      return doc.layers;
    case 'linetype':
      return doc.linetypes;
    case 'textStyle':
      return doc.textStyles;
    case 'dimStyle':
      return doc.dimStyles;
    case 'block':
      return doc.blocks;
  }
}

/** 외부 참조 의존 이름 `XREF|이름` → 이름 */
export function stripXrefPrefix(name: string): string {
  const i = name.indexOf('|');
  return i >= 0 ? name.slice(i + 1) : name;
}

/** 결합한 이름 `XREF$0$이름` → 이름(아니면 null) */
export function unbindName(prefix: string, name: string): string | null {
  const m = /^(.*)\$(\d+)\$(.*)$/.exec(name);
  if (!m || tableKey(m[1]!) !== tableKey(prefix)) return null;
  return m[3]!;
}

/**
 * 결합 이름 짓기(BIND·참조 편집의 고유 이름): `접두사$n$이름`에서 받는 도면에 없는 가장 작은 n.
 * 같은 (종류, 이름)에는 늘 같은 결과를 준다.
 */
export function bindMapper(dst: CadDocument, prefix: string): NameMapper {
  const cache = new Map<string, string>();
  const taken = new Set<string>();
  return (kind, name) => {
    if (isFixedName(kind, name)) return name;
    const ck = `${kind}:${tableKey(name)}`;
    const hit = cache.get(ck);
    if (hit) return hit;
    const t = tableOf(dst, kind);
    let n = 0;
    let out = `${prefix}$${n}$${name}`;
    while (t.has(tableKey(out)) || taken.has(`${kind}:${tableKey(out)}`)) out = `${prefix}$${++n}$${name}`;
    taken.add(`${kind}:${tableKey(out)}`);
    cache.set(ck, out);
    return out;
  };
}

export interface ImportOptions {
  /** 새로 만드는 도면층의 상태(결합: 호스트의 `XREF|도면층` 재지정). 보내는 도면의 이름으로 묻는다 */
  layerFrom?: (srcName: string) => Layer | undefined;
  /** 블록 이름을 옮길 수 없을 때(외부 참조 블록 등) */
  blockAllowed?: (srcKey: string) => boolean;
}

export interface Importer {
  readonly src: CadDocument;
  readonly dst: CadDocument;
  /** 받는 도면에 표·블록을 만드는 작업(객체보다 먼저 적용) */
  readonly ops: EditOp[];
  /** 받는 도면의 이름(종류:대문자) → 보내는 도면의 이름(되돌릴 때) */
  readonly origin: Map<string, string>;
  /** 만든 블록 이름(대문자) */
  readonly createdBlocks: Set<string>;
  /** 이름을 맞춘다(필요하면 받는 도면에 만든다). 블록을 옮길 수 없으면 null */
  name(kind: NameKind, srcName: string): string | null;
  /** 객체 하나를 받는 도면의 이름으로 복사한다(새 핸들, 소유자 없음). 옮길 수 없으면 null */
  entity(e: Entity): Entity | null;
}

const DEP = 16 | 32 | 64;

export function createImporter(src: CadDocument, dst: CadDocument, map: NameMapper, newHandle: () => string, opt: ImportOptions = {}): Importer {
  const ops: EditOp[] = [];
  const origin = new Map<string, string>();
  const createdBlocks = new Set<string>();
  /** 이 가져오기에서 정한 이름(종류:보내는 쪽 대문자 → 받는 쪽 이름) */
  const decided = new Map<string, string | null>();
  /** 만든 것(종류:받는 쪽 대문자) */
  const made = new Set<string>();
  const appIds = new Set([...dst.appIds.keys()].map((k) => tableKey(k)));
  const styleByHandle = new Map<string, TextStyle>();
  for (const s of src.textStyles.values()) if (s.handle) styleByHandle.set(normalizeHandle(s.handle), s);

  const exists = (kind: NameKind, dstName: string) => tableOf(dst, kind).has(tableKey(dstName)) || made.has(`${kind}:${tableKey(dstName)}`);

  const keepXdata = (x: XData[] | undefined): XData[] | undefined => {
    if (!x?.length) return undefined;
    const out = x.filter((d) => appIds.has(tableKey(d.app)));
    return out.length ? out : undefined;
  };

  const name = (kind: NameKind, srcName: string): string | null => {
    if (isFixedName(kind, srcName)) {
      // 도면층 0·DEFPOINTS가 받는 도면에 없을 수는 없지만, 없으면 만든다
      if (kind === 'layer' && !exists('layer', srcName)) createLayer(srcName, srcName);
      return srcName;
    }
    const dk = `${kind}:${tableKey(srcName)}`;
    if (decided.has(dk)) return decided.get(dk)!;
    let dstName = map(kind, srcName);
    if (kind === 'block' && /^\*/.test(srcName)) {
      // 익명 블록은 늘 새 익명 블록으로(받는 도면의 번호로)
      const prefix = /^\*[A-Za-z]+/.exec(srcName)?.[0] ?? '*U';
      let n = 1;
      while (exists('block', `${prefix}${n}`)) n++;
      dstName = `${prefix}${n}`;
    }
    decided.set(dk, dstName);
    origin.set(`${kind}:${tableKey(dstName)}`, srcName);
    if (exists(kind, dstName)) return dstName;
    switch (kind) {
      case 'layer':
        createLayer(srcName, dstName);
        break;
      case 'linetype':
        createLinetype(srcName, dstName);
        break;
      case 'textStyle':
        createTextStyle(srcName, dstName);
        break;
      case 'dimStyle':
        createDimStyle(srcName, dstName);
        break;
      case 'block':
        if (!createBlock(srcName, dstName)) {
          decided.set(dk, null);
          origin.delete(`${kind}:${tableKey(dstName)}`);
          return null;
        }
        break;
    }
    return dstName;
  };

  function createLayer(srcName: string, dstName: string): void {
    const own = src.layers.get(tableKey(srcName));
    const s = opt.layerFrom?.(srcName) ?? own;
    made.add(`layer:${tableKey(dstName)}`);
    const l: Layer = s
      ? { ...structuredClone(s), name: dstName, handle: newHandle(), flags: s.flags & ~DEP, plotStyle: undefined, xdict: undefined, xdata: keepXdata(s.xdata) }
      : { name: dstName, handle: newHandle(), flags: 0, color: { aci: 7 }, off: false, frozen: false, locked: false, linetype: 'Continuous', lineweight: -3, plot: true, transparency: 255 };
    // 선종류는 보내는 도면의 이름으로 맞춘다(재지정 상태를 받아도)
    l.linetype = name('linetype', own?.linetype ?? 'Continuous') ?? 'Continuous';
    ops.push({ kind: 'layer', key: tableKey(dstName), before: null, after: l });
  }

  function createLinetype(srcName: string, dstName: string): void {
    const s = src.linetypes.get(tableKey(srcName));
    made.add(`linetype:${tableKey(dstName)}`);
    const lt: Linetype = s
      ? { ...structuredClone(s), name: dstName, handle: newHandle(), flags: s.flags & ~DEP, xdict: undefined, xdata: keepXdata(s.xdata) }
      : { name: dstName, handle: newHandle(), flags: 0, description: '', patternLength: 0, elements: [] };
    for (const el of lt.elements) {
      if (!el.styleHandle) continue;
      const st = styleByHandle.get(normalizeHandle(el.styleHandle));
      const dn = st ? name('textStyle', st.name) : null;
      const ds = dn ? (dst.textStyles.get(tableKey(dn)) ?? pendingStyle(dn)) : undefined;
      if (ds?.handle) el.styleHandle = ds.handle;
      else delete el.styleHandle;
    }
    ops.push({ kind: 'linetype', key: tableKey(dstName), before: null, after: lt });
  }

  const pendingStyle = (dstName: string): TextStyle | undefined => {
    for (const op of ops) if (op.kind === 'textStyle' && op.key === tableKey(dstName)) return op.after ?? undefined;
    return undefined;
  };

  function createTextStyle(srcName: string, dstName: string): void {
    const s = src.textStyles.get(tableKey(srcName));
    made.add(`textStyle:${tableKey(dstName)}`);
    const ts: TextStyle = s
      ? { ...structuredClone(s), name: dstName, handle: newHandle(), flags: s.flags & ~DEP, xdict: undefined, xdata: keepXdata(s.xdata) }
      : { name: dstName, handle: newHandle(), flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0, lastHeight: 2.5, font: 'txt', bigFont: '' };
    ops.push({ kind: 'textStyle', key: tableKey(dstName), before: null, after: ts });
  }

  function createDimStyle(srcName: string, dstName: string): void {
    const s = src.dimStyles.get(tableKey(srcName));
    made.add(`dimStyle:${tableKey(dstName)}`);
    const ds: DimStyle = s ? { ...structuredClone(s), name: dstName, handle: newHandle(), flags: s.flags & ~DEP, xdict: undefined, xdata: keepXdata(s.xdata) } : { name: dstName, handle: newHandle(), flags: 0, vars: {} };
    const v = ds.vars;
    if (typeof v.DIMTXSTY === 'string' && v.DIMTXSTY) v.DIMTXSTY = name('textStyle', v.DIMTXSTY) ?? 'Standard';
    for (const k of ['DIMLTYPE', 'DIMLTEX1', 'DIMLTEX2']) if (typeof v[k] === 'string' && v[k]) v[k] = name('linetype', v[k] as string) ?? 'ByBlock';
    for (const k of ['DIMBLK', 'DIMBLK1', 'DIMBLK2', 'DIMLDRBLK']) {
      const b = v[k];
      // 화살촉 블록이 보내는 도면에 정의되어 있을 때만 옮긴다(표준 화살촉 이름은 그대로)
      if (typeof b === 'string' && b && src.blocks.has(tableKey(b))) v[k] = name('block', b) ?? '';
    }
    ops.push({ kind: 'dimStyle', key: tableKey(dstName), before: null, after: ds });
  }

  function createBlock(srcName: string, dstName: string): boolean {
    const sk = tableKey(srcName);
    const s = src.blocks.get(sk);
    if (!s || s.flags & 4 || /^\*(MODEL|PAPER)_SPACE/i.test(sk)) return false;
    if (opt.blockAllowed && !opt.blockAllowed(sk)) return false;
    const key = tableKey(dstName);
    made.add(`block:${key}`);
    createdBlocks.add(key);
    const srec = src.blockRecords.get(sk);
    const rec: BlockRecord = {
      name: dstName,
      handle: newHandle(),
      flags: (srec?.flags ?? 0) & ~DEP,
      insertUnits: srec?.insertUnits ?? 0,
      explodable: srec?.explodable ?? true,
      scalable: srec?.scalable ?? true,
    };
    // 블록 안 객체 먼저 이름을 맞춘다(재귀 — 만든 것으로 표시해 두었으니 순환해도 멈춘다)
    const entities: Entity[] = [];
    for (const e of s.entities) {
      const c = entity(e);
      if (!c) continue;
      c.owner = rec.handle;
      if (c.type === 'INSERT') for (const a of c.attribs) a.owner = c.handle;
      entities.push(c);
    }
    const def: BlockDef = {
      name: dstName,
      handle: newHandle(),
      recordHandle: rec.handle,
      endHandle: newHandle(),
      basePoint: { ...s.basePoint },
      flags: s.flags & ~(4 | 8 | DEP),
      description: s.description,
      layer: s.layer ? (name('layer', s.layer) ?? '0') : undefined,
      entities,
    };
    ops.push({ kind: 'blockRecord', key, before: null, after: rec });
    ops.push({ kind: 'blockDef', key, before: null, after: def });
    return true;
  }

  function entity(e: Entity): Entity | null {
    if (!canCrossDocs(e)) return null;
    const c = structuredClone(e) as Entity;
    if (c.type === 'INSERT') {
      const b = name('block', c.block);
      if (!b) return null;
      c.block = b;
    }
    if (c.type === 'DIMENSION' && c.block) {
      const b = name('block', c.block);
      // 치수 블록이 없으면 치수 생성기가 다시 만든다
      c.block = b ?? '';
    }
    strip(c);
    c.handle = newHandle();
    c.owner = undefined;
    if (c.type === 'INSERT')
      for (const a of c.attribs) {
        strip(a as unknown as Entity);
        a.handle = newHandle();
        a.owner = c.handle;
        mapCommon(a as unknown as Entity);
        a.style = name('textStyle', a.style) ?? 'Standard';
        if (a.mtext) a.mtext.style = name('textStyle', a.mtext.style) ?? 'Standard';
      }
    mapCommon(c);
    switch (c.type) {
      case 'TEXT':
      case 'ATTDEF':
      case 'ATTRIB':
      case 'MTEXT':
        c.style = name('textStyle', c.style) ?? 'Standard';
        if (c.type === 'ATTDEF' || c.type === 'ATTRIB') {
          const mt = (c as AttribEntity).mtext;
          if (mt) mt.style = name('textStyle', mt.style) ?? 'Standard';
        }
        break;
      case 'DIMENSION':
      case 'TOLERANCE':
        c.dimStyle = name('dimStyle', c.dimStyle) ?? 'Standard';
        break;
      case 'LEADER':
        c.dimStyle = name('dimStyle', c.dimStyle) ?? 'Standard';
        c.annotation = undefined;
        break;
      case 'HATCH':
        // 연관 경계는 다른 도면의 핸들이라 끊는다
        c.associative = false;
        for (const p of c.paths) delete p.sources;
        break;
    }
    return c;
  }

  function strip(c: Entity): void {
    delete c.xdict;
    delete c.reactors;
    delete c.dwgRaw;
    delete c.plotStyle;
    delete c.material;
    c.xdata = keepXdata(c.xdata);
    if (!c.xdata) delete c.xdata;
  }

  function mapCommon(c: Entity): void {
    c.layer = name('layer', c.layer || '0') ?? '0';
    if (c.linetype && !isFixedName('linetype', c.linetype)) c.linetype = name('linetype', c.linetype) ?? 'ByLayer';
  }

  return { src, dst, ops, origin, createdBlocks, name, entity };
}

/**
 * 되돌리는 이름(현재 도면 → 외부 참조 도면): 열 때 가져온 이름은 원래 이름으로, `XREF$n$이름`·`XREF|이름`은 이름으로,
 * 나머지(현재 도면에서 새로 쓴 이름)는 그대로.
 */
export function reverseMapper(origin: ReadonlyMap<string, string>, xrefName: string): NameMapper {
  return (kind, name) => {
    const o = origin.get(`${kind}:${tableKey(name)}`);
    if (o !== undefined) return o;
    const ub = unbindName(xrefName, name);
    if (ub !== null) return ub;
    const bar = name.indexOf('|');
    if (bar > 0 && tableKey(name.slice(0, bar)) === tableKey(xrefName)) return name.slice(bar + 1);
    return name;
  };
}
