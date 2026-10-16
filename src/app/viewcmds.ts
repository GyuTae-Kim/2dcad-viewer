/**
 * 명명된 뷰: VIEW(V, 뷰 관리자 — 현재로 설정·새로 만들기·이름 바꾸기·경계 업데이트·삭제), -VIEW(-V, 명령행)
 * 모형 뷰는 모형 탭에서, 종이 공간 뷰(플래그 1)는 배치에서 복원한다. 프롬프트는 AutoCAD 2026 한국어판을 따른다.
 */
import type { ViewRecord } from '../core/model';
import type { EditOp } from '../edit/session';
import { MODEL_SPACE, tableKey } from '../core/model';
import type { App, CommandContext } from './app';
import type { DocState } from './docstate';
import { ask, h } from './ui/dom';
import { btn, fail, pickList, resultDialog, row, textIn } from './mgr-ui';

type Rect = [number, number, number, number];

function viewOf(st: DocState, name: string, r: Rect, paper: boolean): ViewRecord {
  const old = st.doc.views.get(tableKey(name));
  return {
    name,
    handle: old?.handle ?? st.session.newHandle(),
    flags: paper ? 1 : 0,
    center: { x: (r[0] + r[2]) / 2, y: (r[1] + r[3]) / 2 },
    width: Math.abs(r[2] - r[0]),
    height: Math.abs(r[3] - r[1]),
    viewDirection: { x: 0, y: 0, z: 1 },
    viewTarget: { x: 0, y: 0, z: 0 },
    twist: 0,
  };
}

/** 지금 화면(도면 좌표) */
function screenRect(app: App): Rect {
  return app.view.visibleWorld();
}

function save(app: App, ctx: CommandContext | null, name: string, r: Rect): void {
  const st = app.active!;
  const key = tableKey(name);
  const after = viewOf(st, name, r, st.onLayout && !st.msVp);
  st.session.commit({ label: 'VIEW', ops: [{ kind: 'view', key, before: st.doc.views.get(key) ?? null, after }], group: ctx?.group });
}

export async function restore(app: App, v: ViewRecord): Promise<void> {
  const st = app.active!;
  const paper = (v.flags & 1) !== 0;
  if (paper && !st.onLayout) {
    const lay = st.doc.layouts.filter((l) => tableKey(l.blockName) !== MODEL_SPACE).sort((a, b) => a.tabOrder - b.tabOrder)[0];
    if (lay) await app.setSpace(lay.blockName);
  } else if (paper && st.msVp) app.exitViewport(st);
  else if (!paper && st.onLayout && !st.msVp) await app.setSpace(MODEL_SPACE);
  // DCS 중심 + 뷰 대상(비틀림은 무시)
  const cx = v.center.x + v.viewTarget.x;
  const cy = v.center.y + v.viewTarget.y;
  app.view.zoomRect(cx - v.width / 2, cy - v.height / 2, cx + v.width / 2, cy + v.height / 2, true, 0);
}

function remove(app: App, name: string): boolean {
  const st = app.active!;
  const key = tableKey(name);
  const before = st.doc.views.get(key);
  if (!before) return false;
  st.session.commit({ label: 'VIEW', ops: [{ kind: 'view', key, before, after: null }] });
  return true;
}

async function windowRect(ctx: CommandContext): Promise<Rect | null> {
  const r = await ctx.getPoint('첫 번째 구석 지정:');
  if (!('point' in r)) return null;
  const a = r.point;
  const q = await ctx.getPoint('반대 구석 지정:', { base: a, rubber: (p) => [{ pts: [a.x, a.y, p.x, a.y, p.x, p.y, a.x, p.y], closed: true, dashed: true }] });
  if (!('point' in q)) return null;
  return [Math.min(a.x, q.point.x), Math.min(a.y, q.point.y), Math.max(a.x, q.point.x), Math.max(a.y, q.point.y)];
}

export function registerViewCommands(app: App): void {
  app.register({
    name: '-VIEW',
    aliases: ['-V'],
    title: '명명된 뷰(명령행)',
    async run(ctx) {
      const st = app.active!;
      const r = await ctx.getPoint('옵션 입력 [?/삭제(D)/복원(R)/저장(S)/창(W)]:', {
        keywords: [
          { key: '?', label: '?' },
          { key: 'D', label: '삭제' },
          { key: 'R', label: '복원' },
          { key: 'S', label: '저장' },
          { key: 'W', label: '창' },
        ],
      });
      if (!('keyword' in r)) return;
      if (r.keyword === '?') {
        const list = [...st.doc.views.values()];
        if (!list.length) ctx.print('저장된 뷰가 없습니다.');
        for (const v of list) ctx.print(`${v.name}  ${v.flags & 1 ? '종이' : '모형'}  폭 ${v.width.toFixed(4)}, 높이 ${v.height.toFixed(4)}`);
        return;
      }
      const t = await ctx.getPoint(r.keyword === 'D' ? '삭제할 뷰 이름 입력:' : r.keyword === 'R' ? '복원할 뷰 이름 입력:' : '저장할 뷰 이름 입력:', { allowText: true });
      const name = 'text' in t ? t.text.trim() : '';
      if (!name) return;
      if (r.keyword === 'D') {
        let n = 0;
        for (const one of name.split(',')) if (remove(app, one.trim())) n++;
        if (!n) ctx.print(`뷰 "${name}"을(를) 찾을 수 없습니다.`, 'err');
        return;
      }
      if (r.keyword === 'R') {
        const v = st.doc.views.get(tableKey(name));
        if (!v) ctx.print(`뷰 "${name}"을(를) 찾을 수 없습니다.`, 'err');
        else await restore(app, v);
        return;
      }
      if (!/^[^<>/\\":;?*|,=`]+$/.test(name)) {
        ctx.print('뷰 이름에 쓸 수 없는 문자가 있습니다.', 'err');
        return;
      }
      const rect = r.keyword === 'W' ? await windowRect(ctx) : screenRect(app);
      if (rect) save(app, ctx, name, rect);
    },
  });

  app.register({
    name: 'VIEW',
    aliases: ['V'],
    title: '뷰 관리자',
    run: (ctx) => viewManager(app, ctx),
  });
}

const BAD_VIEW_NAME = /[<>/\\":;?*|,=`]/;

/** 뷰 이름 바꾸기 작업(대소문자만 바꾸면 같은 열쇠). 같은 이름이 있으면 null */
export function renameViewOps(st: DocState, oldName: string, newName: string): EditOp[] | null {
  const ok = tableKey(oldName);
  const nk = tableKey(newName);
  const v = st.doc.views.get(ok);
  if (!v) return null;
  if (nk !== ok && st.doc.views.has(nk)) return null;
  const after: ViewRecord = { ...v, name: newName };
  if (nk === ok) return [{ kind: 'view', key: ok, before: v, after }];
  return [
    { kind: 'view', key: ok, before: v, after: null },
    { kind: 'view', key: nk, before: null, after },
  ];
}

type ViewAct = 'current' | 'new' | 'rename' | 'update' | 'delete' | 'close';

/** 뷰 관리자: 현재로 설정, 새로 만들기, 이름 바꾸기, 업데이트(지금 화면으로), 삭제. 변경은 명령 취소 한 단계(같은 묶음) */
async function viewManager(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const nameOk = (n: string) => !!n.trim() && !BAD_VIEW_NAME.test(n);
  let keep: string | null = null;
  for (;;) {
    const views = [...st.doc.views.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    let act: ViewAct = 'close';
    let submitNow: (() => void) | null = null;
    const go = (a: ViewAct) => {
      act = a;
      submitNow?.();
    };
    const list = pickList<ViewRecord>(['이름', '공간', '크기'], (v) => [v.name, v.flags & 1 ? '배치' : '모형', `${v.width.toFixed(2)} × ${v.height.toFixed(2)}`], { height: 240, onActivate: () => go('current') });
    const body = h(
      'div',
      { class: 'mgr-dlg' },
      h('div', { class: 'mgr-note' }, `현재 뷰: ${st.onLayout && !st.msVp ? '배치' : '모형'}`),
      h(
        'div',
        { class: 'mgr-cols' },
        views.length ? list.el : h('div', { class: 'mgr-note' }, '저장된 뷰가 없습니다. 새로 만들기(N)로 지금 화면을 저장합니다.'),
        h('div', { class: 'mgr-btns', style: 'flex-direction:column;flex:0 0 150px;min-width:150px' }, btn('현재로 설정(C)', () => go('current')), btn('새로 만들기(N)...', () => go('new')), btn('이름 바꾸기(R)...', () => go('rename')), btn('경계 업데이트(B)', () => go('update')), btn('삭제(D)', () => go('delete'))),
      ),
    );
    list.refresh(views, keep ? (v) => v.name === keep : undefined);
    const r = await resultDialog<{ act: ViewAct; view: ViewRecord | null }>('뷰 관리자', body, {
      ok: '닫기',
      cancel: null,
      width: 560,
      bind: (sub) => (submitNow = sub),
      submit: () => {
        const v = list.selected();
        if (act !== 'close' && act !== 'new' && !v) return fail('뷰를 고르십시오.');
        const out = { act, view: v };
        act = 'close';
        return out;
      },
    });
    if (!r || r.act === 'close') return;
    const v = r.view;
    switch (r.act) {
      case 'current':
        if (v) await restore(app, v);
        return;
      case 'new': {
        const rect = screenRect(app);
        const nameIn = textIn(`뷰${st.doc.views.size + 1}`, '뷰 이름');
        const n = await resultDialog('새 뷰', h('div', { class: 'mgr-dlg' }, row('뷰 이름(N)', nameIn), h('div', { class: 'mgr-note' }, '지금 화면을 뷰로 저장합니다.')), {
          ok: '확인',
          width: 380,
          submit: () => (nameOk(nameIn.value) ? nameIn.value.trim() : fail('뷰 이름에 쓸 수 없는 문자가 있습니다.')),
        });
        if (!n) break;
        if (st.doc.views.has(tableKey(n))) {
          const a = await ask('뷰 - 재정의', `뷰 "${n}"이(가) 이미 있습니다. 바꾸시겠습니까?`, [
            { label: '예', value: 'Y', primary: true },
            { label: '아니오', value: 'N' },
          ]);
          if (a !== 'Y') break;
        }
        save(app, ctx, n, rect);
        keep = n;
        break;
      }
      case 'rename': {
        if (!v) break;
        const nameIn = textIn(v.name, '새 이름');
        const n = await resultDialog('뷰 이름 바꾸기', h('div', { class: 'mgr-dlg' }, row('새 이름', nameIn)), {
          width: 380,
          submit: () => {
            const t = nameIn.value.trim();
            if (!nameOk(t)) return fail('뷰 이름에 쓸 수 없는 문자가 있습니다.');
            if (tableKey(t) !== tableKey(v.name) && st.doc.views.has(tableKey(t))) return fail(`뷰 "${t}"이(가) 이미 있습니다.`);
            return t;
          },
        });
        if (!n || n === v.name) break;
        const ops = renameViewOps(st, v.name, n);
        if (ops) st.session.commit({ label: 'VIEW', ops, group: ctx.group });
        keep = n;
        break;
      }
      case 'update':
        if (v) {
          const after = { ...viewOf(st, v.name, screenRect(app), st.onLayout && !st.msVp), handle: v.handle };
          st.session.commit({ label: 'VIEW', ops: [{ kind: 'view', key: tableKey(v.name), before: v, after }], group: ctx.group });
          keep = v.name;
        }
        break;
      case 'delete':
        if (v) {
          const key = tableKey(v.name);
          st.session.commit({ label: 'VIEW', ops: [{ kind: 'view', key, before: v, after: null }], group: ctx.group });
          keep = null;
        }
        break;
    }
  }
}
