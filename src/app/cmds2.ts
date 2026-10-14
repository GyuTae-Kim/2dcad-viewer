/**
 * 명령 묶음(cmds2): DIM(스마트 치수), LEADER(옛 지시선), ARRAYPATH(경로 배열), -LAYER(명령행 도면층), -WBLOCK(명령행 블록 쓰기).
 */
import type { App } from './app';
import { registerArrayPathCommand } from './arraypath';
import { registerDimSmartCommand } from './dimsmart';
import { registerDashLayerCommand } from './layercmd';
import { registerLeaderCommand } from './leaderold';
import { registerDashWblockCommand } from './wblockcmd';

export function registerCmds2Commands(app: App): void {
  registerDimSmartCommand(app);
  registerLeaderCommand(app);
  registerArrayPathCommand(app);
  registerDashLayerCommand(app);
  registerDashWblockCommand(app);
}
