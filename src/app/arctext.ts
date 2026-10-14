/**
 * 원호 정렬 문자: ARCTEXT(Express Tools 문자 › 원호 정렬 문자).
 * `호 또는 원호 정렬 문자 선택:`(먼저 고른 객체도) → "원호 정렬 문자 작업장 - 작성/수정" 대화상자(열어 둔 동안 도면에 미리보기).
 * 호를 고르면 만들고, 원호 정렬 문자를 고르면 고친다. 명령 취소 한 단계.
 *
 * 연관: installArcTextHooks가 편집 세션의 commit을 감싸, 호가 바뀌는 모든 편집(이동·회전·축척·그립·TRIM·LENGTHEN…)에서
 * 그 호를 따르는 문자를 같은 트랜잭션 안에서 다시 놓는다(src/edit/textools/arctext.ts followArcTexts).
 */
import type { ArcEntity, ArcTextEntity, CadColor, Entity } from '../core/model';
import { tableKey } from '../core/model';
import { ARC_ALIGN, ARC_DIRECTION, ARC_POSITION, arcTextError, arcTextParts } from '../text/arctext';
import { followArcTextsOnCommit, newArcText } from '../edit/textools/arctext';
import type { App, CommandContext } from './app';
import type { DocState } from './docstate';
import { addEntities, currentProps } from './draw';
import { colorText } from './inquiry';
import { unlockedOnly } from './layers';
import { pickColor } from './ui/colorpick';
import { dialog, h } from './ui/dom';

// ---------------------------------------------------------------------------
// 연관(호 따라가기)
// ---------------------------------------------------------------------------

function hookSession(st: DocState): void {
  if (st.session) followArcTextsOnCommit(st.session);
}

/** 편집 세션 고리를 단다(문서를 열 때마다, 이미 연 문서에도) */
export function installArcTextHooks(app: App): void {
  const ed = app.edits as typeof app.edits & { __arcTextHooked?: boolean };
  if (!ed.__arcTextHooked) {
    ed.__arcTextHooked = true;
    const attach = ed.attach.bind(ed);
    ed.attach = (st: DocState) => {
      attach(st);
      hookSession(st);
    };
  }
  for (const st of app.docs) hookSession(st);
}

// ---------------------------------------------------------------------------
// 원호 정렬 문자 작업장
// ---------------------------------------------------------------------------

type Field = HTMLInputElement | HTMLSelectElement;

/** 작업장 대화상자. 확인하면 정의(base의 원호·특성 + 입력 값), 취소하면 null */
function workshop(app: App, title: string, base: ArcTextEntity): Promise<ArcTextEntity | null> {
  const st = app.active!;
  return new Promise((resolve) => {
    let done = false;
    let color: CadColor = { ...base.color };
    const styles = [...st.doc.textStyles.values()].filter((s) => s.name && !(s.flags & 1)).sort((a, b) => a.name.localeCompare(b.name));
    const styleName = st.doc.textStyles.get(tableKey(base.style))?.name ?? base.style;
    if (!styles.some((s) => s.name === styleName)) styles.unshift({ ...styles[0]!, name: styleName });
    const fields = new Map<string, Field>();
    const text = (key: string, value: string | number, numeric = false): HTMLInputElement => {
      const el = h('input', { type: 'text', inputmode: numeric ? 'decimal' : undefined }) as HTMLInputElement;
      el.value = String(value);
      fields.set(key, el);
      return el;
    };
    const select = (key: string, value: string | number, options: [string | number, string][]): HTMLSelectElement => {
      const el = h('select', {}, ...options.map(([v, l]) => h('option', { value: String(v) }, l))) as HTMLSelectElement;
      el.value = String(value);
      fields.set(key, el);
      return el;
    };
    const check = (key: string, value: boolean): HTMLInputElement => {
      const el = h('input', { type: 'checkbox' }) as HTMLInputElement;
      el.checked = value;
      fields.set(key, el);
      return el;
    };
    const row = (label: string, el: HTMLElement, cls = '') => {
      el.setAttribute('aria-label', label);
      return h('label', { class: `form-row ${cls}` }, h('span', {}, label), el);
    };
    const colorBtn = h('button', { class: 'btn', type: 'button' }, colorText(color)) as HTMLButtonElement;
    colorBtn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      const c = await pickColor(color, { allowBy: true });
      if (c) {
        color = c;
        colorBtn.textContent = colorText(c);
        update();
      }
    });
    const textEl = text('text', base.text);
    textEl.style.width = '100%';
    textEl.setAttribute('aria-label', '문자');
    const err = h('div', { class: 'form-error', role: 'alert' });
    const left = h(
      'div',
      { class: 'form' },
      row('텍스트 스타일', select('style', styleName, styles.map((s) => [s.name, s.name]))),
      row('정렬', select('alignment', base.alignment, [[ARC_ALIGN.fit, '맞춤'], [ARC_ALIGN.left, '왼쪽'], [ARC_ALIGN.right, '오른쪽'], [ARC_ALIGN.center, '중심']])),
      row('위치', select('position', base.position, [[ARC_POSITION.convex, '볼록(호 바깥)'], [ARC_POSITION.concave, '오목(호 안)']])),
      row('방향', select('direction', base.direction, [[ARC_DIRECTION.outward, '바깥쪽'], [ARC_DIRECTION.inward, '안쪽']])),
      row('문자 반전', check('reversed', base.reversed), 'check'),
      row('굵게', check('bold', base.bold), 'check'),
      row('기울임꼴', check('italic', base.italic), 'check'),
      row('밑줄', check('underline', base.underline), 'check'),
      row('색상', colorBtn),
    );
    const right = h(
      'div',
      { class: 'form' },
      row('문자 높이', text('height', base.height, true)),
      row('폭 비율', text('widthFactor', base.widthFactor, true)),
      row('문자 간격', text('charSpacing', base.charSpacing, true)),
      row('호에서 간격띄우기', text('offset', base.offset, true)),
      row('왼쪽에서 간격띄우기', text('leftOffset', base.leftOffset, true)),
      row('오른쪽에서 간격띄우기', text('rightOffset', base.rightOffset, true)),
    );
    const grid = h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:4px 18px' }, left, right);
    const body = h('div', {}, h('label', { class: 'form-row', style: 'grid-template-columns:60px 1fr' }, h('span', {}, '문자'), textEl), grid, h('div', { class: 'form-note' }, '열어 둔 동안 도면에 미리보기가 보입니다. 굵게는 화면에 따로 그리지 않습니다.'), err);
    const read = (): ArcTextEntity | string => {
      const n = (k: string) => Number((fields.get(k) as HTMLInputElement).value.trim());
      const out: ArcTextEntity = {
        ...base,
        color: { ...color },
        text: (fields.get('text') as HTMLInputElement).value,
        style: fields.get('style')!.value,
        alignment: Number(fields.get('alignment')!.value),
        position: Number(fields.get('position')!.value),
        direction: Number(fields.get('direction')!.value),
        reversed: (fields.get('reversed') as HTMLInputElement).checked,
        bold: (fields.get('bold') as HTMLInputElement).checked,
        italic: (fields.get('italic') as HTMLInputElement).checked,
        underline: (fields.get('underline') as HTMLInputElement).checked,
        height: n('height'),
        widthFactor: n('widthFactor'),
        charSpacing: n('charSpacing'),
        offset: n('offset'),
        leftOffset: n('leftOffset'),
        rightOffset: n('rightOffset'),
      };
      for (const [k, label] of [
        ['height', '문자 높이'],
        ['widthFactor', '폭 비율'],
        ['charSpacing', '문자 간격'],
        ['offset', '호에서 간격띄우기'],
        ['leftOffset', '왼쪽에서 간격띄우기'],
        ['rightOffset', '오른쪽에서 간격띄우기'],
      ] as const)
        if (!Number.isFinite(out[k])) return `${label}: 숫자를 입력하십시오.`;
      return arcTextError(out) ?? out;
    };
    const showGhost = (ents: Entity[]) => {
      const pk = app.picker();
      app.view.overlay.ghost = pk && ents.length ? [pk.geometryOf(ents)] : [];
      app.view.requestOverlay();
    };
    function update(): void {
      const v = read();
      if (typeof v === 'string') {
        // 문자를 아직 입력하지 않았으면 알리지 않는다
        err.textContent = (fields.get('text') as HTMLInputElement).value.trim() ? v : '';
        showGhost([]);
        return;
      }
      err.textContent = '';
      showGhost(arcTextParts(v));
    }
    const submit = (): boolean => {
      const v = read();
      if (typeof v === 'string') {
        err.textContent = v;
        return true;
      }
      done = true;
      resolve(v);
      return false;
    };
    const back = dialog(title, body, [
      { label: '취소', run: () => undefined },
      { label: '확인', primary: true, run: () => submit() },
    ]);
    // 도면이 보이게: 어두운 막을 옅게, 대화상자를 오른쪽 위로
    back.style.background = 'rgba(10, 13, 18, 0.12)';
    back.style.justifyContent = 'flex-end';
    back.style.alignItems = 'flex-start';
    const box = back.querySelector('.dialog') as HTMLElement | null;
    if (box) box.style.width = 'min(640px, 100%)';
    for (const el of fields.values()) {
      el.addEventListener('input', update);
      el.addEventListener('change', update);
      el.addEventListener('keydown', (ev) => {
        const k = ev as KeyboardEvent;
        k.stopPropagation();
        if (k.key === 'Escape') back.remove();
        else if (k.key === 'Enter' && submit() === false) back.remove();
      });
    }
    const obs = new MutationObserver(() => {
      if (!back.isConnected) {
        obs.disconnect();
        app.view.overlay.ghost = [];
        app.view.requestOverlay();
        if (!done) resolve(null);
      }
    });
    obs.observe(document.body, { childList: true });
    update();
    setTimeout(() => {
      textEl.focus();
      textEl.select();
    });
  });
}

/** 새 원호 정렬 문자의 기본값: 현재 문자 스타일(TEXTSTYLE), 높이 = 스타일 고정 높이 또는 TEXTSIZE */
function creationBase(app: App, arc: ArcEntity): ArcTextEntity {
  const d = app.active!.doc;
  const styleName = String(d.header.get('$TEXTSTYLE') ?? 'Standard');
  const style = d.textStyles.get(tableKey(styleName));
  const height = style?.height && style.height > 0 ? style.height : Number(d.header.get('$TEXTSIZE') ?? 2.5) || 2.5;
  const props = currentProps(app);
  return newArcText(arc, { text: '', style: style?.name ?? styleName, height, widthFactor: style?.widthFactor && style.widthFactor > 0 ? style.widthFactor : 1 }, props);
}

async function pickTarget(app: App, ctx: CommandContext): Promise<Entity | null> {
  const st = app.active!;
  const pre = [...st.selection].map((hd) => st.doc.entityIndex.get(hd));
  if (pre.length === 1 && (pre[0]?.type === 'ARC' || pre[0]?.type === 'ARCALIGNEDTEXT')) return pre[0];
  for (;;) {
    const r = await ctx.getEntity('호 또는 원호 정렬 문자 선택:');
    if (!('handle' in r)) return null;
    const e = st.doc.entityIndex.get(r.handle);
    if (e?.type === 'ARC' || e?.type === 'ARCALIGNEDTEXT') return e;
    if (e?.type === 'UNKNOWN' && e.originalType === 'ARCALIGNEDTEXT') ctx.print('이 원호 정렬 문자는 DWG 파일에서 정의를 읽을 수 없어 편집할 수 없습니다(그림만 보입니다).', 'err');
    else ctx.print('호 또는 원호 정렬 문자가 아닙니다.', 'err');
  }
}

export function registerArcTextCommands(app: App): void {
  installArcTextHooks(app);
  app.register({
    name: 'ARCTEXT',
    title: '원호 정렬 문자',
    async run(ctx) {
      const st = app.active!;
      const target = await pickTarget(app, ctx);
      if (!target) return;
      if (!unlockedOnly(app, [target.handle]).length) return;
      if (target.type === 'ARC') {
        const def = await workshop(app, '원호 정렬 문자 작업장 - 작성', creationBase(app, target));
        if (!def) return;
        addEntities(app, ctx, [{ ...def, handle: '' }], 'ARCTEXT');
        ctx.print('원호 정렬 문자를 만들었습니다.');
        return;
      }
      if (target.type !== 'ARCALIGNEDTEXT') return;
      const def = await workshop(app, '원호 정렬 문자 작업장 - 수정', target);
      if (!def) return;
      const block = st.session.ownerOf(target.handle);
      if (!block) return;
      st.session.commit({ label: 'ARCTEXT', ops: [{ kind: 'modify', block, before: target, after: def }], group: ctx.group });
    },
  });
}
