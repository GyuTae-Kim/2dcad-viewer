/**
 * 이미지·언더레이 자르기: IMAGECLIP, PDFCLIP, 그리고 고른 객체 종류에 맞는 자르기로 보내는 CLIP.
 * 프롬프트는 AutoCAD 2026 한국어판을 따른다. 경계는 사각형(두 구석점) 또는 폴리곤, 반전 자르기(I)를 켤 수 있다.
 */
import type { Entity, ImageEntity, UnderlayEntity, Vec2 } from '../core/model';
import { imageWithClip, imageWithoutClip, underlayWithClip, underlayWithoutClip } from '../edit/imageclip';
import type { App, CommandContext } from './app';
import { commitChanged } from './annot2-common';
import { unlockedOnly } from './layers';

type Clippable = ImageEntity | UnderlayEntity;

/** 사각형 또는 폴리곤 경계(도면 좌표)와 반전 여부 */
async function askBoundary(ctx: CommandContext, inverted0: boolean): Promise<{ pts: Vec2[]; inverted: boolean } | null> {
  let inverted = inverted0;
  for (;;) {
    const k = await ctx.getPoint('[폴리곤(P)/직사각형(R)/반전 자르기(I)] <직사각형>:', {
      keywords: [
        { key: 'P', label: '폴리곤' },
        { key: 'R', label: '직사각형' },
        { key: 'I', label: '반전 자르기' },
      ],
    });
    if ('keyword' in k && k.keyword === 'I') {
      inverted = !inverted;
      ctx.print(`반전 자르기 상태가 ${inverted ? '켜짐' : '꺼짐'}입니다.`);
      continue;
    }
    if (!('keyword' in k) && !('enter' in k)) return null;
    if ('keyword' in k && k.keyword === 'P') {
      const pts: Vec2[] = [];
      const a = await ctx.getPoint('첫 번째 점 지정:');
      if (!('point' in a)) return null;
      pts.push(a.point);
      for (;;) {
        const r = await ctx.getPoint(pts.length < 3 ? '다음 점 지정 또는 [명령 취소(U)]:' : '다음 점 지정 또는 [명령 취소(U)] <끝>:', {
          base: pts[pts.length - 1],
          keywords: [{ key: 'U', label: '명령 취소' }],
          rubber: (q) => [{ pts: [...pts.flatMap((p) => [p.x, p.y]), q.x, q.y], closed: true, dashed: true }],
        });
        if ('point' in r) pts.push(r.point);
        else if ('keyword' in r) {
          if (pts.length > 1) pts.pop();
        } else if ('enter' in r && pts.length >= 3) return { pts, inverted };
        else if (!('enter' in r)) return null;
      }
    }
    const a = await ctx.getPoint('첫 번째 구석점 지정:');
    if (!('point' in a)) return null;
    const p0 = a.point;
    const b = await ctx.getPoint('반대 구석점 지정:', { rubber: (q) => [{ pts: [p0.x, p0.y, q.x, p0.y, q.x, q.y, p0.x, q.y], closed: true, dashed: true }] });
    if (!('point' in b)) return null;
    if (Math.abs(b.point.x - p0.x) < 1e-12 || Math.abs(b.point.y - p0.y) < 1e-12) {
      ctx.print('경계의 폭과 높이가 0보다 커야 합니다.', 'err');
      return null;
    }
    return { pts: [p0, b.point], inverted };
  }
}

const isImage = (e: Entity | undefined): e is ImageEntity => e?.type === 'IMAGE';
const isUnderlay = (e: Entity | undefined): e is UnderlayEntity => e?.type === 'PDFUNDERLAY' || e?.type === 'DWFUNDERLAY' || e?.type === 'DGNUNDERLAY';

async function clipCommand(app: App, ctx: CommandContext, kind: 'image' | 'underlay', arg?: string): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  const ok = (e: Entity | undefined): e is Clippable => (kind === 'image' ? isImage(e) : isUnderlay(e));
  let target: Clippable | undefined;
  const pre = arg ? doc.entityIndex.get(arg) : undefined;
  if (ok(pre)) target = pre;
  else {
    const r = await ctx.getEntity(kind === 'image' ? '자를 이미지 선택:' : '자를 PDF 언더레이 선택:');
    if (!('handle' in r)) return;
    const e = doc.entityIndex.get(r.handle);
    if (!ok(e)) {
      ctx.print(kind === 'image' ? '래스터 이미지가 아닙니다.' : 'PDF 언더레이가 아닙니다.', 'err');
      return;
    }
    target = e;
  }
  if (!unlockedOnly(app, [target.handle]).length) return;
  const has = kind === 'image' ? (target as ImageEntity).clipping || (target as ImageEntity).clipBoundary.length > 2 : (target as UnderlayEntity).clipBoundary.length >= 2;
  const r = await ctx.getPoint('자르기 옵션 입력 [켜기(ON)/끄기(OFF)/삭제(D)/새 경계(N)] <새 경계>:', {
    keywords: [
      { key: 'ON', label: '켜기' },
      { key: 'OFF', label: '끄기' },
      { key: 'D', label: '삭제' },
      { key: 'N', label: '새 경계' },
    ],
  });
  if (!('keyword' in r) && !('enter' in r)) return;
  const k = 'keyword' in r ? r.keyword : 'N';
  const label = kind === 'image' ? 'IMAGECLIP' : 'PDFCLIP';
  let after: Clippable | null = null;
  if (k === 'ON' || k === 'OFF') {
    if (!has) {
      ctx.print('자르기 경계가 없습니다.', 'err');
      return;
    }
    if (kind === 'image') after = { ...(target as ImageEntity), clipping: k === 'ON' };
    else after = { ...(target as UnderlayEntity), flags: k === 'ON' ? (target as UnderlayEntity).flags | 1 : (target as UnderlayEntity).flags & ~1 };
  } else if (k === 'D') {
    after = kind === 'image' ? imageWithoutClip(target as ImageEntity) : underlayWithoutClip(target as UnderlayEntity);
  } else {
    if (has) {
      const y = await ctx.getPoint('이전 경계를 삭제하시겠습니까? [예(Y)/아니오(N)] <예>:', {
        keywords: [
          { key: 'Y', label: '예' },
          { key: 'N', label: '아니오' },
        ],
      });
      if ('keyword' in y && y.keyword === 'N') return;
      if (!('keyword' in y) && !('enter' in y)) return;
    }
    const inv0 = kind === 'image' ? !!(target as ImageEntity).clipInverted : ((target as UnderlayEntity).flags & 16) !== 0;
    const b = await askBoundary(ctx, inv0);
    if (!b) return;
    after = kind === 'image' ? imageWithClip(target as ImageEntity, b.pts, b.inverted) : underlayWithClip(target as UnderlayEntity, b.pts, b.inverted);
    if (!after) {
      ctx.print('경계를 이 객체의 좌표로 바꿀 수 없습니다.', 'err');
      return;
    }
  }
  commitChanged(app, ctx, [after as Entity], label);
}

export function registerImageClipCommands(app: App): void {
  app.register({ name: 'IMAGECLIP', aliases: ['ICL'], title: '이미지 자르기', run: (ctx, arg) => clipCommand(app, ctx, 'image', arg) });
  app.register({ name: 'PDFCLIP', title: 'PDF 언더레이 자르기', run: (ctx, arg) => clipCommand(app, ctx, 'underlay', arg) });
  app.register({
    name: 'CLIP',
    title: '자르기',
    async run(ctx) {
      const st = app.active!;
      const r = await ctx.getEntity('자를 객체 선택:');
      if (!('handle' in r)) return;
      const e = st.doc.entityIndex.get(r.handle);
      if (isImage(e)) return clipCommand(app, ctx, 'image', e.handle);
      if (isUnderlay(e)) return clipCommand(app, ctx, 'underlay', e.handle);
      if (e?.type === 'INSERT' || e?.type === 'VIEWPORT') {
        // 블록·외부 참조는 XCLIP, 배치 뷰포트는 VPCLIP(그 명령이 고른 객체를 쓴다)
        app.setSelection([e.handle], 'replace');
        await app.run(e.type === 'INSERT' ? 'XCLIP' : 'VPCLIP');
        return;
      }
      ctx.print('자를 수 있는 객체(블록·외부 참조, 이미지, 언더레이, 뷰포트)가 아닙니다.', 'err');
    },
  });
}
