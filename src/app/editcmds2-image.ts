/**
 * 래스터 이미지·PDF 언더레이 조정 명령(AutoCAD 2026 한국어판 프롬프트):
 * - IMAGEADJUST(IAD): 고른 이미지의 밝기·대비·흐리기 대화상자. -IMAGEADJUST: 명령행.
 * - IMAGEQUALITY: 이미지 품질 [높음(H)/초안(D)] — 도면(RASTERVARIABLES)에 저장한다. 이 뷰어의 화면은 늘 높음으로 그린다.
 * - TRANSPARENCY: 고른 이미지의 바탕 화소 투명 [켜기(ON)/끄기(OFF)](이미지 표시 플래그 8).
 * - PDFADJUST: PDF 언더레이의 흐리기·대비·단색.
 * - PDFLAYERS: PDF 언더레이의 PDF 도면층(선택 내용 그룹) 켜기·끄기 대화상자. pdf.js로 그 페이지를 다시 그린다.
 *   상태는 PDF 페이지마다(같은 페이지를 쓰는 언더레이는 함께) 이 세션에만 둔다.
 */
import type { Entity, ImageEntity, UnderlayDefObject, UnderlayEntity } from '../core/model';
import { type UnderlayAdjust, adjustImage, adjustUnderlay, imageAdjustOf, imageQuality, imageQualityOps, imageValueProblem, underlayAdjustOf, underlayFadeProblem } from '../edit/editcmds2/imagevars';
import type { EditOp } from '../edit/session';
import { pdfPageNumber, pdfUnderlayKey } from '../render/build';
import type { App, CommandContext, Keyword } from './app';
import { askOption, askReal, askYN } from './dashcmds-ask';
import { unlockedOnly } from './layers';
import { pdfFileBytes, refHooks, replacePdfRaster } from './refs';
import { dialog, form, h } from './ui/dom';

const isImage = (e: Entity | undefined): e is ImageEntity => e?.type === 'IMAGE';
const isPdf = (e: Entity | undefined): e is UnderlayEntity => e?.type === 'PDFUNDERLAY';

/** 고른 객체 중 조건에 맞는 것(잠긴 도면층은 뺀다) */
async function selectOf<T extends Entity>(app: App, ctx: CommandContext, prompt: string, ok: (e: Entity | undefined) => e is T, none: string): Promise<T[]> {
  const st = app.active!;
  const hs = unlockedOnly(app, await ctx.getSelection(prompt));
  const list = hs.map((x) => st.doc.entityIndex.get(x)).filter(ok);
  if (hs.length && !list.length) ctx.print(none, 'err');
  return list;
}

/** 바뀐 객체들을 한 번에 확정 */
function commitModified(app: App, ctx: CommandContext, pairs: [Entity, Entity][], label: string): number {
  const st = app.active!;
  const ops: EditOp[] = [];
  for (const [before, after] of pairs) {
    const block = st.session.ownerOf(before.handle);
    if (block) ops.push({ kind: 'modify', block, before, after });
  }
  if (ops.length) st.session.commit({ label, ops, group: ctx.group, rebuildNow: true });
  return ops.length;
}

// ---------------------------------------------------------------------------
// PDF 도면층 상태(열쇠 'pdf:파일#쪽' → 끈 도면층 식별자)
// ---------------------------------------------------------------------------

const hiddenLayers = new Map<string, Set<string>>();

/** PDF 언더레이가 쓰는 파일 열쇠·페이지 */
function pdfSource(app: App, e: UnderlayEntity): { key: string; file: string; page: number } | null {
  const doc = app.active!.doc;
  const key = pdfUnderlayKey(doc, e);
  const d = e.definition ? (doc.objects.get(e.definition) as UnderlayDefObject | undefined) : undefined;
  if (!key || !d) return null;
  return { key, file: d.fileName.replace(/^.*[\\/]/, '').toLowerCase(), page: pdfPageNumber(d.name) };
}

/** PDF 도면층 대화상자: 체크한 것이 켜짐. 취소면 null */
function pdfLayersDialog(title: string, layers: { id: string; name: string }[], hidden: ReadonlySet<string>): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    let done = false;
    const boxes = layers.map((l) => {
      const c = h('input', { type: 'checkbox', 'aria-label': l.name }) as HTMLInputElement;
      c.checked = !hidden.has(l.id);
      return { l, c };
    });
    const all = (on: boolean) => {
      for (const b of boxes) b.c.checked = on;
    };
    const list = h(
      'div',
      { style: 'max-height:50vh;overflow:auto;display:flex;flex-direction:column;gap:4px;min-width:260px' },
      ...boxes.map((b) => h('label', { class: 'form-row check', style: 'display:flex;gap:8px;align-items:center' }, b.c, h('span', {}, b.l.name))),
    );
    const tools = h(
      'div',
      { style: 'display:flex;gap:6px;margin-bottom:8px' },
      h('button', { class: 'btn', onclick: () => all(true) }, '모두 켜기'),
      h('button', { class: 'btn', onclick: () => all(false) }, '모두 끄기'),
    );
    const back = dialog(title, h('div', {}, tools, list), [
      {
        label: '확인',
        primary: true,
        run: () => {
          done = true;
          resolve(new Set(boxes.filter((b) => !b.c.checked).map((b) => b.l.id)));
        },
      },
      { label: '취소' },
    ]);
    const obs = new MutationObserver(() => {
      if (!back.isConnected) {
        obs.disconnect();
        if (!done) resolve(null);
      }
    });
    obs.observe(document.body, { childList: true });
  });
}

export function registerEditCmds2Image(app: App): void {
  // PDF를 (다시) 연결해 그릴 때도 끈 도면층을 지킨다
  refHooks.pdfHiddenLayers = (key) => hiddenLayers.get(key);

  // ------------------------------------------------------------- IMAGEADJUST
  app.register({
    name: 'IMAGEADJUST',
    aliases: ['IAD'],
    title: '이미지 조정',
    async run(ctx) {
      const list = await selectOf(app, ctx, '이미지 선택:', isImage, '래스터 이미지가 아닙니다.');
      app.clearSelection();
      if (!list.length) return;
      const cur = imageAdjustOf(list[0]!);
      const v = await form(
        '이미지 조정',
        [
          { key: 'brightness', label: '밝기(0-100)', type: 'number', value: cur.brightness },
          { key: 'contrast', label: '대비(0-100)', type: 'number', value: cur.contrast },
          { key: 'fade', label: '흐리기(0-100)', type: 'number', value: cur.fade },
        ],
        {
          ok: '확인',
          note: list.length > 1 ? `이미지 ${list.length}개에 적용합니다.` : undefined,
          validate: (x) => imageValueProblem(Number(x.brightness)) ?? imageValueProblem(Number(x.contrast)) ?? imageValueProblem(Number(x.fade)),
        },
      );
      if (!v) return;
      const patch = { brightness: Number(v.brightness), contrast: Number(v.contrast), fade: Number(v.fade) };
      const pairs: [Entity, Entity][] = [];
      for (const e of list) {
        const n = adjustImage(e, patch);
        if (n) pairs.push([e, n]);
      }
      commitModified(app, ctx, pairs, 'IMAGEADJUST');
    },
  });

  app.register({
    name: '-IMAGEADJUST',
    title: '이미지 조정(명령행)',
    async run(ctx) {
      const list = await selectOf(app, ctx, '이미지 선택:', isImage, '래스터 이미지가 아닙니다.');
      app.clearSelection();
      if (!list.length) return;
      const kws: Keyword[] = [
        { key: 'C', label: '대비' },
        { key: 'F', label: '흐리기' },
        { key: 'B', label: '밝기' },
      ];
      const k = await askOption(ctx, '이미지 옵션 입력 [대비(C)/흐리기(F)/밝기(B)] <밝기>:', kws, 'B');
      if (!k) return;
      const cur = imageAdjustOf(list[0]!);
      const what = k === 'C' ? '대비' : k === 'F' ? '흐리기' : '밝기';
      const def = k === 'C' ? cur.contrast : k === 'F' ? cur.fade : cur.brightness;
      const v = await askReal(ctx, `${what} 값 입력 (0-100) <${def}>:`, def, imageValueProblem);
      const patch = k === 'C' ? { contrast: v } : k === 'F' ? { fade: v } : { brightness: v };
      const pairs: [Entity, Entity][] = [];
      for (const e of list) {
        const n = adjustImage(e, patch);
        if (n) pairs.push([e, n]);
      }
      commitModified(app, ctx, pairs, 'IMAGEADJUST');
    },
  });

  // ------------------------------------------------------------- IMAGEQUALITY
  app.register({
    name: 'IMAGEQUALITY',
    title: '이미지 품질',
    async run(ctx) {
      const st = app.active!;
      const cur = imageQuality(st.doc);
      const k = await askOption(
        ctx,
        `이미지 품질 설정 입력 [높음(H)/초안(D)] <${cur ? '높음' : '초안'}>:`,
        [
          { key: 'H', label: '높음' },
          { key: 'D', label: '초안' },
        ],
        cur ? 'H' : 'D',
      );
      if (!k) return;
      const ops = imageQualityOps(st.doc, k === 'D' ? 0 : 1, () => st.session.newHandle());
      if (ops === null) {
        ctx.print('이 도면에는 이름 있는 객체 사전이 없어 이미지 품질을 저장할 수 없습니다(R12 형식 등).', 'err');
        return;
      }
      if (ops.length) st.session.commit({ label: 'IMAGEQUALITY', ops, group: ctx.group });
      if (k === 'D') ctx.print('참고: 이 프로그램은 화면에 이미지를 늘 높은 품질로 그립니다. 설정은 도면에 저장됩니다.');
    },
  });

  // ------------------------------------------------------------- TRANSPARENCY(이미지 바탕 투명)
  app.register({
    name: 'TRANSPARENCY',
    title: '이미지 투명도',
    async run(ctx) {
      const list = await selectOf(app, ctx, '이미지 선택:', isImage, '래스터 이미지가 아닙니다.');
      app.clearSelection();
      if (!list.length) return;
      const on = (list[0]!.displayFlags & 8) !== 0;
      const k = await askOption(
        ctx,
        `투명 모드 입력 [켜기(ON)/끄기(OFF)] <${on ? '켜기' : '끄기'}>:`,
        [
          { key: 'ON', label: '켜기' },
          { key: 'OFF', label: '끄기' },
        ],
        on ? 'ON' : 'OFF',
      );
      if (!k) return;
      const pairs: [Entity, Entity][] = [];
      for (const e of list) {
        const flags = k === 'ON' ? e.displayFlags | 8 : e.displayFlags & ~8;
        if (flags !== e.displayFlags) pairs.push([e, { ...e, displayFlags: flags }]);
      }
      commitModified(app, ctx, pairs, 'TRANSPARENCY');
    },
  });

  // ------------------------------------------------------------- PDFADJUST
  app.register({
    name: 'PDFADJUST',
    title: 'PDF 언더레이 조정',
    async run(ctx) {
      const list = await selectOf(app, ctx, 'PDF 언더레이 선택:', isPdf, 'PDF 언더레이가 아닙니다.');
      app.clearSelection();
      if (!list.length) return;
      const cur = underlayAdjustOf(list[0]!);
      const k = await askOption(
        ctx,
        'PDF 언더레이 옵션 입력 [흐리기(F)/대비(C)/단색(M)] <흐리기>:',
        [
          { key: 'F', label: '흐리기' },
          { key: 'C', label: '대비' },
          { key: 'M', label: '단색' },
        ],
        'F',
      );
      if (!k) return;
      let patch: Partial<UnderlayAdjust>;
      if (k === 'F') patch = { fade: await askReal(ctx, `흐리기 값 입력 (0-80) <${cur.fade}>:`, cur.fade, underlayFadeProblem) };
      else if (k === 'C') patch = { contrast: await askReal(ctx, `대비 값 입력 (0-100) <${cur.contrast}>:`, cur.contrast, imageValueProblem) };
      else patch = { monochrome: await askYN(ctx, '단색?', cur.monochrome) };
      const pairs: [Entity, Entity][] = [];
      for (const e of list) {
        const n = adjustUnderlay(e, patch);
        if (n) pairs.push([e, n]);
      }
      commitModified(app, ctx, pairs, 'PDFADJUST');
    },
  });

  // ------------------------------------------------------------- PDFLAYERS
  app.register({
    name: 'PDFLAYERS',
    title: 'PDF 언더레이 도면층',
    async run(ctx) {
      const st = app.active!;
      let target: UnderlayEntity | undefined;
      const pre = [...st.selection].map((x) => st.doc.entityIndex.get(x)).filter(isPdf);
      if (pre.length === 1) target = pre[0];
      else {
        for (;;) {
          const r = await ctx.getEntity('PDF 언더레이 선택:');
          if (!('handle' in r)) return;
          const e = st.doc.entityIndex.get(r.handle);
          if (isPdf(e)) {
            target = e;
            break;
          }
          ctx.print('PDF 언더레이가 아닙니다.', 'err');
        }
      }
      app.clearSelection();
      const src = target ? pdfSource(app, target) : null;
      if (!src) {
        ctx.print('PDF 언더레이의 정의를 찾을 수 없습니다.', 'err');
        return;
      }
      const bytes = pdfFileBytes(src.file);
      if (!bytes) {
        ctx.print(`PDF 파일(${src.file})이 연결되지 않았습니다. EXTERNALREFERENCES(XR)에서 파일을 연결하십시오.`, 'err');
        return;
      }
      const r = await import('./pdfraster');
      let opened;
      try {
        opened = await r.openPdf(bytes);
      } catch (e) {
        ctx.print(`PDF를 열지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, 'err');
        return;
      }
      try {
        const layers = await r.pdfLayers(opened.pdf);
        if (!layers.length) {
          ctx.print('이 PDF에는 도면층이 없습니다.');
          return;
        }
        const hidden = hiddenLayers.get(src.key) ?? new Set(layers.filter((l) => !l.visible).map((l) => l.id));
        const next = await pdfLayersDialog(`PDF 언더레이 도면층 — ${src.file}${src.page > 1 ? ` (${src.page}쪽)` : ''}`, layers, hidden);
        if (!next) return;
        hiddenLayers.set(src.key, next);
        app.ui.setBusy('PDF 페이지 그리는 중…', 0.5);
        try {
          const gl = app.view.renderer.gl;
          const max = Math.min(4096, (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) || 4096);
          const page = await r.rasterPage(opened.pdf, src.page, max, next);
          if (page) replacePdfRaster(app, src.key, page.bitmap);
        } finally {
          app.ui.setBusy(null);
        }
        const off = layers.filter((l) => next.has(l.id)).length;
        ctx.print(`PDF 도면층 ${layers.length}개 중 ${layers.length - off}개를 켜고 ${off}개를 껐습니다.`);
      } finally {
        void opened.close();
      }
    },
  });
}
