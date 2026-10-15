/**
 * Express Tools 명령 모음(AutoCAD 2026 한국어판 Express Tools를 따른다).
 * - 문자: TCASE·-TCASE, TCOUNT, TORIENT, TEXTFIT, TEXTMASK, TEXTUNMASK, TCIRCLE, TXTEXP (express-text.ts)
 * - 선택·조회: SSX, GETSEL, XLIST, XDLIST, NCOPY, GATTE (express-select.ts)
 * - 그리기·수정: BREAKLINE, MPEDIT, EXOFFSET, FLATTEN, CDORDER, MKLTYPE, SHOWURLS, REDIR (express-draw.ts)
 * 이미 같은 이름(또는 별칭)으로 등록된 명령이 있으면 그것을 남긴다.
 */
import type { App, Command } from './app';
import { registerExpressDrawCommands } from './express-draw';
import { registerExpressSelectCommands } from './express-select';
import { registerExpressTextCommands } from './express-text';

export type CommandSink = (c: Command) => void;

export function registerExpressCommands(app: App): void {
  const taken = (n: string) => app.commands.has(n.toUpperCase()) || (!n.startsWith('-') && !!app.findCommand(n));
  const add: CommandSink = (c) => {
    if (taken(c.name)) return;
    app.register({ ...c, aliases: (c.aliases ?? []).filter((a) => !taken(a)) });
  };
  registerExpressTextCommands(app, add);
  registerExpressSelectCommands(app, add);
  registerExpressDrawCommands(app, add);
}
