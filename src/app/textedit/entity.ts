/**
 * 객체 문자 고치기(TEXTEDIT·두 번 누르기): 문자·여러 줄 문자·속성 정의·치수 문자·다중 지시선 문자는 제자리 편집기,
 * 공차는 "기하학적 공차" 대화상자, 옛 지시선은 그 주석 객체, 블록 참조는 속성 편집. 편집 하나는 명령 취소 한 단계다.
 */
import type { AttribEntity, DimensionEntity, Entity, LeaderEntity, MLeaderEntity, MTextEntity, TextEntity, ToleranceEntity } from '../../core/model';
import { applyTemplate, withFieldTemplate } from '../../edit/field/store';
import { buildToleranceText, parseToleranceText } from '../../edit/annot/tolerance';
import type { EditOp } from '../../edit/session';
import { cloneEntity } from '../../edit/session';
import type { App, CommandContext } from '../app';
import { CancelError } from '../app';
import { form } from '../ui/dom';
import type { Pt } from '../view';
import { fieldCtx } from './commands';
import { type EditorInit, type EditorResult, openTextEditor } from './editor';
import { dimInit, entityInit, mleaderInit, mtextInit, styleHandleOf, textInit } from './index';

let fakeGroup = -1_000_000;

/** 명령 밖(두 번 누르기·특성 팔레트)에서 쓰는 명령 문맥: 입력은 받지 않고 묶음 번호는 따로 */
export function detachedContext(app: App): CommandContext {
  const reject = () => Promise.reject(new CancelError());
  return { app, print: (t, c) => app.cmd.print(t, c), getPoint: reject, getEntity: reject, getSelection: reject, group: fakeGroup-- };
}

/** 문자를 고칠 수 있는 객체인지(두 번 누르기 고리가 맡을 것) */
export function isTextEditable(e: Entity | undefined): boolean {
  if (!e) return false;
  switch (e.type) {
    case 'TEXT':
    case 'MTEXT':
    case 'ATTDEF':
    case 'DIMENSION':
    case 'TOLERANCE':
    case 'LEADER':
      return true;
    case 'MULTILEADER':
      return e.contentType === 2 && !!e.context.text;
    default:
      return false;
  }
}

function commitModify(app: App, ctx: CommandContext | undefined, before: Entity, after: Entity | null): boolean {
  const st = app.active!;
  const block = st.session.ownerOf(before.handle);
  if (!block) return false;
  const ops: EditOp[] = after ? [{ kind: 'modify', block, before, after }] : [{ kind: 'remove', block, entity: before, index: st.doc.blocks.get(block)!.entities.indexOf(before) }];
  st.session.commit({ label: 'TEXTEDIT', ops, group: ctx?.group });
  if (!after) st.selection.delete(before.handle);
  return true;
}

/** 필드 템플릿 결과를 문자 객체에 적용(필드가 없으면 필드 기록을 뗀다) */
function withText<T extends TextEntity | MTextEntity | AttribEntity>(app: App, e: T, r: EditorResult): T {
  const c = { ...(cloneEntity(e) as T), text: r.text };
  if (r.fields) return applyTemplate(c, r.text, fieldCtx(app.active!));
  if (r.textChanged) {
    const x = withFieldTemplate(c.xdata, null);
    if (x) c.xdata = x;
    else delete c.xdata;
  }
  return c;
}

async function editTextEntity(app: App, e: TextEntity, ctx?: CommandContext): Promise<boolean> {
  const init = entityInit(app, e)!;
  const r = await openTextEditor(app, { ...init, ctx });
  if (!r || !r.changed) return false;
  // 내용을 모두 지우면 객체를 지운다(AutoCAD와 같다)
  if (!r.plain.trim()) return commitModify(app, ctx, e, null);
  return commitModify(app, ctx, e, withText(app, e, r));
}

/** 속성 정의: 태그를 제자리에서, "속성 정의..."로 태그·프롬프트·기본값 대화상자 */
async function editAttdef(app: App, e: AttribEntity, ctx?: CommandContext): Promise<boolean> {
  let full = false;
  const init: EditorInit = {
    ...textInit(app, e as unknown as TextEntity, e.tag, '속성 정의 편집'),
    extra: [
      {
        label: '속성 정의...',
        title: '태그·프롬프트·기본값 편집',
        run: (ed) => {
          full = true;
          ed.cancel();
        },
      },
    ],
    ctx,
  };
  const r = await openTextEditor(app, init);
  if (full) {
    const v = await form('속성 정의 편집', [
      { key: 'tag', label: '태그', type: 'text', value: e.tag },
      { key: 'prompt', label: '프롬프트', type: 'text', value: e.prompt ?? '' },
      { key: 'value', label: '기본값', type: 'text', value: e.text },
    ]);
    if (!v) return false;
    const tag = String(v.tag).trim().toUpperCase().replace(/\s+/g, '_') || e.tag;
    const after = { ...cloneEntity(e), tag, prompt: String(v.prompt) || undefined, text: String(v.value) } as AttribEntity;
    if (JSON.stringify(after) === JSON.stringify(e)) return false;
    return commitModify(app, ctx, e, after as unknown as Entity);
  }
  if (!r || !r.textChanged) return false;
  const tag = r.plain.trim().toUpperCase();
  if (!tag || /\s/.test(tag)) {
    app.cmd.print('속성 태그는 비울 수 없고 공백을 포함할 수 없습니다.', 'err');
    return false;
  }
  return commitModify(app, ctx, e as unknown as Entity, { ...cloneEntity(e), tag } as unknown as Entity);
}

async function editMText(app: App, e: MTextEntity, ctx?: CommandContext): Promise<boolean> {
  const r = await openTextEditor(app, { ...mtextInit(e), ctx });
  if (!r || !r.changed) return false;
  if (!r.plain.trim()) return commitModify(app, ctx, e, null);
  const after = withText(app, e, r);
  after.height = r.height;
  after.style = r.style;
  after.attachment = r.attachment;
  after.width = r.width;
  after.lineSpacingFactor = r.lineSpacingFactor;
  after.lineSpacingStyle = r.lineSpacingStyle;
  if (r.columns && r.columns.type > 0) {
    after.columns = r.columns;
    if (r.rectHeight) after.rectHeight = r.rectHeight;
  } else {
    delete after.columns;
  }
  return commitModify(app, ctx, e, after);
}

/** 치수 문자: 바꾸면 치수 블록을 치수 생성기로 다시 만든다 */
async function editDimension(app: App, e: DimensionEntity, ctx?: CommandContext): Promise<boolean> {
  const r = await openTextEditor(app, { ...dimInit(app, e), ctx });
  if (!r || !r.textChanged) return false;
  const t = r.text === '<>' ? '' : r.plain.trim() ? r.text : ' ';
  if (t === (e.text || '')) return false;
  const after = { ...cloneEntity(e), text: t } as DimensionEntity;
  const { commitResults } = await import('../modify');
  commitResults(app, ctx ?? detachedContext(app), [{ replace: [after] }], 'TEXTEDIT', { quiet: true });
  return true;
}

async function editMLeader(app: App, e: MLeaderEntity, ctx?: CommandContext): Promise<boolean> {
  const init = mleaderInit(app, e);
  if (!init) {
    app.cmd.print('여러 줄 문자 내용이 있는 다중 지시선이 아닙니다.', 'err');
    return false;
  }
  const r = await openTextEditor(app, { ...init, ctx });
  if (!r || !r.changed || !r.plain.trim()) return false;
  const after = cloneEntity(e) as MLeaderEntity;
  const t = after.context.text!;
  t.text = r.text;
  t.width = r.width;
  t.lineSpacingFactor = r.lineSpacingFactor;
  t.lineSpacingStyle = r.lineSpacingStyle;
  const sh = styleHandleOf(app, r.style);
  if (sh) {
    t.styleHandle = sh;
    after.textStyleHandle = sh;
  }
  after.context.textHeight = r.height;
  return commitModify(app, ctx, e, after as Entity);
}

/** 공차: 기하학적 공차 대화상자를 지금 값으로 */
export async function editTolerance(app: App, e: ToleranceEntity, ctx?: CommandContext): Promise<boolean> {
  const spec = parseToleranceText(e.text);
  const { toleranceDialog } = await import('../annot2-misc');
  const v = await toleranceDialog(spec);
  if (!v) return false;
  const body = buildToleranceText(v);
  const text = [body, ...spec.extra].filter((x, i) => i === 0 || x).join('^J');
  if (!body) {
    app.cmd.print('공차 내용이 비어 있어 바꾸지 않았습니다.', 'err');
    return false;
  }
  if (text === e.text) return false;
  return commitModify(app, ctx, e, { ...cloneEntity(e), text } as ToleranceEntity);
}

/**
 * 객체의 문자를 고친다. 바꿨으면 true.
 * point는 객체를 고른 점(표 셀 편집).
 */
export async function editEntityText(app: App, handle: string, ctx?: CommandContext, point?: Pt | null): Promise<boolean> {
  const st = app.active;
  if (!st) return false;
  const e = st.doc.entityIndex.get(handle);
  if (!e) return false;
  if (e.type === 'INSERT') {
    const { editAttributes } = await import('../blocks');
    return editAttributes(app, ctx ?? null, handle);
  }
  const { unlockedOnly } = await import('../layers');
  if (!unlockedOnly(app, [handle]).length) return false;
  if (!st.session.ownerOf(handle)) return false;
  switch (e.type) {
    case 'TEXT':
      return editTextEntity(app, e as TextEntity, ctx);
    case 'ATTDEF':
      return editAttdef(app, e as unknown as AttribEntity, ctx);
    case 'MTEXT':
      return editMText(app, e, ctx);
    case 'DIMENSION':
      return editDimension(app, e, ctx);
    case 'MULTILEADER':
      return editMLeader(app, e, ctx);
    case 'TOLERANCE':
      return editTolerance(app, e, ctx);
    case 'LEADER': {
      const l = e as LeaderEntity;
      const a = l.annotation ? st.doc.entityIndex.get(l.annotation) : undefined;
      if (!a) {
        app.cmd.print('이 지시선에는 주석 객체가 없습니다.', 'err');
        return false;
      }
      return editEntityText(app, a.handle, ctx, point);
    }
    case 'ACAD_TABLE': {
      const { editTableAt } = await import('../tablecmds');
      await editTableAt(app, handle, point ?? null);
      return true;
    }
    default:
      app.cmd.print('문자나 치수, 속성이 있는 블록을 고르십시오.', 'err');
      return false;
  }
}
