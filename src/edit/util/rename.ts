/**
 * RENAME(UI 없음): 명명된 객체의 이름을 바꾸고 그 이름을 적어 둔 모든 곳(객체·표·치수 스타일·헤더 변수)을 함께 바꾼다.
 * 종류: 블록, 치수 스타일, 도면층, 선종류, 문자 스타일, 배치.
 * (뷰·UCS는 편집 세션에 그 표를 바꾸는 작업이 없어 아직 바꿀 수 없다.)
 */
import type { CadDocument, DictionaryObject, DimStyle, Entity, HeaderValue, Layer, Layout, MLineStyleObject } from '../../core/model';
import { MODEL_SPACE, tableKey } from '../../core/model';
import type { EditOp } from '../session';
import { cloneEntity, isLayoutBlock } from '../session';

export type RenameKind = 'block' | 'dimStyle' | 'layer' | 'linetype' | 'textStyle' | 'layout';

export const RENAME_KINDS: readonly { kind: RenameKind; label: string; key: string }[] = [
  { kind: 'block', label: '블록', key: 'B' },
  { kind: 'dimStyle', label: '치수 스타일', key: 'D' },
  { kind: 'layer', label: '도면층', key: 'LA' },
  { kind: 'linetype', label: '선종류', key: 'LT' },
  { kind: 'textStyle', label: '문자 스타일', key: 'S' },
  { kind: 'layout', label: '배치', key: 'L' },
];

const BAD = /[<>/\\":;?*|,=`]/;

/** 새 이름으로 쓸 수 없으면 까닭 */
export function nameProblem(name: string): string | null {
  if (!name) return '이름을 입력하십시오.';
  if (name !== name.trim()) return '이름 앞뒤에 공백을 둘 수 없습니다.';
  if (name.length > 255) return '이름은 255자 이내여야 합니다.';
  if (/[\u0000-\u001f]/.test(name)) return '이름에 제어 문자를 쓸 수 없습니다.';
  if (BAD.test(name)) return '이름에 < > / \\ " : ; ? * | , = ` 문자는 쓸 수 없습니다.';
  return null;
}

/** 종류의 모든 이름(표 철자) */
export function namesOf(doc: CadDocument, kind: RenameKind): string[] {
  switch (kind) {
    case 'block':
      return [...doc.blocks.values()].map((b) => b.name);
    case 'dimStyle':
      return [...doc.dimStyles.values()].map((d) => d.name);
    case 'layer':
      return [...doc.layers.values()].map((l) => l.name);
    case 'linetype':
      return [...doc.linetypes.values()].map((l) => l.name);
    case 'textStyle':
      return [...doc.textStyles.values()].filter((s) => s.name && !(s.flags & 1)).map((s) => s.name);
    case 'layout':
      return doc.layouts.map((l) => l.name);
  }
}

/** 이 이름을 바꿀 수 없으면 까닭(바꿀 수 있으면 null) */
export function lockedReason(doc: CadDocument, kind: RenameKind, name: string): string | null {
  const k = tableKey(name);
  if (name.includes('|')) return '외부 참조에 종속된 이름은 바꿀 수 없습니다.';
  switch (kind) {
    case 'block': {
      const b = doc.blocks.get(k);
      if (!b) return '없는 블록입니다.';
      if (name.startsWith('*') || isLayoutBlock(k)) return '익명 블록과 배치 블록은 이름을 바꿀 수 없습니다.';
      if (b.flags & (4 | 16)) return '외부 참조 블록은 이름을 바꿀 수 없습니다.';
      return null;
    }
    case 'dimStyle': {
      const d = doc.dimStyles.get(k);
      if (!d) return '없는 치수 스타일입니다.';
      if (k === 'STANDARD') return 'Standard 치수 스타일은 이름을 바꿀 수 없습니다.';
      if (/\$\d$/.test(name)) return '하위 치수 스타일은 상위 스타일과 함께 바뀝니다.';
      if (d.flags & 16) return '외부 참조 치수 스타일은 이름을 바꿀 수 없습니다.';
      return null;
    }
    case 'layer': {
      const l = doc.layers.get(k);
      if (!l) return '없는 도면층입니다.';
      if (k === '0' || k === 'DEFPOINTS') return `도면층 ${l.name}의 이름은 바꿀 수 없습니다.`;
      if (l.flags & 16) return '외부 참조 도면층은 이름을 바꿀 수 없습니다.';
      return null;
    }
    case 'linetype': {
      const l = doc.linetypes.get(k);
      if (!l) return '없는 선종류입니다.';
      if (k === 'BYLAYER' || k === 'BYBLOCK' || k === 'CONTINUOUS') return `선종류 ${l.name}의 이름은 바꿀 수 없습니다.`;
      if (l.flags & 16) return '외부 참조 선종류는 이름을 바꿀 수 없습니다.';
      return null;
    }
    case 'textStyle': {
      const s = doc.textStyles.get(k);
      if (!s) return '없는 문자 스타일입니다.';
      if (k === 'STANDARD') return 'Standard 문자 스타일은 이름을 바꿀 수 없습니다.';
      if (s.flags & 16) return '외부 참조 문자 스타일은 이름을 바꿀 수 없습니다.';
      return null;
    }
    case 'layout': {
      const l = doc.layouts.find((x) => tableKey(x.name) === k);
      if (!l) return '없는 배치입니다.';
      if (tableKey(l.blockName) === MODEL_SPACE) return '모형 배치는 이름을 바꿀 수 없습니다.';
      return null;
    }
  }
}

/** 바꿀 수 있는 이름(정렬) */
export function renamableNames(doc: CadDocument, kind: RenameKind): string[] {
  return namesOf(doc, kind)
    .filter((n) => !lockedReason(doc, kind, n))
    .sort((a, b) => a.localeCompare(b, 'ko'));
}

/** 이름 바꾸기를 할 수 없으면 까닭. taken: 이 묶음에서 이미 쓰인(또는 비워질) 이름(대문자) */
export function renameProblem(doc: CadDocument, kind: RenameKind, oldName: string, newName: string, taken: ReadonlySet<string> = new Set()): string | null {
  const lock = lockedReason(doc, kind, oldName);
  if (lock) return lock;
  const bad = nameProblem(newName);
  if (bad) return bad;
  const nk = tableKey(newName);
  if (nk === tableKey(oldName)) return null; // 대소문자만 바꾸기
  if (namesOf(doc, kind).some((n) => tableKey(n) === nk) || taken.has(nk)) return `${newName}은(는) 이미 있는 이름입니다.`;
  if (kind === 'block' && newName.startsWith('*')) return '블록 이름은 *로 시작할 수 없습니다.';
  return null;
}

const same = (a: string | undefined, k: string) => typeof a === 'string' && tableKey(a) === k;

/** 블록마다 객체를 고쳐 modify 작업을 만든다(fix가 null이면 그대로) */
function entityOps(doc: CadDocument, fix: (c: Entity) => boolean): EditOp[] {
  const ops: EditOp[] = [];
  for (const [bk, b] of doc.blocks) {
    for (const e of b.entities) {
      const c = cloneEntity(e);
      if (!fix(c)) continue;
      delete c.dwgRaw;
      if (c.type === 'INSERT') for (const a of c.attribs) delete a.dwgRaw;
      ops.push({ kind: 'modify', block: bk, before: e, after: c });
    }
  }
  return ops;
}

function headerOps(doc: CadDocument, names: string[], k: string, newName: string): EditOp[] {
  const ops: EditOp[] = [];
  for (const n of names) {
    const v: HeaderValue | undefined = doc.header.get(n);
    if (typeof v === 'string' && tableKey(v) === k) ops.push({ kind: 'header', name: n, before: v, after: newName });
  }
  return ops;
}

function dimStyleVarOps(doc: CadDocument, vars: string[], k: string, newName: string, skip?: Set<string>): EditOp[] {
  const ops: EditOp[] = [];
  for (const [dk, d] of doc.dimStyles) {
    if (skip?.has(dk)) continue;
    let hit = false;
    const after: DimStyle = { ...d, vars: { ...d.vars } };
    for (const v of vars)
      if (same(after.vars[v] as string | undefined, k)) {
        after.vars[v] = newName;
        hit = true;
      }
    if (hit) ops.push({ kind: 'dimStyle', key: dk, before: d, after });
  }
  return ops;
}

/**
 * 이름 바꾸기 작업. 순서대로 한 트랜잭션으로 적용한다(앞 작업이 옛 이름의 표 키를 쓴다).
 * 바꿀 수 없으면 빈 배열.
 */
export function renameOps(doc: CadDocument, kind: RenameKind, oldName: string, newName: string): EditOp[] {
  if (renameProblem(doc, kind, oldName, newName)) return [];
  const k = tableKey(oldName);
  const nk = tableKey(newName);
  const ops: EditOp[] = [];
  switch (kind) {
    case 'layer': {
      const before = doc.layers.get(k)!;
      const after: Layer = { ...structuredClone(before), name: newName };
      delete (after as { dwgRaw?: unknown }).dwgRaw;
      ops.push(
        ...entityOps(doc, (c) => {
          let hit = false;
          if (same(c.layer, k)) {
            c.layer = newName;
            hit = true;
          }
          if (c.type === 'INSERT')
            for (const a of c.attribs)
              if (same(a.layer, k)) {
                a.layer = newName;
                hit = true;
              }
          if (c.type === 'VIEWPORT' && c.frozenLayers.some((l) => same(l, k))) {
            c.frozenLayers = c.frozenLayers.map((l) => (same(l, k) ? newName : l));
            hit = true;
          }
          return hit;
        }),
      );
      for (const [bk, b] of doc.blocks) if (same(b.layer, k)) ops.push({ kind: 'blockDef', key: bk, before: b, after: { ...b, layer: newName } });
      if (nk === k) ops.push({ kind: 'layer', key: k, before, after });
      else ops.push({ kind: 'layer', key: k, before, after: null }, { kind: 'layer', key: nk, before: null, after });
      ops.push(...headerOps(doc, ['$CLAYER'], k, newName));
      break;
    }
    case 'linetype': {
      const before = doc.linetypes.get(k)!;
      ops.push(
        ...entityOps(doc, (c) => {
          let hit = false;
          if (same(c.linetype, k)) {
            c.linetype = newName;
            hit = true;
          }
          if (c.type === 'INSERT')
            for (const a of c.attribs)
              if (same(a.linetype, k)) {
                a.linetype = newName;
                hit = true;
              }
          return hit;
        }),
      );
      for (const [lk, l] of doc.layers) if (same(l.linetype, k)) ops.push({ kind: 'layer', key: lk, before: l, after: { ...l, linetype: newName } });
      ops.push(...dimStyleVarOps(doc, ['DIMLTYPE', 'DIMLTEX1', 'DIMLTEX2'], k, newName));
      for (const o of doc.objects.values()) {
        if (o.type !== 'MLINESTYLE') continue;
        const m = o as MLineStyleObject;
        if (!m.elements.some((x) => same(x.linetype, k))) continue;
        ops.push({ kind: 'object', key: m.handle, before: m, after: { ...m, elements: m.elements.map((x) => (same(x.linetype, k) ? { ...x, linetype: newName } : x)) } });
      }
      const after = { ...structuredClone(before), name: newName };
      if (nk === k) ops.push({ kind: 'linetype', key: k, before, after });
      else ops.push({ kind: 'linetype', key: k, before, after: null }, { kind: 'linetype', key: nk, before: null, after });
      ops.push(...headerOps(doc, ['$CELTYPE', '$DIMLTYPE', '$DIMLTEX1', '$DIMLTEX2'], k, newName));
      break;
    }
    case 'textStyle': {
      const before = doc.textStyles.get(k)!;
      ops.push(
        ...entityOps(doc, (c) => {
          let hit = false;
          const t = c as { style?: string };
          if ((c.type === 'TEXT' || c.type === 'MTEXT' || c.type === 'ATTRIB' || c.type === 'ATTDEF') && same(t.style, k)) {
            t.style = newName;
            hit = true;
          }
          const am = (c as { mtext?: { style: string } }).mtext;
          if ((c.type === 'ATTRIB' || c.type === 'ATTDEF') && am && same(am.style, k)) {
            am.style = newName;
            hit = true;
          }
          if (c.type === 'INSERT')
            for (const a of c.attribs) {
              if (same(a.style, k)) {
                a.style = newName;
                hit = true;
              }
              if (a.mtext && same(a.mtext.style, k)) {
                a.mtext.style = newName;
                hit = true;
              }
            }
          return hit;
        }),
      );
      ops.push(...dimStyleVarOps(doc, ['DIMTXSTY'], k, newName));
      const after = { ...structuredClone(before), name: newName };
      if (nk === k) ops.push({ kind: 'textStyle', key: k, before, after });
      else ops.push({ kind: 'textStyle', key: k, before, after: null }, { kind: 'textStyle', key: nk, before: null, after });
      ops.push(...headerOps(doc, ['$TEXTSTYLE', '$DIMTXSTY'], k, newName));
      break;
    }
    case 'dimStyle': {
      // 하위 스타일(이름$0 …)도 함께
      const family: [string, string][] = [[k, newName]];
      for (const d of doc.dimStyles.values()) {
        const m = /^(.*)\$(\d)$/.exec(d.name);
        if (m && tableKey(m[1]!) === k) family.push([tableKey(d.name), `${newName}$${m[2]}`]);
      }
      const map = new Map(family);
      ops.push(
        ...entityOps(doc, (c) => {
          if ((c.type === 'DIMENSION' || c.type === 'LEADER' || c.type === 'TOLERANCE') && map.has(tableKey(c.dimStyle))) {
            c.dimStyle = map.get(tableKey(c.dimStyle))!;
            return true;
          }
          return false;
        }),
      );
      for (const [ok, nn] of family) {
        const before = doc.dimStyles.get(ok)!;
        const after = { ...structuredClone(before), name: nn };
        const nkey = tableKey(nn);
        if (nkey === ok) ops.push({ kind: 'dimStyle', key: ok, before, after });
        else ops.push({ kind: 'dimStyle', key: ok, before, after: null }, { kind: 'dimStyle', key: nkey, before: null, after });
      }
      ops.push(...headerOps(doc, ['$DIMSTYLE'], k, newName));
      break;
    }
    case 'block': {
      const def = doc.blocks.get(k)!;
      ops.push(
        ...entityOps(doc, (c) => {
          if (c.type === 'INSERT' && same(c.block, k)) {
            c.block = newName;
            return true;
          }
          return false;
        }).filter((o) => !(o.kind === 'modify' && o.block === k)),
      );
      ops.push(...dimStyleVarOps(doc, ['DIMBLK', 'DIMBLK1', 'DIMBLK2', 'DIMLDRBLK'], k, newName));
      const rec = doc.blockRecords.get(k);
      const def2 = { ...def, name: newName };
      if (nk === k) {
        ops.push({ kind: 'blockDef', key: k, before: def, after: def2 });
        if (rec) ops.push({ kind: 'blockRecord', key: k, before: rec, after: { ...rec, name: newName } });
      } else {
        ops.push({ kind: 'blockDef', key: k, before: def, after: null }, { kind: 'blockDef', key: nk, before: null, after: def2 });
        if (rec) ops.push({ kind: 'blockRecord', key: k, before: rec, after: null }, { kind: 'blockRecord', key: nk, before: null, after: { ...rec, name: newName } });
      }
      ops.push(...headerOps(doc, ['$DIMBLK', '$DIMBLK1', '$DIMBLK2', '$DIMLDRBLK'], k, newName));
      break;
    }
    case 'layout': {
      const l = doc.layouts.find((x) => tableKey(x.name) === k)!;
      const after: Layout = { ...l, name: newName };
      ops.push({ kind: 'layout', key: tableKey(l.blockName), before: l, after });
      for (const o of doc.objects.values()) {
        if (o.type !== 'DICTIONARY' && o.type !== 'ACDBDICTIONARYWDFLT') continue;
        const d = o as DictionaryObject;
        const hit = [...d.entries].find(([, h]) => h === l.handle);
        if (!hit) continue;
        const entries = new Map<string, string>();
        for (const [name, h] of d.entries) entries.set(h === l.handle ? newName : name, h);
        ops.push({ kind: 'object', key: d.handle, before: d, after: { ...d, entries } });
      }
      break;
    }
  }
  return ops;
}
