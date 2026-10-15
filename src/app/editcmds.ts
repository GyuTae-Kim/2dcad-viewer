/**
 * 편집 명령: MATCHPROP(특성 일치), DRAWORDER(그리기 순서), TEXTEDIT(문자 고치기), PURGE(안 쓰는 항목 지우기)
 */
import type { DimensionEntity, Entity, LwPolylineEntity } from '../core/model';
import { tableKey } from '../core/model';
import type { EditOp } from '../edit/session';
import { cloneEntity, isLayoutBlock } from '../edit/session';
import type { App } from './app';
import { editAttributes } from './blocks';
import { textDialog } from './draw';
import { unlockedOnly } from './layers';
import { form } from './ui/dom';
import { lwCount, tidyWidths, zeros } from '../core/lwpoly';

/** MATCHPROP이 옮기는 특성 */
const MATCH_KEYS = ['layer', 'color', 'linetype', 'ltscale', 'lineweight', 'transparency', 'thickness'] as const;

function matchProps(src: Entity, dst: Entity): Entity {
  const c = cloneEntity(dst) as unknown as Record<string, unknown>;
  const s = src as unknown as Record<string, unknown>;
  for (const k of MATCH_KEYS) {
    if (s[k] === undefined) delete c[k];
    else c[k] = structuredClone(s[k]);
  }
  // 같은 종류끼리는 종류별 특성도(AutoCAD 기본 설정과 같게)
  const textual = (t: string) => t === 'TEXT' || t === 'MTEXT' || t === 'ATTDEF' || t === 'ATTRIB';
  if (textual(src.type) && textual(dst.type)) {
    c.style = s.style;
    if (src.type === dst.type) {
      c.height = s.height;
      if (src.type !== 'MTEXT') {
        c.widthFactor = s.widthFactor;
        c.oblique = s.oblique;
      }
    }
  }
  if (src.type === 'DIMENSION' && dst.type === 'DIMENSION') {
    (c as unknown as DimensionEntity).dimStyle = (src as DimensionEntity).dimStyle;
    (c as unknown as DimensionEntity).overrides = structuredClone((src as DimensionEntity).overrides);
  }
  if (src.type === 'HATCH' && dst.type === 'HATCH') {
    for (const k of ['patternName', 'solid', 'patternType', 'patternAngle', 'patternScale', 'patternDouble', 'patternLines', 'gradient', 'hatchStyle'] as const) c[k] = structuredClone(s[k]);
  }
  if (src.type === 'LWPOLYLINE' && dst.type === 'LWPOLYLINE') {
    c.constantWidth = s.constantWidth;
    // 정점 폭도 모두 전역 폭으로(0이면 정점 폭 없음)
    const w = s.constantWidth as number;
    c.widths = tidyWidths(zeros(lwCount(dst as LwPolylineEntity) * 2).fill(w));
  }
  return c as unknown as Entity;
}

export function registerEditCommands(app: App): void {
  // ------------------------------------------------------------- MATCHPROP
  app.register({
    name: 'MATCHPROP',
    aliases: ['MA', 'PAINTER'],
    title: '특성 일치',
    async run(ctx) {
      const st = app.active!;
      const r = await ctx.getEntity('원본 객체 선택:');
      if (!('handle' in r)) return;
      const src = st.doc.entityIndex.get(r.handle);
      if (!src) return;
      ctx.print(`현재 활성 설정: 색상 도면층 선종류 선종류축척 선가중치 투명도 두께 문자 치수 해치 폴리선`);
      app.clearSelection();
      for (;;) {
        const hs = unlockedOnly(app, await ctx.getSelection('대상 객체 선택:', { noPickfirst: true }));
        if (!hs.length) break;
        const ops: EditOp[] = [];
        for (const h of hs) {
          if (h === src.handle) continue;
          const e = st.doc.entityIndex.get(h);
          const block = st.session.ownerOf(h);
          if (!e || !block) continue;
          const c = matchProps(src, e);
          if (JSON.stringify(c) !== JSON.stringify(e)) ops.push({ kind: 'modify', block, before: e, after: c });
        }
        app.clearSelection();
        if (ops.length) st.session.commit({ label: 'MATCHPROP', ops, group: ctx.group });
      }
    },
  });

  // ------------------------------------------------------------- DRAWORDER
  app.register({
    name: 'DRAWORDER',
    aliases: ['DR'],
    title: '그리기 순서',
    async run(ctx, arg) {
      const hs = unlockedOnly(app, await ctx.getSelection());
      if (!hs.length) return;
      let mode = (arg ?? '').toUpperCase();
      if (!['A', 'U', 'F', 'B'].includes(mode)) {
        const r = await ctx.getPoint('객체 순서 옵션 입력 [객체 위로(A)/객체 아래로(U)/맨 앞으로(F)/맨 뒤로(B)] <맨 뒤로>:', {
          keywords: [
            { key: 'A', label: '객체 위로' },
            { key: 'U', label: '객체 아래로' },
            { key: 'F', label: '맨 앞으로' },
            { key: 'B', label: '맨 뒤로' },
          ],
        });
        mode = 'keyword' in r ? r.keyword : 'B';
      }
      let ref: string[] = [];
      if (mode === 'A' || mode === 'U') {
        app.clearSelection();
        ref = await ctx.getSelection('참조 객체 선택:', { noPickfirst: true });
        if (!ref.length) return;
      }
      const n = reorder(app, hs, mode as 'A' | 'U' | 'F' | 'B', ref);
      app.clearSelection();
      ctx.print(n ? `객체 ${n}개의 그리기 순서를 바꿨습니다.` : '바꿀 것이 없습니다.');
    },
  });
  app.register({ name: 'TEXTTOFRONT', title: '문자·치수 맨 앞으로', run: (ctx) => {
    const st = app.active!;
    const space = st.doc.blocks.get(st.space)!;
    const hs = space.entities.filter((e) => e.type === 'TEXT' || e.type === 'MTEXT' || e.type === 'DIMENSION' || e.type === 'MULTILEADER' || e.type === 'LEADER').map((e) => e.handle);
    const n = reorder(app, hs, 'F', []);
    ctx.print(`문자·치수 ${n}개를 맨 앞으로 옮겼습니다.`);
  } });
  app.register({ name: 'HATCHTOBACK', title: '해치 맨 뒤로', run: (ctx) => {
    const st = app.active!;
    const space = st.doc.blocks.get(st.space)!;
    const n = reorder(app, space.entities.filter((e) => e.type === 'HATCH').map((e) => e.handle), 'B', []);
    ctx.print(`해치 ${n}개를 맨 뒤로 옮겼습니다.`);
  } });

  // ------------------------------------------------------------- TEXTEDIT
  app.register({
    name: 'TEXTEDIT',
    aliases: ['ED', 'DDEDIT'],
    title: '문자 편집',
    async run(ctx) {
      for (;;) {
        const r = await ctx.getEntity('주석 객체 선택:');
        if (!('handle' in r)) return;
        await editText(app, r.handle);
      }
    },
  });

  // ------------------------------------------------------------- PURGE
  app.register({
    name: 'PURGE',
    aliases: ['PU'],
    title: '소거',
    async run(ctx) {
      const st = app.active!;
      const found = purgeable(app);
      const total = found.layers.length + found.linetypes.length + found.textStyles.length + found.dimStyles.length + found.blocks.length;
      if (!total) {
        ctx.print('소거할 항목이 없습니다.');
        return;
      }
      const v = await form(
        '소거',
        [
          { key: 'blocks', label: `블록 (${found.blocks.length})`, type: 'check', value: found.blocks.length > 0 },
          { key: 'layers', label: `도면층 (${found.layers.length})`, type: 'check', value: found.layers.length > 0 },
          { key: 'linetypes', label: `선종류 (${found.linetypes.length})`, type: 'check', value: found.linetypes.length > 0 },
          { key: 'textStyles', label: `문자 스타일 (${found.textStyles.length})`, type: 'check', value: found.textStyles.length > 0 },
          { key: 'dimStyles', label: `치수 스타일 (${found.dimStyles.length})`, type: 'check', value: found.dimStyles.length > 0 },
        ],
        { ok: '소거', note: '쓰이지 않는 항목만 지웁니다. 명령 취소(U)로 되돌릴 수 있습니다.' },
      );
      if (!v) return;
      const ops: EditOp[] = [];
      if (v.blocks)
        for (const k of found.blocks) {
          ops.push({ kind: 'blockDef', key: k, before: st.doc.blocks.get(k)!, after: null });
          const rec = st.doc.blockRecords.get(k);
          if (rec) ops.push({ kind: 'blockRecord', key: k, before: rec, after: null });
        }
      if (v.layers) for (const k of found.layers) ops.push({ kind: 'layer', key: k, before: st.doc.layers.get(k)!, after: null });
      if (v.linetypes) for (const k of found.linetypes) ops.push({ kind: 'linetype', key: k, before: st.doc.linetypes.get(k)!, after: null });
      if (v.textStyles) for (const k of found.textStyles) ops.push({ kind: 'textStyle', key: k, before: st.doc.textStyles.get(k)!, after: null });
      if (v.dimStyles) for (const k of found.dimStyles) ops.push({ kind: 'dimStyle', key: k, before: st.doc.dimStyles.get(k)!, after: null });
      if (!ops.length) return;
      st.session.commit({ label: 'PURGE', ops });
      ctx.print(`항목 ${ops.filter((o) => o.kind !== 'blockRecord').length}개를 소거했습니다.`);
    },
  });
}

/** 그리기 순서 바꾸기: 고른 객체를 맨 앞(F)·맨 뒤(B)·참조 위(A)·아래(U)로 */
export function reorder(app: App, handles: string[], mode: 'A' | 'U' | 'F' | 'B', ref: string[]): number {
  const st = app.active!;
  const ops: EditOp[] = [];
  // 공간(블록)별로
  const byBlock = new Map<string, string[]>();
  for (const h of handles) {
    const b = st.session.ownerOf(h);
    if (!b) continue;
    let l = byBlock.get(b);
    if (!l) byBlock.set(b, (l = []));
    l.push(h);
  }
  let moved = 0;
  for (const [bk, hs] of byBlock) {
    const block = st.doc.blocks.get(bk)!;
    const set = new Set(hs);
    const list = block.entities;
    const picked = list.filter((e) => set.has(e.handle));
    const rest = list.filter((e) => !set.has(e.handle));
    let at: number;
    if (mode === 'F') at = rest.length;
    else if (mode === 'B') at = 0;
    else {
      const refSet = new Set(ref);
      const idx = rest.map((e, i) => (refSet.has(e.handle) ? i : -1)).filter((i) => i >= 0);
      if (!idx.length) continue;
      at = mode === 'A' ? Math.max(...idx) + 1 : Math.min(...idx);
    }
    const next = [...rest.slice(0, at), ...picked, ...rest.slice(at)];
    if (next.every((e, i) => e === list[i])) continue;
    // 지우고(뒤에서부터) 새 자리에 넣기(앞에서부터)
    const removes: EditOp[] = [];
    list.forEach((e, i) => {
      if (set.has(e.handle)) removes.push({ kind: 'remove', block: bk, entity: e, index: i });
    });
    ops.push(...removes.reverse());
    picked.forEach((e, j) => ops.push({ kind: 'add', block: bk, entity: e, index: at + j }));
    moved += picked.length;
  }
  if (ops.length) st.session.commit({ label: 'DRAWORDER', ops, rebuildNow: true });
  return moved;
}

/** 문자·여러 줄 문자·속성 정의·치수 문자·블록 속성을 고친다 */
export async function editText(app: App, handle: string): Promise<boolean> {
  const st = app.active!;
  const e = st.doc.entityIndex.get(handle);
  if (!e) return false;
  if (e.type === 'INSERT') return editAttributes(app, null, handle);
  if (!unlockedOnly(app, [handle]).length) return false;
  const block = st.session.ownerOf(handle);
  if (!block) return false;
  let after: Entity | null = null;
  if (e.type === 'TEXT') {
    const v = await form('문자 편집', [{ key: 't', label: '문자', type: 'text', value: e.text }]);
    if (!v) return false;
    after = { ...cloneEntity(e), text: String(v.t) };
  } else if (e.type === 'ATTDEF' && 'tag' in e) {
    const v = await form('속성 정의 편집', [
      { key: 'tag', label: '태그', type: 'text', value: e.tag },
      { key: 'prompt', label: '프롬프트', type: 'text', value: e.prompt ?? '' },
      { key: 'value', label: '기본값', type: 'text', value: e.text },
    ]);
    if (!v) return false;
    after = { ...cloneEntity(e), tag: String(v.tag).trim().toUpperCase() || e.tag, prompt: String(v.prompt) || undefined, text: String(v.value) };
  } else if (e.type === 'MTEXT') {
    const v = await textDialog('여러 줄 문자 편집', e.text.replace(/\\P/g, '\n'), e.height);
    if (!v) return false;
    after = { ...cloneEntity(e), text: v.text.replace(/\r?\n/g, '\\P'), height: v.height };
  } else if (e.type === 'DIMENSION') {
    const v = await form('치수 문자 편집', [{ key: 't', label: '문자', type: 'text', value: e.text || '<>' }], { note: '<>는 측정값입니다. 비우면 측정값만 보입니다.' });
    if (!v) return false;
    const t = String(v.t);
    after = { ...cloneEntity(e), text: t === '<>' ? '' : t };
  } else {
    app.cmd.print('문자나 치수, 속성이 있는 블록을 고르십시오.', 'err');
    return false;
  }
  if (!after || JSON.stringify(after) === JSON.stringify(e)) return false;
  st.session.commit({ label: 'TEXTEDIT', ops: [{ kind: 'modify', block, before: e, after }] });
  return true;
}

/** 쓰이지 않는 표 항목과 블록 */
export function purgeable(app: App): { layers: string[]; linetypes: string[]; textStyles: string[]; dimStyles: string[]; blocks: string[] } {
  const d = app.active!.doc;
  const usedLayers = new Set<string>(['0', 'DEFPOINTS', tableKey(String(d.header.get('$CLAYER') ?? '0'))]);
  const usedLt = new Set<string>(['BYLAYER', 'BYBLOCK', 'CONTINUOUS', tableKey(String(d.header.get('$CELTYPE') ?? 'BYLAYER'))]);
  const usedTs = new Set<string>(['STANDARD', tableKey(String(d.header.get('$TEXTSTYLE') ?? 'STANDARD'))]);
  const usedDs = new Set<string>(['STANDARD', tableKey(String(d.header.get('$DIMSTYLE') ?? 'STANDARD'))]);
  const usedBlocks = new Set<string>();
  const visit = (e: Entity) => {
    const a = e as Entity & Record<string, unknown>;
    usedLayers.add(tableKey(e.layer));
    usedLt.add(tableKey(e.linetype));
    if (typeof a.style === 'string') usedTs.add(tableKey(a.style));
    if (e.type === 'INSERT') {
      usedBlocks.add(tableKey(e.block));
      for (const at of e.attribs) visit(at);
    }
    if (e.type === 'DIMENSION') {
      usedDs.add(tableKey(e.dimStyle));
      if (e.block) usedBlocks.add(tableKey(e.block));
    }
    if (e.type === 'ACAD_TABLE' || e.type === 'MULTILEADER') {
      const b = (a.block as string | undefined) ?? (a.blockName as string | undefined);
      if (b) usedBlocks.add(tableKey(b));
    }
  };
  for (const b of d.blocks.values()) for (const e of b.entities) visit(e);
  for (const l of d.layers.values()) usedLt.add(tableKey(l.linetype));
  for (const ds of d.dimStyles.values()) {
    for (const v of Object.values(ds as unknown as Record<string, unknown>)) {
      if (typeof v === 'string') {
        const k = tableKey(v);
        if (d.textStyles.has(k)) usedTs.add(k);
        if (d.blocks.has(k)) usedBlocks.add(k);
        if (d.linetypes.has(k)) usedLt.add(k);
      }
    }
  }
  // 문자 무늬가 있는 선종류가 쓰는 문자 스타일
  for (const lt of d.linetypes.values()) for (const el of lt.elements ?? []) if (el.styleHandle) for (const ts of d.textStyles.values()) if (ts.handle === el.styleHandle) usedTs.add(tableKey(ts.name));
  // 쓰이지 않는 블록 안의 객체가 쓰는 블록·도면층은 아직 쓰이는 것으로 본다(한 번 더 PURGE하면 지워진다)
  const blocks = [...d.blocks.entries()]
    .filter(([k, b]) => !isLayoutBlock(k) && !b.name.startsWith('*') && !(b.flags & 4) && !b.name.includes('|') && !usedBlocks.has(k))
    .map(([k]) => k);
  return {
    layers: [...d.layers.keys()].filter((k) => !usedLayers.has(k) && !k.includes('|')),
    linetypes: [...d.linetypes.keys()].filter((k) => !usedLt.has(k) && !k.includes('|')),
    textStyles: [...d.textStyles.entries()].filter(([k, s]) => !usedTs.has(k) && s.name !== '' && !(s.flags & 1) && !k.includes('|')).map(([k]) => k),
    dimStyles: [...d.dimStyles.keys()].filter((k) => !usedDs.has(k) && !k.includes('|')),
    blocks,
  };
}
