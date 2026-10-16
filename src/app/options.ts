/**
 * OPTIONS(옵션 대화상자): 열기 및 저장·화면표시·선택·제도·사용자 기본 설정 탭. AutoCAD 2026의 같은 칸만 둔다.
 * 값은 시스템 변수(sysvars.ts의 이 브라우저 변수 — PICKBOX·GRIPSIZE·CURSORSIZE·APERTURE·AUTOSNAP·PICKFIRST·PICKADD·
 * SELECTIONPREVIEW·SHORTCUTMENU·SHORTCUTMENUDURATION)와 이 브라우저 보관 값(SAVETIME·COLORTHEME·기본 저장 형식·도면 영역 배경색·
 * AutoSnap 표식기 크기)으로 저장한다. 화면·입력은 App.settings(settings.ts)가 optionValue로 읽고, 값이 바뀌면
 * onSysvarChange로 바로 다시 읽는다(표식기 크기는 저장 뒤 이어지는 변수 저장의 알림 때 함께 읽힌다).
 */
import type { App, CommandContext } from './app';
import { SAVE_TYPES } from './save';
import { saveTime } from './autosave';
import { colorTheme } from './theme';
import { browserSysvar, setBrowserSysvar } from './sysvars';
import { h } from './ui/dom';
import { checkIn, fail, group, numIn, numOf, prefGet, prefSet, resultDialog, row, selectIn, tabs } from './mgr-ui';

const KEY_SAVETYPE = 'opencad.options.saveType';
const KEY_BG = 'opencad.options.modelBg';
const KEY_MARKER = 'opencad.options.autosnapMarker';
const KEY_SAVETIME = 'opencad.savetime';
const KEY_THEME = 'opencad.colortheme';

/** 다른 이름으로 저장의 기본 파일 유형(SAVE_TYPES 값). 정하지 않았으면 null */
export function defaultSaveType(): string | null {
  const v = prefGet(KEY_SAVETYPE);
  return v && SAVE_TYPES.some((t) => t.value === v) ? v : null;
}

/** AutoSnap 표식기 크기(1~20, 기본 5) */
export function autosnapMarkerSize(): number {
  const n = Number(prefGet(KEY_MARKER));
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : 5;
}

/** 도면 영역(모형) 배경색(0xRRGGBB). 정하지 않았으면 null */
export function savedModelBackground(): number | null {
  const v = prefGet(KEY_BG);
  if (!v || !/^#?[0-9a-f]{6}$/i.test(v)) return null;
  return parseInt(v.replace('#', ''), 16);
}

/** 화면이 읽는 설정 값 한곳(이름은 시스템 변수 또는 AUTOSNAPMARKER·MODELBG) */
export function optionValue(name: string): number {
  switch (name.toUpperCase()) {
    case 'AUTOSNAPMARKER':
      return autosnapMarkerSize();
    case 'MODELBG':
      return savedModelBackground() ?? 0x212830;
    default:
      return browserSysvar(name);
  }
}

const hex6 = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

/** SHORTCUTMENU 비트 ↔ 대화상자 칸(1 기본 모드 메뉴, 2 편집 모드 메뉴, 4 명령 모드 늘 메뉴, 8 옵션이 있을 때만, 16 시간에 민감한 오른쪽 클릭) */
export function shortcutMenuBits(v: { menus: boolean; def: 'repeat' | 'menu'; edit: 'repeat' | 'menu'; cmd: 'enter' | 'options' | 'always'; timed: boolean }): number {
  if (!v.menus) return v.timed ? 16 : 0;
  return (v.def === 'menu' ? 1 : 0) | (v.edit === 'menu' ? 2 : 0) | (v.cmd === 'always' ? 4 : v.cmd === 'options' ? 8 : 0) | (v.timed ? 16 : 0);
}

export function shortcutMenuFields(bits: number): { menus: boolean; def: 'repeat' | 'menu'; edit: 'repeat' | 'menu'; cmd: 'enter' | 'options' | 'always'; timed: boolean } {
  return {
    menus: (bits & 15) !== 0,
    def: bits & 1 ? 'menu' : 'repeat',
    edit: bits & 2 ? 'menu' : 'repeat',
    cmd: bits & 4 ? 'always' : bits & 8 ? 'options' : 'enter',
    timed: (bits & 16) !== 0,
  };
}

async function optionsDialog(app: App, ctx: CommandContext, startTab: number): Promise<void> {
  // 열기 및 저장
  const saveType = selectIn([{ value: '', label: '열린 파일과 같은 형식(새 도면은 AutoCAD 2018 DWG)' }, ...SAVE_TYPES.map((t) => ({ value: t.value, label: t.label }))], defaultSaveType() ?? '', '다른 이름으로 저장');
  const st0 = saveTime();
  const autoSave = checkIn(st0 > 0, '자동 저장');
  const saveMin = numIn(st0 > 0 ? st0 : 10, '저장 간격 분');
  autoSave.addEventListener('change', () => (saveMin.disabled = !autoSave.checked));
  saveMin.disabled = !autoSave.checked;
  const openSave = h(
    'div',
    { class: 'mgr-dlg' },
    group('파일 저장', row('다른 이름으로 저장(S)', saveType)),
    group('파일 안전 예방 조치', row('자동 저장(U)', autoSave), row('저장 간격 분(M)', saveMin), h('div', { class: 'mgr-note' }, '자동 저장본은 이 브라우저(IndexedDB)에 두고 DRAWINGRECOVERY로 엽니다.')),
  );
  // 화면표시
  const theme = selectIn(
    [
      { value: '0', label: '어둡게' },
      { value: '1', label: '밝게' },
    ],
    String(colorTheme()),
    '색 테마',
  );
  const bg = h('input', { type: 'color', 'aria-label': '도면 영역 배경색', class: 'mgr-in', style: 'padding:0 2px' }) as HTMLInputElement;
  bg.value = hex6(app.view?.modelBg ?? 0x212830);
  const cursor = numIn(browserSysvar('CURSORSIZE'), '십자선 크기');
  const display = h(
    'div',
    { class: 'mgr-dlg' },
    group('윈도우 요소', row('색 테마(M)', theme)),
    group('색상', row('2D 모형 공간 배경(C)', bg)),
    group('십자선 크기(Z)', row('화면의 %(1~100)', cursor)),
  );
  // 선택
  const pickbox = numIn(app.view?.overlay?.pickbox ?? browserSysvar('PICKBOX'), '확인란 크기');
  const gripsize = numIn(browserSysvar('GRIPSIZE'), '그립 크기');
  const grips = checkIn(browserSysvar('GRIPS') !== 0, '그립 표시');
  const pickfirst = checkIn(browserSysvar('PICKFIRST') !== 0, '명사/동사 선택');
  const pickadd = checkIn(browserSysvar('PICKADD') === 0, 'Shift 키를 사용하여 선택 세트에 추가');
  const sp = browserSysvar('SELECTIONPREVIEW');
  const spCmd = checkIn((sp & 1) !== 0, '명령이 활성화되어 있을 때');
  const spIdle = checkIn((sp & 2) !== 0, '명령이 활성화되어 있지 않을 때');
  const selection = h(
    'div',
    { class: 'mgr-dlg' },
    h('div', { class: 'mgr-cols' }, group('확인란 크기(P)', row('픽셀(0~50)', pickbox)), group('그립 크기(Z)', row('픽셀(1~255)', gripsize))),
    group('선택 미리보기', row('명령이 활성화되어 있을 때(S)', spCmd), row('명령이 활성화되어 있지 않을 때(W)', spIdle)),
    group('선택 모드', row('명사/동사 선택(N)', pickfirst), row('Shift 키를 사용하여 선택 세트에 추가(F)', pickadd)),
    group('그립', row('그립 표시(R)', grips)),
  );
  // 제도
  const as = browserSysvar('AUTOSNAP');
  const marker = checkIn((as & 1) !== 0, '표식기');
  const magnet = checkIn((as & 2) !== 0, '마그넷');
  const tooltip = checkIn((as & 4) !== 0, 'AutoSnap 툴팁 표시');
  const markerSize = numIn(autosnapMarkerSize(), 'AutoSnap 표식기 크기');
  const aperture = numIn(browserSysvar('APERTURE'), '조준창 크기');
  const drafting = h(
    'div',
    { class: 'mgr-dlg' },
    group('AutoSnap 설정', row('표식기(M)', marker), row('마그넷(G)', magnet), row('AutoSnap 툴팁 표시(T)', tooltip)),
    h('div', { class: 'mgr-cols' }, group('AutoSnap 표식기 크기(S)', row('1~20', markerSize)), group('조준창 크기(Z)', row('픽셀(1~50)', aperture))),
  );
  // 사용자 기본 설정
  const sm = shortcutMenuFields(browserSysvar('SHORTCUTMENU'));
  const menus = checkIn(sm.menus, '도면 영역의 바로 가기 메뉴');
  const defMode = selectIn(
    [
      { value: 'repeat', label: '마지막 명령 반복(R)' },
      { value: 'menu', label: '바로 가기 메뉴(S)' },
    ],
    sm.def,
    '기본 모드',
  );
  const editMode = selectIn(
    [
      { value: 'repeat', label: '마지막 명령 반복(L)' },
      { value: 'menu', label: '바로 가기 메뉴(M)' },
    ],
    sm.edit,
    '편집 모드',
  );
  const cmdMode = selectIn(
    [
      { value: 'enter', label: 'Enter(E)' },
      { value: 'options', label: '바로 가기 메뉴: 명령 옵션이 있을 때 사용(C)' },
      { value: 'always', label: '바로 가기 메뉴: 항상 사용(A)' },
    ],
    sm.cmd,
    '명령 모드',
  );
  const timed = checkIn(sm.timed, '시간에 민감한 오른쪽 클릭');
  const duration = numIn(browserSysvar('SHORTCUTMENUDURATION'), '길게 누르는 시간');
  const syncMenus = () => {
    for (const el of [defMode, editMode, cmdMode]) el.disabled = !menus.checked;
    duration.disabled = !timed.checked;
  };
  menus.addEventListener('change', syncMenus);
  timed.addEventListener('change', syncMenus);
  syncMenus();
  const prefs = h(
    'div',
    { class: 'mgr-dlg' },
    group('Windows 표준 동작', row('도면 영역의 바로 가기 메뉴(M)', menus)),
    group('오른쪽 클릭 사용자화', row('기본 모드', defMode), row('편집 모드', editMode), row('명령 모드', cmdMode), row('시간에 민감한 오른쪽 클릭(T)', timed), row('길게 누르는 시간(밀리초)', duration)),
  );
  const t = tabs(
    [
      { label: '열기 및 저장', body: openSave },
      { label: '화면표시', body: display },
      { label: '선택', body: selection },
      { label: '제도', body: drafting },
      { label: '사용자 기본 설정', body: prefs },
    ],
    startTab,
  );
  const intIn = (el: HTMLInputElement, lo: number, hi: number, label: string): number | string => {
    const v = numOf(el);
    return Number.isInteger(v) && v >= lo && v <= hi ? v : `${label}: ${lo}과(와) ${hi} 사이의 정수가 필요합니다.`;
  };
  const r = await resultDialog('옵션', t.el, {
    width: 640,
    submit: () => {
      const vals = {
        saveMin: autoSave.checked ? intIn(saveMin, 1, 600, '저장 간격') : 0,
        cursor: intIn(cursor, 1, 100, '십자선 크기'),
        pickbox: intIn(pickbox, 0, 50, '확인란 크기'),
        gripsize: intIn(gripsize, 1, 255, '그립 크기'),
        markerSize: intIn(markerSize, 1, 20, 'AutoSnap 표식기 크기'),
        aperture: intIn(aperture, 1, 50, '조준창 크기'),
        duration: intIn(duration, 100, 10000, '길게 누르는 시간'),
      };
      for (const v of Object.values(vals)) if (typeof v === 'string') return fail(v);
      return vals as Record<keyof typeof vals, number>;
    },
  });
  if (!r) return;
  prefSet(KEY_SAVETYPE, saveType.value || null);
  prefSet(KEY_SAVETIME, String(r.saveMin));
  // 색 테마는 theme.ts와 같은 보관 값·문서 표시
  prefSet(KEY_THEME, theme.value);
  if (typeof document !== 'undefined') {
    if (theme.value === '1') document.documentElement.dataset.theme = 'light';
    else delete document.documentElement.dataset.theme;
  }
  const bgv = parseInt(bg.value.replace('#', ''), 16);
  if (Number.isFinite(bgv) && app.view && bgv !== app.view.modelBg) {
    app.view.modelBg = bgv;
    prefSet(KEY_BG, bg.value);
    app.view.requestRender();
  }
  prefSet(KEY_MARKER, String(r.markerSize));
  const set = (n: string, v: number) => setBrowserSysvar(n, v);
  set('CURSORSIZE', r.cursor);
  set('PICKBOX', r.pickbox);
  if (app.view?.overlay) app.view.overlay.pickbox = r.pickbox;
  set('GRIPSIZE', r.gripsize);
  set('GRIPS', grips.checked ? (browserSysvar('GRIPS') || 2) : 0);
  set('PICKFIRST', pickfirst.checked ? 1 : 0);
  set('PICKADD', pickadd.checked ? 0 : 2);
  set('SELECTIONPREVIEW', (spCmd.checked ? 1 : 0) | (spIdle.checked ? 2 : 0));
  set('AUTOSNAP', (as & ~7) | (marker.checked ? 1 : 0) | (magnet.checked ? 2 : 0) | (tooltip.checked ? 4 : 0));
  set('APERTURE', r.aperture);
  set('SHORTCUTMENU', shortcutMenuBits({ menus: menus.checked, def: defMode.value as 'repeat', edit: editMode.value as 'repeat', cmd: cmdMode.value as 'enter', timed: timed.checked }));
  set('SHORTCUTMENUDURATION', r.duration);
  app.view?.requestOverlay?.();
  app.ui?.refreshStatus?.();
  ctx.print('옵션을 저장했습니다(이 브라우저).');
}

export function registerOptions(app: App): void {
  // 저장한 배경색은 시작할 때 화면에 반영
  const bg = savedModelBackground();
  if (bg !== null && app.view) app.view.modelBg = bg;
  app.register({ name: 'OPTIONS', aliases: ['OP', 'PREFERENCES'], title: '옵션', noDoc: true, transparent: true, run: (ctx, arg) => optionsDialog(app, ctx, optionTab(arg)) });
  // 예전 그립·선택 대화상자 이름은 옵션의 선택 탭
  app.register({ name: 'DDGRIPS', aliases: ['GR'], title: '그립 설정(옵션 › 선택)', noDoc: true, transparent: true, run: (ctx) => optionsDialog(app, ctx, 2) });
  app.register({ name: 'DDSELECT', title: '선택 설정(옵션 › 선택)', noDoc: true, transparent: true, run: (ctx) => optionsDialog(app, ctx, 2) });
}

/** 인자로 처음 열 탭(DDGRIPS·DDSELECT는 선택 탭) */
function optionTab(arg: string | undefined): number {
  const a = (arg ?? '').trim().toUpperCase();
  return a === 'SELECTION' ? 2 : a === 'DRAFTING' ? 3 : a === 'DISPLAY' ? 1 : a === 'USER' ? 4 : 0;
}
