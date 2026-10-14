/**
 * 블록·그룹·선택·유틸리티 명령(util2) 등록.
 * - 블록: BATTMAN, ATTSYNC, BCOUNT, BURST, BLOCKREPLACE, MINSERT, WBLOCK(W)
 * - 그룹: GROUP(G), UNGROUP, PICKSTYLE
 * - 선택: SELECT, QSELECT, SELECTSIMILAR, FILTER(FI)
 * - 유틸리티: OOPS, RENAME(REN)·-RENAME, AUDIT, STATUS, QUICKCALC(QC)·CAL, LIMITS, MULTIPLE, REDRAW(R)
 * 계산·검사 논리는 src/edit/util/ 아래(화면 없음)에 있다.
 *
 * OOPS는 ERASE를 감싸서 지운 객체를 기억하므로, 이 함수는 registerDrawCommands 다음에 불러야 한다.
 */
import type { App } from './app';
import { registerUtil2BlockCommands } from './util2-blocks';
import { registerUtil2MiscCommands } from './util2-misc';
import { groupExpander, pickstyle, registerUtil2SelectCommands, setPickstyle } from './util2-select';
import { ensureStyles } from './util2-ui';

export { groupExpander, pickstyle, setPickstyle } from './util2-select';

let keyInstalled = false;

export function registerUtil2Commands(app: App): void {
  ensureStyles();
  registerUtil2BlockCommands(app);
  registerUtil2SelectCommands(app);
  registerUtil2MiscCommands(app);
  // PICKSTYLE 1(그룹 선택): App에 고르기 넓히기 고리가 있으면 연결한다(없으면 GROUP·UNGROUP만 쓰인다)
  const hook = app as unknown as { selectionExpander?: ((handles: string[]) => string[]) | null };
  if ('selectionExpander' in hook) hook.selectionExpander = groupExpander(app);
  // Ctrl+Shift+A: 그룹 선택 켜기·끄기(AutoCAD와 같은 바로 가기)
  if (!keyInstalled && typeof window !== 'undefined') {
    keyInstalled = true;
    window.addEventListener('keydown', (ev) => {
      if (!(ev.ctrlKey || ev.metaKey) || !ev.shiftKey || ev.altKey || ev.key.toLowerCase() !== 'a') return;
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) && t !== app.cmd.input) return;
      ev.preventDefault();
      const v = pickstyle() ^ 1;
      setPickstyle(v);
      app.cmd.print(`<그룹 ${v & 1 ? '켜기' : '끄기'}>`);
    });
  }
}
