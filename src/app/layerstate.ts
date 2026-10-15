/**
 * 도면층 상태 명령 등록: LAYERSTATE(도면층 상태 관리자, 별칭 LAS), -LAYERSTATE(명령행),
 * LAYERP(도면층 이전)·LAYERPMODE, SETBYLAYER·SETBYLAYERMODE.
 * 리본의 도면층 상태 목록 등이 쓸 수 있게 목록·복원·새 상태 함수도 내보낸다.
 */
import type { App } from './app';
import { restoreLayerState, stateByName, visibleStates } from './layerstate-core';
import { runLayerStateOptions } from './layerstate-cmd';
import { registerLayerToolCommands } from './layerstate-tools';
import { newLayerStateDialog, openLayerStateManager } from './layerstate-ui';

export function registerLayerStateCommands(app: App): void {
  app.register({
    name: 'LAYERSTATE',
    aliases: ['LAS'],
    title: '도면층 상태 관리자',
    run: (ctx) => openLayerStateManager(app, ctx),
  });

  app.register({
    name: '-LAYERSTATE',
    title: '도면층 상태(명령행)',
    run: (ctx) => runLayerStateOptions(app, ctx),
  });

  registerLayerToolCommands(app);
}

/** 관리자에 나오는 상태 이름(리본 목록용) */
export function layerStateNames(app: App): string[] {
  const st = app.active;
  return st ? visibleStates(st.doc).map((s) => s.key) : [];
}

/** 이름으로 복원(리본 목록용). 없으면 false */
export function restoreLayerStateNamed(app: App, name: string): boolean {
  const s = app.active ? stateByName(app, name) : null;
  if (!s) return false;
  return restoreLayerState(app, (t, cls) => app.cmd.print(t, cls), s.state);
}

/** 새 도면층 상태 대화상자(리본의 "새 도면층 상태…"용) */
export function newLayerState(app: App): Promise<string | null> {
  return newLayerStateDialog(app);
}
