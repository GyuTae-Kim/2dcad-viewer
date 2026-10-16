/**
 * ALIASEDIT: 명령 별칭 편집기(별칭 목록·검색·추가·편집·제거·기본값 복원). AutoCAD의 acad.pgp 자리.
 * 고친 내용은 이 브라우저(localStorage "opencad.aliases.v1" = {set: {별칭: 명령}, removed: [별칭]})에 두고,
 * 시작할 때 registerAliasEdit가 모든 명령이 등록된 뒤(main.ts의 동기 등록이 끝난 다음 차례) App.setAlias로 되살린다.
 */
import type { App } from './app';
import { h } from './ui/dom';
import { btn, ensureMgrStyle, fail, pickList, prefGet, prefSet, resultDialog, row, textIn } from './mgr-ui';

export const ALIAS_KEY = 'opencad.aliases.v1';

export interface AliasStore {
  set: Record<string, string>;
  removed: string[];
}

type AliasHost = Pick<App, 'aliasEntries' | 'setAlias' | 'findCommand'>;

/** 내장 별칭(사용자 설정을 적용하기 전의 표) */
const builtins = new WeakMap<object, Map<string, string>>();

export function loadAliasStore(): AliasStore {
  try {
    const v = JSON.parse(prefGet(ALIAS_KEY) ?? 'null') as Partial<AliasStore> | null;
    const set: Record<string, string> = {};
    for (const [a, c] of Object.entries(v?.set ?? {})) if (typeof c === 'string' && validAlias(a)) set[a.toUpperCase()] = c.toUpperCase();
    const removed = (v?.removed ?? []).filter((a): a is string => typeof a === 'string' && validAlias(a)).map((a) => a.toUpperCase());
    return { set, removed };
  } catch {
    return { set: {}, removed: [] };
  }
}

export function saveAliasStore(s: AliasStore): void {
  prefSet(ALIAS_KEY, !Object.keys(s.set).length && !s.removed.length ? null : JSON.stringify(s));
}

/** 별칭으로 쓸 수 있는 글(영문·숫자·몇몇 기호, 공백·쉼표 없이) */
export function validAlias(a: string): boolean {
  return /^[A-Za-z0-9_\-?.'$#@!%&*+]{1,32}$/.test(a.trim()) && !/^[_.']/.test(a.trim());
}

/** 내장 별칭 표(처음 부를 때 지금 표를 기억한다) */
export function builtinAliases(app: AliasHost): Map<string, string> {
  let m = builtins.get(app);
  if (!m) {
    m = new Map(app.aliasEntries());
    builtins.set(app, m);
  }
  return m;
}

/** 저장한 설정을 별칭 표에 적용한다(없는 명령을 가리키는 별칭은 건너뛴다). 적용한 수 */
export function applyAliasStore(app: AliasHost, s: AliasStore): number {
  builtinAliases(app);
  let n = 0;
  for (const a of s.removed) {
    app.setAlias(a, null);
    n++;
  }
  for (const [a, c] of Object.entries(s.set)) {
    if (!app.findCommand(c)) continue;
    app.setAlias(a, c);
    n++;
  }
  return n;
}

/** 최종 표와 내장 표의 차이 → 저장할 설정 */
export function aliasDiff(base: ReadonlyMap<string, string>, final: ReadonlyMap<string, string>): AliasStore {
  const set: Record<string, string> = {};
  const removed: string[] = [];
  for (const [a, c] of final) if (base.get(a) !== c) set[a] = c;
  for (const a of base.keys()) if (!final.has(a)) removed.push(a);
  return { set, removed: removed.sort() };
}

/** 최종 표를 별칭 표에 맞춘다(지금 표와 다른 것만 바꾼다) */
export function applyAliasTable(app: AliasHost, final: ReadonlyMap<string, string>): void {
  const now = new Map(app.aliasEntries());
  for (const a of now.keys()) if (!final.has(a)) app.setAlias(a, null);
  for (const [a, c] of final) if (now.get(a) !== c) app.setAlias(a, c);
}

async function aliasEditor(app: App): Promise<void> {
  ensureMgrStyle();
  const base = builtinAliases(app);
  const table = new Map(app.aliasEntries());
  type Row = { alias: string; cmd: string; kind: string };
  const rowsOf = (): Row[] => {
    const q = search.value.trim().toUpperCase();
    return [...table]
      .filter(([a, c]) => !q || a.includes(q) || c.includes(q))
      .sort((x, y) => x[0].localeCompare(y[0]))
      .map(([a, c]) => ({ alias: a, cmd: c, kind: !base.has(a) ? '사용자' : base.get(a) !== c ? '바뀜' : '기본' }));
  };
  const search = textIn('', '검색');
  search.placeholder = '별칭 또는 명령 검색';
  const aliasIn = textIn('', '별칭');
  const cmdIn = textIn('', '명령');
  const listId = `mgr-cmds-${Math.random().toString(36).slice(2, 8)}`;
  const dl = h('datalist', { id: listId }, ...[...app.commands.keys()].sort().map((n) => h('option', { value: n })));
  cmdIn.setAttribute('list', listId);
  const err = h('div', { class: 'mgr-err' });
  const list = pickList<Row>(['별칭', '명령', '구분'], (r) => [r.alias, r.cmd, r.kind], {
    height: 300,
    onPick: (r) => {
      if (!r) return;
      aliasIn.value = r.alias;
      cmdIn.value = r.cmd;
      err.textContent = '';
    },
  });
  const refresh = (keep?: string) => list.refresh(rowsOf(), keep ? (r) => r.alias === keep : undefined);
  search.addEventListener('input', () => refresh(list.selected()?.alias));
  const put = () => {
    const a = aliasIn.value.trim().toUpperCase();
    const c = cmdIn.value.trim().toUpperCase().replace(/^[_.']+/, '');
    if (!validAlias(a)) return void (err.textContent = '별칭에는 영문·숫자를 쓰고 공백을 넣을 수 없습니다.');
    const cmd = app.findCommand(c);
    if (!cmd) return void (err.textContent = `명령 "${c}"이(가) 없습니다.`);
    if (app.commands.has(a) && a !== cmd.name) return void (err.textContent = `"${a}"은(는) 명령 이름이라 별칭으로 쓸 수 없습니다.`);
    table.set(a, cmd.name.toUpperCase());
    err.textContent = '';
    refresh(a);
  };
  const remove = () => {
    const r = list.selected();
    if (!r) return void (err.textContent = '제거할 별칭을 고르십시오.');
    table.delete(r.alias);
    refresh();
  };
  const restore = () => {
    table.clear();
    for (const [a, c] of base) table.set(a, c);
    refresh();
  };
  const body = h(
    'div',
    { class: 'mgr-dlg' },
    dl,
    search,
    list.el,
    h('div', { class: 'mgr-cols' }, row('별칭(A)', aliasIn), row('명령(C)', cmdIn)),
    h('div', { class: 'mgr-btns' }, btn('추가·편집', put), btn('제거(R)', remove), btn('기본값 복원', restore)),
    err,
    h('div', { class: 'mgr-note' }, '별칭은 이 브라우저에만 보관됩니다. 명령 이름과 같은 별칭은 쓸 수 없습니다.'),
  );
  refresh();
  const ok = await resultDialog('명령 별칭 편집', body, {
    width: 620,
    submit: () => {
      if (!table.size) return fail('별칭이 하나도 없습니다. 기본값 복원을 누르십시오.');
      return true;
    },
  });
  if (!ok) return;
  applyAliasTable(app, table);
  saveAliasStore(aliasDiff(base, table));
  app.cmd.print('별칭을 저장했습니다.');
}

/**
 * ALIASEDIT 등록과 저장한 별칭 되살리기. 모든 명령이 등록된 뒤에 적용해야 내장 별칭을 덮으므로,
 * 지금 한 번(이미 등록된 명령) 적용하고 다음 차례(main.ts의 나머지 동기 등록 뒤)에 한 번 더 적용한다.
 */
export function registerAliasEdit(app: App): void {
  app.register({ name: 'ALIASEDIT', title: '명령 별칭 편집', noDoc: true, run: () => aliasEditor(app) });
  const store = loadAliasStore();
  if (!Object.keys(store.set).length && !store.removed.length) return;
  setTimeout(() => {
    builtinAliases(app);
    applyAliasStore(app, loadAliasStore());
  }, 0);
}
