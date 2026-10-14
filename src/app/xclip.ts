/**
 * 블록 참조 자르기: XCLIP(XC). 새 경계(직사각형·다각형·폴리선 선택), 켜기·끄기, 삭제, 폴리선 생성.
 * 경계 밖이 숨겨진다(자르기 반전은 파일 형식이 확실하지 않아 넣지 않았다). 프롬프트는 AutoCAD 2026 한국어판을 따른다.
 */
import type { Entity, InsertEntity, Vec2 } from '../core/model';
import { entityDefaults } from '../core/model';
import type { EditOp } from '../edit/session';
import { enableXclipOps, removeXclipOps, setXclipOps, xclipBoundaryWorld, xclipParts } from '../edit/xclip';
import type { App, CommandContext } from './app';
import { currentProps } from './draw';
import { unlockedOnly } from './layers';

async function boundary(ctx: CommandContext, app: App): Promise<Vec2[] | null> {
  ctx.print('외부 모드 - 경계 외부의 객체가 숨겨집니다.');
  for (;;) {
    const r = await ctx.getPoint('자르기 경계 지정 또는 [폴리선 선택(S)/다각형(P)/직사각형(R)] <직사각형>:', {
      keywords: [
        { key: 'S', label: '폴리선 선택' },
        { key: 'P', label: '다각형' },
        { key: 'R', label: '직사각형' },
      ],
    });
    const k = 'keyword' in r ? r.keyword : 'enter' in r ? 'R' : 'point' in r ? 'R*' : null;
    if (!k) return null;
    if (k === 'R' || k === 'R*') {
      let a: Vec2;
      if ('point' in r) a = r.point;
      else {
        const q = await ctx.getPoint('첫 번째 구석 지정:');
        if (!('point' in q)) return null;
        a = q.point;
      }
      const b = await ctx.getPoint('반대 구석 지정:', { base: a, rubber: (q) => [{ pts: [a.x, a.y, q.x, a.y, q.x, q.y, a.x, q.y], closed: true, dashed: true }] });
      if (!('point' in b)) return null;
      if (Math.abs(b.point.x - a.x) < 1e-9 || Math.abs(b.point.y - a.y) < 1e-9) {
        ctx.print('경계의 넓이가 0입니다.', 'err');
        continue;
      }
      return [a, { x: b.point.x, y: a.y }, b.point, { x: a.x, y: b.point.y }];
    }
    if (k === 'P') {
      const pts: Vec2[] = [];
      for (;;) {
        const q = await ctx.getPoint(pts.length ? (pts.length < 2 ? '다음 점 지정 또는 [명령 취소(U)]:' : '다음 점 지정 또는 [명령 취소(U)] <끝>:') : '첫 번째 점 지정:', {
          base: pts[pts.length - 1] ?? null,
          keywords: pts.length ? [{ key: 'U', label: '명령 취소' }] : [],
          rubber: (q) => (pts.length ? [{ pts: [...pts, q, pts[0]!].flatMap((p) => [p.x, p.y]), dashed: true }] : []),
        });
        if ('point' in q) pts.push(q.point);
        else if ('keyword' in q) pts.pop();
        else if ('enter' in q && pts.length >= 3) return pts;
        else if ('enter' in q) continue;
        else return null;
      }
    }
    if (k === 'S') {
      const q = await ctx.getEntity('자르기 경계로 사용할 폴리선 선택:');
      if (!('handle' in q)) return null;
      const e = app.active!.doc.entityIndex.get(q.handle);
      if (e?.type !== 'LWPOLYLINE' || !e.closed || e.vertices.length < 3) {
        ctx.print('닫힌 폴리선을 선택하십시오.', 'err');
        continue;
      }
      if (e.vertices.some((v) => Math.abs(v.bulge) > 1e-12)) ctx.print('호 세그먼트는 직선으로 이어 자릅니다.');
      return e.vertices.map((v) => ({ x: v.x, y: v.y }));
    }
  }
}

export function registerXclipCommands(app: App): void {
  app.register({
    name: 'XCLIP',
    aliases: ['XC'],
    title: '블록 자르기',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const hs = unlockedOnly(app, await ctx.getSelection('객체 선택:'));
      const inserts = hs.map((h) => doc.entityIndex.get(h)).filter((e): e is InsertEntity => e?.type === 'INSERT');
      if (!inserts.length) {
        ctx.print('블록 참조나 외부 참조를 선택하십시오.', 'err');
        return;
      }
      const r = await ctx.getPoint('자르기 옵션 입력 [켜기(ON)/끄기(OFF)/삭제(D)/폴리선 생성(P)/새 경계(N)] <새 경계>:', {
        keywords: [
          { key: 'ON', label: '켜기' },
          { key: 'OFF', label: '끄기' },
          { key: 'D', label: '삭제' },
          { key: 'P', label: '폴리선 생성' },
          { key: 'N', label: '새 경계' },
        ],
      });
      const k = 'keyword' in r ? r.keyword : 'enter' in r ? 'N' : null;
      if (!k) return;
      const ops: EditOp[] = [];
      const blockOf = (e: Entity) => st.session.ownerOf(e.handle);
      if (k === 'ON' || k === 'OFF') {
        for (const e of inserts) ops.push(...enableXclipOps(doc, e, k === 'ON'));
      } else if (k === 'D') {
        for (const e of inserts) ops.push(...removeXclipOps(doc, e));
      } else if (k === 'P') {
        const props = currentProps(app);
        for (const e of inserts) {
          const pts = xclipBoundaryWorld(doc, e);
          const b = blockOf(e);
          if (!pts || !b) continue;
          const pl: Entity = {
            type: 'LWPOLYLINE',
            ...entityDefaults(),
            ...props,
            handle: st.session.newHandle(),
            owner: doc.blocks.get(b)?.recordHandle,
            vertices: pts.map((p) => ({ x: p.x, y: p.y, bulge: 0, startWidth: 0, endWidth: 0 })),
            closed: true,
            plinegen: false,
            constantWidth: 0,
            elevation: 0,
          } as Entity;
          ops.push({ kind: 'add', block: b, entity: pl });
        }
        if (!ops.length) ctx.print('선택한 블록에 자르기 경계가 없습니다.', 'err');
      } else {
        const hasOld = inserts.some((e) => xclipParts(doc, e).filter);
        if (hasOld) {
          const q = await ctx.getPoint('기존 경계를 삭제하시겠습니까? [예(Y)/아니오(N)] <예>:', {
            keywords: [
              { key: 'Y', label: '예' },
              { key: 'N', label: '아니오' },
            ],
          });
          if ('keyword' in q && q.keyword === 'N') return;
          if (!('keyword' in q) && !('enter' in q)) return;
        }
        const pts = await boundary(ctx, app);
        if (!pts) return;
        for (const e of inserts) {
          const b = blockOf(e);
          if (b) ops.push(...setXclipOps(doc, e, b, pts, () => st.session.newHandle()));
        }
      }
      if (!ops.length) return;
      // 객체(필터)만 바뀌면 화면이 모르므로 블록 참조도 함께 다시 그린다
      for (const e of inserts) {
        const b = blockOf(e);
        if (b && !ops.some((o) => o.kind === 'modify' && o.before.handle === e.handle)) ops.push({ kind: 'modify', block: b, before: e, after: { ...e } });
      }
      st.session.commit({ label: 'XCLIP', ops, group: ctx.group, rebuildNow: true });
    },
  });
}
