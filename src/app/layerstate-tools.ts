/**
 * 도면층 이전(LAYERP·LAYERPMODE)과 SETBYLAYER·SETBYLAYERMODE.
 *
 * LAYERP 기록은 편집 세션의 확정(commit)에 단 고리에서 모은다: 도면층 팔레트·LAYER/-LAYER·도면층 도구·도면층 상태 복원 등
 * 도면층 표를 바꾸는 모든 명령이 같은 길로 확정하므로 기존 코드를 고치지 않고 모두 기록된다. 명령 취소(U)·다시 실행은
 * 확정이 아니라서 기록하지 않는다. LAYERP 자신의 변경도 기록하지 않는다(연달아 쓰면 더 앞 단계로 간다).
 * 프롬프트는 AutoCAD 2026 한국어판 꼴을 따른다(확인하지 못한 문구는 보고서에 적었다).
 */
import { tableKey } from '../core/model';
import { LayerPreviousLog, layerPreviousOps } from '../edit/layerstate/previous';
import { SBL_BLOCKS, SBL_BYBLOCK, SBL_DEFAULT, SBL_PROPS, activeSettingsText, setByLayerOps } from '../edit/layerstate/setbylayer';
import type { EditSession, Transaction } from '../edit/session';
import type { App } from './app';
import type { DocState } from './docstate';
import { unlockedOnly } from './layers';
import { form } from './ui/dom';
import { askInt, askKeyword, askYesNo, loadPref, savePref, selectWithKeywords } from './util2-ui';

// ---------------------------------------------------------------------------
// LAYERP 기록
// ---------------------------------------------------------------------------

const logs = new WeakMap<DocState, LayerPreviousLog>();
let suppress = 0;
let layerPMode = true;

export function layerPreviousLog(st: DocState): LayerPreviousLog {
  let l = logs.get(st);
  if (!l) {
    l = new LayerPreviousLog();
    logs.set(st, l);
  }
  return l;
}

/** LAYERPMODE(켜져 있으면 도면층 설정 변경을 기록한다) */
export function getLayerPMode(): boolean {
  return layerPMode;
}

export function setLayerPMode(on: boolean, app?: App): void {
  layerPMode = on;
  // 끄면 기록을 버린다(다시 켠 뒤의 변경부터 되돌린다)
  if (!on && app) for (const st of app.docs) layerPreviousLog(st).clear();
}

function hookSession(st: DocState): void {
  const s = st.session as (EditSession & { __layerP?: boolean }) | undefined;
  if (!s || s.__layerP) return;
  s.__layerP = true;
  const commit = s.commit.bind(s);
  s.commit = (tx: Transaction) => {
    commit(tx);
    if (!suppress && layerPMode) layerPreviousLog(st).record(tx);
  };
}

/** 편집 세션에 LAYERP 고리를 단다(지금 열린 도면과 앞으로 여는 도면 모두) */
export function installLayerPreviousHook(app: App): void {
  const ed = app.edits as (typeof app.edits & { __layerP?: boolean }) | undefined;
  if (ed && !ed.__layerP) {
    ed.__layerP = true;
    const attach = ed.attach.bind(ed);
    ed.attach = (st: DocState) => {
      attach(st);
      hookSession(st);
    };
  }
  for (const st of app.docs) hookSession(st);
}

/** 기록하지 않고 확정한다(LAYERP 자신) */
export function commitWithoutLayerP(st: DocState, tx: Transaction): void {
  suppress++;
  try {
    st.session.commit(tx);
  } finally {
    suppress--;
  }
}

/** 한 단계 되돌리기. 되돌린 도면층 수(기록이 없으면 -1) */
export function layerPrevious(app: App, print: (t: string, cls?: 'err' | 'res') => void, group?: number): number {
  const st = app.active!;
  const log = layerPreviousLog(st);
  for (;;) {
    const step = log.pop();
    if (!step) return -1;
    const ops = layerPreviousOps(st.doc, step);
    if (!ops.length) continue;
    // 현재 도면층(되돌린 뒤의)은 동결할 수 없다
    const clOp = ops.find((o) => o.kind === 'header' && o.name === '$CLAYER');
    const cl = tableKey(String((clOp && clOp.kind === 'header' ? clOp.after : st.doc.header.get('$CLAYER')) ?? '0'));
    for (const op of ops) {
      if (op.kind === 'layer' && op.after && op.key === cl && op.after.frozen) {
        op.after.frozen = false;
        print(`현재 도면층 "${op.after.name}"은(는) 동결할 수 없어 동결하지 않았습니다.`);
      }
    }
    commitWithoutLayerP(st, { label: 'LAYERP', ops, group });
    return ops.length;
  }
}

// ---------------------------------------------------------------------------
// SETBYLAYER
// ---------------------------------------------------------------------------

const SBL_PREF = 'opencad.setbylayermode';

export function getSetByLayerMode(): number {
  const v = Number(loadPref<number>(SBL_PREF, SBL_DEFAULT));
  return Number.isInteger(v) && v >= 0 && v <= 255 ? v : SBL_DEFAULT;
}

export function setSetByLayerMode(v: number): void {
  savePref(SBL_PREF, v & 255);
}

/** SetByLayer 설정 대화상자 */
async function settingsDialog(): Promise<void> {
  const mode = getSetByLayerMode();
  const v = await form(
    'SetByLayer 설정',
    [
      ...SBL_PROPS.map((p) => ({ key: String(p.bit), label: p.label, type: 'check' as const, value: (mode & p.bit) !== 0 })),
      { key: String(SBL_BYBLOCK), label: 'ByBlock을 ByLayer로 변경', type: 'check' as const, value: (mode & SBL_BYBLOCK) !== 0 },
      { key: String(SBL_BLOCKS), label: '블록 포함', type: 'check' as const, value: (mode & SBL_BLOCKS) !== 0 },
    ],
    { ok: '확인', note: 'ByLayer로 바꿀 특성을 고릅니다(SETBYLAYERMODE).' },
  );
  if (!v) return;
  let m = 0;
  for (const [k, on] of Object.entries(v)) if (on) m |= Number(k);
  setSetByLayerMode(m);
}

export function registerLayerToolCommands(app: App): void {
  installLayerPreviousHook(app);

  app.register({
    name: 'LAYERP',
    title: '도면층 이전',
    run(ctx) {
      if (!layerPMode) {
        ctx.print('LAYERPMODE가 꺼져 있어 도면층 변경을 기록하지 않습니다. LAYERPMODE로 켜십시오.', 'err');
        return;
      }
      const n = layerPrevious(app, ctx.print, ctx.group);
      if (n < 0) ctx.print('*** 이전 도면층 상태가 없습니다 ***');
      else ctx.print('이전 도면층 상태를 복원했습니다.');
    },
  });

  app.register({
    name: 'LAYERPMODE',
    title: '도면층 이전 기록',
    noDoc: true,
    async run(ctx) {
      const r = await askKeyword(
        ctx,
        `LAYERP 모드 입력 [켜기(ON)/끄기(OFF)] <${layerPMode ? '켜기' : '끄기'}>:`,
        [
          { key: 'ON', label: '켜기' },
          { key: 'OFF', label: '끄기' },
        ],
        layerPMode ? 'ON' : 'OFF',
      );
      if (r === null || typeof r !== 'string') {
        if (r !== null) ctx.print('ON 또는 OFF를 입력하십시오.', 'err');
        return;
      }
      setLayerPMode(r === 'ON', app);
    },
  });

  app.register({
    name: 'SETBYLAYERMODE',
    title: 'SETBYLAYER 특성',
    noDoc: true,
    async run(ctx) {
      const v = await askInt(ctx, 'SETBYLAYERMODE에 대한 새 값 입력', getSetByLayerMode(), 0, 255);
      setSetByLayerMode(v);
    },
  });

  app.register({
    name: 'SETBYLAYER',
    title: 'ByLayer로 설정',
    async run(ctx) {
      const st = app.active!;
      let handles: string[] = [];
      let first = true;
      for (;;) {
        ctx.print(`현재 활성 설정: ${activeSettingsText(getSetByLayerMode())}`);
        const r = await selectWithKeywords(ctx, '객체 선택 또는 [설정(S)]:', [{ key: 'S', label: '설정' }], first);
        first = false;
        if (Array.isArray(r)) {
          handles = r;
          break;
        }
        if (r.keyword === 'S') await settingsDialog();
      }
      app.clearSelection();
      if (!handles.length) return;
      handles = unlockedOnly(app, handles);
      if (!handles.length) return;
      let mode = getSetByLayerMode();
      const byBlock = await askYesNo(ctx, 'ByBlock을 ByLayer로 변경하시겠습니까?', (mode & SBL_BYBLOCK) !== 0);
      const blocks = await askYesNo(ctx, '블록을 포함하시겠습니까?', (mode & SBL_BLOCKS) !== 0);
      mode = (mode & ~(SBL_BYBLOCK | SBL_BLOCKS)) | (byBlock ? SBL_BYBLOCK : 0) | (blocks ? SBL_BLOCKS : 0);
      setSetByLayerMode(mode);
      const targets = handles
        .map((h) => {
          const entity = st.doc.entityIndex.get(h);
          const block = entity ? st.session.ownerOf(h) : null;
          return entity && block ? { block, entity } : null;
        })
        .filter((x): x is NonNullable<typeof x> => !!x);
      const res = setByLayerOps(st.doc, targets, { mode, byBlock, includeBlocks: blocks });
      if (res.ops.length) st.session.commit({ label: 'SETBYLAYER', ops: res.ops, group: ctx.group });
      ctx.print(`${res.changed}개의 객체가 수정되었습니다.${res.blocks ? ` 블록 정의 ${res.blocks}개 안의 객체 ${res.nested}개도 수정했습니다.` : ''}`);
    },
  });
}
