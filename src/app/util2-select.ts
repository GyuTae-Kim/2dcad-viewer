/**
 * 그룹·선택 명령(util2): GROUP(G), UNGROUP, PICKSTYLE, SELECT, QSELECT, SELECTSIMILAR, FILTER(FI)
 */
import type { Entity } from '../core/model';
import { createGroupOps, deleteGroupOps, expandByGroups, groupNameProblem, groupsContaining, listGroups, type GroupInfo } from '../edit/util/groups';
import {
  OP_LABELS,
  PROPS,
  SELECTSIMILARMODE_DEFAULT,
  SIMILAR_BITS,
  colorText,
  filterRowText,
  lineweightText,
  passesFilter,
  propDef,
  propValue,
  quickSelect,
  selectSimilar,
  typeLabel,
  valueProblem,
  type CompareOp,
  type FilterRow,
} from '../edit/util/select';
import type { App, CommandContext } from './app';
import { form, h } from './ui/dom';
import { askKeyword, askText, button, checkbox, listBox, loadPref, modal, savePref, select, selectWithKeywords, setOptions, spaceHandles, textInput } from './util2-ui';

// ---------------------------------------------------------------------------
// PICKSTYLE(이 브라우저에 저장, 기본 1)
// ---------------------------------------------------------------------------

const PICKSTYLE_KEY = 'opencad.pickstyle';

export function pickstyle(): number {
  const v = loadPref<number>(PICKSTYLE_KEY, 1);
  return Number.isInteger(v) && v >= 0 && v <= 3 ? v : 1;
}

export function setPickstyle(v: number): void {
  savePref(PICKSTYLE_KEY, v);
}

/**
 * 고르기 넓히기(PICKSTYLE 1 = 그룹 선택). app.ts가 클릭·창 선택 결과를 이 함수로 넘겨 주면 그룹 단위로 고른다.
 * (App에 `selectionExpander` 고리가 있을 때 util2가 연결한다.)
 */
export function groupExpander(app: App): (handles: string[]) => string[] {
  return (handles) => {
    const st = app.active;
    if (!st || !(pickstyle() & 1)) return handles;
    return expandByGroups(st.doc, handles);
  };
}

function groupLabel(g: GroupInfo): string {
  return g.group.unnamed ? `${g.name}(이름 없음)` : g.name;
}

function listGroupsText(app: App, ctx: CommandContext): void {
  const gs = listGroups(app.active!.doc);
  if (!gs.length) {
    ctx.print('이 도면에는 그룹이 없습니다.', 'res');
    return;
  }
  for (const g of gs) ctx.print(`${groupLabel(g).padEnd(20)} 객체 ${g.group.entities.length}개${g.group.selectable ? '' : ', 선택 불가'}${g.group.description ? ` — ${g.group.description}` : ''}`, 'res');
}

// ---------------------------------------------------------------------------
// FILTER 상태(페이지가 열린 동안 리스트 유지, 명명된 필터는 이 브라우저에)
// ---------------------------------------------------------------------------

const FILTERS_KEY = 'opencad.filters.v1';
let filterRows: FilterRow[] = [];

function namedFilters(): Record<string, FilterRow[]> {
  const v = loadPref<{ filters?: Record<string, FilterRow[]> }>(FILTERS_KEY, {});
  return v.filters ?? {};
}

function saveNamedFilters(f: Record<string, FilterRow[]>): void {
  savePref(FILTERS_KEY, { filters: f });
}

/** 지금 공간에 있는 객체 종류(목록용) */
function typesIn(app: App, handles: readonly string[]): string[] {
  const st = app.active!;
  const set = new Set<string>();
  for (const x of handles) {
    const e = st.doc.entityIndex.get(x);
    if (e) set.add(e.type);
  }
  return [...set].sort((a, b) => typeLabel(a).localeCompare(typeLabel(b), 'ko'));
}

const ALL_TYPES = ['ARC', 'ATTDEF', 'INSERT', 'CIRCLE', 'DIMENSION', 'ELLIPSE', 'HATCH', 'IMAGE', 'LEADER', 'LINE', 'MLINE', 'MTEXT', 'MULTILEADER', 'POINT', 'LWPOLYLINE', 'POLYLINE', 'RAY', 'SHAPE', 'SOLID', 'SPLINE', 'TEXT', 'TOLERANCE', 'TRACE', 'VIEWPORT', 'XLINE', 'WIPEOUT', 'ACAD_TABLE'];

/** 특성 값 후보(이름 특성일 때 값 입력 옆 목록) */
function valueChoices(app: App, prop: string): string[] {
  const d = app.active!.doc;
  switch (prop) {
    case 'layer':
      return [...d.layers.values()].map((l) => l.name);
    case 'linetype':
      return ['ByLayer', 'ByBlock', ...[...d.linetypes.values()].map((l) => l.name).filter((n) => !/^by(layer|block)$/i.test(n))];
    case 'blockName':
      return [...d.blocks.values()].filter((b) => !b.name.startsWith('*')).map((b) => b.name);
    case 'textStyle':
      return [...d.textStyles.values()].filter((s) => s.name).map((s) => s.name);
    case 'dimStyle':
      return [...d.dimStyles.values()].map((s) => s.name);
    case 'color':
      return ['ByLayer', 'ByBlock', '1', '2', '3', '4', '5', '6', '7'];
    case 'lineweight':
      return ['ByLayer', 'ByBlock', '기본값', '0.00', '0.13', '0.18', '0.25', '0.35', '0.50', '0.70', '1.00'];
    default:
      return [];
  }
}

function valueText(e: Entity, prop: string): string {
  const v = propValue(e, prop);
  if (v === null) return '';
  if (prop === 'color') return colorText(v as never);
  if (prop === 'lineweight') return lineweightText(v as number).replace(' mm', '');
  return typeof v === 'number' ? String(+v.toFixed(6)) : String(v);
}

export function registerUtil2SelectCommands(app: App): void {
  // ------------------------------------------------------------- GROUP
  app.register({
    name: 'GROUP',
    aliases: ['G'],
    title: '그룹',
    async run(ctx) {
      const st = app.active!;
      let name: string | null = null;
      let desc = '';
      let first = true;
      let hs: string[] = [];
      for (;;) {
        const r = await selectWithKeywords(
          ctx,
          '객체 선택 또는 [이름(N)/설명(D)]:',
          [
            { key: 'N', label: '이름' },
            { key: 'D', label: '설명' },
          ],
          first,
        );
        first = false;
        if (Array.isArray(r)) {
          hs = r;
          break;
        }
        if (r.keyword === 'N') {
          for (;;) {
            const t = (await askText(ctx, '그룹 이름 입력 또는 [?]:')).trim();
            if (!t) break;
            if (t === '?') {
              listGroupsText(app, ctx);
              continue;
            }
            const bad = groupNameProblem(st.doc, t);
            if (bad) {
              ctx.print(bad, 'err');
              continue;
            }
            name = t;
            break;
          }
        } else if (r.keyword === 'D') desc = await askText(ctx, '그룹 설명 입력:', desc);
      }
      hs = hs.filter((x) => st.doc.entityIndex.has(x));
      if (!hs.length) {
        ctx.print('선택된 객체가 없습니다.');
        return;
      }
      const g = createGroupOps(st.doc, name, desc, hs, () => st.session.newHandle());
      if (!g) {
        ctx.print('이 도면에는 이름 있는 객체 사전이 없어 그룹을 만들 수 없습니다(R12 형식 등).', 'err');
        return;
      }
      st.session.commit({ label: 'GROUP', ops: g.ops, group: ctx.group });
      app.clearSelection();
      ctx.print(name ? `그룹 "${g.name}"이(가) 작성되었습니다(객체 ${hs.length}개).` : `이름 없는 그룹이 작성되었습니다(객체 ${hs.length}개).`);
    },
  });

  // ------------------------------------------------------------- UNGROUP
  app.register({
    name: 'UNGROUP',
    title: '그룹 해제',
    async run(ctx) {
      const st = app.active!;
      const doUngroup = (gs: GroupInfo[]) => {
        const ops = gs.flatMap((g) => deleteGroupOps(st.doc, g.handle));
        if (!ops.length) return;
        st.session.commit({ label: 'UNGROUP', ops, group: ctx.group });
        for (const g of gs) ctx.print(`그룹 ${groupLabel(g)}이(가) 분해되었습니다.`);
      };
      if (st.selection.size) {
        const gs = new Map<string, GroupInfo>();
        for (const x of st.selection) for (const g of groupsContaining(st.doc, x)) gs.set(g.handle, g);
        if (!gs.size) {
          ctx.print('선택한 객체는 그룹에 들어 있지 않습니다.', 'err');
          return;
        }
        doUngroup([...gs.values()]);
        app.clearSelection();
        return;
      }
      for (;;) {
        const r = await ctx.getEntity('그룹 선택 또는 [이름(N)]:', [{ key: 'N', label: '이름' }]);
        if ('enter' in r) return;
        if ('keyword' in r) {
          for (;;) {
            const t = (await askText(ctx, '그룹 이름 입력 또는 [?]:')).trim();
            if (!t) return;
            if (t === '?') {
              listGroupsText(app, ctx);
              continue;
            }
            const g = listGroups(st.doc).find((x) => x.name.toUpperCase() === t.toUpperCase());
            if (!g) {
              ctx.print(`그룹 "${t}"을(를) 찾을 수 없습니다.`, 'err');
              continue;
            }
            doUngroup([g]);
            return;
          }
        }
        if (!('handle' in r)) continue;
        const gs = groupsContaining(st.doc, r.handle);
        if (!gs.length) {
          ctx.print('객체가 그룹의 구성원이 아닙니다.', 'err');
          continue;
        }
        let i = 0;
        while (gs.length > 1) {
          const a = await askKeyword(ctx, `그룹 ${groupLabel(gs[i]!)} [다음(N)/수락(A)] <수락>:`, [
            { key: 'N', label: '다음' },
            { key: 'A', label: '수락' },
          ]);
          if (a === 'N') {
            i = (i + 1) % gs.length;
            continue;
          }
          break;
        }
        doUngroup([gs[i]!]);
        return;
      }
    },
  });

  // ------------------------------------------------------------- PICKSTYLE
  app.register({
    name: 'PICKSTYLE',
    title: '그룹 선택 방식',
    transparent: true,
    noDoc: true,
    async run(ctx, arg) {
      let v = arg !== undefined ? Number(arg) : NaN;
      if (!Number.isInteger(v)) {
        const r = await ctx.getPoint(`PICKSTYLE에 대한 새 값 입력 <${pickstyle()}>:`, { preferNumber: true });
        if ('enter' in r) return;
        v = 'text' in r ? Number(r.text) : NaN;
      }
      if (!Number.isInteger(v) || v < 0 || v > 3) {
        ctx.print('0에서 3 사이의 정수가 필요합니다.', 'err');
        return;
      }
      setPickstyle(v);
      ctx.print(`PICKSTYLE = ${v} (${v & 1 ? '그룹 선택 켜기' : '그룹 선택 끄기'})`);
    },
  });

  // ------------------------------------------------------------- SELECT
  app.register({
    name: 'SELECT',
    title: '선택 세트 만들기',
    async run(ctx) {
      const hs = await ctx.getSelection('객체 선택:');
      app.lastSelection = [...hs];
      app.clearSelection();
      ctx.print(hs.length ? `${hs.length}개를 선택했습니다. 다음 명령에서 이전(P)으로 쓸 수 있습니다.` : '선택된 객체가 없습니다.');
    },
  });

  // ------------------------------------------------------------- QSELECT
  app.register({
    name: 'QSELECT',
    title: '신속 선택',
    async run(ctx) {
      const st = app.active!;
      const hasSel = st.selection.size > 0;
      const selNow = [...st.selection];
      let scopeKind = hasSel ? 'sel' : 'all';
      const scope = () => (scopeKind === 'sel' ? selNow : spaceHandles(app));
      const typeOpts = () => [{ value: '', label: '다중' }, ...typesIn(app, scope()).map((t) => ({ value: t, label: typeLabel(t) }))];
      const typeSel = select(typeOpts(), '', () => refreshProps());
      const propSel = select([], 'layer', () => refreshValues());
      const opSel = select(
        (['eq', 'ne', 'gt', 'lt', 'wild', 'all'] as CompareOp[]).map((o) => ({ value: o, label: OP_LABELS[o] })),
        'eq',
        () => (valueIn.disabled = opSel.value === 'all'),
      );
      const valueIn = textInput('', '값');
      const dl = h('datalist', { id: 'u2-qs-values' });
      valueIn.setAttribute('list', 'u2-qs-values');
      const include = h('input', { type: 'radio', name: 'u2-qs-how', checked: true }) as HTMLInputElement;
      const exclude = h('input', { type: 'radio', name: 'u2-qs-how' }) as HTMLInputElement;
      const append = checkbox('현재 선택 세트에 추가', false);
      const err = h('div', { class: 'u2-err' });
      const refreshProps = () => {
        const t = typeSel.value;
        setOptions(
          propSel,
          PROPS.filter((p) => (t ? !p.types || p.types.includes(t) : !p.types)).map((p) => ({ value: p.key, label: p.label })),
        );
        refreshValues();
      };
      const refreshValues = () => {
        dl.innerHTML = '';
        const vals = new Set(valueChoices(app, propSel.value));
        // 범위 안 객체의 실제 값도
        const t = typeSel.value;
        for (const x of scope().slice(0, 4000)) {
          const e = st.doc.entityIndex.get(x);
          if (!e || (t && e.type !== t)) continue;
          const v = valueText(e, propSel.value);
          if (v) vals.add(v);
          if (vals.size > 200) break;
        }
        for (const v of vals) dl.append(h('option', { value: v }));
      };
      const scopeSel = select(
        [{ value: 'all', label: '전체 도면(지금 공간)' }, ...(hasSel ? [{ value: 'sel', label: '현재 선택' }] : [])],
        scopeKind,
        (v) => {
          scopeKind = v;
          setOptions(typeSel, typeOpts());
          refreshProps();
        },
      );
      refreshProps();
      const row = (label: string, el: HTMLElement) => h('div', { class: 'form-row' }, h('span', {}, label), el);
      const body = h(
        'div',
        { class: 'form' },
        row('적용 위치', scopeSel),
        row('객체 유형', typeSel),
        row('특성', propSel),
        row('연산자', opSel),
        row('값', valueIn),
        dl,
        h('fieldset', {}, h('legend', {}, '적용 방법'), h('label', { style: 'display:block' }, include, ' 새 선택 세트에 포함'), h('label', { style: 'display:block' }, exclude, ' 새 선택 세트에서 제외')),
        append.el,
        err,
      );
      const m = modal<{ handles: string[] } | 'cancel'>('신속 선택', body, [
        { label: '취소', value: 'cancel' },
        {
          label: '확인',
          primary: true,
          value: () => {
            const op = opSel.value as CompareOp;
            const bad = valueProblem(propSel.value, op, valueIn.value);
            if (bad) {
              err.textContent = bad;
              return undefined;
            }
            if (!propSel.value && op !== 'all') {
              err.textContent = '특성을 고르십시오.';
              return undefined;
            }
            return { handles: quickSelect(st.doc, scope(), { types: typeSel.value ? [typeSel.value] : [], prop: propSel.value, op, value: valueIn.value, include: include.checked }) };
          },
        },
      ]);
      const r = await m.done;
      if (!r || r === 'cancel') return;
      if (!r.handles.length) {
        ctx.print('조건에 맞는 객체가 없습니다.');
        if (!append.box.checked) app.clearSelection();
        return;
      }
      app.setSelection(r.handles, append.box.checked ? 'add' : 'replace');
      ctx.print(`${r.handles.length}개 항목이 선택되었습니다.`);
    },
  });

  // ------------------------------------------------------------- SELECTSIMILAR
  const SIM_KEY = 'opencad.selectsimilarmode';
  const simMode = () => {
    const v = loadPref<number>(SIM_KEY, SELECTSIMILARMODE_DEFAULT);
    return Number.isInteger(v) && v >= 0 && v <= 255 ? v : SELECTSIMILARMODE_DEFAULT;
  };
  app.register({
    name: 'SELECTSIMILAR',
    title: '유사 선택',
    async run(ctx) {
      const st = app.active!;
      let first = true;
      let refs: string[] = [];
      for (;;) {
        const r = await selectWithKeywords(ctx, '객체 선택 또는 [설정(SE)]:', [{ key: 'SE', label: '설정' }], first);
        first = false;
        if (Array.isArray(r)) {
          refs = r;
          break;
        }
        const mode = simMode();
        const v = await form(
          '유사 선택 설정',
          SIMILAR_BITS.map((b) => ({ key: `b${b.bit}`, label: b.label, type: 'check' as const, value: !!(mode & b.bit) })),
          { note: '객체 종류는 늘 같아야 합니다. 이름은 블록·외부 참조·이미지·해치 패턴 이름, 객체 스타일은 문자·치수·다중 지시선·표 스타일입니다.' },
        );
        if (v) savePref(SIM_KEY, SIMILAR_BITS.reduce((n, b) => n | (v[`b${b.bit}`] ? b.bit : 0), 0));
      }
      if (!refs.length) return;
      const out = selectSimilar(st.doc, refs, spaceHandles(app), simMode());
      app.setSelection(out, 'replace');
      ctx.print(`${out.length}개를 찾음`);
    },
  });

  // ------------------------------------------------------------- FILTER
  app.register({
    name: 'FILTER',
    aliases: ['FI'],
    title: '객체 선택 필터',
    transparent: true,
    async run(ctx) {
      const st = app.active!;
      for (;;) {
        const action = await filterDialog(app);
        if (action === null) return;
        if (action === 'pick') {
          const r = await ctx.getEntity('추가할 객체 선택:');
          if ('handle' in r) {
            const e = st.doc.entityIndex.get(r.handle);
            if (e) {
              filterRows.push({ prop: 'type', op: 'eq', value: e.type });
              for (const k of ['layer', 'color', 'linetype']) filterRows.push({ prop: k, op: 'eq', value: valueText(e, k) });
              for (const p of PROPS) if (p.types?.includes(e.type) && p.key !== 'textValue') filterRows.push({ prop: p.key, op: 'eq', value: valueText(e, p.key) });
            }
          }
          continue;
        }
        break;
      }
      if (!filterRows.length) {
        ctx.print('필터 리스트가 비어 있습니다.', 'err');
        return;
      }
      ctx.print('필터링된 선택 적용.');
      const rows = [...filterRows];
      const hs = await ctx.getSelection('>>객체 선택:', { noPickfirst: true });
      const pass: string[] = [];
      let dropped = 0;
      for (const x of hs) {
        const e = st.doc.entityIndex.get(x);
        if (e && passesFilter(e, rows)) pass.push(x);
        else dropped++;
      }
      if (dropped) ctx.print(`${dropped}개는 필터링됨.`);
      app.setSelection(pass, 'replace');
      app.lastSelection = pass;
      ctx.print(`필터링된 선택 종료함. ${pass.length}개 선택.`);
    },
  });
}

/** FILTER 대화상자. 'apply' = 적용, 'pick' = 선택된 객체 추가, null = 취소 */
async function filterDialog(app: App): Promise<'apply' | 'pick' | null> {
  let sel = filterRows.length ? filterRows.length - 1 : -1;
  const list = listBox([], null, (v) => {
    sel = Number(v);
    loadRow();
  });
  const render = () =>
    list.set(
      filterRows.map((r, i) => ({ value: String(i), label: filterRowText(r) })),
      sel >= 0 ? String(sel) : null,
    );
  const kindSel = select([{ value: 'type', label: '** 객체' }, ...PROPS.map((p) => ({ value: p.key, label: p.label }))], 'type', () => syncKind());
  const opSel = select([], 'eq');
  const typeSel = select(
    ALL_TYPES.map((t) => ({ value: t, label: typeLabel(t) })).sort((a, b) => a.label.localeCompare(b.label, 'ko')),
    'LINE',
  );
  const valueIn = textInput('', '값');
  const dl = h('datalist', { id: 'u2-fi-values' });
  valueIn.setAttribute('list', 'u2-fi-values');
  const err = h('div', { class: 'u2-err' });
  const syncKind = () => {
    const k = kindSel.value;
    const d = propDef(k);
    const ops: CompareOp[] = k === 'type' ? ['eq', 'ne'] : d?.kind === 'name' || d?.kind === 'text' ? ['eq', 'ne', 'any'] : ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'any'];
    setOptions(
      opSel,
      ops.map((o) => ({ value: o, label: { eq: '=', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=', any: '* (아무 값)', wild: '*', all: '*' }[o] })),
    );
    typeSel.hidden = k !== 'type';
    valueIn.hidden = k === 'type';
    dl.innerHTML = '';
    for (const v of valueChoices(app, k)) dl.append(h('option', { value: v }));
  };
  const loadRow = () => {
    const r = filterRows[sel];
    if (!r) return;
    kindSel.value = r.prop;
    syncKind();
    opSel.value = r.op;
    if (r.prop === 'type') typeSel.value = r.value;
    else valueIn.value = r.value;
  };
  const current = (): FilterRow | null => {
    const prop = kindSel.value;
    const op = opSel.value as CompareOp;
    const value = prop === 'type' ? typeSel.value : valueIn.value.trim();
    const bad = valueProblem(prop, op, value);
    if (bad) {
      err.textContent = bad;
      return null;
    }
    err.textContent = '';
    return { prop, op, value };
  };
  syncKind();
  render();
  // 명명된 필터
  const named = namedFilters();
  const namedSel = select([{ value: '', label: '*사용되지 않음*' }, ...Object.keys(named).map((n) => ({ value: n, label: n }))], '', (v) => {
    const rows = namedFilters()[v];
    if (rows) {
      filterRows = rows.map((r) => ({ ...r }));
      sel = filterRows.length - 1;
      render();
    }
  });
  const saveName = textInput('', '이름(18자 이내)');
  saveName.maxLength = 18;
  let pick = false;
  let closeDialog: (v: 'apply' | 'pick' | 'cancel' | null) => void = () => {};
  const body = h(
    'div',
    {},
    h('div', { class: 'u2-note' }, '필터 리스트(모든 줄을 통과한 객체만 고릅니다)'),
    list.el,
    h(
      'fieldset',
      { style: 'margin-top:8px' },
      h('legend', {}, '필터 선택'),
      h('div', { class: 'u2-row' }, kindSel, opSel, typeSel, valueIn, dl),
      h(
        'div',
        { class: 'u2-row' },
        button('리스트에 추가(L)', () => {
          const r = current();
          if (!r) return;
          filterRows.splice(sel + 1, 0, r);
          sel++;
          render();
        }),
        button('대치(S)', () => {
          const r = current();
          if (!r || sel < 0 || !filterRows[sel]) return;
          filterRows[sel] = r;
          render();
        }),
        button('선택된 객체 추가 <', () => {
          pick = true;
          closeDialog('pick');
        }),
      ),
    ),
    h(
      'div',
      { class: 'u2-row' },
      button('항목 편집(I)', loadRow),
      button('삭제(D)', () => {
        if (sel < 0) return;
        filterRows.splice(sel, 1);
        sel = Math.min(sel, filterRows.length - 1);
        render();
      }),
      button('리스트 지우기(C)', () => {
        filterRows = [];
        sel = -1;
        render();
      }),
    ),
    h(
      'fieldset',
      {},
      h('legend', {}, '명명된 필터'),
      h(
        'div',
        { class: 'u2-row' },
        h('span', {}, '현재(U):'),
        namedSel,
        button('현재 필터 리스트 삭제(F)', () => {
          const n = namedSel.value;
          if (!n) return;
          const f = namedFilters();
          delete f[n];
          saveNamedFilters(f);
          setOptions(namedSel, [{ value: '', label: '*사용되지 않음*' }, ...Object.keys(f).map((x) => ({ value: x, label: x }))], '');
        }),
      ),
      h(
        'div',
        { class: 'u2-row' },
        button('다른 이름으로 저장(V):', () => {
          const n = saveName.value.trim();
          if (!n || n.length > 18 || /[*?"<>|]/.test(n)) {
            err.textContent = '필터 이름은 18자 이내로 입력하십시오.';
            return;
          }
          const f = namedFilters();
          if (Object.keys(f).length >= 50 && !f[n]) {
            err.textContent = '명명된 필터는 50개까지 저장합니다.';
            return;
          }
          f[n] = filterRows.slice(0, 200).map((r) => ({ ...r }));
          saveNamedFilters(f);
          setOptions(namedSel, [{ value: '', label: '*사용되지 않음*' }, ...Object.keys(f).map((x) => ({ value: x, label: x }))], n);
        }),
        saveName,
      ),
      h('div', { class: 'u2-note' }, '명명된 필터는 이 브라우저에 저장합니다(도면에는 넣지 않습니다).'),
    ),
    err,
  );
  const m = modal<'apply' | 'pick' | 'cancel'>(
    '객체 선택 필터',
    body,
    [
      { label: '취소', value: 'cancel' },
      { label: '적용(A)', primary: true, value: 'apply' },
    ],
    'mid',
  );
  closeDialog = m.close;
  const r = await m.done;
  if (pick) return 'pick';
  return r === 'apply' ? 'apply' : null;
}
