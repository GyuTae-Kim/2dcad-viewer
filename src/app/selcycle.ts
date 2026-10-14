/**
 * 선택 순환: SELECTIONCYCLING(0 끔, 1 켬(목록 없음), 2 겹친 객체가 여럿이면 목록에서 고름). 이 브라우저에 보관한다.
 */
import type { App } from './app';

const PREF = 'opencad.selectioncycling';

export function registerSelectionCyclingCommands(app: App): void {
  try {
    const v = Number(localStorage.getItem(PREF));
    if (v === 1 || v === 2) app.selectionCycling = v;
  } catch {
    /* 기본값 0 */
  }
  app.register({
    name: 'SELECTIONCYCLING',
    title: '선택 순환',
    noDoc: true,
    transparent: true,
    async run(ctx) {
      const r = await ctx.getPoint(`SELECTIONCYCLING에 대한 새 값 입력 <${app.selectionCycling}>:`, { preferNumber: true, allowText: true });
      if (!('text' in r)) return;
      const v = Number(r.text);
      if (v !== 0 && v !== 1 && v !== 2) {
        ctx.print('0, 1, 2 중 하나를 입력하십시오.', 'err');
        return;
      }
      app.selectionCycling = v;
      try {
        localStorage.setItem(PREF, String(v));
      } catch {
        /* 이번 세션만 */
      }
      ctx.print(v === 2 ? '겹친 객체를 누르면 목록에서 고릅니다.' : '선택 순환 목록을 쓰지 않습니다.');
    },
  });
}
