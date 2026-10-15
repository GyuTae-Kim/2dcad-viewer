/**
 * 동적 블록 참조 명령: DYNPROPS(대화상자), -DYNPROPS(명령행), RESETBLOCK(블록 재설정).
 * 그립·특성 팔레트에 붙이는 도우미(dynGripsOf, dynGripEdit, dynPaletteGroup)도 여기서 낸다.
 *
 * 값을 바꾸면 참조가 새 익명 표현 블록(*U…)을 가리키고 참조 캐시가 바뀐다(명령 취소 한 단계).
 */
import type { InsertEntity } from '../core/model';
import { formatAngle, formatLength, parseAngle, parseLength } from '../core/units';
import {
  type DynChange,
  type DynEditResult,
  type DynGrip,
  type DynProperty,
  MSG_SAME,
  MSG_UNSUPPORTED,
  applyDynGrip,
  definitionName,
  dynGrips,
  dynProperties,
  dynResetOps,
  dynSetOps,
  isDynamicReference,
  previewDynGrip,
  readReference,
} from '../edit/dynblock';
import type { App, CommandContext, Keyword } from './app';
import { unlockedOnly } from './layers';
import { form, h, showMenu } from './ui/dom';
import type { OverlayGeom, Pt } from './view';

// ---------------------------------------------------------------------------
// 공통
// ---------------------------------------------------------------------------

function insertOf(app: App, handle: string): InsertEntity | null {
  const e = app.active?.doc.entityIndex.get(handle);
  return e && isDynamicReference(app.active!.doc, e) ? e : null;
}

/** 결과를 세션에 넣는다(메시지 출력). 바뀌었으면 참 */
function commitResult(app: App, label: string, r: DynEditResult, ctx?: CommandContext | null): boolean {
  const out = ctx ?? app.cmd;
  if (!r.ops.length) {
    if (r.message) out.print(r.message, r.message === MSG_SAME ? undefined : 'err');
    return false;
  }
  if (r.message) out.print(r.message);
  app.active!.session.commit({ label, ops: r.ops, group: ctx?.group });
  app.refreshSelectionOverlay();
  app.ui?.refreshPalette();
  return true;
}

/** 특성 값 표시 */
function show(app: App, p: DynProperty): string {
  const u = app.active!.units;
  if (p.editor === 'select' && p.options) {
    const v = typeof p.value === 'boolean' ? (p.value ? '1' : '0') : String(p.value);
    return p.options.find((o) => o.value === v)?.label ?? (typeof p.value === 'number' ? formatLength(p.value, u) : v);
  }
  if (p.editor === 'angle' || p.kind === 'rotation') return formatAngle(p.value as number, u);
  if (typeof p.value === 'number') return formatLength(p.value, u);
  if (typeof p.value === 'boolean') return p.value ? '예' : '아니오';
  if (typeof p.value === 'object') return `${formatLength(p.value.x, u)}, ${formatLength(p.value.y, u)}`;
  return p.value || '(없음)';
}

/** 고른 값 문자열 → 바꿀 값 */
function changeOf(app: App, p: DynProperty, input: string): DynChange | { error: string } {
  const t = input.trim();
  switch (p.kind) {
    case 'flip':
      return { key: p.key, value: t === '1' || t === p.options?.[1]?.label };
    case 'visibility':
    case 'lookup': {
      const o = p.options?.find((x) => x.value === t) ?? p.options?.find((x) => x.label.toUpperCase() === t.toUpperCase());
      return o ? { key: p.key, value: o.value } : { error: `"${t}"은(는) 목록에 없습니다.` };
    }
    case 'rotation': {
      const a = parseAngle(t, app.active!.units.aunits);
      return a === null ? { error: '각도가 올바르지 않습니다.' } : { key: p.key, value: a };
    }
    default: {
      if (p.editor === 'angle') {
        const a = parseAngle(t, app.active!.units.aunits);
        return a === null ? { error: '각도가 올바르지 않습니다.' } : { key: p.key, value: a };
      }
      if (p.editor === 'coord') {
        const v = parseLength(t);
        return v === null ? { error: '좌표가 올바르지 않습니다.' } : { key: p.key, value: v };
      }
      const v = parseLength(t);
      if (v === null || !(v > 0)) return { error: '0보다 큰 거리를 입력하십시오.' };
      return { key: p.key, value: v };
    }
  }
}

/** 특성 하나를 바꾼다(명령 밖에서도 — 특성 팔레트·그립 메뉴). 바뀌었으면 참 */
export function setDynProperty(app: App, handle: string, key: string, input: string, ctx?: CommandContext | null): boolean {
  const st = app.active;
  const ins = insertOf(app, handle);
  if (!st || !ins) return false;
  if (!unlockedOnly(app, [handle]).length) return false;
  const p = dynProperties(st.doc, ins)?.find((x) => x.key === key);
  if (!p) return false;
  const c = changeOf(app, p, input);
  if ('error' in c) {
    (ctx ?? app.cmd).print(`${p.label}: ${c.error}`, 'err');
    return false;
  }
  return commitResult(app, 'DYNPROPS', dynSetOps(st.doc, ins, c, () => st.session.newHandle()), ctx);
}

/** 고른 객체나 새로 고른 동적 블록 참조 */
async function pickReference(app: App, ctx: CommandContext, prompt = '동적 블록 참조 선택:'): Promise<InsertEntity | null> {
  const st = app.active!;
  const pre = [...st.selection].map((x) => st.doc.entityIndex.get(x)).filter((e): e is InsertEntity => isDynamicReference(st.doc, e));
  if (pre.length === 1 && st.selection.size === 1) return unlockedOnly(app, [pre[0]!.handle]).length ? pre[0]! : null;
  for (;;) {
    const r = await ctx.getEntity(prompt);
    if (!('handle' in r)) return null;
    const e = st.doc.entityIndex.get(r.handle);
    if (!isDynamicReference(st.doc, e)) {
      ctx.print('동적 블록 참조가 아닙니다.', 'err');
      continue;
    }
    if (!unlockedOnly(app, [e.handle]).length) return null;
    return e;
  }
}

/** 정의를 해석하지 못했으면 안내하고 참 */
function undecoded(app: App, ctx: CommandContext, ins: InsertEntity): boolean {
  const def = readReference(app.active!.doc, ins)?.def;
  if (!def?.undecoded.length) return false;
  ctx.print(`이 동적 블록 정의는 읽을 수 없는 자료(${[...new Set(def.undecoded)].join(', ')})가 있어 고칠 수 없습니다.`, 'err');
  return true;
}

/** 명령행 키워드 이름(대괄호·괄호·빗금은 프롬프트 구문과 겹친다) */
const kwLabel = (s: string) => s.replace(/[[\]()/]/g, ' ').replace(/\s+/g, ' ').trim() || '?';

// ---------------------------------------------------------------------------
// 그립(앱의 그립 목록·GRIPEDIT에 붙인다)
// ---------------------------------------------------------------------------

/** 선택한 객체가 동적 참조면 그 매개변수 그립 */
export function dynGripsOf(app: App, handle: string): DynGrip[] {
  const st = app.active;
  const ins = st ? insertOf(app, handle) : null;
  if (!st || !ins) return [];
  try {
    return dynGrips(st.doc, ins);
  } catch {
    return [];
  }
}

/**
 * 동적 그립을 눌렀을 때: 가시성·조회 → 목록 메뉴, 뒤집기 → 바로 뒤집기, 선형·XY·회전 → "** 신축 **" 끌기(숫자는 거리·각도),
 * 나머지 → "이 매개변수의 동작은 지원되지 않습니다."
 */
export async function dynGripEdit(app: App, ctx: CommandContext, handle: string, gripId: string): Promise<void> {
  const st = app.active!;
  const ins = insertOf(app, handle);
  if (!ins || !unlockedOnly(app, [handle]).length) return;
  const g = dynGrips(st.doc, ins).find((x) => x.id === gripId);
  if (!g) return;
  const nh = () => st.session.newHandle();
  switch (g.mode) {
    case 'none':
      ctx.print(MSG_UNSUPPORTED, 'err');
      return;
    case 'toggle':
      commitResult(app, 'GRIP', applyDynGrip(st.doc, ins, gripId, null, nh), ctx);
      return;
    case 'menu': {
      const p = dynProperties(st.doc, ins)?.find((x) => x.param === g.param);
      if (!p?.options?.length) return;
      const cur = String(p.value);
      const r = app.view.el.getBoundingClientRect();
      const s = app.view.worldToScreen(g.point.x, g.point.y);
      showMenu(r.left + s.x + 8, r.top + s.y + 8, [
        { heading: p.label },
        ...p.options.map((o) => ({ label: `${o.value === cur ? '✓ ' : ' '}${o.label}`, run: () => void setDynProperty(app, handle, p.key, o.value) })),
      ]);
      return;
    }
    case 'drag': {
      const pk = app.picker();
      const ghost = (q: Pt): OverlayGeom[] => {
        const cur = insertOf(app, handle);
        if (!cur || !pk) return [];
        const list = previewDynGrip(st.doc, cur, gripId, q);
        return list.length ? [pk.geometryOf(list)] : [];
      };
      ctx.print('** 신축 **');
      for (;;) {
        const numeric = g.kind === 'linear' || g.kind === 'rotation' || g.kind === 'polar';
        const r = await ctx.getPoint('신축점 지정 또는 [종료(X)]:', { base: g.anchor ?? g.point, keywords: [{ key: 'X', label: '종료' }], ghost, preferNumber: numeric });
        if ('keyword' in r || 'enter' in r) return;
        const cur = insertOf(app, handle);
        if (!cur) return;
        if ('point' in r) {
          commitResult(app, 'GRIP', applyDynGrip(st.doc, cur, gripId, r.point, nh), ctx);
          return;
        }
        if ('text' in r && numeric) {
          const p = dynProperties(st.doc, cur)?.find((x) => x.param === g.param);
          if (!p) return;
          const c = changeOf(app, p, r.text);
          if ('error' in c) {
            ctx.print(c.error, 'err');
            continue;
          }
          commitResult(app, 'GRIP', dynSetOps(st.doc, cur, c, nh), ctx);
          return;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 특성 팔레트("사용자화" 범주)
// ---------------------------------------------------------------------------

/** 고른 동적 참조 하나의 "사용자화" 특성 묶음(특성 팔레트의 prop-group 꼴). 동적 참조가 아니면 null */
export function dynPaletteGroup(app: App, handle: string): HTMLElement | null {
  const st = app.active;
  const ins = st ? insertOf(app, handle) : null;
  if (!st || !ins) return null;
  const props = dynProperties(st.doc, ins);
  if (!props?.length) return null;
  const rows = props.map((p) => {
    const id = `pf-dyn-${p.key}`;
    const title = p.description || p.label;
    if (p.editor === 'readonly') return h('div', { class: 'prop-row', title }, h('span', { class: 'k' }, p.label), h('span', { class: 'v', title: show(app, p) }, show(app, p)));
    let ctl: HTMLElement;
    if (p.editor === 'select' && p.options) {
      const cur = typeof p.value === 'boolean' ? (p.value ? '1' : '0') : String(p.value);
      const opts = [...p.options];
      // 일치하지 않는 조회 이름 등 목록에 없는 지금 값
      if (!opts.some((o) => o.value === cur)) opts.unshift({ value: cur, label: typeof p.value === 'number' ? formatLength(p.value, st.units) : cur || '(없음)' });
      const el = h('select', { 'data-field': id, 'aria-label': p.label }, ...opts.map((o) => h('option', { value: o.value }, o.label)));
      el.value = cur;
      el.addEventListener('change', () => {
        if (el.value !== cur) setDynProperty(app, handle, p.key, el.value);
      });
      ctl = el;
    } else {
      const el = h('input', { 'data-field': id, 'aria-label': p.label }) as HTMLInputElement;
      el.value = p.editor === 'angle' ? formatAngle(p.value as number, st.units) : formatLength(p.value as number, st.units);
      const orig = el.value;
      el.addEventListener('keydown', (ev) => {
        if ((ev as KeyboardEvent).key === 'Enter') el.blur();
        if ((ev as KeyboardEvent).key === 'Escape') {
          el.value = orig;
          el.blur();
        }
      });
      el.addEventListener('change', () => {
        if (el.value.trim() === orig) return;
        if (!setDynProperty(app, handle, p.key, el.value)) el.value = orig;
      });
      ctl = el;
    }
    return h('label', { class: 'prop-row edit', title }, h('span', { class: 'k' }, p.label), ctl);
  });
  return h('div', { class: 'prop-group' }, h('h4', {}, '사용자화'), ...rows);
}

// ---------------------------------------------------------------------------
// 명령
// ---------------------------------------------------------------------------

/** 명령행에서 값 하나 묻기. null = 그대로 */
async function askValue(app: App, ctx: CommandContext, ins: InsertEntity, p: DynProperty): Promise<DynEditResult | null> {
  const st = app.active!;
  const nh = () => st.session.newHandle();
  const cur = show(app, p);
  const grip = dynGrips(st.doc, ins).filter((g) => g.param === p.param && g.mode === 'drag').pop();
  if (p.editor === 'select' && p.options) {
    const kws: Keyword[] = p.options.map((o, i) => ({ key: String(i + 1), label: kwLabel(o.label) }));
    for (;;) {
      const r = await ctx.getPoint(`${kwLabel(p.label)} 입력 [${kws.map((k) => `${k.label}(${k.key})`).join('/')}] <${cur}>:`, { keywords: kws, allowText: true });
      if ('enter' in r) return null;
      let input: string | null = null;
      if ('keyword' in r) input = p.options[Number(r.keyword) - 1]?.value ?? null;
      else if ('text' in r) {
        const o = p.options.find((x) => x.label.toUpperCase() === r.text.trim().toUpperCase() || x.value === r.text.trim());
        input = o ? o.value : p.kind === 'linear' || p.kind === 'xy' || p.kind === 'polar' ? r.text : null;
      } else if ('point' in r && grip && p.kind === 'linear') return applyDynGrip(st.doc, ins, grip.id, r.point, nh);
      if (input === null) {
        ctx.print('목록에서 고르십시오.', 'err');
        continue;
      }
      const c = changeOf(app, p, input);
      if ('error' in c) {
        ctx.print(c.error, 'err');
        continue;
      }
      return dynSetOps(st.doc, ins, c, nh);
    }
  }
  for (;;) {
    const r = await ctx.getPoint(`${kwLabel(p.label)} 입력 <${cur}>:`, { preferNumber: true, base: grip?.anchor ?? null });
    if ('enter' in r || 'keyword' in r) return null;
    if ('point' in r) {
      if (grip && (p.kind === 'linear' || p.kind === 'rotation' || p.kind === 'polar' || p.kind === 'point')) return applyDynGrip(st.doc, ins, grip.id, r.point, nh);
      ctx.print(p.editor === 'angle' ? '각도를 입력하십시오.' : p.editor === 'coord' ? '좌표를 입력하십시오.' : '거리를 입력하십시오.', 'err');
      continue;
    }
    const c = changeOf(app, p, r.text);
    if ('error' in c) {
      ctx.print(c.error, 'err');
      continue;
    }
    return dynSetOps(st.doc, ins, c, nh);
  }
}

export function registerDynBlockCommands(app: App): void {
  // ------------------------------------------------------------- -DYNPROPS
  app.register({
    name: '-DYNPROPS',
    title: '동적 블록 특성(명령행)',
    async run(ctx) {
      const st = app.active!;
      const first = await pickReference(app, ctx);
      if (!first || undecoded(app, ctx, first)) return;
      const handle = first.handle;
      ctx.print(`동적 블록: ${definitionName(st.doc, first) ?? first.block}`);
      for (;;) {
        const ins = insertOf(app, handle);
        if (!ins) return;
        const props = dynProperties(st.doc, ins) ?? [];
        for (const p of props) ctx.print(`  ${p.label} = ${show(app, p)}${p.editor === 'readonly' ? ' (읽기 전용)' : ''}`);
        const editable = props.filter((p) => p.editor !== 'readonly');
        if (!editable.length) {
          ctx.print('고칠 수 있는 동적 블록 특성이 없습니다.');
          return;
        }
        const kws: Keyword[] = editable.map((p, i) => ({ key: String(i + 1), label: kwLabel(p.label) }));
        const r = await ctx.getPoint(`고칠 특성 입력 [${kws.map((k) => `${k.label}(${k.key})`).join('/')}] <종료>:`, { keywords: kws, allowText: true });
        if ('enter' in r || 'point' in r) return;
        const p = 'keyword' in r ? editable[Number(r.keyword) - 1] : editable.find((x) => x.label.toUpperCase() === r.text.trim().toUpperCase() || kwLabel(x.label).toUpperCase() === r.text.trim().toUpperCase());
        if (!p) {
          ctx.print('특성 이름이 올바르지 않습니다.', 'err');
          continue;
        }
        const res = await askValue(app, ctx, ins, p);
        if (res) commitResult(app, '-DYNPROPS', res, ctx);
      }
    },
  });

  // ------------------------------------------------------------- DYNPROPS
  app.register({
    name: 'DYNPROPS',
    title: '동적 블록 특성',
    async run(ctx) {
      const st = app.active!;
      const ins = await pickReference(app, ctx);
      if (!ins || undecoded(app, ctx, ins)) return;
      const props = dynProperties(st.doc, ins) ?? [];
      const editable = props.filter((p) => p.editor !== 'readonly');
      const readonly = props.filter((p) => p.editor === 'readonly');
      if (!editable.length) {
        ctx.print('고칠 수 있는 동적 블록 특성이 없습니다.');
        return;
      }
      const init = new Map<string, string>();
      const fields = editable.map((p, i) => {
        const key = `p${i}`;
        if (p.editor === 'select' && p.options) {
          const cur = typeof p.value === 'boolean' ? (p.value ? '1' : '0') : String(p.value);
          const opts = p.options.some((o) => o.value === cur) ? p.options : [{ value: cur, label: typeof p.value === 'number' ? formatLength(p.value, st.units) : cur || '(없음)' }, ...p.options];
          init.set(key, cur);
          return { key, label: p.label, type: 'select' as const, value: cur, options: opts };
        }
        const v = p.editor === 'angle' ? formatAngle(p.value as number, st.units) : formatLength(p.value as number, st.units);
        init.set(key, v);
        return { key, label: p.label, type: 'text' as const, value: v };
      });
      const note = readonly.length ? `읽기 전용: ${readonly.map((p) => `${p.label} = ${show(app, p)}`).join(', ')}` : undefined;
      const v = await form(`동적 블록 — ${definitionName(st.doc, ins) ?? ins.block}`, fields, {
        ok: '적용',
        note,
        validate: (x) => {
          for (const [i, p] of editable.entries()) {
            const s = String(x[`p${i}`]);
            if (s === init.get(`p${i}`)) continue;
            const c = changeOf(app, p, s);
            if ('error' in c) return `${p.label}: ${c.error}`;
          }
          return null;
        },
      });
      if (!v) return;
      // 조회 → 가시성 → 뒤집기 → 거리 → 각도 순
      const rank = (p: DynProperty) => ({ lookup: 0, visibility: 1, flip: 2, rotation: 4 })[p.kind as 'lookup'] ?? 3;
      const changes: DynChange[] = [];
      for (const [i, p] of [...editable.entries()].sort((a, b) => rank(a[1]) - rank(b[1]))) {
        const s = String(v[`p${i}`]);
        if (s === init.get(`p${i}`)) continue;
        const c = changeOf(app, p, s);
        if (!('error' in c)) changes.push(c);
      }
      if (!changes.length) return;
      commitResult(app, 'DYNPROPS', dynSetOps(st.doc, ins, changes, () => st.session.newHandle()), ctx);
    },
  });

  // ------------------------------------------------------------- RESETBLOCK
  app.register({
    name: 'RESETBLOCK',
    title: '블록 재설정',
    async run(ctx) {
      const st = app.active!;
      const hs = unlockedOnly(app, await ctx.getSelection('객체 선택:'));
      let n = 0;
      for (const h0 of hs) {
        const ins = insertOf(app, h0);
        if (!ins) continue;
        n++;
        const r = dynResetOps(st.doc, ins, () => st.session.newHandle());
        if (r.ops.length) st.session.commit({ label: 'RESETBLOCK', ops: r.ops, group: ctx.group });
      }
      if (!n) {
        ctx.print('고른 객체 중 동적 블록 참조가 없습니다.');
        return;
      }
      app.refreshSelectionOverlay();
      app.ui?.refreshPalette();
      ctx.print(`블록 ${n}개를 재설정했습니다.`);
    },
  });
}
