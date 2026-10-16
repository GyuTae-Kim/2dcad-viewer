/**
 * FIND(찾기 및 대치): 찾을 위치(전체 도면·현재 공간·선택한 객체)와 찾을 객체 종류(문자·블록 속성 값·치수 문자 재지정·
 * 표 문자·다중 지시선 문자)에서 일치를 찾고 바꾼다. 대치 한 번(모두 대치 포함)은 명령 취소 한 단계다.
 * 필드가 있는 문자(바꾸면 필드가 사라진다)와 잠긴 도면층의 객체는 바꾸지 않고 센다.
 */
import type { DimensionEntity, Entity, InsertEntity, MLeaderEntity } from '../../core/model';
import { tableKey } from '../../core/model';
import { type FindOptions, type TextMode, countMatches, replaceMatches } from '../../edit/annot/findreplace';
import { fieldTemplate } from '../../edit/field/store';
import type { EditOp } from '../../edit/session';
import { cloneEntity, isLayoutBlock } from '../../edit/session';
import { getText, setText } from '../../edit/table/model';
import { isEditableTable, tableFromEntity } from '../../edit/table/entity';
import { parseRich, plainText } from '../../text/mtextedit';
import type { App, CommandContext } from '../app';
import { commitResults } from '../modify';
import { commitTable } from '../tablecmds';
import { detachedContext } from './entity';

export type FindKind = 'text' | 'attrib' | 'dim' | 'table' | 'mleader';

export const FIND_KINDS: { key: FindKind; label: string }[] = [
  { key: 'text', label: '문자(단일 행·여러 줄)' },
  { key: 'attrib', label: '블록 속성 값' },
  { key: 'dim', label: '치수 문자 재지정' },
  { key: 'table', label: '표 문자' },
  { key: 'mleader', label: '다중 지시선 문자' },
];

export type FindScope = 'all' | 'space' | 'selection';

export interface FindQuery extends FindOptions {
  query: string;
  scope: FindScope;
  kinds: ReadonlySet<FindKind>;
}

export interface FindTarget {
  /** 문자를 가진 객체(속성이면 블록 참조) */
  handle: string;
  space: string;
  kind: FindKind;
  label: string;
  /** 보이는 글자 */
  preview: string;
  count: number;
  attrib?: number;
  cell?: { r: number; c: number };
  /** 필드가 있는 문자 */
  field?: boolean;
  locked?: boolean;
}

function preview(src: string, mode: TextMode): string {
  return plainText(parseRich(src, { mode: mode === 'text' ? 'text' : 'mtext', measure: mode === 'dim' }), () => '', '<>').replace(/\n/g, ' ');
}

const colName = (c: number): string => {
  let s = '';
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

/** 찾을 객체들(공간 블록 이름과 함께) */
function scopeEntities(app: App, scope: FindScope): { e: Entity; space: string }[] {
  const st = app.active!;
  const out: { e: Entity; space: string }[] = [];
  if (scope === 'selection') {
    for (const h of st.selection) {
      const e = st.doc.entityIndex.get(h);
      const space = st.session.ownerOf(h);
      if (e && space) out.push({ e, space });
    }
    return out;
  }
  const keys = scope === 'all' ? [...st.doc.blocks.keys()].filter(isLayoutBlock) : [st.space];
  for (const k of keys) for (const e of st.doc.blocks.get(k)?.entities ?? []) out.push({ e, space: k });
  return out;
}

/** 일치가 있는 문자들 */
export function findTargets(app: App, q: FindQuery): FindTarget[] {
  const st = app.active!;
  const out: FindTarget[] = [];
  if (!q.query) return out;
  const locked = (e: Entity) => !!st.doc.layers.get(tableKey(e.layer))?.locked;
  const push = (t: Omit<FindTarget, 'count' | 'preview'>, src: string, mode: TextMode) => {
    const count = countMatches(src, mode, q.query, q);
    if (count) out.push({ ...t, count, preview: preview(src, mode) });
  };
  for (const { e, space } of scopeEntities(app, q.scope)) {
    if (out.length > 2000) break;
    switch (e.type) {
      case 'TEXT':
      case 'MTEXT':
        if (q.kinds.has('text')) push({ handle: e.handle, space, kind: 'text', label: e.type === 'TEXT' ? '문자' : '여러 줄 문자', field: fieldTemplate(e) !== null, locked: locked(e) }, e.text, e.type === 'TEXT' ? 'text' : 'mtext');
        break;
      case 'INSERT':
        if (q.kinds.has('attrib'))
          e.attribs.forEach((a, i) => {
            if (a.attFlags & 1) return;
            const mt = !!a.mtext;
            push({ handle: e.handle, space, kind: 'attrib', label: `속성 ${a.tag}`, attrib: i, field: fieldTemplate(a) !== null, locked: locked(e) }, mt ? a.mtext!.text : a.text, mt ? 'mtext' : 'text');
          });
        if (q.kinds.has('table') && isEditableTable(e)) pushTable(e);
        break;
      case 'DIMENSION':
        if (q.kinds.has('dim') && e.text && e.text !== ' ') push({ handle: e.handle, space, kind: 'dim', label: '치수', locked: locked(e) }, e.text, 'dim');
        break;
      case 'MULTILEADER':
        if (q.kinds.has('mleader') && e.contentType === 2 && e.context.text) push({ handle: e.handle, space, kind: 'mleader', label: '다중 지시선', locked: locked(e) }, e.context.text.text, 'mtext');
        break;
      case 'ACAD_TABLE':
        if (q.kinds.has('table')) pushTable(e);
        break;
    }
  }
  return out;

  function pushTable(e: Entity): void {
    if (!isEditableTable(e)) return;
    const t = tableFromEntity(e, st.doc);
    if (!t) return;
    const space = st.session.ownerOf(e.handle) ?? st.space;
    for (let r = 0; r < t.data.rows; r++)
      for (let c = 0; c < t.data.cols; c++) {
        const text = t.data.cells[r * t.data.cols + c]?.text ?? '';
        if (!text || text.startsWith('=')) continue;
        push({ handle: e.handle, space, kind: 'table', label: `표 ${colName(c)}${r + 1}`, cell: { r, c }, locked: !!st.doc.layers.get(tableKey(e.layer))?.locked }, text, 'mtext');
      }
  }
}

export interface ReplaceSummary {
  /** 바꾼 일치 수 */
  replaced: number;
  /** 바꾼 객체 수 */
  objects: number;
  skippedField: number;
  skippedLocked: number;
}

/** 찾은 문자들의 일치를 모두 바꾼다(한 번의 명령 취소) */
export function replaceTargets(app: App, targets: readonly FindTarget[], q: FindQuery, replacement: string, ctx?: CommandContext): ReplaceSummary {
  const st = app.active!;
  const sum: ReplaceSummary = { replaced: 0, objects: 0, skippedField: 0, skippedLocked: 0 };
  const c = ctx ?? detachedContext(app);
  const group = c.group;
  // 객체마다 고친 사본(같은 객체의 여러 대상 — 속성·셀 — 을 한 사본에)
  const edited = new Map<string, Entity>();
  const tables = new Map<string, { r: number; c: number }[]>();
  for (const t of targets) {
    if (t.locked) {
      sum.skippedLocked++;
      continue;
    }
    if (t.field) {
      sum.skippedField++;
      continue;
    }
    if (t.kind === 'table') {
      const l = tables.get(t.handle) ?? [];
      l.push(t.cell!);
      tables.set(t.handle, l);
      continue;
    }
    const orig = st.doc.entityIndex.get(t.handle);
    if (!orig) continue;
    const e = edited.get(t.handle) ?? cloneEntity(orig);
    let n = 0;
    if (t.kind === 'text' && (e.type === 'TEXT' || e.type === 'MTEXT')) {
      const r = replaceMatches(e.text, e.type === 'TEXT' ? 'text' : 'mtext', q.query, replacement, q);
      e.text = r.text;
      n = r.count;
    } else if (t.kind === 'attrib' && e.type === 'INSERT') {
      const a = (e as InsertEntity).attribs[t.attrib!];
      if (a?.mtext) {
        const r = replaceMatches(a.mtext.text, 'mtext', q.query, replacement, q);
        a.mtext.text = r.text;
        a.text = preview(r.text, 'mtext');
        n = r.count;
      } else if (a) {
        const r = replaceMatches(a.text, 'text', q.query, replacement, q);
        a.text = r.text;
        n = r.count;
      }
    } else if (t.kind === 'dim' && e.type === 'DIMENSION') {
      const r = replaceMatches((e as DimensionEntity).text, 'dim', q.query, replacement, q);
      (e as DimensionEntity).text = r.text;
      n = r.count;
    } else if (t.kind === 'mleader' && e.type === 'MULTILEADER' && (e as MLeaderEntity).context.text) {
      const tx = (e as MLeaderEntity).context.text!;
      const r = replaceMatches(tx.text, 'mtext', q.query, replacement, q);
      tx.text = r.text;
      n = r.count;
    }
    if (n) {
      sum.replaced += n;
      edited.set(t.handle, e);
    }
  }
  // 문자·속성·다중 지시선: 한 번에. 치수는 블록을 다시 만든다
  const ops: EditOp[] = [];
  const dims: Entity[] = [];
  for (const [hd, e] of edited) {
    const before = st.doc.entityIndex.get(hd)!;
    const block = st.session.ownerOf(hd);
    if (!block || JSON.stringify(before) === JSON.stringify(e)) continue;
    if (e.type === 'DIMENSION') dims.push(e);
    else ops.push({ kind: 'modify', block, before, after: e });
    sum.objects++;
  }
  if (ops.length) st.session.commit({ label: 'FIND', ops, group });
  if (dims.length) commitResults(app, c, [{ replace: dims }], 'FIND', { quiet: true });
  // 표: 셀 문자를 바꿔 표마다 확정(같은 묶음 번호라 한 단계)
  for (const [hd, cells] of tables) {
    const e = st.doc.entityIndex.get(hd);
    if (!isEditableTable(e)) continue;
    const t = tableFromEntity(e, st.doc);
    if (!t) continue;
    let data = t.data;
    let n = 0;
    for (const cell of cells) {
      const r = replaceMatches(getText(data, cell.r, cell.c), 'mtext', q.query, replacement, q);
      if (!r.count) continue;
      data = setText(data, cell.r, cell.c, r.text);
      n += r.count;
    }
    if (!n) continue;
    sum.replaced += n;
    sum.objects++;
    commitTable(app, { entity: e, space: st.session.ownerOf(hd) ?? st.space, style: t.style, styleHandle: t.styleEntry?.handle }, data, 'FIND', group);
  }
  return sum;
}
