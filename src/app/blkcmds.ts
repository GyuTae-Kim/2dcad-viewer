/**
 * 블록·참조 명령 묶음 등록(이미 같은 이름이 있으면 건너뛴다):
 * - 속성 파일: ATTOUT·ATTIN(Express), ATTEXT·-ATTEXT(DDATTEXT), ATTREDEF — blkcmds-att.ts
 * - 외부 참조: XATTACH(XA)·IMAGEATTACH(IAT)·PDFATTACH, XBIND(XB)·-XBIND(-XB), XOPEN, BLOCKTOXREF, CLASSICXREF — blkcmds-xref.ts
 * - 기타: UNDEFINE·REDEFINE, BASE, TINSERT, PASTESPEC(PA), DIMEX·DIMIM — blkcmds-misc.ts
 * - 블록 팔레트: BLOCKSPALETTE·BLOCKSPALETTECLOSE — blkcmds-palette.ts
 */
import type { App } from './app';
import { registerBlkAttCommands } from './blkcmds-att';
import { registerBlkMiscCommands } from './blkcmds-misc';
import { registerBlkPaletteCommands } from './blkcmds-palette';
import { registerBlkXrefCommands } from './blkcmds-xref';

export function registerBlkCommands(app: App): void {
  registerBlkAttCommands(app);
  registerBlkXrefCommands(app);
  registerBlkMiscCommands(app);
  registerBlkPaletteCommands(app);
}
