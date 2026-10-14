/**
 * 검사 치수: DIMINSPECT(대화상자), -DIMINSPECT(명령행). 치수 문자에 레이블·검사율 프레임을 붙이거나 뗀다.
 * 기록은 AutoCAD와 같은 XDATA ACAD_DSTYLE_DIMINSPECT(src/edit/dim/inspect.ts). 프롬프트는 AutoCAD 2026 한국어판을 따른다.
 */
import type { DimensionEntity, Entity } from '../core/model';
import { type Inspect, type InspectShape, readInspect, withInspect } from '../edit/dim/inspect';
import type { App, CommandContext } from './app';
import { commitChanged } from './annot2-common';
import { unlockedOnly } from './layers';
import { form } from './ui/dom';

function dims(app: App, hs: string[]): DimensionEntity[] {
  const doc = app.active!.doc;
  return unlockedOnly(app, hs)
    .map((h) => doc.entityIndex.get(h))
    .filter((e): e is DimensionEntity => e?.type === 'DIMENSION');
}

function apply(app: App, ctx: CommandContext, list: DimensionEntity[], ins: Inspect | null, removeKeep = false): number {
  const changed: Entity[] = [];
  for (const d of list) {
    let next: Inspect | null = ins;
    // -DIMINSPECT 제거는 값을 두고 끈다(AutoCAD와 같다)
    if (removeKeep) {
      const cur = readInspect(d);
      if (!cur?.on) continue;
      next = { ...cur, on: false };
    }
    const xdata = withInspect(d.xdata, next);
    const after = { ...d, xdata } as DimensionEntity;
    if (!xdata) delete after.xdata;
    changed.push(after);
  }
  return commitChanged(app, ctx, changed, 'DIMINSPECT');
}

export function registerDimInspectCommands(app: App): void {
  app.register({
    name: 'DIMINSPECT',
    title: '검사 치수',
    async run(ctx) {
      const list = dims(app, await ctx.getSelection('치수 선택:'));
      if (!list.length) {
        ctx.print('치수를 선택하십시오.', 'err');
        return;
      }
      const cur = list.length === 1 ? readInspect(list[0]!) : null;
      const v = await form('검사 치수', [
        {
          key: 'shape',
          label: '쉐이프',
          type: 'select',
          value: cur?.shape ?? 'round',
          options: [
            { value: 'round', label: '원형(R)' },
            { value: 'angular', label: '각도(A)' },
            { value: 'none', label: '없음(N)' },
          ],
        },
        { key: 'useLabel', label: '레이블(L)', type: 'check', value: cur?.label != null },
        { key: 'label', label: '레이블 값', type: 'text', value: cur?.label ?? '' },
        { key: 'useRate', label: '검사율(I)', type: 'check', value: cur ? cur.rate !== null : true },
        { key: 'rate', label: '검사율 값', type: 'text', value: cur?.rate ?? '100%' },
        { key: 'remove', label: '검사 제거(M)', type: 'check', value: false },
      ]);
      if (!v) return;
      if (v.remove) {
        const n = apply(app, ctx, list, null);
        ctx.print(`${n}개 치수에서 검사를 제거했습니다.`);
        return;
      }
      const ins: Inspect = { on: true, shape: v.shape as InspectShape, label: v.useLabel ? String(v.label) : null, rate: v.useRate ? String(v.rate) || '100%' : null };
      const n = apply(app, ctx, list, ins);
      ctx.print(`${n}개 치수를 검사 치수로 만들었습니다.`);
    },
  });

  app.register({
    name: '-DIMINSPECT',
    title: '검사 치수(명령행)',
    async run(ctx) {
      const k = await ctx.getPoint('검사 데이터 추가 또는 [제거(R)] <추가(A)>:', {
        keywords: [
          { key: 'A', label: '추가' },
          { key: 'R', label: '제거' },
        ],
      });
      if (!('keyword' in k) && !('enter' in k)) return;
      const remove = 'keyword' in k && k.keyword === 'R';
      const list = dims(app, await ctx.getSelection('치수 선택:'));
      if (!list.length) return;
      if (remove) {
        apply(app, ctx, list, null, true);
        return;
      }
      const sh = await ctx.getPoint('쉐이프 옵션 입력 [원형(R)/각도(A)/없음(N)] <원형(R)>:', {
        keywords: [
          { key: 'R', label: '원형' },
          { key: 'A', label: '각도' },
          { key: 'N', label: '없음' },
        ],
      });
      const shape: InspectShape = 'keyword' in sh ? (sh.keyword === 'A' ? 'angular' : sh.keyword === 'N' ? 'none' : 'round') : 'round';
      const lab = await ctx.getPoint('레이블 데이터 입력 <없음>:', { allowText: true });
      if ('keyword' in lab) return;
      const label = 'text' in lab && lab.text.trim() ? lab.text.trim() : null;
      const rt = await ctx.getPoint('검사율 입력 <100%>:', { allowText: true });
      if ('keyword' in rt) return;
      const rate = 'text' in rt && rt.text.trim() ? rt.text.trim() : '100%';
      apply(app, ctx, list, { on: true, shape, label, rate });
    },
  });
}
