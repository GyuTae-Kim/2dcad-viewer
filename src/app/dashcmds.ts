/**
 * 스크립트와 명령행 버전 명령 등록(main.ts가 한 번 부른다).
 * SCRIPT·RSCRIPT·RESUME·DELAY·FILEDIA·CMDDIA·CMDECHO(script.ts),
 * -INSERT·-ATTEDIT, -ARRAY, -HATCH·-BOUNDARY, -PURGE·-STYLE·-LINETYPE·-DIMSTYLE·-UNITS, -OVERKILL·-XREF·-IMAGE, -PLOT·PSETUPIN·-PSETUPIN.
 * 이미 같은 이름으로 등록된 명령·별칭(다른 모듈이 먼저 만든 것)은 덮어쓰지 않는다.
 */
import type { App, Command } from './app';
import { registerDashArrayCommand } from './dashcmds-array';
import { registerDashHatchCommands } from './dashcmds-hatch';
import { registerDashInsertCommands } from './dashcmds-insert';
import { registerDashMiscCommands } from './dashcmds-misc';
import { registerDashPlotCommands } from './dashcmds-plot';
import { registerDashTableCommands } from './dashcmds-tables';
import { registerScriptCommands } from './script';

/** 파일 끌어 놓기 등에서 스크립트를 실행할 때(셸이 쓴다) */
export { runScriptFile, runScriptText, scriptRunner } from './script';

export function registerDashCommands(app: App): void {
  const aliasMap = (app as unknown as { aliases?: Map<string, string> }).aliases;
  const taken = (n: string) => app.commands.has(n.toUpperCase()) || !!aliasMap?.has(n.toUpperCase());
  // 등록 함수들이 app.register를 부르는 동안만 겹침 검사를 끼운다
  const own = Object.prototype.hasOwnProperty.call(app, 'register');
  const prev = app.register;
  app.register = (c: Command) => {
    if (taken(c.name)) return;
    prev.call(app, { ...c, aliases: (c.aliases ?? []).filter((a) => !taken(a)) });
  };
  try {
    registerScriptCommands(app);
    registerDashInsertCommands(app);
    registerDashArrayCommand(app);
    registerDashHatchCommands(app);
    registerDashTableCommands(app);
    registerDashMiscCommands(app);
    registerDashPlotCommands(app);
  } finally {
    if (own) app.register = prev;
    else Reflect.deleteProperty(app, 'register');
  }
}
