/**
 * 화면 테마: COLORTHEME(0 어둡게, 1 밝게). 리본·팔레트·명령행 같은 화면 틀만 바꾸고 도면 영역은 그대로 둔다.
 * 이 브라우저에 보관한다.
 */
import type { App } from './app';

const PREF = 'opencad.colortheme';

function apply(v: number): void {
  if (v === 1) document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
}

export function colorTheme(): number {
  try {
    return localStorage.getItem(PREF) === '1' ? 1 : 0;
  } catch {
    return 0;
  }
}

export function registerThemeCommands(app: App): void {
  apply(colorTheme());
  app.register({
    name: 'COLORTHEME',
    title: '화면 테마',
    noDoc: true,
    transparent: true,
    async run(ctx) {
      const cur = colorTheme();
      const r = await ctx.getPoint(`COLORTHEME에 대한 새 값 입력 <${cur}>:`, { preferNumber: true, allowText: true });
      if (!('text' in r)) return;
      const v = Number(r.text);
      if (v !== 0 && v !== 1) {
        ctx.print('0(어둡게) 또는 1(밝게)을 입력하십시오.', 'err');
        return;
      }
      try {
        localStorage.setItem(PREF, String(v));
      } catch {
        /* 이번 세션만 */
      }
      apply(v);
      app.view.requestOverlay();
    },
  });
}
