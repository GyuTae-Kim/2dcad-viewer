/**
 * 도면층 편집: 켜기·동결·잠금·색·선종류·선가중치·이름·만들기·지우기·현재 도면층.
 * 모두 문서의 도면층 표를 바꾸는 트랜잭션이라 저장되고 명령 취소로 되돌릴 수 있다.
 */
import type { Entity, Layer } from '../core/model';
import { tableKey } from '../core/model';
import type { EditOp } from '../edit/session';
import { dropLayerFromFiltersOps } from '../edit/layerfilter/store';
import { cloneEntity } from '../edit/session';
import type { App } from './app';

export type LayerPatch = Partial<Pick<Layer, 'off' | 'frozen' | 'locked' | 'color' | 'linetype' | 'lineweight' | 'plot' | 'transparency' | 'description'>>;

/** 여러 도면층을 한 번에 바꾼다(바뀐 것이 없으면 아무것도 하지 않는다) */
export function patchLayers(app: App, label: string, patches: Iterable<[string, LayerPatch]>): number {
  const st = app.active;
  if (!st) return 0;
  const ops: EditOp[] = [];
  for (const [name, patch] of patches) {
    const key = tableKey(name);
    const before = st.doc.layers.get(key);
    if (!before) continue;
    const after: Layer = { ...structuredClone(before), ...structuredClone(patch) };
    if (JSON.stringify(after) === JSON.stringify(before)) continue;
    ops.push({ kind: 'layer', key, before, after });
  }
  if (ops.length) st.session.commit({ label, ops });
  return ops.length;
}

export function currentLayer(app: App): string {
  const v = app.active?.doc.header.get('$CLAYER');
  return typeof v === 'string' && v ? v : '0';
}

/** 현재 도면층을 바꾼다 */
export function setCurrentLayer(app: App, name: string): boolean {
  const st = app.active;
  if (!st) return false;
  const l = st.doc.layers.get(tableKey(name));
  if (!l) return false;
  if (l.frozen) {
    app.cmd.print(`동결된 도면층 "${l.name}"은(는) 현재 도면층으로 만들 수 없습니다.`, 'err');
    return false;
  }
  const before = st.doc.header.get('$CLAYER');
  if (typeof before === 'string' && tableKey(before) === tableKey(l.name)) return true;
  st.session.commit({ label: 'CLAYER', ops: [{ kind: 'header', name: '$CLAYER', before, after: l.name }] });
  return true;
}

/** 쓸 수 없는 도면층 이름 문자 */
const BAD_NAME = /[<>/\\":;?*|,=`]/;

export function validLayerName(name: string): string | null {
  const n = name.trim();
  if (!n) return '이름이 비어 있습니다.';
  if (n.length > 255) return '이름이 너무 깁니다.';
  if (BAD_NAME.test(n)) return '이름에 < > / \\ " : ; ? * | , = ` 문자는 쓸 수 없습니다.';
  return null;
}

/** 새 도면층(이름이 겹치면 번호를 붙인다) */
export function newLayerName(app: App, base = '도면층'): string {
  const st = app.active!;
  for (let i = 1; ; i++) {
    const n = `${base}${i}`;
    if (!st.doc.layers.has(tableKey(n))) return n;
  }
}

export function createLayer(app: App, name: string, props: LayerPatch = {}): Layer | null {
  const st = app.active;
  if (!st) return null;
  const err = validLayerName(name);
  if (err) {
    app.cmd.print(err, 'err');
    return null;
  }
  const key = tableKey(name.trim());
  if (st.doc.layers.has(key)) {
    app.cmd.print(`도면층 "${name}"이(가) 이미 있습니다.`, 'err');
    return null;
  }
  const layer: Layer = {
    name: name.trim(),
    handle: st.session.newHandle(),
    flags: 0,
    color: { aci: 7 },
    off: false,
    frozen: false,
    locked: false,
    linetype: 'Continuous',
    lineweight: -3,
    plot: true,
    transparency: 255,
    ...props,
  } as Layer;
  st.session.commit({ label: 'LAYER', ops: [{ kind: 'layer', key, before: null, after: layer }] });
  return layer;
}

/** 도면층을 쓰는 객체 수(블록 정의 안 포함) */
export function layerUsage(app: App): Map<string, number> {
  const used = new Map<string, number>();
  const st = app.active;
  if (!st) return used;
  for (const b of st.doc.blocks.values()) {
    for (const e of b.entities) {
      const k = tableKey(e.layer);
      used.set(k, (used.get(k) ?? 0) + 1);
    }
  }
  return used;
}

/** 지울 수 있는지(지울 수 없으면 까닭) */
export function cannotDeleteLayer(app: App, key: string): string | null {
  const st = app.active!;
  const k = tableKey(key);
  if (k === '0') return '도면층 0은 지울 수 없습니다.';
  if (k === 'DEFPOINTS') return 'Defpoints 도면층은 지울 수 없습니다.';
  if (k === tableKey(currentLayer(app))) return '현재 도면층은 지울 수 없습니다.';
  if ((st.doc.layers.get(k)?.flags ?? 0) & 16 || k.includes('|')) return '외부 참조 도면층은 지울 수 없습니다.';
  if ((layerUsage(app).get(k) ?? 0) > 0) return '객체가 있는 도면층은 지울 수 없습니다.';
  return null;
}

export function deleteLayer(app: App, key: string): boolean {
  const st = app.active;
  if (!st) return false;
  const why = cannotDeleteLayer(app, key);
  if (why) {
    app.cmd.print(why, 'err');
    return false;
  }
  const k = tableKey(key);
  const before = st.doc.layers.get(k)!;
  // 그룹 필터(도면층 필터)에서도 뺀다
  const filterOps = dropLayerFromFiltersOps(st.doc, before.handle, () => st.session.newHandle());
  st.session.commit({ label: 'LAYER', ops: [...filterOps, { kind: 'layer', key: k, before, after: null }] });
  return true;
}

/** 이름 바꾸기: 그 도면층을 쓰는 모든 객체와 현재 도면층도 함께 바꾼다 */
export function renameLayer(app: App, key: string, name: string): boolean {
  const st = app.active;
  if (!st) return false;
  const k = tableKey(key);
  const before = st.doc.layers.get(k);
  if (!before) return false;
  if (k === '0' || k === 'DEFPOINTS') {
    app.cmd.print(`도면층 "${before.name}"의 이름은 바꿀 수 없습니다.`, 'err');
    return false;
  }
  const err = validLayerName(name);
  if (err) {
    app.cmd.print(err, 'err');
    return false;
  }
  const nk = tableKey(name.trim());
  if (nk !== k && st.doc.layers.has(nk)) {
    app.cmd.print(`도면층 "${name}"이(가) 이미 있습니다.`, 'err');
    return false;
  }
  const after: Layer = { ...structuredClone(before), name: name.trim() };
  const ops: EditOp[] = [];
  if (nk === k) ops.push({ kind: 'layer', key: k, before, after });
  else ops.push({ kind: 'layer', key: k, before, after: null }, { kind: 'layer', key: nk, before: null, after });
  const fix = (e: Entity): Entity | null => {
    const hit = tableKey(e.layer) === k || (e.type === 'INSERT' && e.attribs.some((a) => tableKey(a.layer) === k));
    if (!hit) return null;
    const c = cloneEntity(e);
    if (tableKey(c.layer) === k) c.layer = after.name;
    if (c.type === 'INSERT') for (const a of c.attribs) if (tableKey(a.layer) === k) a.layer = after.name;
    return c;
  };
  for (const [bk, b] of st.doc.blocks) {
    for (const e of b.entities) {
      const c = fix(e);
      if (c) ops.push({ kind: 'modify', block: bk, before: e, after: c });
    }
  }
  const cl = st.doc.header.get('$CLAYER');
  if (typeof cl === 'string' && tableKey(cl) === k) ops.push({ kind: 'header', name: '$CLAYER', before: cl, after: after.name });
  st.session.commit({ label: 'RENAME', ops });
  return true;
}

/** 잠긴 도면층의 객체를 빼고 돌려준다(뺀 것이 있으면 알린다) */
export function unlockedOnly(app: App, handles: string[]): string[] {
  const st = app.active;
  if (!st) return [];
  const out: string[] = [];
  let locked = 0;
  for (const h of handles) {
    const e = st.doc.entityIndex.get(h);
    if (!e) continue;
    if (st.doc.layers.get(tableKey(e.layer))?.locked) locked++;
    else out.push(h);
  }
  if (locked) app.cmd.print(`잠긴 도면층의 객체 ${locked}개는 뺐습니다.`);
  return out;
}
