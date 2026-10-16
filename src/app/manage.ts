/**
 * 도면 관리 명령 묶음 등록(main.ts에서 registerLispCommands 뒤에 한 번 부른다):
 * - 시스템 변수 이름 바로 입력(App.commandFallbacks)·SYSVDLG — sysvars.ts
 * - ALIASEDIT와 저장한 별칭 되살리기 — aliasedit.ts
 * - DWGPROPS(도면 특성) — dwgprops.ts
 * - OPTIONS(OP)·DDGRIPS(GR)·DDSELECT — options.ts
 * - ADDSELECTED — addselected.ts
 */
import type { App } from './app';
import { registerAddSelected } from './addselected';
import { registerAliasEdit } from './aliasedit';
import { registerDwgProps } from './dwgprops';
import { registerOptions } from './options';
import { registerSysvarCommands } from './sysvars';

export function registerManageCommands(app: App): void {
  registerSysvarCommands(app);
  registerDwgProps(app);
  registerOptions(app);
  registerAddSelected(app);
  // 별칭은 모든 명령이 등록된 뒤에 적용한다(registerAliasEdit가 다음 차례로 미룬다)
  registerAliasEdit(app);
}
