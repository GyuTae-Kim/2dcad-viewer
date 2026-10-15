/**
 * 해치 경계·원점 명령(AutoCAD 2026 한국어판 프롬프트):
 * - HATCHGENERATEBOUNDARY: 고른 해치 둘레에 연관되지 않은 경계(닫힌 폴리선, 곡선 경계는 스플라인)를 현재 도면층에 만든다.
 * - HATCHSETBOUNDARY: 해치 하나의 경계를 고른 닫힌 객체(또는 닫힌 고리를 이루는 객체들)로 다시 정한다.
 *   무늬·축척·각도·원점은 그대로, 연관 해치면 새 경계에 연관한다.
 * - HATCHSETORIGIN: 고른 해치들의 무늬 원점을 새 점으로 옮긴다(단색·그라데이션은 원점이 없어 건너뛴다).
 * 계산은 src/edit/editcmds2/hatch.ts.
 */
import type { Entity, HatchEntity } from '../core/model';
import { hasPatternOrigin, hatchBoundaryEntities, hatchWithBoundary, relinkReactors, withHatchOrigin } from '../edit/editcmds2/hatch';
import type { EditOp } from '../edit/session';
import { HATCH_LINE_LIMIT } from '../render/hatch';
import type { App, CommandContext } from './app';
import { addEntities, currentProps } from './draw';
import { unlockedOnly } from './layers';

const isHatch = (e: Entity | undefined): e is HatchEntity => e?.type === 'HATCH' || e?.type === 'MPOLYGON';

/** 해치 객체 고르기(여러 개). 해치가 아닌 것은 뺀다 */
async function selectHatches(app: App, ctx: CommandContext, unlocked: boolean): Promise<HatchEntity[]> {
  const st = app.active!;
  let hs = await ctx.getSelection('해치 객체 선택:');
  if (unlocked) hs = unlockedOnly(app, hs);
  const list = hs.map((h) => st.doc.entityIndex.get(h)).filter(isHatch);
  if (hs.length && list.length < hs.length) ctx.print(`해치가 아닌 객체 ${hs.length - list.length}개는 뺐습니다.`);
  return list;
}

/** 해치 하나 고르기(고른 것이 해치 하나면 그것) */
async function pickHatch(app: App, ctx: CommandContext): Promise<HatchEntity | null> {
  const st = app.active!;
  const pre = [...st.selection].map((h) => st.doc.entityIndex.get(h)).filter(isHatch);
  if (pre.length === 1 && st.selection.size === 1 && unlockedOnly(app, [pre[0]!.handle]).length) return pre[0]!;
  for (;;) {
    const r = await ctx.getEntity('해치 객체 선택:');
    if (!('handle' in r)) return null;
    const e = st.doc.entityIndex.get(r.handle);
    if (!isHatch(e)) {
      ctx.print('선택한 객체는 해치가 아닙니다.', 'err');
      continue;
    }
    if (!unlockedOnly(app, [e.handle]).length) continue;
    return e;
  }
}

export function registerEditCmds2Hatch(app: App): void {
  // ------------------------------------------------------------- HATCHGENERATEBOUNDARY
  app.register({
    name: 'HATCHGENERATEBOUNDARY',
    title: '해치 경계 생성',
    async run(ctx) {
      const list = await selectHatches(app, ctx, false);
      if (!list.length) return;
      const props = currentProps(app);
      const objs: Entity[] = [];
      for (const h of list) objs.push(...hatchBoundaryEntities(h, { ...props, handle: '' }));
      app.clearSelection();
      if (!objs.length) {
        ctx.print('해치에 경계 경로가 없습니다.', 'err');
        return;
      }
      app.lastCreated = addEntities(app, ctx, objs, 'HATCHGENERATEBOUNDARY');
      const nSp = objs.filter((o) => o.type === 'SPLINE').length;
      const nPl = objs.length - nSp;
      ctx.print(nSp ? `경계 폴리선 ${nPl}개, 스플라인 ${nSp}개를 만들었습니다.` : `경계 폴리선 ${nPl}개를 만들었습니다.`);
    },
  });

  // ------------------------------------------------------------- HATCHSETBOUNDARY
  app.register({
    name: 'HATCHSETBOUNDARY',
    title: '해치 경계 설정',
    async run(ctx) {
      const st = app.active!;
      const h = await pickHatch(app, ctx);
      if (!h) return;
      app.clearSelection();
      const hs = await ctx.getSelection('경계 객체 선택:', { noPickfirst: true });
      const ents = hs
        .filter((x) => x !== h.handle)
        .map((x) => st.doc.entityIndex.get(x))
        .filter((e): e is Entity => !!e && !isHatch(e));
      app.clearSelection();
      if (!ents.length) {
        ctx.print('선택된 경계 객체가 없습니다.');
        return;
      }
      const n = hatchWithBoundary(st.doc, h, ents, h.associative, HATCH_LINE_LIMIT);
      if (typeof n === 'string') {
        ctx.print(n, 'err');
        return;
      }
      const block = st.session.ownerOf(h.handle);
      if (!block) return;
      const ops: EditOp[] = [{ kind: 'modify', block, before: h, after: n }];
      for (const u of relinkReactors(st.doc, h, n)) {
        const b = st.session.ownerOf(u.before.handle);
        if (b) ops.push({ kind: 'modify', block: b, before: u.before, after: u.after });
      }
      st.session.commit({ label: 'HATCHSETBOUNDARY', ops, group: ctx.group, rebuildNow: true });
      ctx.print(n.associative ? `해치 경계를 객체 ${ents.length}개로 다시 정했습니다(연관).` : `해치 경계를 객체 ${ents.length}개로 다시 정했습니다.`);
    },
  });

  // ------------------------------------------------------------- HATCHSETORIGIN
  app.register({
    name: 'HATCHSETORIGIN',
    title: '해치 원점 설정',
    async run(ctx) {
      const st = app.active!;
      const list = await selectHatches(app, ctx, true);
      if (!list.length) return;
      const movable = list.filter(hasPatternOrigin);
      if (movable.length < list.length) ctx.print(`단색 채우기·그라데이션 해치 ${list.length - movable.length}개는 원점이 없어 건너뜁니다.`);
      if (!movable.length) {
        app.clearSelection();
        return;
      }
      const r = await ctx.getPoint('새 해치 원점 지정:');
      app.clearSelection();
      if (!('point' in r)) return;
      const ops: EditOp[] = [];
      for (const h of movable) {
        const n = withHatchOrigin(h, r.point);
        const block = st.session.ownerOf(h.handle);
        if (n && block) ops.push({ kind: 'modify', block, before: h, after: n });
      }
      if (!ops.length) return;
      st.session.commit({ label: 'HATCHSETORIGIN', ops, group: ctx.group, rebuildNow: true });
      ctx.print(`해치 ${ops.length}개의 원점을 바꿨습니다.`);
    },
  });
}
