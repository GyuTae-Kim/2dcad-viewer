/**
 * 나선: HELIX. 프롬프트는 AutoCAD 2026 한국어판을 따른다. 축은 WCS Z이고 평면에는 투영(높이 0이면 평면 나선형)이 보인다.
 * R2007 이상으로 저장하면 HELIX, 그 전 버전은 같은 스플라인으로 남는다.
 */
import { formatLength } from '../core/units';
import { type HelixSpec, helixEntity, helixPreview } from '../edit/helix';
import type { App, CommandContext } from './app';
import { addEntities, currentProps } from './draw';
import type { Pt } from './view';

/** 마지막에 쓴 값(AutoCAD처럼 다음 나선의 기본값) */
const last = { turns: 3, ccw: true, base: 1, top: 1, height: 1 };

function circle(c: Pt, r: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    out.push(c.x + r * Math.cos(a), c.y + r * Math.sin(a));
  }
  return out;
}

/** 거리·반지름 입력. 점을 찍으면 base에서의 거리와 그 점, [지름(D)]이면 지름으로 받는다 */
async function radiusInput(ctx: CommandContext, prompt: string, center: Pt, def: number, rubber: (q: Pt) => { pts: number[] }[]): Promise<{ r: number; at: Pt | null } | null> {
  const f = (v: number) => formatLength(v, ctx.app.active!.units);
  for (;;) {
    const r = await ctx.getPoint(`${prompt} 또는 [지름(D)] <${f(def)}>:`, { base: center, allowText: true, keywords: [{ key: 'D', label: '지름' }], rubber });
    if ('enter' in r) return { r: def, at: null };
    if ('point' in r) return { r: Math.hypot(r.point.x - center.x, r.point.y - center.y), at: r.point };
    if ('keyword' in r) {
      const d = await ctx.getPoint(`지름 지정 <${f(def * 2)}>:`, { base: center, allowText: true, rubber: (q) => rubber({ x: center.x + (q.x - center.x) / 2, y: center.y + (q.y - center.y) / 2 }) });
      if ('enter' in d) return { r: def, at: null };
      if ('point' in d) return { r: Math.hypot(d.point.x - center.x, d.point.y - center.y) / 2, at: null };
      if ('text' in d && Number.isFinite(parseFloat(d.text)) && parseFloat(d.text) >= 0) return { r: parseFloat(d.text) / 2, at: null };
      ctx.print('0 이상의 값을 입력하십시오.', 'err');
      continue;
    }
    if ('text' in r) {
      const v = parseFloat(r.text);
      if (Number.isFinite(v) && v >= 0) return { r: v, at: null };
    }
    ctx.print('0 이상의 값을 입력하거나 점을 지정하십시오.', 'err');
  }
}

export function registerHelixCommands(app: App): void {
  app.register({
    name: 'HELIX',
    title: '나선',
    async run(ctx) {
      const f = (v: number) => formatLength(v, app.active!.units);
      ctx.print(`회전 수 = ${last.turns.toFixed(4)}    비틀기=${last.ccw ? 'CCW' : 'CW'}`);
      const c = await ctx.getPoint('기준 중심점 지정:');
      if (!('point' in c)) return;
      const center = c.point;
      const spec = (o: Partial<HelixSpec>): HelixSpec => ({
        center: { x: center.x, y: center.y, z: 0 },
        baseRadius: last.base,
        topRadius: last.top,
        startAngle: 0,
        turns: last.turns,
        height: last.height,
        ccw: last.ccw,
        ...o,
      });
      const b = await radiusInput(ctx, '기준 반지름 지정', center, last.base, (q) => [{ pts: circle(center, Math.hypot(q.x - center.x, q.y - center.y)) }]);
      if (!b) return;
      if (!(b.r > 0)) {
        ctx.print('반지름은 0보다 커야 합니다.', 'err');
        return;
      }
      const startAngle = b.at ? Math.atan2(b.at.y - center.y, b.at.x - center.x) : 0;
      const base = b.r;
      // 상단 반지름 기본값은 기준 반지름(AutoCAD와 같다)
      const t = await radiusInput(ctx, '상단 반지름 지정', center, base, (q) => [{ pts: helixPreview(spec({ baseRadius: base, topRadius: Math.hypot(q.x - center.x, q.y - center.y), startAngle })) }]);
      if (!t) return;
      const top = t.r;
      if (!(top >= 0) || (top === 0 && base === 0)) {
        ctx.print('반지름을 확인하십시오.', 'err');
        return;
      }
      let turns = last.turns;
      let ccw = last.ccw;
      let height = last.height;
      for (;;) {
        const preview = () => [{ pts: helixPreview(spec({ baseRadius: base, topRadius: top, startAngle, turns, ccw })) }];
        const r = await ctx.getPoint(`나선 높이 지정 또는 [축 끝점(A)/회전(T)/회전 높이(H)/비틀기(W)] <${f(height)}>:`, {
          base: center,
          allowText: true,
          rubber: preview,
          keywords: [
            { key: 'A', label: '축 끝점' },
            { key: 'T', label: '회전' },
            { key: 'H', label: '회전 높이' },
            { key: 'W', label: '비틀기' },
          ],
        });
        if ('enter' in r) break;
        if ('point' in r) {
          height = Math.hypot(r.point.x - center.x, r.point.y - center.y);
          break;
        }
        if ('text' in r) {
          const v = parseFloat(r.text);
          if (Number.isFinite(v)) {
            // 음수 높이 허용(아래로 감긴다)
            height = v;
            break;
          }
          ctx.print('숫자를 입력하거나 점을 지정하십시오.', 'err');
          continue;
        }
        const k = r.keyword;
        if (k === 'T') {
          const v = await ctx.getPoint(`회전 수 입력 <${turns.toFixed(4)}>:`, { allowText: true, preferNumber: true });
          if ('text' in v) {
            const n = parseFloat(v.text);
            if (Number.isFinite(n) && n > 0 && n <= 500) turns = n;
            else ctx.print('회전 수는 0보다 크고 500 이하여야 합니다.', 'err');
          }
        } else if (k === 'H') {
          const v = await ctx.getPoint(`회전 사이의 거리 지정 <${f(turns > 0 ? height / turns : 0)}>:`, { allowText: true, preferNumber: true });
          if ('text' in v) {
            const n = parseFloat(v.text);
            if (Number.isFinite(n)) {
              // 회전 높이를 정하면 높이 = 회전 수 × 회전 높이
              height = n * turns;
              break;
            }
          }
        } else if (k === 'W') {
          const v = await ctx.getPoint(`나선의 비틀기 방향 입력 [시계 방향(CW)/시계 반대 방향(CCW)] <${ccw ? 'CCW' : 'CW'}>:`, {
            keywords: [
              { key: 'CW', label: '시계 방향' },
              { key: 'CCW', label: '시계 반대 방향' },
            ],
          });
          if ('keyword' in v) ccw = v.keyword === 'CCW';
        } else if (k === 'A') {
          const v = await ctx.getPoint('축 끝점 지정:', { base: center, allowText: true });
          // 이 앱의 나선 축은 Z뿐이므로 축 끝점의 Z만 높이로 쓴다(x,y,z로 입력)
          if ('text' in v) {
            const parts = v.text.split(',').map((s) => parseFloat(s));
            if (parts.length === 3 && parts.every(Number.isFinite)) {
              if (Math.hypot(parts[0]! - center.x, parts[1]! - center.y) > 1e-9) ctx.print('축은 Z 방향만 지원합니다. 축 끝점의 Z 좌표를 높이로 씁니다.');
              height = parts[2]!;
              break;
            }
          }
          ctx.print('축 끝점은 x,y,z로 입력하십시오(축은 Z 방향).', 'err');
        }
      }
      Object.assign(last, { turns, ccw, base, top, height });
      const e = helixEntity(spec({ baseRadius: base, topRadius: top, startAngle, turns, ccw, height }), currentProps(app));
      addEntities(app, ctx, [e], 'HELIX');
      app.lastCreated = [e.handle];
    },
  });
}
