/**
 * MOCORO(Express Tools): 고른 객체를 한 명령에서 이동·복사·회전·축척.
 * `객체 선택:` → `기준점 지정:` → 이동 `두 번째 점 지정 또는 [복사(C)/회전(R)/축척(S)/기준(B)/명령 취소(U)] <종료>:`,
 * 회전·축척 모드는 같은 옵션에 이동(M)이 더해진다. 복사(C)를 켜면 그다음부터 사본을 남기고(원본은 그대로), 끄면 원본을 바꾼다.
 * 이동하면 기준점도 따라간다. 단계마다 명령 취소(U), 명령 전체는 명령 취소 한 단계.
 */
import type { EditResult } from '../edit/geom';
import type { App, CommandContext, Keyword } from './app';
import { Ghost, commitResults, compose, rotateAbout, scaleAbout, translate, type Affine } from './modify';
import { selectEditable, transformList } from './modify2-util';
import type { Pt } from './view';

type Mode = 'move' | 'rotate' | 'scale';

export function registerMocoroCommand(app: App): void {
  app.register({
    name: 'MOCORO',
    title: '이동·복사·회전·축척',
    async run(ctx: CommandContext) {
      const st = app.active!;
      let hs = await selectEditable(app, ctx);
      if (!hs.length) return;
      const b0 = await ctx.getPoint('기준점 지정:');
      if (!('point' in b0)) return;
      let base: Pt = b0.point;
      let mode: Mode = 'move';
      let copy = false;
      const steps: { ops: number; base: Pt; hs: string[]; acc: Affine }[] = [];
      // 미리보기: 처음 형상에 지금까지의 변환(acc)을 거친 뒤 이번 변환
      const ghost = new Ghost(app, hs);
      let acc: Affine = [1, 0, 0, 1, 0, 0];
      for (;;) {
        const kws: Keyword[] = [
          { key: 'C', label: '복사' },
          ...(mode !== 'move' ? [{ key: 'M', label: '이동' }] : []),
          ...(mode !== 'rotate' ? [{ key: 'R', label: '회전' }] : []),
          ...(mode !== 'scale' ? [{ key: 'S', label: '축척' }] : []),
          { key: 'B', label: '기준' },
          { key: 'U', label: '명령 취소' },
        ];
        const what = mode === 'move' ? '두 번째 점 지정' : mode === 'rotate' ? '회전 각도 지정' : '축척 비율 지정';
        const b = base;
        const xf = (p: Pt): Affine | null => {
          if (mode === 'move') return translate(p.x - b.x, p.y - b.y);
          if (mode === 'rotate') return rotateAbout(b, Math.atan2(p.y - b.y, p.x - b.x));
          const k = Math.hypot(p.x - b.x, p.y - b.y);
          return k > 1e-12 ? scaleAbout(b, k) : null;
        };
        const r = await ctx.getPoint(`${what} 또는 [${kws.map((k) => `${k.label}(${k.key})`).join('/')}] <종료>:`, {
          base,
          keywords: kws,
          preferNumber: mode !== 'move',
          ghost: (p) => {
            const m = xf(p);
            return m ? ghost.at(compose(acc, m)) : [];
          },
        });
        if ('enter' in r) return;
        if ('keyword' in r) {
          const k = r.keyword;
          if (k === 'C') {
            copy = !copy;
            ctx.print(copy ? '복사 모드: 사본을 남깁니다.' : '복사 모드를 껐습니다.');
          } else if (k === 'M') mode = 'move';
          else if (k === 'R') mode = 'rotate';
          else if (k === 'S') mode = 'scale';
          else if (k === 'B') {
            const nb = await ctx.getPoint('기준점 지정:', { base });
            if ('point' in nb) base = nb.point;
          } else if (k === 'U') {
            const s = steps.pop();
            if (!s) ctx.print('명령 취소할 것이 없습니다.');
            else {
              st.session.undoLastStep(ctx.group, s.ops);
              base = s.base;
              hs = s.hs;
              acc = s.acc;
            }
          }
          continue;
        }
        let m: Affine | null = null;
        if ('point' in r) m = xf(r.point);
        else if ('text' in r) {
          const v = Number(r.text);
          if (Number.isFinite(v)) {
            if (mode === 'rotate') m = rotateAbout(base, (v * Math.PI) / 180);
            else if (mode === 'scale' && v > 0) m = scaleAbout(base, v);
          }
        }
        if (!m) continue;
        const results: EditResult[] = transformList(st, hs, m, copy);
        st.selection.clear();
        const a = commitResults(app, ctx, results, 'MOCORO', { transform: copy ? undefined : m });
        if (!a.ops) continue;
        steps.push({ ops: a.ops, base, hs, acc });
        if (!copy) {
          // 바뀐 객체를 계속 다룬다(종류가 바뀐 객체는 새 핸들로)
          const removed = new Set(results.flatMap((x) => x.remove ?? []));
          hs = [...hs.filter((h) => !removed.has(h) && st.doc.entityIndex.has(h)), ...a.added];
          acc = compose(acc, m);
          if (mode === 'move' && 'point' in r) base = r.point;
        }
        app.refreshSelectionOverlay();
      }
    },
  });
}
