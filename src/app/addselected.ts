/**
 * ADDSELECTED: 고른 객체와 같은 종류의 작성 명령을 그 객체의 특성으로 시작한다(AutoCAD의 종류 → 명령 대응표).
 * - 공통 특성(도면층·색·선종류·선가중치·선종류 축척·투명도)은 명령이 끝날 때까지 편집 확정 고리(App.commitHooks before)가
 *   새로 넣는 객체에 입힌다 — 현재 특성 변수는 바꾸지 않고, 명령 취소 단계도 그 명령 하나다.
 * - 종류별 특성(문자·치수·여러 줄·다중 지시선·테이블 스타일, 해치 패턴·축척·각도, 블록 이름)은 그 명령이 읽는 현재 값으로
 *   잠시 바꿨다가 명령이 끝나면 되돌린다(머리말은 편집 기록 없이 바꿨다 되돌린다).
 */
import type { Entity, HatchEntity, HeaderValue, InsertEntity, MLineEntity, TableEntity } from '../core/model';
import { tableKey } from '../core/model';
import type { Transaction } from '../edit/session';
import { isLayoutBlock } from '../edit/session';
import type { App, CommandContext } from './app';
import type { DocState } from './docstate';
import { addHook, type ContextMenuItem, type ContextMenuProvider } from './hooks';
import { settingsOf } from './hatchcmd';

export interface AddSelectedPlan {
  command: string;
  arg?: string;
  /** 명령 동안 잠시 바꿀 머리말 값 */
  header: Record<string, HeaderValue>;
  /** 새 객체에 입힐 공통 특성 */
  props: Pick<Entity, 'layer' | 'color' | 'linetype' | 'lineweight' | 'ltscale' | 'transparency'>;
  /** 해치 설정 */
  hatch?: { pattern: string; scale: number; angle: number; double: boolean };
}

const DIM_COMMAND: Record<number, string> = { 0: 'DIMLINEAR', 1: 'DIMALIGNED', 2: 'DIMANGULAR', 3: 'DIMDIAMETER', 4: 'DIMRADIUS', 5: 'DIMANGULAR', 6: 'DIMORDINATE' };

/** 고른 객체 → 실행할 명령과 특성. 대응하는 작성 명령이 없으면 문구 */
export function addSelectedPlan(st: DocState, e: Entity, has: (cmd: string) => boolean): AddSelectedPlan | { error: string } {
  const doc = st.doc;
  const props = { layer: e.layer, color: { ...e.color }, linetype: e.linetype, lineweight: e.lineweight, ltscale: e.ltscale, transparency: e.transparency };
  const header: Record<string, HeaderValue> = {};
  let command = '';
  let arg: string | undefined;
  let hatch: AddSelectedPlan['hatch'];
  const style = (e as { style?: unknown }).style;
  switch (e.type) {
    case 'LINE':
    case 'XLINE':
    case 'RAY':
    case 'CIRCLE':
    case 'ARC':
    case 'ELLIPSE':
    case 'SPLINE':
    case 'POINT':
    case '3DFACE':
    case 'WIPEOUT':
    case 'SOLID':
    case 'TOLERANCE':
    case 'LEADER':
      command = e.type;
      if (e.type === 'TOLERANCE' || e.type === 'LEADER') header.$DIMSTYLE = (e as { dimStyle: string }).dimStyle;
      break;
    case 'LWPOLYLINE':
      command = 'PLINE';
      break;
    case 'POLYLINE':
      // 3D 폴리선(플래그 8)·메시는 3DPOLY
      command = (e as { flags?: number }).flags! & (8 | 16 | 64) ? '3DPOLY' : 'PLINE';
      break;
    case 'TEXT':
    case 'MTEXT':
    case 'ATTDEF':
      command = e.type;
      if (typeof style === 'string' && doc.textStyles.has(tableKey(style))) header.$TEXTSTYLE = doc.textStyles.get(tableKey(style))!.name;
      break;
    case 'INSERT': {
      const ins = e as InsertEntity;
      const def = doc.blocks.get(tableKey(ins.block));
      if (!def || def.name.startsWith('*') || def.flags & 4 || isLayoutBlock(tableKey(def.name))) return { error: '이 객체 유형은 ADDSELECTED에서 지원하지 않습니다.' };
      command = 'INSERT';
      arg = def.name;
      break;
    }
    case 'DIMENSION': {
      const d = e as { subtype?: string; dimType: number; dimStyle: string };
      command = d.subtype === 'ARC_DIMENSION' ? 'DIMARC' : d.subtype === 'LARGE_RADIAL_DIMENSION' ? 'DIMJOGGED' : (DIM_COMMAND[d.dimType & 7] ?? 'DIMLINEAR');
      if (doc.dimStyles.has(tableKey(d.dimStyle))) header.$DIMSTYLE = doc.dimStyles.get(tableKey(d.dimStyle))!.name;
      break;
    }
    case 'HATCH': {
      const hh = e as HatchEntity;
      command = (e as { gradient?: unknown }).gradient ? 'GRADIENT' : 'HATCH';
      hatch = { pattern: hh.solid ? 'SOLID' : hh.patternName, scale: hh.patternScale || 1, angle: hh.patternAngle || 0, double: !!hh.patternDouble };
      break;
    }
    case 'MULTILEADER': {
      command = 'MLEADER';
      const sh = (e as { styleHandle?: string }).styleHandle;
      const so = sh ? doc.objects.get(sh) : undefined;
      if (so?.type === 'MLEADERSTYLE') header.$CMLEADERSTYLE = (so as { name: string }).name;
      break;
    }
    case 'MLINE': {
      command = 'MLINE';
      const m = e as MLineEntity;
      header.$CMLSTYLE = m.styleName;
      header.$CMLSCALE = m.scale;
      header.$CMLJUST = m.justification;
      break;
    }
    case 'ACAD_TABLE': {
      command = 'TABLE';
      const th = (e as TableEntity).tableStyle;
      const so = th ? doc.objects.get(th) : undefined;
      const nm = so ? (so as { name?: string }).name : undefined;
      if (nm) header.$CTABLESTYLE = nm;
      break;
    }
    case 'IMAGE':
      command = 'IMAGEATTACH';
      break;
    case 'VIEWPORT':
      command = 'MVIEW';
      break;
    default:
      return { error: '이 객체 유형은 ADDSELECTED에서 지원하지 않습니다.' };
  }
  if (!has(command)) return { error: '이 객체 유형은 ADDSELECTED에서 지원하지 않습니다.' };
  return { command, arg, header, props, hatch };
}

/** 명령이 도는 동안 새 객체에 입힐 특성(문서별) */
let active: { st: DocState; props: AddSelectedPlan['props'] } | null = null;

function paint(st: DocState, tx: Transaction): Transaction {
  if (!active || active.st !== st) return tx;
  const p = active.props;
  let touched = false;
  const ops = tx.ops.map((op) => {
    // 지금 공간에 넣는 객체만(치수·테이블의 익명 블록 안 객체는 그대로)
    if (op.kind !== 'add' || op.block !== st.space) return op;
    touched = true;
    const e = { ...op.entity, layer: p.layer, color: { ...p.color }, linetype: p.linetype, lineweight: p.lineweight, ltscale: p.ltscale, transparency: p.transparency } as Entity;
    if (e.type === 'INSERT') (e as InsertEntity).attribs = (op.entity as InsertEntity).attribs.map((a) => (a.layer === (op.entity as InsertEntity).layer ? { ...a, layer: p.layer } : a));
    return { ...op, entity: e };
  });
  return touched ? { ...tx, ops } : tx;
}

/** ADDSELECTED 실행(고른 객체 하나) */
export async function runAddSelected(app: App, ctx: CommandContext, handle: string): Promise<void> {
  const st = app.active!;
  const e = st.doc.entityIndex.get(handle);
  if (!e) return;
  const plan = addSelectedPlan(st, e, (c) => !!app.findCommand(c));
  if ('error' in plan) {
    ctx.print(plan.error, 'err');
    return;
  }
  // 잠시 바꿀 값(되돌릴 원래 값)
  const saved = new Map<string, HeaderValue | undefined>();
  for (const [k, v] of Object.entries(plan.header)) {
    saved.set(k, st.doc.header.get(k));
    st.doc.header.set(k, v);
  }
  const hs = plan.hatch ? settingsOf(st) : null;
  const hsSaved = hs ? { pattern: hs.pattern, scale: hs.scale, angle: hs.angle, double: hs.double } : null;
  if (hs && plan.hatch) Object.assign(hs, plan.hatch);
  st.selection.clear();
  app.clearSelection?.();
  active = { st, props: plan.props };
  try {
    await app.run(plan.command, plan.arg);
  } finally {
    active = null;
    for (const [k, v] of saved) {
      if (v === undefined) st.doc.header.delete(k);
      else st.doc.header.set(k, v);
    }
    if (hs && hsSaved) Object.assign(hs, hsSaved);
  }
}

export function registerAddSelected(app: App): void {
  addHook(app.commitHooks, { name: 'addselected', before: (st, tx) => paint(st, tx) });
  app.register({
    name: 'ADDSELECTED',
    title: '선택한 객체 추가',
    async run(ctx) {
      const st = app.active!;
      const pre = [...st.selection];
      let h = pre.length === 1 ? pre[0]! : '';
      if (!h) {
        const r = await ctx.getEntity('객체 선택:');
        if (!('handle' in r)) return;
        h = r.handle;
      }
      await runAddSelected(app, ctx, h);
    },
  });
  // 도면 영역 오른쪽 클릭(편집 모드, 객체 하나)에 "선택한 객체 추가" — App.contextMenuProviders가 있을 때
  const providers = (app as unknown as { contextMenuProviders?: ContextMenuProvider[] }).contextMenuProviders;
  if (providers)
    addHook(providers, {
      name: 'addselected',
      items: (c): ContextMenuItem[] | null => (c.mode === 'edit' && c.selection.length === 1 ? [{ label: '선택한 객체 추가(D)', run: () => void app.run('ADDSELECTED') }] : null),
    });
}
