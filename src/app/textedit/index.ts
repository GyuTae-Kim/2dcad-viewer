/**
 * 제자리 문자 편집기 진입점: 객체에서 편집기 초기값(자리·높이·스타일·색)을 만들고, 옛 textDialog 자리의 편집기를 띄운다.
 */
import type { CadColor, DimensionEntity, Entity, MLeaderEntity, MTextEntity, TextEntity } from '../../core/model';
import { tableKey } from '../../core/model';
import { dimensionText, generateDimensionGeometry, rawDimVars } from '../../edit/dim';
import { dimKindName } from '../../edit/dim/format';
import { fieldTemplate } from '../../edit/field/store';
import type { App, CommandContext } from '../app';
import type { Pt } from '../view';
import { type EditorHooks, type EditorInit, type EditorResult, TextEditor, openTextEditor } from './editor';

export { TextEditor, openTextEditor, activeEditor, SYMBOLS } from './editor';
export type { EditorInit, EditorResult, EditorHooks } from './editor';

const ang = (v: { x: number; y: number } | undefined, fallback: number) => (v && (v.x || v.y) ? Math.atan2(v.y, v.x) : fallback);

/** 문자 스타일 핸들 → 이름 */
export function styleNameOf(app: App, handle: string | undefined, fallback = 'Standard'): string {
  if (!handle) return fallback;
  const st = app.active;
  const s = st ? [...st.doc.textStyles.values()].find((t) => t.handle === handle) : undefined;
  return s?.name ?? fallback;
}

/** 문자 스타일 이름 → 핸들 */
export function styleHandleOf(app: App, name: string): string | undefined {
  return app.active?.doc.textStyles.get(tableKey(name))?.handle;
}

/** MTEXT 편집 초기값 */
export function mtextInit(e: MTextEntity, label = '여러 줄 문자 편집'): EditorInit {
  const tpl = fieldTemplate(e);
  return {
    mode: 'mtext',
    label,
    text: tpl ?? e.text,
    fields: tpl !== null,
    height: e.height,
    style: e.style,
    attachment: e.attachment,
    width: e.width,
    rotation: ang(e.direction, e.rotation),
    at: { x: e.insert.x, y: e.insert.y },
    lineSpacingFactor: e.lineSpacingFactor,
    lineSpacingStyle: e.lineSpacingStyle,
    columns: e.columns,
    rectHeight: e.rectHeight,
    color: e.color,
    layer: e.layer,
  };
}

/** TEXT·속성 정의의 기준선 왼쪽 점(정렬된 문자는 배치한 첫 글자 자리) */
export function textBaseline(app: App, e: TextEntity): { at: Pt; rotation: number } {
  const st = app.active;
  let rot = e.rotation;
  if ((e.halign === 3 || e.halign === 5) && e.alignPoint) rot = Math.atan2(e.alignPoint.y - e.insert.y, e.alignPoint.x - e.insert.x);
  if (e.halign === 0 && e.valign === 0) return { at: { x: e.insert.x, y: e.insert.y }, rotation: rot };
  try {
    const style = st?.doc.textStyles.get(tableKey(e.style));
    const l = app.text.layoutText({ text: e.text || 'X', insert: e.insert, alignPoint: e.alignPoint, height: e.height, rotation: e.rotation, widthFactor: e.widthFactor, oblique: e.oblique, generation: e.generation, halign: e.halign, valign: e.valign, style });
    const g = l.glyphs[0];
    if (g) return { at: { x: g.m[4], y: g.m[5] }, rotation: rot };
  } catch {
    /* 글꼴이 없으면 삽입점 */
  }
  const p = e.alignPoint ?? e.insert;
  return { at: { x: p.x, y: p.y }, rotation: rot };
}

/** TEXT(또는 속성 정의의 값) 편집 초기값 */
export function textInit(app: App, e: TextEntity, text: string, label = '문자 편집', fields = false): EditorInit {
  const b = textBaseline(app, e);
  return { mode: 'text', label, text, fields, height: e.height, style: e.style, at: b.at, rotation: b.rotation, baseline: true, color: e.color, layer: e.layer, selectAll: true };
}

/** 치수 문자의 측정값 글자 */
export function measuredText(app: App, d: DimensionEntity): string {
  const doc = app.active!.doc;
  try {
    return dimensionText(rawDimVars(doc, d), dimKindName(d), d.measurement, '').measured;
  } catch {
    return String(+d.measurement.toFixed(4));
  }
}

/** 치수 문자 편집 초기값(문자 자리는 생성기가 놓는 자리) */
export function dimInit(app: App, d: DimensionEntity): EditorInit {
  const doc = app.active!.doc;
  let at: Pt | null = { x: d.textMid.x, y: d.textMid.y };
  let rot = d.textRotation || 0;
  let height = 2.5;
  let style = 'Standard';
  try {
    const g = generateDimensionGeometry(doc, d);
    const m = g.entities.find((x): x is MTextEntity => x.type === 'MTEXT');
    if (m) {
      at = { x: m.insert.x, y: m.insert.y };
      rot = ang(m.direction, m.rotation);
      height = m.height;
      style = m.style;
    }
  } catch {
    /* 정의를 그릴 수 없으면 문자 중간점 */
  }
  return {
    mode: 'mtext',
    label: '치수 문자 편집',
    text: d.text && d.text !== ' ' ? d.text : d.text === ' ' ? '' : '<>',
    measure: measuredText(app, d),
    height,
    style,
    attachment: 5,
    width: 0,
    rotation: rot,
    at,
    color: d.color,
    layer: d.layer,
    noEntityProps: true,
  };
}

/** 다중 지시선 문자 편집 초기값 */
export function mleaderInit(app: App, e: MLeaderEntity): EditorInit | null {
  const t = e.context.text;
  if (e.contentType !== 2 || !t) return null;
  const color: CadColor | undefined = t.color && t.color.aci !== 0 ? t.color : e.color;
  return {
    mode: 'mtext',
    label: '다중 지시선 문자 편집',
    text: t.text,
    height: e.context.textHeight,
    style: styleNameOf(app, t.styleHandle ?? e.textStyleHandle),
    attachment: t.attachment || 1,
    width: t.width,
    rotation: ang(t.direction, t.rotation),
    at: { x: t.location.x, y: t.location.y },
    lineSpacingFactor: t.lineSpacingFactor,
    lineSpacingStyle: t.lineSpacingStyle,
    color,
    layer: e.layer,
  };
}

/** 객체의 편집 초기값(문자를 고칠 수 없는 객체는 null) */
export function entityInit(app: App, e: Entity): EditorInit | null {
  switch (e.type) {
    case 'MTEXT':
      return mtextInit(e);
    case 'TEXT': {
      const tpl = fieldTemplate(e);
      return textInit(app, e, tpl ?? e.text, '문자 편집', tpl !== null);
    }
    case 'DIMENSION':
      return dimInit(app, e);
    case 'MULTILEADER':
      return mleaderInit(app, e);
    default:
      return null;
  }
}

export interface TextDialogOptions {
  app?: App | null;
  /** 부착점(도면 좌표). 없으면 커서 자리(없으면 화면 위쪽 가운데) */
  at?: Pt | null;
  attachment?: number;
  rotation?: number;
  width?: number;
  style?: string;
  /** 치수 문자: <>에 보일 측정값 */
  measure?: string;
  ctx?: CommandContext;
  color?: CadColor;
  layer?: string;
  lineSpacingFactor?: number;
  lineSpacingStyle?: number;
  columns?: EditorInit['columns'];
  rectHeight?: number;
  /** 필드를 템플릿으로 남긴다(호출자가 applyTemplate으로 확정) */
  fields?: boolean;
  hooks?: EditorHooks;
}

/** 커서 자리(도면 좌표) */
export function cursorWorld(app: App | null | undefined): Pt | null {
  if (!app) return null;
  const view = app.view as unknown as { overlay?: { cursor?: Pt | null }; screenToWorld?: (x: number, y: number) => Pt };
  const c = view.overlay?.cursor;
  if (!c || !view.screenToWorld) return null;
  return view.screenToWorld(c.x, c.y);
}

/**
 * 여러 줄 문자 편집기(옛 textDialog 자리). 결과 text는 MTEXT 서식 문자열(문단은 \P).
 * 높이 0이면 현재 문자 높이(TEXTSIZE).
 */
export function richTextDialog(title: string, initial: string, height: number, opt: TextDialogOptions = {}): Promise<EditorResult | null> {
  const app = opt.app ?? null;
  const doc = app?.active?.doc;
  const h = height > 0 ? height : Number(doc?.header.get('$DIMTXT') ?? doc?.header.get('$TEXTSIZE') ?? 2.5) || 2.5;
  const style = opt.style ?? String(doc?.header.get('$TEXTSTYLE') ?? 'Standard');
  const at = opt.at === undefined ? cursorWorld(app) : opt.at;
  const init: EditorInit = {
    mode: 'mtext',
    label: title,
    text: initial,
    fields: opt.fields,
    measure: opt.measure ?? (/<>/.test(initial) ? '<>' : undefined),
    height: h,
    style,
    attachment: opt.attachment ?? (opt.at === undefined && at ? 5 : 1),
    width: opt.width ?? 0,
    rotation: opt.rotation ?? 0,
    at,
    lineSpacingFactor: opt.lineSpacingFactor,
    lineSpacingStyle: opt.lineSpacingStyle,
    columns: opt.columns,
    rectHeight: opt.rectHeight,
    color: opt.color,
    layer: opt.layer,
    ctx: opt.ctx,
    noEntityProps: opt.measure !== undefined || /<>/.test(initial),
  };
  return openTextEditor(app, init, opt.hooks);
}

export function makeEditor(app: App | null, init: EditorInit): TextEditor {
  return new TextEditor(app, init);
}
