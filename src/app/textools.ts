/**
 * 문자 도구: TXT2MTXT(문자를 여러 줄 문자로), TEXTALIGN(문자 정렬), ATTIPEDIT(속성 바로 편집), ARCTEXT(원호 정렬 문자, arctext.ts).
 * 순수 계산은 src/edit/textools/*.ts. 각 명령은 한 번의 명령 취소로 되돌린다.
 */
import type { Entity, InsertEntity } from '../core/model';
import { affTranslate, transformEntity } from '../edit/geom';
import { TXT2MTXT_DEFAULTS, type Txt2MtxtOptions, textsToMText } from '../edit/textools/txt2mtxt';
import { SPACING_LABEL, type SpacingMode, anchorOf, isAlignable, justKeyOf, planTextAlign } from '../edit/textools/textalign';
import { attributeAt, attributeValue, withAttributeValue } from '../edit/textools/attipedit';
import type { App, CommandContext, Keyword } from './app';
import { registerArcTextCommands } from './arctext';
import { unlockedOnly } from './layers';
import { commitResults } from './modify';
import { form } from './ui/dom';
import type { Pt } from './view';

// ---------------------------------------------------------------------------
// TXT2MTXT
// ---------------------------------------------------------------------------

const T2M_PREF = 'opencad.txt2mtxt';

function loadT2M(): Txt2MtxtOptions {
  try {
    const v = JSON.parse(localStorage.getItem(T2M_PREF) ?? 'null') as Partial<Txt2MtxtOptions> | null;
    if (v && typeof v === 'object') return { ...TXT2MTXT_DEFAULTS, ...v };
  } catch {
    /* 저장소를 쓸 수 없으면 기본값 */
  }
  return { ...TXT2MTXT_DEFAULTS };
}

function saveT2M(o: Txt2MtxtOptions): void {
  try {
    localStorage.setItem(T2M_PREF, JSON.stringify(o));
  } catch {
    /* 무시 */
  }
}

/** "문자를 여러 줄 문자로 설정" 대화상자 */
async function txt2mtxtSettings(cur: Txt2MtxtOptions): Promise<Txt2MtxtOptions | null> {
  const v = await form(
    '문자를 여러 줄 문자로 설정',
    [
      { key: 'combine', label: '하나의 여러 줄 문자로 결합', type: 'check', value: cur.combine },
      {
        key: 'order',
        label: '텍스트 줄 정렬',
        type: 'select',
        value: cur.order,
        options: [
          { value: 'position', label: '위에서 아래로 정렬' },
          { value: 'selection', label: '선택 순서' },
        ],
      },
      { key: 'wordWrap', label: '자동 줄바꿈', type: 'check', value: cur.wordWrap },
    ],
    { note: '결합하지 않으면 한 줄 문자마다 여러 줄 문자 하나로 바꿉니다. 자동 줄바꿈을 켜면 줄을 이어 한 문단으로 만들고 가장 긴 줄의 폭을 여러 줄 문자 폭으로 합니다.' },
  );
  if (!v) return null;
  return { combine: !!v.combine, order: v.order === 'selection' ? 'selection' : 'position', wordWrap: !!v.wordWrap };
}

async function runTxt2Mtxt(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  let opt = loadT2M();
  let hs: string[] = [];
  let first = true;
  for (;;) {
    try {
      hs = await ctx.getSelection('객체 선택 또는 [설정(SE)]:', { keywords: [{ key: 'SE', label: '설정' }], noPickfirst: !first });
      break;
    } catch (e) {
      if ((e as { keyword?: string }).keyword !== 'SE') throw e;
      const next = await txt2mtxtSettings(opt);
      if (next) {
        opt = next;
        saveT2M(opt);
      }
    }
    first = false;
  }
  const list = unlockedOnly(app, hs)
    .map((h) => st.doc.entityIndex.get(h))
    .filter((e): e is Entity => !!e && (e.type === 'TEXT' || e.type === 'MTEXT'));
  if (!list.length) {
    ctx.print('문자를 선택하지 않았습니다.', 'err');
    return;
  }
  const r = textsToMText(list, st.doc, opt);
  if (!r) {
    ctx.print('여러 줄 문자로 바꿀 한 줄 문자가 없습니다.', 'err');
    return;
  }
  const applied = commitResults(app, ctx, [{ remove: r.remove, add: r.add }], 'TXT2MTXT', { quiet: true });
  app.setSelection(applied.added, 'replace');
  ctx.print(opt.combine ? `문자 ${r.remove.length}개를 여러 줄 문자 1개로 결합했습니다.` : `한 줄 문자 ${r.add.length}개를 여러 줄 문자로 바꿨습니다.`);
}

// ---------------------------------------------------------------------------
// TEXTALIGN
// ---------------------------------------------------------------------------

let spacingMode: SpacingMode = 'V';
let spacingValue = 0;
/** 지금 간격 모드(옵션 입력으로 바뀐다) */
const currentMode = (): SpacingMode => spacingMode;

async function textAlignOptions(ctx: CommandContext): Promise<void> {
  const kws: Keyword[] = [
    { key: 'D', label: '분산' },
    { key: 'S', label: '간격 설정' },
    { key: 'V', label: '현재 수직' },
    { key: 'H', label: '현재 수평' },
  ];
  const r = await ctx.getPoint(`옵션 입력 [분산(D)/간격 설정(S)/현재 수직(V)/현재 수평(H)] <${SPACING_LABEL[spacingMode]}>:`, { keywords: kws });
  if ('keyword' in r) spacingMode = r.keyword.toUpperCase() as SpacingMode;
  else if ('text' in r) {
    const k = r.text.trim().toUpperCase();
    if (k === 'D' || k === 'S' || k === 'V' || k === 'H') spacingMode = k;
  }
  if (spacingMode === 'S') {
    for (;;) {
      const s = await ctx.getPoint(`간격 입력 <${spacingValue}>:`, { allowText: true, preferNumber: true });
      if ('enter' in s) break;
      if ('text' in s) {
        const v = Number(s.text);
        if (Number.isFinite(v) && v >= 0) {
          spacingValue = v;
          break;
        }
        ctx.print('0 이상인 숫자를 입력하십시오.', 'err');
        continue;
      }
      break;
    }
  }
}

async function pickPoints(ctx: CommandContext): Promise<[Pt, Pt] | null> {
  const a = await ctx.getPoint('첫 번째 점 선택:');
  if (!('point' in a)) return null;
  const b = await ctx.getPoint('두 번째 점 선택:', { base: a.point });
  if (!('point' in b)) return null;
  return [a.point, b.point];
}

async function runTextAlign(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  ctx.print(`현재 설정: 간격 모드 = ${SPACING_LABEL[spacingMode]}`);
  const kws: Keyword[] = [
    { key: 'O', label: '옵션' },
    { key: 'P', label: '점' },
  ];
  let hs: string[] = [];
  let usePoints = false;
  let first = true;
  for (;;) {
    const prompt = st.selection.size && !first ? '정렬할 문자 객체 선택 [옵션(O)/점(P)]:' : '정렬할 문자 객체 선택 또는 [옵션(O)/점(P)]:';
    try {
      hs = await ctx.getSelection(prompt, { keywords: kws, noPickfirst: !first });
      break;
    } catch (e) {
      const k = (e as { keyword?: string }).keyword;
      if (k === 'O') await textAlignOptions(ctx);
      else if (k === 'P') {
        usePoints = true;
        hs = [...st.selection];
        break;
      } else throw e;
    }
    first = false;
  }
  let texts = unlockedOnly(app, hs)
    .map((h) => doc.entityIndex.get(h))
    .filter((e): e is Entity => !!e && isAlignable(e));
  if (!texts.length) {
    ctx.print('문자 객체를 선택하지 않았습니다.', 'err');
    return;
  }
  app.setSelection(texts.map((e) => e.handle), 'replace');
  let reference: Entity | null = null;
  let from: Pt;
  let key = justKeyOf(texts[0]!);
  if (spacingMode === 'D' || usePoints) {
    const pp = await pickPoints(ctx);
    if (!pp) return;
    const plan = planTextAlign({ texts, key, from: pp[0], to: pp[1], mode: spacingMode === 'D' ? 'D' : spacingMode, spacing: spacingValue }, doc);
    apply(app, ctx, texts, plan);
    return;
  }
  for (;;) {
    const r = await ctx.getEntity('정렬 기준 문자 객체 선택 [점(P)]:', [{ key: 'P', label: '점' }]);
    if ('keyword' in r) {
      const pp = await pickPoints(ctx);
      if (!pp) return;
      apply(app, ctx, texts, planTextAlign({ texts, key, from: pp[0], to: pp[1], mode: spacingMode, spacing: spacingValue }, doc));
      return;
    }
    if (!('handle' in r)) return;
    const e = doc.entityIndex.get(r.handle);
    if (e && isAlignable(e)) {
      reference = e;
      break;
    }
    ctx.print('문자 객체가 아닙니다.', 'err');
  }
  key = justKeyOf(reference);
  texts = texts.filter((e) => e.handle !== reference!.handle);
  from = anchorOf(reference, key, doc) ?? { x: 0, y: 0 };
  if (!texts.length) {
    ctx.print('정렬할 다른 문자가 없습니다.', 'err');
    return;
  }
  const pk = app.picker();
  const moved = (to: Pt): Entity[] => {
    const out: Entity[] = [];
    for (const p of planTextAlign({ texts, reference, key, from, to, mode: spacingMode, spacing: spacingValue }, doc)) {
      const e = doc.entityIndex.get(p.handle);
      if (!e) continue;
      const r = transformEntity(e, affTranslate(p.dx, p.dy), doc);
      out.push(...(r.replace ?? []));
    }
    return out;
  };
  for (;;) {
    const r = await ctx.getPoint('두 번째 점 선택 또는 [옵션(O)]:', {
      base: from,
      keywords: [{ key: 'O', label: '옵션' }],
      ghost: (p) => {
        try {
          const ents = moved(p);
          return pk && ents.length ? [pk.geometryOf(ents)] : [];
        } catch {
          return [];
        }
      },
    });
    if ('keyword' in r) {
      await textAlignOptions(ctx);
      if (currentMode() === 'D') {
        const pp = await pickPoints(ctx);
        if (!pp) return;
        apply(app, ctx, [reference, ...texts], planTextAlign({ texts: [reference, ...texts], key, from: pp[0], to: pp[1], mode: 'D' }, doc));
        return;
      }
      continue;
    }
    if (!('point' in r)) return;
    apply(app, ctx, texts, planTextAlign({ texts, reference, key, from, to: r.point, mode: spacingMode, spacing: spacingValue }, doc));
    return;
  }
}

function apply(app: App, ctx: CommandContext, _texts: Entity[], plan: { handle: string; dx: number; dy: number }[]): void {
  const doc = app.active!.doc;
  const replace: Entity[] = [];
  for (const p of plan) {
    const e = doc.entityIndex.get(p.handle);
    if (!e) continue;
    const r = transformEntity(e, affTranslate(p.dx, p.dy), doc);
    replace.push(...(r.replace ?? []));
  }
  if (!replace.length) {
    ctx.print('옮길 문자가 없습니다(이미 맞춰져 있습니다).');
    return;
  }
  commitResults(app, ctx, [{ replace }], 'TEXTALIGN', { quiet: true });
  ctx.print(`문자 ${replace.length}개를 정렬했습니다.`);
}

// ---------------------------------------------------------------------------
// ATTIPEDIT
// ---------------------------------------------------------------------------

async function runAttIpEdit(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  for (;;) {
    const r = await ctx.getEntity('편집할 속성 선택:');
    if (!('handle' in r)) return;
    const e = doc.entityIndex.get(r.handle);
    if (e?.type !== 'INSERT' || !e.attribs.length) {
      ctx.print('블록 속성이 아닙니다.', 'err');
      continue;
    }
    if (!unlockedOnly(app, [e.handle]).length) return;
    const px = app.view.pixelSize?.() ?? 0;
    const tol = Math.max((app.view.overlay.pickbox || 5) * px * 2, 1e-9);
    const a = attributeAt(e, r.point, doc, tol);
    if (!a) {
      ctx.print('그 자리에 고칠 수 있는 속성이 없습니다.', 'err');
      continue;
    }
    const v = await form(`속성 편집 - ${a.tag}`, [{ key: 'v', label: a.prompt || a.tag, type: a.mtext ? 'textarea' : 'text', value: attributeValue(a) }], {
      note: a.mtext ? '여러 줄 속성입니다. 줄바꿈은 그대로 여러 줄 문자 줄바꿈이 됩니다.' : undefined,
    });
    if (!v) return;
    const next = withAttributeValue(e as InsertEntity, a.handle, String(v.v));
    if (!next) return;
    const block = st.session.ownerOf(e.handle);
    if (!block) return;
    st.session.commit({ label: 'ATTIPEDIT', ops: [{ kind: 'modify', block, before: e, after: next }], group: ctx.group });
    return;
  }
}

// ---------------------------------------------------------------------------

export function registerTextToolCommands(app: App): void {
  app.register({ name: 'TXT2MTXT', title: '문자를 여러 줄 문자로', run: (ctx) => runTxt2Mtxt(app, ctx) });
  app.register({ name: 'TEXTALIGN', title: '문자 정렬', run: (ctx) => runTextAlign(app, ctx) });
  app.register({ name: 'ATTIPEDIT', title: '속성 바로 편집', run: (ctx) => runAttIpEdit(app, ctx) });
  registerArcTextCommands(app);
}
