/**
 * 명령행 클래식 배열 -ARRAY(비연관): 객체 선택 → `배열 유형 입력 [직사각형(R)/원형(P)] <R>:` →
 * 직사각형: 행 수 → 열 수 → 행 사이 거리(또는 단위 셀) → 열 사이 거리. 원형: 중심점(또는 기준) → 항목 수 → 채울 각도 → 회전 여부.
 * 직사각형은 SNAPANG(스냅 회전 각도) 방향으로 놓는다. 항목은 각자 따로 만든다(연관 배열이 아니다).
 */
import type { Entity } from '../core/model';
import { boundsOf } from '../edit/geom/query';
import { polarArrayAngles, polarCountFrom, rectArrayOffsets } from '../edit/script/dash';
import type { App, CommandContext } from './app';
import { askInteger, askOption, askReal, askYN, parseReal } from './dashcmds-ask';
import { type Affine, commitResults, rotateAbout, translate } from './modify';
import { memOf, selectEditable, transformList } from './modify2-util';
import type { Pt } from './view';

const MAX_ITEMS = 100000;

/** 거리: 숫자 또는 두 점 */
async function askDistance(ctx: CommandContext, prompt: string): Promise<number> {
  for (;;) {
    const r = await ctx.getPoint(prompt, { preferNumber: true, allowText: true });
    if ('text' in r) {
      const v = parseReal(r.text);
      if (v !== null && v !== 0) return v;
    }
    if ('point' in r) {
      const a = r.point;
      const q = await ctx.getPoint('두 번째 점 지정:', { base: a, rubber: (p) => [{ pts: [a.x, a.y, p.x, p.y] }] });
      if ('point' in q) {
        const d = Math.hypot(q.point.x - a.x, q.point.y - a.y);
        if (d > 1e-12) return d;
      }
    }
    ctx.print('0이 아닌 거리가 필요합니다.', 'err');
  }
}

export function registerDashArrayCommand(app: App): void {
  app.register({
    name: '-ARRAY',
    aliases: ['-AR'],
    title: '배열(클래식, 명령행)',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const hs = await selectEditable(app, ctx);
      if (!hs.length) return;
      const m = memOf(st);
      const lastType = m.arrayType === 'P' ? 'P' : 'R';
      const type = await askOption(
        ctx,
        `배열 유형 입력 [직사각형(R)/원형(P)] <${lastType}>:`,
        [
          { key: 'R', label: '직사각형' },
          { key: 'P', label: '원형' },
        ],
        lastType,
      );
      m.arrayType = type;
      const results = [];
      let count: number;
      if (type === 'R') {
        const rows = await askInteger(ctx, '행 수 입력 (---) <1>:', 1, 1, 32767);
        const cols = await askInteger(ctx, '열 수 입력 (|||) <1>:', 1, 1, 32767);
        if (rows * cols === 1) {
          ctx.print('요소가 하나인 배열이므로 할 일이 없습니다.');
          return;
        }
        if (rows * cols > MAX_ITEMS) {
          ctx.print(`항목이 너무 많습니다(${MAX_ITEMS}개까지).`, 'err');
          return;
        }
        let dx = 0;
        let dy = 0;
        if (rows > 1 && cols > 1) {
          for (;;) {
            const r = await ctx.getPoint('행 사이의 거리 입력 또는 단위 셀 지정 (---):', { preferNumber: true, allowText: true });
            if ('point' in r) {
              const a = r.point;
              const q = await ctx.getPoint('반대 구석 지정:', { base: a, rubber: (p) => [{ pts: [a.x, a.y, p.x, a.y, p.x, p.y, a.x, p.y], closed: true, dashed: true }] });
              if ('point' in q && Math.abs(q.point.x - a.x) > 1e-12 && Math.abs(q.point.y - a.y) > 1e-12) {
                dx = q.point.x - a.x;
                dy = q.point.y - a.y;
                break;
              }
              ctx.print('단위 셀은 폭과 높이가 0이 아니어야 합니다.', 'err');
              continue;
            }
            const v = 'text' in r ? parseReal(r.text) : null;
            if (v !== null && v !== 0) {
              dy = v;
              dx = await askDistance(ctx, '열 사이의 거리 지정 (|||):');
              break;
            }
            ctx.print('0이 아닌 거리 또는 점이 필요합니다.', 'err');
          }
        } else if (rows > 1) dy = await askDistance(ctx, '행 사이의 거리 입력 (---):');
        else dx = await askDistance(ctx, '열 사이의 거리 지정 (|||):');
        const snapang = Number(doc.header.get('$SNAPANG') ?? 0) || 0;
        for (const o of rectArrayOffsets(rows, cols, dy, dx, snapang)) results.push(...transformList(st, hs, translate(o.x, o.y), true));
        count = rows * cols;
      } else {
        // 회전하지 않을 때 옮기는 기준: 기준(B)으로 준 점, 없으면 선택 범위의 가운데
        let base: Pt | null = null;
        let center: Pt;
        for (;;) {
          const r = await ctx.getPoint('배열의 중심점 지정 또는 [기준(B)]:', { keywords: [{ key: 'B', label: '기준' }] });
          if ('point' in r) {
            center = r.point;
            break;
          }
          if ('keyword' in r) {
            const b = await ctx.getPoint('객체의 기준점 지정:');
            if ('point' in b) base = b.point;
            continue;
          }
          ctx.print('점 또는 옵션 키워드가 필요합니다.', 'err');
        }
        let n = 0;
        for (;;) {
          const r = await ctx.getPoint('배열에 있는 항목 수 입력:', { preferNumber: true, allowText: true });
          if ('enter' in r) break;
          const v = 'text' in r ? parseReal(r.text) : null;
          if (v !== null && Number.isInteger(v) && v >= 2 && v <= MAX_ITEMS) {
            n = v;
            break;
          }
          ctx.print(`2에서 ${MAX_ITEMS} 사이의 정수가 필요합니다.`, 'err');
        }
        const deg = (v: number) => (v * Math.PI) / 180;
        const fill = deg(await askReal(ctx, '채울 각도 지정 (+=시계 반대 방향, -=시계 방향) <360>:', 360, (v) => (Math.abs(v) <= 360 ? null : '-360에서 360 사이의 각도가 필요합니다.')));
        let angles: number[];
        if (n && fill) angles = polarArrayAngles(n, fill);
        else {
          let between = deg(
            await askReal(ctx, '항목 사이의 각도 지정 (+=시계 반대 방향, -=시계 방향):', null, (v) => (v !== 0 && Math.abs(v) <= 360 ? null : '0이 아닌 각도가 필요합니다.')),
          );
          if (fill < 0 && between > 0) between = -between;
          if (!n) n = polarCountFrom(fill, between);
          if (n < 2) {
            ctx.print('요소가 하나인 배열이므로 할 일이 없습니다.');
            return;
          }
          angles = polarArrayAngles(n, 0, between);
        }
        const rotate = await askYN(ctx, '배열된 객체를 회전하시겠습니까?', true);
        const ents = hs.map((h) => doc.entityIndex.get(h)).filter((e): e is Entity => !!e);
        const box = boundsOf(ents, doc);
        const ref = base ?? (box ? { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 } : center);
        for (const a of angles) {
          let mm: Affine;
          if (rotate) mm = rotateAbout(center, a);
          else {
            const q = rotateAbout(center, a);
            mm = translate(q[0] * ref.x + q[2] * ref.y + q[4] - ref.x, q[1] * ref.x + q[3] * ref.y + q[5] - ref.y);
          }
          results.push(...transformList(st, hs, mm, true));
        }
        count = n;
      }
      st.selection.clear();
      const res = commitResults(app, ctx, results, 'ARRAY', { quiet: true });
      app.lastCreated = res.added;
      ctx.print(`항목 ${count}개(새 객체 ${res.added.length}개)를 만들었습니다.`);
    },
  });
}
