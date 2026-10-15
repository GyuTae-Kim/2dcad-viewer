/**
 * 진짜 App으로 시험한다(명령 실행·입력 요청·확장 지점). 화면·명령행·엔진·글꼴은 시험 파일의 vi.mock이 fakes.ts로 바꿔 끼운다.
 * 문서는 새 도면 하나(DocState + EditSession), App.addDocument처럼 편집 세션을 확정 고리에 잇는다.
 */
import { App, type UiHooks } from '../../src/app/app';
import { DocState } from '../../src/app/docstate';
import { bindCommitHooks } from '../../src/app/hooks';
import { createNewDocument } from '../../src/core/newdoc';
import type { CadDocument } from '../../src/core/model';
import { EditSession } from '../../src/edit/session';
import type { FakeCommandLine, FakeEngine, FakeView } from './fakes';

export interface RealApp {
  app: App;
  st: DocState;
  doc: CadDocument;
  view: FakeView;
  cmd: FakeCommandLine;
  engine: FakeEngine;
  /** UI 고리가 불린 횟수(refreshTabs 등) */
  ui: Record<string, number>;
  /** 명령행 출력 */
  out(): string[];
}

export function makeApp(setup?: (doc: CadDocument) => void): RealApp {
  const app = new App({} as HTMLElement);
  const ui: Record<string, number> = {};
  const count = (k: string) => () => {
    ui[k] = (ui[k] ?? 0) + 1;
  };
  app.ui = {
    refreshTabs: count('refreshTabs'),
    refreshLayouts: count('refreshLayouts'),
    refreshStatus: count('refreshStatus'),
    refreshPalette: count('refreshPalette'),
    showStart: count('showStart'),
    setBusy: count('setBusy'),
    setCoords: count('setCoords'),
    openPalette: count('openPalette'),
  } satisfies UiHooks;
  const doc = createNewDocument('metric');
  setup?.(doc);
  const st = new DocState(1, doc, 't.dwg', 0, 0);
  st.session = new EditSession(doc, () => {});
  bindCommitHooks(app, st);
  app.docs.push(st);
  app.active = st;
  const cmd = app.cmd as unknown as FakeCommandLine;
  return { app, st, doc, view: app.view as unknown as FakeView, cmd, engine: app.engine as unknown as FakeEngine, ui, out: () => cmd.lines.map((l) => l.text) };
}

/** 마이크로태스크를 여러 번 돌리고 타이머 한 바퀴(명령의 catch·finally가 끝나게) */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
