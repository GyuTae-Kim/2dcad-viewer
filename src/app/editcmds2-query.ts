/**
 * 조회·특성·변수·그룹·도면층 창 명령(AutoCAD 2026 한국어판 프롬프트):
 * - QUICKPROPERTIES(QP): 고른 객체 옆 빠른 특성 창. QPMODE: 객체를 고를 때 저절로 띄울지(이 브라우저에 저장).
 * - DBLIST: 도면의 모든 객체를 LIST 형식으로(모형 공간, 그다음 배치 순서).
 * - TRANSPARENCYDISPLAY: 객체 투명도 표시 켜기·끄기(화면만, 출력은 그대로).
 * - VIEWRES: 빠른 줌·원 줌 퍼센트(값만 기억한다 — 이 뷰어는 화면 배율에 맞춰 곡선을 나눈다).
 * - ELEV: 새 객체의 기본 고도·두께($ELEVATION·$THICKNESS, 배치에서는 $PELEVATION).
 * - PLAN: 현재 UCS·이름 있는 UCS·WCS의 평면도. 이 뷰어의 2D 화면은 늘 평면도이고 화면 회전이 없으므로 범위로 줌한다.
 * - GROUPEDIT: 그룹에 객체 추가·제거, 이름 바꾸기, 분해.
 * - LAYERCLOSE·CLASSICLAYER: 도면층 창(팔레트의 도면층 탭) 닫기·열기.
 */
import type { CadDocument, Entity } from '../core/model';
import { tableKey } from '../core/model';
import { addToGroupOps, explodeGroupOps, removeFromGroupOps, renameGroupOps } from '../edit/editcmds2/groupedit';
import { onOffProblem, qpModeProblem, viewresProblem } from '../edit/editcmds2/vars';
import type { EditOp } from '../edit/session';
import { groupsContaining, listGroups, type GroupInfo } from '../edit/util/groups';
import { displayFlags } from '../render/styles';
import type { App, CommandContext } from './app';
import { askOption, askReal, askYN } from './dashcmds-ask';
import { attachQuickProperties, qpMode, setQpMode, showQuickProperties } from './editcmds2-qp';
import { entityProperties, typeName } from './inquiry';
import { loadPref, savePref } from './util2-ui';
import { formatLength } from '../core/units';

const TPY_KEY = 'opencad.transparencydisplay';

/** 저장한 투명도 표시(1 켜기) */
export function transparencyDisplay(): number {
  const v = loadPref<number>(TPY_KEY, 1);
  return v === 0 ? 0 : 1;
}

/** 문서별 VIEWRES(빠른 줌, 원 줌 퍼센트) */
const viewres = new WeakMap<CadDocument, { fast: boolean; percent: number }>();

/** 공간 순서(모형 → 배치 탭 순서 → 그 밖의 *PAPER_SPACE) */
function spaceOrder(doc: CadDocument): string[] {
  const out = ['*MODEL_SPACE'];
  for (const l of [...doc.layouts].sort((a, b) => a.tabOrder - b.tabOrder)) {
    const k = tableKey(l.blockName);
    if (!out.includes(k) && doc.blocks.has(k)) out.push(k);
  }
  for (const k of doc.blocks.keys()) if (/^\*PAPER_SPACE/i.test(k) && !out.includes(k)) out.push(k);
  return out.filter((k) => doc.blocks.has(k));
}

const DBLIST_MAX = 5000;

function groupLabel(g: GroupInfo): string {
  return g.group.unnamed ? `${g.name}(이름 없음)` : g.name;
}

/** 그룹 고르기: 객체를 찍거나 이름(N). 여러 그룹에 든 객체면 다음(N)/수락(A) */
async function pickGroup(app: App, ctx: CommandContext): Promise<GroupInfo | null> {
  const st = app.active!;
  for (;;) {
    const r = await ctx.getEntity('그룹 선택 또는 [이름(N)]:', [{ key: 'N', label: '이름' }]);
    if ('enter' in r) return null;
    if ('keyword' in r) {
      for (;;) {
        const t = (await askWordLine(ctx, '그룹 이름 입력 또는 [?]:')).trim();
        if (!t) return null;
        if (t === '?') {
          const gs = listGroups(st.doc);
          if (!gs.length) ctx.print('이 도면에는 그룹이 없습니다.', 'res');
          for (const g of gs) ctx.print(`${groupLabel(g).padEnd(20)} 객체 ${g.group.entities.length}개${g.group.description ? ` — ${g.group.description}` : ''}`, 'res');
          continue;
        }
        const g = listGroups(st.doc).find((x) => x.name.toUpperCase() === t.toUpperCase());
        if (!g) {
          ctx.print(`그룹 "${t}"을(를) 찾을 수 없습니다.`, 'err');
          continue;
        }
        return g;
      }
    }
    const gs = groupsContaining(st.doc, r.handle);
    if (!gs.length) {
      ctx.print('객체가 그룹의 구성원이 아닙니다.', 'err');
      continue;
    }
    let i = 0;
    while (gs.length > 1) {
      const a = await askOption(
        ctx,
        `그룹 ${groupLabel(gs[i]!)} [다음(N)/수락(A)] <수락>:`,
        [
          { key: 'N', label: '다음' },
          { key: 'A', label: '수락' },
        ],
        'A',
      );
      if (a === 'N') {
        i = (i + 1) % gs.length;
        continue;
      }
      break;
    }
    return gs[i]!;
  }
}

/** 공백을 포함하지 않는 글 한 줄(이름) */
async function askWordLine(ctx: CommandContext, prompt: string): Promise<string> {
  const r = await ctx.getPoint(prompt, { allowText: true });
  return 'text' in r ? r.text : '';
}

/** 그룹 선택(PICKSTYLE) 없이 객체 고르기 */
async function selectPlain(app: App, ctx: CommandContext, prompt: string): Promise<string[]> {
  const prev = app.selectionExpander;
  app.selectionExpander = null;
  try {
    return await ctx.getSelection(prompt, { noPickfirst: true });
  } finally {
    app.selectionExpander = prev;
    app.clearSelection();
  }
}

/** 도면층 창(팔레트의 도면층 탭)이 열려 있으면 닫는다. 닫았으면 true */
function closeLayerPalette(): boolean {
  const pal = document.querySelector<HTMLElement>('.palette');
  if (!pal || pal.hidden) return false;
  const tab = pal.querySelector('.palette-tab.active')?.textContent?.trim();
  if (tab !== '도면층') return false;
  pal.hidden = true;
  return true;
}

export function registerEditCmds2Query(app: App): void {
  attachQuickProperties(app);
  displayFlags.transparency = transparencyDisplay() === 1;

  // ------------------------------------------------------------- QUICKPROPERTIES·QPMODE
  app.register({
    name: 'QUICKPROPERTIES',
    title: '빠른 특성',
    async run(ctx) {
      const st = app.active!;
      if (!st.selection.size) {
        const hs = await ctx.getSelection('객체 선택:');
        if (!hs.length) return;
        app.setSelection(hs);
      }
      showQuickProperties(app);
    },
  });
  app.register({
    name: 'QPMODE',
    title: '빠른 특성 표시 방식',
    transparent: true,
    noDoc: true,
    async run(ctx) {
      const cur = qpMode();
      const v = await askReal(ctx, `QPMODE에 대한 새 값 입력 <${cur}>:`, cur, qpModeProblem);
      setQpMode(v);
      ctx.print(v > 0 ? (v === 1 ? '객체를 고르면 빠른 특성 창을 띄웁니다.' : '형상 항목이 있는 객체를 고르면 빠른 특성 창을 띄웁니다.') : '빠른 특성 창을 저절로 띄우지 않습니다(QUICKPROPERTIES로 부를 수 있습니다).');
    },
  });

  // ------------------------------------------------------------- DBLIST
  app.register({
    name: 'DBLIST',
    title: '데이터베이스 리스트',
    run(ctx) {
      const st = app.active!;
      let n = 0;
      let total = 0;
      for (const key of spaceOrder(st.doc)) {
        const space = /^\*MODEL_SPACE$/i.test(key) ? '모형 공간' : '도면 공간';
        for (const e of st.doc.blocks.get(key)!.entities) {
          total++;
          if (n >= DBLIST_MAX) continue;
          n++;
          ctx.print(`${typeName(e)}  도면층: "${e.layer}"  공간: ${space}  핸들 = ${e.handle}`, 'res');
          for (const g of entityProperties(st.doc, e as Entity, st.units).slice(1)) for (const row of g.rows) ctx.print(`    ${row.k}: ${row.v}`);
        }
      }
      if (total > n) ctx.print(`… ${total - n}개는 생략했습니다(처음 ${DBLIST_MAX}개만 보입니다).`);
      ctx.print(`객체 ${total}개${total ? '' : ' — 도면이 비어 있습니다'}.`);
    },
  });

  // ------------------------------------------------------------- TRANSPARENCYDISPLAY
  app.register({
    name: 'TRANSPARENCYDISPLAY',
    title: '투명도 표시',
    transparent: true,
    noDoc: true,
    async run(ctx, arg) {
      const cur = displayFlags.transparency ? 1 : 0;
      const a = arg !== undefined ? Number(arg) : NaN;
      const v = Number.isFinite(a) && !onOffProblem(a) ? a : await askReal(ctx, `TRANSPARENCYDISPLAY에 대한 새 값 입력 <${cur}>:`, cur, onOffProblem);
      savePref(TPY_KEY, v);
      displayFlags.transparency = v === 1;
      app.view.requestRender();
      app.ui?.refreshStatus();
    },
  });

  // ------------------------------------------------------------- VIEWRES
  app.register({
    name: 'VIEWRES',
    title: '뷰 해상도',
    async run(ctx) {
      const st = app.active!;
      const cur = viewres.get(st.doc) ?? { fast: true, percent: 1000 };
      const fast = await askYN(ctx, '빠른 줌을 원하십니까?', cur.fast);
      const percent = await askReal(ctx, `원 줌 퍼센트 입력 (1-20000) <${cur.percent}>:`, cur.percent, viewresProblem);
      viewres.set(st.doc, { fast, percent });
      app.active?.touchLayers();
      app.view.requestRender();
    },
  });

  // ------------------------------------------------------------- ELEV
  app.register({
    name: 'ELEV',
    title: '고도',
    async run(ctx) {
      const st = app.active!;
      const ek = st.isModel ? '$ELEVATION' : '$PELEVATION';
      const num = (k: string) => {
        const v = st.doc.header.get(k);
        return typeof v === 'number' ? v : 0;
      };
      const show = (v: number) => formatLength(v, st.units);
      const e0 = num(ek);
      const t0 = num('$THICKNESS');
      const elev = await askReal(ctx, `새 기본 고도 지정 <${show(e0)}>:`, e0);
      const thick = await askReal(ctx, `새 기본 두께 지정 <${show(t0)}>:`, t0);
      const ops: EditOp[] = [];
      if (elev !== e0 || st.doc.header.get(ek) === undefined) ops.push({ kind: 'header', name: ek, before: st.doc.header.get(ek), after: elev });
      if (thick !== t0 || st.doc.header.get('$THICKNESS') === undefined) ops.push({ kind: 'header', name: '$THICKNESS', before: st.doc.header.get('$THICKNESS'), after: thick });
      if (ops.length) st.session.commit({ label: 'ELEV', ops, group: ctx.group });
    },
  });

  // ------------------------------------------------------------- PLAN
  app.register({
    name: 'PLAN',
    title: '평면도',
    async run(ctx) {
      const st = app.active!;
      const k = await askOption(
        ctx,
        '옵션 입력 [현재 UCS(C)/UCS(U)/표준(W)] <현재 UCS>:',
        [
          { key: 'C', label: '현재 UCS' },
          { key: 'U', label: 'UCS' },
          { key: 'W', label: '표준' },
        ],
        'C',
      );
      if (!k) return;
      let angle = 0;
      if (k === 'C') {
        const x = st.doc.header.get(st.isModel ? '$UCSXDIR' : '$PUCSXDIR');
        if (x && typeof x === 'object') angle = Math.atan2(x.y, x.x);
      } else if (k === 'U') {
        for (;;) {
          const t = (await askWordLine(ctx, 'UCS 이름 입력 또는 [?]:')).trim();
          if (!t) return;
          if (t === '?') {
            const names = [...st.doc.ucs.values()].map((u) => u.name);
            ctx.print(names.length ? names.join(', ') : '이름 있는 UCS가 없습니다.', 'res');
            continue;
          }
          const u = st.doc.ucs.get(tableKey(t));
          if (!u) {
            ctx.print(`UCS "${t}"을(를) 찾을 수 없습니다.`, 'err');
            continue;
          }
          angle = Math.atan2(u.xAxis.y, u.xAxis.x);
          break;
        }
      }
      ctx.print(`${st.isModel ? '모형' : '배치'} 재생성 중.`);
      app.view.zoomExtents();
      if (Math.abs(angle) > 1e-9) ctx.print('참고: 이 프로그램은 화면을 돌리지 않으므로 UCS가 돌아가 있어도 표준 방향으로 범위를 보여 줍니다.');
    },
  });

  // ------------------------------------------------------------- GROUPEDIT
  app.register({
    name: 'GROUPEDIT',
    title: '그룹 편집',
    async run(ctx) {
      const st = app.active!;
      app.clearSelection();
      const g = await pickGroup(app, ctx);
      if (!g) return;
      const k = await askOption(
        ctx,
        '옵션 입력 [객체 추가(A)/객체 제거(R)/이름 바꾸기(REN)/분해(E)]:',
        [
          { key: 'A', label: '객체 추가' },
          { key: 'R', label: '객체 제거' },
          { key: 'REN', label: '이름 바꾸기' },
          { key: 'E', label: '분해' },
        ],
        null,
      );
      if (!k) return;
      if (k === 'A') {
        ctx.print('그룹에 추가할 객체 선택...');
        const hs = await selectPlain(app, ctx, '객체 선택:');
        const r = addToGroupOps(st.doc, g.handle, hs);
        if (!r.ops.length) {
          ctx.print('그룹에 더할 객체가 없습니다(이미 구성원이거나 선택 없음).');
          return;
        }
        st.session.commit({ label: 'GROUPEDIT', ops: r.ops, group: ctx.group });
        ctx.print(`그룹 ${groupLabel(g)}에 객체 ${r.added}개를 추가했습니다.`);
      } else if (k === 'R') {
        ctx.print('그룹에서 제거할 객체 선택...');
        const hs = await selectPlain(app, ctx, '객체 제거:');
        const r = removeFromGroupOps(st.doc, g.handle, hs);
        if (!r.ops.length) {
          ctx.print('고른 객체 중 그룹의 구성원이 없습니다.');
          return;
        }
        st.session.commit({ label: 'GROUPEDIT', ops: r.ops, group: ctx.group });
        ctx.print(`그룹 ${groupLabel(g)}에서 객체 ${r.removed}개를 제거했습니다.`);
      } else if (k === 'REN') {
        for (;;) {
          const t = (await askWordLine(ctx, `그룹의 새 이름 입력 또는 [?] <${g.group.unnamed ? '' : g.name}>:`)).trim();
          if (!t) return;
          if (t === '?') {
            for (const x of listGroups(st.doc)) ctx.print(groupLabel(x), 'res');
            continue;
          }
          const ops = renameGroupOps(st.doc, g.handle, t);
          if (typeof ops === 'string') {
            ctx.print(ops, 'err');
            continue;
          }
          if (ops.length) st.session.commit({ label: 'GROUPEDIT', ops, group: ctx.group });
          ctx.print(`그룹 이름을 ${t}(으)로 바꿨습니다.`);
          return;
        }
      } else if (k === 'E') {
        const ops = explodeGroupOps(st.doc, g.handle);
        if (!ops.length) return;
        st.session.commit({ label: 'GROUPEDIT', ops, group: ctx.group });
        ctx.print(`그룹 ${groupLabel(g)}이(가) 분해되었습니다.`);
      }
    },
  });

  // ------------------------------------------------------------- LAYERCLOSE·CLASSICLAYER
  app.register({
    name: 'LAYERCLOSE',
    title: '도면층 창 닫기',
    transparent: true,
    noDoc: true,
    run(ctx) {
      if (!closeLayerPalette()) ctx.print('도면층 창이 열려 있지 않습니다.');
    },
  });
  app.register({
    name: 'CLASSICLAYER',
    title: '도면층 창(기존)',
    run: () => app.ui.openPalette('layers'),
  });
}
