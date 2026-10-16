/**
 * 오른쪽 클릭 바로 가기 메뉴(AutoCAD 2026 기본 SHORTCUTMENU 11):
 *  - 명령 중: 옵션([…])이 없는 점·객체·선택 프롬프트는 메뉴 없이 Enter(app.ts가 처리), 옵션이 있으면 명령 모드 메뉴
 *    (입력·취소·최근 입력·옵션·객체 스냅 재지정·초점이동·줌·빠른 계산기)
 *  - Shift(또는 Ctrl)+오른쪽 클릭(명령 중): 객체 스냅 재지정 메뉴
 *  - 명령이 없고 선택이 있으면 편집 모드, 없으면 기본 모드 메뉴. 고리(App.contextMenuProviders)의 항목은 특성 앞에 붙는다
 *  - 명령행(기록·프롬프트): 최근 명령·복사·기록 복사·붙여넣기
 * 메뉴를 띄울지 Enter로 볼지는 SHORTCUTMENU·SHORTCUTMENUDURATION을 따라 app.ts onContext가 정한다(settings.ts contextAction):
 * 모드별 메뉴를 끄면 Enter(명령이 없으면 직전 명령 반복), 시간에 민감한 오른쪽 클릭은 짧게 = Enter·길게 = 메뉴.
 * 하위 메뉴는 항목을 누르면 같은 자리에 그 목록을 다시 펼친다(ui/dom.ts showMenu를 그대로 쓴다).
 * 등록되지 않은 명령의 항목은 빼고, 명령 중에는 투명 명령만 넣는다.
 */
import type { App } from './app';
import type { ContextMenuItem, ContextMenuMode } from './hooks';
import { OVERRIDE_MENU } from './osnap-override';
import { type MenuItem, showMenu, toast } from './ui/dom';
import type { Pt } from './view';

/** 하위 메뉴를 펼치는 항목으로 바꿔 메뉴를 띄운다 */
export function showContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
  showMenu(x, y, toMenu(x, y, tidy(items)));
}

function toMenu(x: number, y: number, items: ContextMenuItem[]): MenuItem[] {
  return items.map((it) => {
    if (!it.items) return it;
    const sub = it.items;
    return {
      label: `${it.label ?? ''} ▸`,
      icon: it.icon,
      disabled: it.disabled || !sub.length,
      run: () => showContextMenu(x, y, [{ heading: it.label }, ...sub]),
    };
  });
}

/** 앞뒤·겹친 구분선을 지운다 */
export function tidy(items: ContextMenuItem[]): ContextMenuItem[] {
  const out: ContextMenuItem[] = [];
  for (const it of items) {
    if (it.separator && (!out.length || out[out.length - 1]!.separator)) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1]!.separator) out.pop();
  return out;
}

/** 명령 항목(등록되지 않았으면 null — 메뉴에서 뺀다). 명령 중이면 투명 명령만 */
function cmdItem(app: App, label: string, cmd: string, opt: { arg?: string; kbd?: string; icon?: string; disabled?: boolean } = {}): ContextMenuItem | null {
  const c = app.findCommand(cmd);
  if (!c) return null;
  if (app.busyCommand && !c.transparent) return null;
  return { label, kbd: opt.kbd, icon: opt.icon, disabled: opt.disabled, run: () => void app.run(cmd, opt.arg) };
}

const keep = (xs: (ContextMenuItem | null | false | undefined)[]): ContextMenuItem[] => xs.filter((x): x is ContextMenuItem => !!x);

/** 최근 입력 하위 메뉴(명령 중이면 입력으로 넣고, 아니면 명령으로 실행) */
function recentItems(app: App, list: readonly string[], asInput: boolean): ContextMenuItem[] {
  return list.slice(0, 10).map((t) => ({ label: t, run: () => (asInput ? app.submitInput(t) : void app.run(t)) }));
}

/** 객체 스냅 재지정 항목(누르면 그 재지정을 입력한 것과 같다) */
export function osnapItems(app: App): ContextMenuItem[] {
  const pick = (key: string) => () => void app.applyOverrideInput(key);
  const out: ContextMenuItem[] = [];
  for (const m of OVERRIDE_MENU) {
    if (m.key === 'END') {
      out.push({
        label: '점 필터',
        items: ['.X', '.Y', '.Z', '.XY', '.XZ', '.YZ'].map((f) => ({ label: f, run: pick(f) })),
      });
      out.push({ separator: true });
    }
    if (m.key === 'NON') out.push({ separator: true });
    out.push({ label: m.label, run: pick(m.key) });
  }
  out.push({ separator: true });
  const os = cmdItem(app, '객체 스냅 설정...', 'OSNAP');
  if (os) out.push(os);
  return out;
}

/** 명령 모드 메뉴(옵션이 있는 프롬프트) */
export function commandMenu(app: App, req: { kind: 'point' | 'entity' | 'select'; keywords: readonly { key: string; label: string }[] }, extra: ContextMenuItem[] = []): ContextMenuItem[] {
  return keep([
    { label: '입력', kbd: 'Enter', run: () => app.acceptInput() },
    { label: '취소', kbd: 'Esc', run: () => app.cancel() },
    { label: '최근 입력', items: recentItems(app, app.recentInputs, true) },
    { separator: true },
    ...req.keywords.map((k) => ({ label: `${k.label}(${k.key})`, run: () => app.submitInput(k.key) })),
    req.kind === 'point' && { separator: true },
    req.kind === 'point' && { label: '객체 스냅 재지정', items: osnapItems(app) },
    { separator: true },
    cmdItem(app, '초점이동', 'PAN', { icon: 'pan' }),
    cmdItem(app, '줌', 'ZOOM', { icon: 'zoomWindow' }),
    ...extra,
    { separator: true },
    cmdItem(app, '빠른 계산기', 'QUICKCALC', { kbd: 'Ctrl+8' }),
  ]);
}

/** 명령이 없을 때(편집 모드 = 선택 있음, 기본 모드 = 없음) */
export function idleMenu(app: App, point: Pt, extra: ContextMenuItem[]): { mode: ContextMenuMode; items: ContextMenuItem[] } {
  const st = app.active;
  const sel = st ? [...st.selection] : [];
  const n = sel.length;
  const last = app.lastCommandName;
  const mode: ContextMenuMode = n ? 'edit' : 'default';
  const common = keep([
    last ? { label: `반복 ${last}`, run: () => void app.run(last) } : null,
    { label: '최근 입력', items: recentItems(app, app.recentCommands, false) },
    { separator: true },
  ]);
  const clip: ContextMenuItem = {
    label: '클립보드',
    items: keep([
      cmdItem(app, '잘라내기', 'CUTCLIP', { kbd: 'Ctrl+X', disabled: !n }),
      cmdItem(app, '복사', 'COPYCLIP', { kbd: 'Ctrl+C', disabled: !n }),
      cmdItem(app, '기준점을 사용하여 복사', 'COPYBASE', { kbd: 'Ctrl+Shift+C', disabled: !n }),
      cmdItem(app, '붙여넣기', 'PASTECLIP', { kbd: 'Ctrl+V' }),
      cmdItem(app, '블록으로 붙여넣기', 'PASTEBLOCK', { kbd: 'Ctrl+Shift+V' }),
      cmdItem(app, '원래 좌표로 붙여넣기', 'PASTEORIG'),
    ]),
  };
  const isolate: ContextMenuItem = {
    label: '격리',
    items: keep([
      cmdItem(app, '객체 격리', 'ISOLATEOBJECTS', { disabled: !n }),
      cmdItem(app, '객체 숨기기', 'HIDEOBJECTS', { disabled: !n }),
      cmdItem(app, '객체 격리 끝', 'UNISOLATEOBJECTS', { disabled: !st?.hiddenObjects.size }),
    ]),
  };
  const tail = keep([
    cmdItem(app, '빠른 선택...', 'QSELECT'),
    cmdItem(app, '빠른 계산기', 'QUICKCALC', { kbd: 'Ctrl+8' }),
    cmdItem(app, '찾기...', 'FIND'),
  ]);
  if (mode === 'edit') {
    const items = keep([
      ...common,
      clip.items!.length ? clip : null,
      isolate.items!.length ? isolate : null,
      { separator: true },
      cmdItem(app, '지우기', 'ERASE', { kbd: 'Delete', icon: 'erase' }),
      cmdItem(app, '이동', 'MOVE', { icon: 'move' }),
      cmdItem(app, '복사 선택', 'COPY', { icon: 'copy' }),
      cmdItem(app, '축척', 'SCALE', { icon: 'scale' }),
      cmdItem(app, '회전', 'ROTATE', { icon: 'rotate' }),
      {
        label: '그리기 순서',
        items: keep([
          cmdItem(app, '맨 앞으로', 'DRAWORDER', { arg: 'F' }),
          cmdItem(app, '맨 뒤로', 'DRAWORDER', { arg: 'B' }),
          cmdItem(app, '객체 위로', 'DRAWORDER', { arg: 'A' }),
          cmdItem(app, '객체 아래로', 'DRAWORDER', { arg: 'U' }),
        ]),
      },
      { separator: true },
      cmdItem(app, '유사 선택', 'SELECTSIMILAR'),
      { label: '모두 선택 해제', kbd: 'Esc', run: () => app.clearSelection() },
      { separator: true },
      ...tail,
      cmdItem(app, '리스트', 'LIST', { icon: 'list' }),
      cmdItem(app, '선택한 객체로 확대', 'ZOOM', { arg: 'O', icon: 'zoomWindow' }),
      ...(extra.length ? [{ separator: true }, ...extra] : []),
      { separator: true },
      cmdItem(app, '특성', 'PROPERTIES', { kbd: 'Ctrl+1', icon: 'props' }),
      cmdItem(app, '빠른 특성', 'QUICKPROPERTIES'),
    ]);
    return { mode, items };
  }
  void point;
  const items = keep([
    ...common,
    clip.items!.length ? clip : null,
    isolate.items!.length ? isolate : null,
    { separator: true },
    cmdItem(app, '명령 취소', 'U', { kbd: 'Ctrl+Z' }),
    cmdItem(app, '명령 복구', 'REDO', { kbd: 'Ctrl+Y' }),
    cmdItem(app, '초점이동', 'PAN', { icon: 'pan' }),
    cmdItem(app, '줌', 'ZOOM', { icon: 'zoomWindow' }),
    { label: '전체 보기', icon: 'extents', kbd: '휠 두 번', run: () => app.view.zoomExtents() },
    { label: '이전 화면', icon: 'zoomPrev', run: () => app.view.zoomPrevious() },
    { separator: true },
    ...tail,
    cmdItem(app, '모두 선택', 'SELECTALL', { kbd: 'Ctrl+A', icon: 'selectAll' }),
    { separator: true },
    cmdItem(app, '거리 측정', 'DIST', { icon: 'dist' }),
    cmdItem(app, '면적 측정', 'AREA', { icon: 'area' }),
    cmdItem(app, '좌표 확인', 'ID', { icon: 'id' }),
    ...(extra.length ? [{ separator: true }, ...extra] : []),
    { separator: true },
    cmdItem(app, '옵션...', 'OPTIONS'),
  ]);
  return { mode, items };
}

/** 명령행 기록·프롬프트의 오른쪽 클릭 메뉴 */
export function commandLineMenu(app: App, historyText: () => string, selectedText: string): ContextMenuItem[] {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  const write = (t: string) => {
    if (!clip?.writeText) return toast('이 브라우저에서는 클립보드에 쓸 수 없습니다.', 'warn');
    void clip.writeText(t).catch(() => toast('클립보드에 쓰지 못했습니다.', 'warn'));
  };
  return keep([
    { label: '최근 명령', items: recentItems(app, app.recentCommands, false) },
    { separator: true },
    { label: '복사', disabled: !selectedText, run: () => write(selectedText) },
    { label: '기록 복사', run: () => write(historyText()) },
    {
      label: '명령행에 붙여넣기',
      run: () => {
        if (!clip?.readText) return toast('이 브라우저에서는 클립보드를 읽을 수 없습니다. 입력란에서 Ctrl+V를 쓰십시오.', 'warn');
        void clip
          .readText()
          .then((t) => app.cmd.insertText(t.replace(/\r?\n/g, ' ')))
          .catch(() => toast('클립보드를 읽지 못했습니다. 입력란에서 Ctrl+V를 쓰십시오.', 'warn'));
      },
    },
    { separator: true },
    cmdItem(app, '옵션...', 'OPTIONS'),
  ]);
}
