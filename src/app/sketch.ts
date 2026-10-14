/**
 * 스케치: SKETCH. 클릭하면 펜을 내리고(마우스를 따라 증분마다 점 기록), 다시 클릭하면 올린다. Enter로 기록하고 Esc로 버린다.
 * 유형(SKPOLY 0 선·1 폴리선·2 스플라인)·증분(SKETCHINC)은 도면 변수, 스플라인 공차는 이번 세션 값이다.
 */
import { formatLength } from '../core/units';
import { type P2, type SketchType, recordPoint, sketchEntities } from '../edit/sketch';
import type { App } from './app';
import { addEntities, currentProps } from './draw';

const TYPE_NAMES: Record<SketchType, string> = { line: '선', polyline: '폴리선', spline: '스플라인' };
let tolerance = 0.5;

export function registerSketchCommands(app: App): void {
  app.register({
    name: 'SKETCH',
    title: '스케치',
    async run(ctx) {
      const doc = app.active!.doc;
      const f = (v: number) => formatLength(v, app.active!.units);
      const skpoly = Number(doc.header.get('$SKPOLY') ?? 0);
      let type: SketchType = skpoly === 1 ? 'polyline' : skpoly === 2 ? 'spline' : 'line';
      let inc = Number(doc.header.get('$SKETCHINC') ?? 1) || 1;
      const strokes: P2[][] = [];
      let pen: P2[] | null = null;
      const info = () => ctx.print(`유형 = ${TYPE_NAMES[type]}   증분 = ${f(inc)}   공차 = ${f(tolerance)}`);
      info();
      const preview = (p: { x: number; y: number }) => {
        if (pen) recordPoint(pen, p, inc);
        const out = strokes.filter((s) => s.length > 1).map((s) => ({ pts: s.flatMap((q) => [q.x, q.y]) }));
        if (pen && pen.length) out.push({ pts: [...pen.flatMap((q) => [q.x, q.y]), p.x, p.y] });
        return out;
      };
      for (;;) {
        const first = !strokes.length && !pen;
        const r = await ctx.getPoint(first || !pen ? '스케치 지정 또는 [유형(T)/증분(I)/공차(L)]:' : '스케치 지정(클릭하면 펜 올림, Enter로 기록):', {
          rubber: preview,
          keywords: pen
            ? []
            : [
                { key: 'T', label: '유형' },
                { key: 'I', label: '증분' },
                { key: 'L', label: '공차' },
              ],
        });
        if ('point' in r) {
          if (pen) {
            // 펜 올림: 획을 끝낸다
            recordPoint(pen, r.point, 0);
            strokes.push(pen);
            pen = null;
          } else {
            pen = [];
            recordPoint(pen, r.point, 0);
          }
          continue;
        }
        if ('enter' in r || 'text' in r) break;
        const k = r.keyword;
        if (k === 'T') {
          const t = await ctx.getPoint(`스케치 유형 입력 [선(L)/폴리선(P)/스플라인(S)] <${TYPE_NAMES[type]}>:`, {
            keywords: [
              { key: 'L', label: '선' },
              { key: 'P', label: '폴리선' },
              { key: 'S', label: '스플라인' },
            ],
          });
          if ('keyword' in t) {
            type = t.keyword === 'P' ? 'polyline' : t.keyword === 'S' ? 'spline' : 'line';
            doc.header.set('$SKPOLY', type === 'polyline' ? 1 : type === 'spline' ? 2 : 0);
          }
        } else if (k === 'I') {
          const t = await ctx.getPoint(`스케치 증분 지정 <${f(inc)}>:`, { allowText: true, preferNumber: true });
          if ('text' in t) {
            const v = parseFloat(t.text);
            if (Number.isFinite(v) && v > 0) {
              inc = v;
              doc.header.set('$SKETCHINC', v);
            } else ctx.print('0보다 큰 값을 입력하십시오.', 'err');
          }
        } else if (k === 'L') {
          const t = await ctx.getPoint(`스플라인 맞춤 공차 지정 <${f(tolerance)}>:`, { allowText: true, preferNumber: true });
          if ('text' in t) {
            const v = parseFloat(t.text);
            if (Number.isFinite(v) && v >= 0) tolerance = v;
            else ctx.print('0 이상의 값을 입력하십시오.', 'err');
          }
        }
        info();
      }
      if (pen) strokes.push(pen);
      const ents = sketchEntities(strokes, type, currentProps(app), tolerance);
      if (!ents.length) {
        ctx.print('기록한 스케치가 없습니다.');
        return;
      }
      app.lastCreated = addEntities(app, ctx, ents, 'SKETCH');
      ctx.print(`${TYPE_NAMES[type]} ${ents.length}개가 기록되었습니다.`);
    },
  });
}
