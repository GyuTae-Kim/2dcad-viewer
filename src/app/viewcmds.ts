/**
 * 명명된 뷰: VIEW(V, 뷰 관리자), -VIEW(-V, 명령행)
 * 모형 뷰는 모형 탭에서, 종이 공간 뷰(플래그 1)는 배치에서 복원한다. 프롬프트는 AutoCAD 2026 한국어판을 따른다.
 */
import type { ViewRecord } from '../core/model';
import { MODEL_SPACE, tableKey } from '../core/model';
import type { App, CommandContext } from './app';
import type { DocState } from './docstate';
import { dialog, form, h } from './ui/dom';

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
    run() {
      const st = app.active!;
      let picked: string | null = null;
      const body = h('div', { class: 'viewmgr' });
      const render = () => {
        body.replaceChildren();
        const list = [...st.doc.views.values()].sort((a, b) => a.name.localeCompare(b.name));
        if (!list.length) {
          body.append(h('div', { style: 'color:var(--text-dim)' }, '저장된 뷰가 없습니다. [새로 만들기]로 지금 화면을 저장합니다.'));
          return;
        }
        const rows = list.map((v) => {
          const tr = h('tr', { style: picked === v.name ? 'background:var(--sel, rgba(61,141,255,0.25))' : 'cursor:pointer' }, h('td', {}, v.name), h('td', {}, v.flags & 1 ? '종이 공간' : '모형'), h('td', {}, `${v.width.toFixed(2)} × ${v.height.toFixed(2)}`));
          tr.addEventListener('click', () => {
            picked = v.name;
            render();
          });
          tr.addEventListener('dblclick', () => void restore(app, v));
          return tr;
        });
        body.append(h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', {}, '이름'), h('th', {}, '공간'), h('th', {}, '크기'))), h('tbody', {}, ...rows)));
      };
      render();
      const dlg = dialog('뷰 관리자', body, [
        {
          label: '새로 만들기…',
          run: () => {
            const rect = screenRect(app);
            void form('새 뷰', [{ key: 'name', label: '뷰 이름', type: 'text', value: `뷰${st.doc.views.size + 1}` }], {
              ok: '저장',
              validate: (v) => (/^[^<>/\\":;?*|,=`]+$/.test(String(v.name).trim()) ? null : '뷰 이름에 쓸 수 없는 문자가 있습니다.'),
            }).then((v) => {
              if (!v) return;
              const name = String(v.name).trim();
              save(app, null, name, rect);
              picked = name;
              render();
            });
            return false;
          },
        },
        {
          label: '삭제',
          run: () => {
            if (picked && remove(app, picked)) picked = null;
            render();
            return false;
          },
        },
        {
          label: '현재로 설정',
          primary: true,
          run: () => {
            const v = picked ? st.doc.views.get(tableKey(picked)) : undefined;
            if (v) void restore(app, v);
            return !!v;
          },
        },
        { label: '닫기' },
      ]);
      void dlg;
    },
  });
}
