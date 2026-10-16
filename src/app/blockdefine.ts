/**
 * 블록 정의: BLOCK(대화상자)·-BLOCK(명령행). 같은 이름이면 재정의 확인 뒤 정의를 바꾸고 모든 참조가 새 정의로 그려진다(명령 취소 한 단계).
 * 대화상자는 AutoCAD 2026 "블록 정의"처럼 이름(기존 블록 목록)·기준점(화면상에 지정·선택 점·X/Y/Z)·객체(화면상에 지정·객체 선택·
 * 유지/블록으로 변환/삭제)·동작(주석·배치에 일치·균일하게 축척·분해 허용)·설정(블록 단위)·설명·블록 편집기에서 열기.
 */
import type { AttribEntity, BlockDef, BlockRecord, CadDocument, Entity, InsertEntity, Vec3 } from '../core/model';
import { entityDefaults, tableKey } from '../core/model';
import { INSUNITS_NAMES } from '../core/units';
import type { EditOp } from '../edit/session';
import { cloneEntity } from '../edit/session';
import { annotativeFlag, withAnnotativeFlag } from '../edit/annoscale/xdata';
import type { App, CommandContext } from './app';
import { currentProps } from './draw';
import { unlockedOnly } from './layers';
import { listBlocks } from './dashcmds-insert';
import { askOption, askWord, askYN } from './dashcmds-ask';
import { ask, h } from './ui/dom';
import { checkIn, fail, group, numIn, numOf, resultDialog, row, selectIn, textIn, areaIn, btn } from './mgr-ui';

export const BAD_BLOCK_NAME = /[<>/\\":;?*|,=`]/;

export type BlockMode = 'convert' | 'retain' | 'delete';

export interface DefineBlockSpec {
  name: string;
  /** 삽입 기준점(도면 좌표) */
  base: Vec3;
  handles: readonly string[];
  mode: BlockMode;
  description?: string;
  annotative?: boolean;
  matchLayout?: boolean;
  scaleUniformly?: boolean;
  explodable?: boolean;
  /** 블록 단위(INSUNITS 코드) */
  units?: number;
}

export interface DefineBlockResult {
  ops: EditOp[];
  /** 블록으로 변환(convert)일 때 새 참조 핸들 */
  insertHandle: string | null;
  count: number;
  redefined: boolean;
}

/** 블록 이름 검사(쓸 수 있으면 null) */
export function blockNameProblem(name: string): string | null {
  const nm = name.trim();
  if (!nm) return '이름을 입력하십시오.';
  if (nm.length > 255) return '이름이 너무 깁니다(255자 이내).';
  if (BAD_BLOCK_NAME.test(nm) || nm.startsWith('*') || /[\x00-\x1f]/.test(nm)) return '이름에 쓸 수 없는 문자가 있습니다.';
  return null;
}

/** 객체가 (중첩을 따라) key 블록을 참조하는가 */
function referencesBlock(doc: CadDocument, e: Entity, key: string, seen: Set<string>): boolean {
  const b = (e as { block?: unknown }).block;
  if (typeof b !== 'string' || !b) return false;
  const k = tableKey(b);
  if (k === key) return true;
  if (seen.has(k)) return false;
  seen.add(k);
  const def = doc.blocks.get(k);
  return !!def && def.entities.some((x) => referencesBlock(doc, x, key, seen));
}

/** 재정의할 수 없는 블록(배치·외부 참조·외부 의존·익명)이면 이유 */
function notRedefinable(def: BlockDef): string | null {
  if (def.name.startsWith('*')) return `블록 "${def.name}"은(는) 재정의할 수 없습니다.`;
  if (def.flags & (4 | 16) || def.xrefPath || def.name.includes('|')) return `외부 참조 "${def.name}"은(는) 재정의할 수 없습니다.`;
  return null;
}

/**
 * 블록 정의(같은 이름이 있으면 재정의) 작업. 기준점은 블록 기준점 그대로(객체는 도면 좌표에 둔다 — AutoCAD BLOCK과 같다).
 * 재정의는 BLOCK·BLOCK_RECORD 핸들을 지키고 객체만 바꾼다. 기존 참조의 속성은 그대로다(ATTSYNC 전까지).
 */
export type AttribMaker = (def: BlockDef, ins: InsertEntity) => AttribEntity[];

export function defineBlockOps(app: App, spec: DefineBlockSpec, make?: AttribMaker): DefineBlockResult | { error: string } {
  const st = app.active!;
  const doc = st.doc;
  const name = spec.name.trim();
  const bad = blockNameProblem(name);
  if (bad) return { error: bad };
  const key = tableKey(name);
  const old = doc.blocks.get(key) ?? null;
  if (old) {
    const why = notRedefinable(old);
    if (why) return { error: why };
  }
  const space = st.space;
  const block = doc.blocks.get(space)!;
  if (tableKey(block.name) === key) return { error: `블록 "${name}"을(를) 편집하는 중에는 재정의할 수 없습니다.` };
  const order = new Map(block.entities.map((e, i) => [e.handle, i]));
  const chosen = spec.handles.filter((x) => st.session.ownerOf(x) === space && order.has(x)).sort((a, b) => order.get(a)! - order.get(b)!);
  // 자기 참조(중첩 포함)
  for (const hd of chosen) {
    const e = doc.entityIndex.get(hd);
    if (e && referencesBlock(doc, e, key, new Set())) return { error: `블록 ${name}이(가) 자신을 참조합니다.` };
  }
  const oldRec = doc.blockRecords.get(key) ?? null;
  const recordHandle = oldRec?.handle ?? old?.recordHandle ?? st.session.newHandle();
  const ops: EditOp[] = [];
  const removeOps: EditOp[] = [];
  const ents: Entity[] = [];
  for (const hd of chosen) {
    const e = doc.entityIndex.get(hd)!;
    const c = cloneEntity(e);
    c.owner = recordHandle;
    if (spec.mode !== 'retain') {
      removeOps.push({ kind: 'remove', block: space, entity: e, index: order.get(hd) ?? -1 });
    } else {
      c.handle = st.session.newHandle();
      delete c.xdict;
      delete c.reactors;
      delete (c as { dwgRaw?: unknown }).dwgRaw;
      if (c.type === 'INSERT')
        for (const a of c.attribs) {
          a.handle = st.session.newHandle();
          a.owner = c.handle;
          delete a.xdict;
          delete a.reactors;
          delete (a as { dwgRaw?: unknown }).dwgRaw;
        }
    }
    ents.push(c);
  }
  // 지우기는 뒤에서부터(앞 객체를 지워도 뒤 번호가 맞게)
  ops.push(...removeOps.reverse());
  const hasAtt = ents.some((e) => e.type === 'ATTDEF');
  const units = spec.units ?? (Number(doc.header.get('$INSUNITS') ?? 0) || 0);
  const record: BlockRecord = oldRec
    ? { ...oldRec, insertUnits: units, explodable: spec.explodable ?? oldRec.explodable, scalable: !(spec.scaleUniformly ?? !oldRec.scalable) }
    : { name, handle: recordHandle, flags: 0, insertUnits: units, explodable: spec.explodable ?? true, scalable: !(spec.scaleUniformly ?? false) };
  // 주석 블록(AcadAnnotative, 방향 일치는 AcadAnnoPO 1070 1)
  if (spec.annotative !== undefined) {
    const rest = (record.xdata ?? []).filter((d) => d.app.toUpperCase() !== 'ACADANNOPO');
    if (spec.annotative) record.xdata = [...withAnnotativeFlag(rest, true), ...(spec.matchLayout ? [{ app: 'AcadAnnoPO', items: [{ code: 1070 as const, value: 1 }] }] : [])];
    else {
      const off = rest.filter((d) => d.app.toUpperCase() !== 'ACADANNOTATIVE');
      record.xdata = off.length ? off : undefined;
    }
  }
  const def: BlockDef = {
    name: old?.name ?? name,
    handle: old?.handle ?? st.session.newHandle(),
    recordHandle,
    basePoint: { x: spec.base.x, y: spec.base.y, z: spec.base.z ?? 0 },
    flags: ((old?.flags ?? 0) & ~2 & ~1) | (hasAtt ? 2 : 0),
    description: spec.description?.trim() || undefined,
    layer: old?.layer ?? '0',
    entities: ents,
    endHandle: old?.endHandle ?? st.session.newHandle(),
  };
  ops.push({ kind: 'blockRecord', key, before: oldRec, after: record }, { kind: 'blockDef', key, before: old, after: def });
  let insertHandle: string | null = null;
  if (spec.mode === 'convert') {
    const ins: InsertEntity = {
      ...entityDefaults(),
      ...currentProps(app),
      type: 'INSERT',
      handle: st.session.newHandle(),
      owner: block.recordHandle,
      block: def.name,
      insert: { x: spec.base.x, y: spec.base.y, z: spec.base.z ?? 0 },
      scale: { x: 1, y: 1, z: 1 },
      rotation: 0,
      columnCount: 1,
      rowCount: 1,
      columnSpacing: 0,
      rowSpacing: 0,
      attribs: [],
    };
    if (make && hasAtt) ins.attribs = make(def, ins);
    insertHandle = ins.handle;
    ops.push({ kind: 'add', block: space, entity: ins });
  }
  return { ops, insertHandle, count: ents.length, redefined: !!old };
}

// ---------------------------------------------------------------------------
// 대화상자
// ---------------------------------------------------------------------------

interface BlockDialogState {
  name: string;
  description: string;
  base: Vec3;
  baseOnScreen: boolean;
  objsOnScreen: boolean;
  handles: string[];
  mode: BlockMode;
  annotative: boolean;
  matchLayout: boolean;
  scaleUniformly: boolean;
  explodable: boolean;
  units: number;
  openEditor: boolean;
}

type DialogAction = 'ok' | 'pickBase' | 'pickObjects';

const UNIT_OPTIONS = Object.entries(INSUNITS_NAMES).map(([k, v]) => ({ value: k, label: v.name }));

function blockDialog(app: App, s: BlockDialogState): Promise<{ action: DialogAction; state: BlockDialogState } | null> {
  const st = app.active!;
  const names = [...st.doc.blocks.values()].filter((b) => !b.name.startsWith('*') && !(b.flags & (4 | 16)) && !b.name.includes('|')).map((b) => b.name).sort((a, b) => a.localeCompare(b, 'ko'));
  const listId = `mgr-blocknames-${Math.random().toString(36).slice(2, 8)}`;
  const dl = h('datalist', { id: listId }, ...names.map((n) => h('option', { value: n })));
  const name = textIn(s.name, '이름', listId);
  const bx = numIn(s.base.x, '기준점 X');
  const by = numIn(s.base.y, '기준점 Y');
  const bz = numIn(s.base.z, '기준점 Z');
  const baseScreen = checkIn(s.baseOnScreen, '기준점 화면상에 지정');
  const objScreen = checkIn(s.objsOnScreen, '객체 화면상에 지정');
  const modeSel = selectIn(
    [
      { value: 'retain', label: '유지(R)' },
      { value: 'convert', label: '블록으로 변환(C)' },
      { value: 'delete', label: '삭제(D)' },
    ],
    s.mode,
    '선택한 객체',
  );
  const anno = checkIn(s.annotative, '주석');
  const match = checkIn(s.matchLayout, '블록 방향을 배치에 일치');
  const uniform = checkIn(s.scaleUniformly, '균일하게 축척');
  const explode = checkIn(s.explodable, '분해 허용');
  const units = selectIn(UNIT_OPTIONS, String(s.units), '블록 단위');
  const desc = areaIn(s.description, '설명', 2);
  const openEd = checkIn(s.openEditor, '블록 편집기에서 열기');
  const objNote = h('div', { class: 'mgr-note' }, s.handles.length ? `${s.handles.length}개의 객체가 선택됨` : '선택된 객체 없음');
  const sync = () => {
    for (const el of [bx, by, bz]) el.disabled = baseScreen.checked;
    match.disabled = !anno.checked;
    if (!anno.checked) match.checked = false;
  };
  // 이름 목록에서 기존 블록을 고르면 그 정의의 기준점·설명·동작·단위를 채운다(재정의할 때 그대로 쓰게)
  name.addEventListener('change', () => {
    const def = st.doc.blocks.get(tableKey(name.value.trim()));
    if (!def || notRedefinable(def)) return;
    const rec = st.doc.blockRecords.get(tableKey(def.name));
    bx.value = String(def.basePoint.x);
    by.value = String(def.basePoint.y);
    bz.value = String(def.basePoint.z);
    desc.value = def.description ?? '';
    if (rec) {
      uniform.checked = !rec.scalable;
      explode.checked = rec.explodable;
      units.value = String(rec.insertUnits);
      anno.checked = annotativeFlag(rec.xdata) === true;
      match.checked = anno.checked && (rec.xdata ?? []).some((d) => d.app.toUpperCase() === 'ACADANNOPO');
    }
    sync();
  });
  baseScreen.addEventListener('change', sync);
  anno.addEventListener('change', sync);
  sync();
  let action: DialogAction = 'ok';
  const read = (): BlockDialogState => ({
    name: name.value.trim(),
    description: desc.value,
    base: { x: numOf(bx) || 0, y: numOf(by) || 0, z: numOf(bz) || 0 },
    baseOnScreen: baseScreen.checked,
    objsOnScreen: objScreen.checked,
    handles: s.handles,
    mode: modeSel.value as BlockMode,
    annotative: anno.checked,
    matchLayout: match.checked,
    scaleUniformly: uniform.checked,
    explodable: explode.checked,
    units: Number(units.value),
    openEditor: openEd.checked,
  });
  let submitNow: (() => void) | null = null;
  const close = () => submitNow?.();
  const pickBase = btn('선택 점(K)', () => {
    action = 'pickBase';
    close();
  });
  const pickObjs = btn('객체 선택(T)', () => {
    action = 'pickObjects';
    close();
  });
  const body = h(
    'div',
    { class: 'mgr-dlg' },
    dl,
    row('이름(N)', name),
    h(
      'div',
      { class: 'mgr-cols' },
      group('기준점', row('화면상에 지정', baseScreen), pickBase, row('X', bx), row('Y', by), row('Z', bz)),
      group('객체', row('화면상에 지정', objScreen), pickObjs, row('선택한 객체', modeSel), objNote),
      group('동작', row('주석(A)', anno), row('블록 방향을 배치에 일치(M)', match), row('균일하게 축척(S)', uniform), row('분해 허용(P)', explode)),
    ),
    group('설정', row('블록 단위(U)', units)),
    row('설명', desc),
    row('블록 편집기에서 열기(O)', openEd),
  );
  const p = resultDialog<{ action: DialogAction; state: BlockDialogState }>('블록 정의', body, {
    width: 720,
    submit: () => {
      const v = read();
      if (action === 'ok') {
        const bad = blockNameProblem(v.name);
        if (bad) return fail(bad);
        if (![v.base.x, v.base.y, v.base.z].every(Number.isFinite)) return fail('기준점: 숫자를 입력하십시오.');
        if (!v.objsOnScreen && !v.handles.length) return fail('객체를 선택하십시오.');
      }
      return { action, state: v };
    },
    // 선택 점·객체 선택 단추는 대화상자를 닫고 화면에서 받은 뒤 다시 연다
    bind: (go) => (submitNow = go),
  });
  return p;
}

/** 재정의 확인(대화상자). 재정의하면 true */
async function confirmRedefine(name: string): Promise<boolean> {
  const a = await ask('블록 - 블록 재정의', `"${name}" 블록이 이미 정의되어 있습니다. 블록을 재정의하면 이 블록의 모든 참조가 새 정의로 바뀝니다. 무엇을 하시겠습니까?`, [
    { label: '블록 재정의', value: 'yes', primary: true },
    { label: '블록 재정의 안 함', value: 'no' },
  ]);
  return a === 'yes';
}

/** 정의를 확정하고 결과를 알린다. 성공하면 정의한 블록 이름 */
function commitDefinition(app: App, ctx: CommandContext, spec: DefineBlockSpec, label: string, make?: AttribMaker): string | null {
  const st = app.active!;
  const r = defineBlockOps(app, spec, make);
  if ('error' in r) {
    ctx.print(r.error, 'err');
    return null;
  }
  st.selection.clear();
  st.session.commit({ label, ops: r.ops, group: ctx.group });
  if (r.insertHandle) app.setSelection([r.insertHandle]);
  ctx.print(r.redefined ? `블록 ${spec.name.trim()}이(가) 재정의되었습니다(객체 ${r.count}개).` : `블록 "${spec.name.trim()}"을(를) 만들었습니다(객체 ${r.count}개).`);
  return spec.name.trim();
}

export function registerBlockDefine(app: App, make: AttribMaker): void {
  // ------------------------------------------------------------- BLOCK (대화상자)
  app.register({
    name: 'BLOCK',
    aliases: ['B', 'BMAKE'],
    title: '블록 정의',
    async run(ctx) {
      const st = app.active!;
      let n = 1;
      while (st.doc.blocks.has(tableKey(`블록${n}`))) n++;
      const insu = Number(st.doc.header.get('$INSUNITS') ?? 0) || 0;
      let s: BlockDialogState = {
        name: `블록${n}`,
        description: '',
        base: { x: 0, y: 0, z: 0 },
        baseOnScreen: false,
        objsOnScreen: false,
        handles: unlockedOnly(app, [...st.selection]),
        mode: 'convert',
        annotative: false,
        matchLayout: false,
        scaleUniformly: false,
        explodable: true,
        units: insu,
        openEditor: false,
      };
      for (;;) {
        const r = await blockDialog(app, s);
        if (!r) return;
        s = r.state;
        if (r.action === 'pickBase') {
          const p = await ctx.getPoint('삽입 기준점 지정:');
          if ('point' in p) s.base = { x: p.point.x, y: p.point.y, z: 0 };
          continue;
        }
        if (r.action === 'pickObjects') {
          s.handles = unlockedOnly(app, await ctx.getSelection('객체 선택:', { noPickfirst: true }));
          continue;
        }
        // 이름이 있는 블록을 고르면 그 설정을 가져온다(AutoCAD 이름 목록처럼) — 재정의 확인
        const key = tableKey(s.name);
        if (st.doc.blocks.has(key)) {
          const why = notRedefinable(st.doc.blocks.get(key)!);
          if (why) {
            ctx.print(why, 'err');
            continue;
          }
          if (!(await confirmRedefine(st.doc.blocks.get(key)!.name))) continue;
        }
        if (s.baseOnScreen) {
          const p = await ctx.getPoint('삽입 기준점 지정:');
          if (!('point' in p)) return;
          s.base = { x: p.point.x, y: p.point.y, z: 0 };
        }
        if (s.objsOnScreen) {
          s.handles = unlockedOnly(app, await ctx.getSelection('객체 선택:', { noPickfirst: true }));
          if (!s.handles.length) {
            ctx.print('객체가 선택되지 않았습니다.', 'err');
            return;
          }
        }
        const done = commitDefinition(
          app,
          ctx,
          {
            name: s.name,
            base: s.base,
            handles: s.handles,
            mode: s.mode,
            description: s.description,
            annotative: s.annotative,
            matchLayout: s.matchLayout,
            scaleUniformly: s.scaleUniformly,
            explodable: s.explodable,
            units: s.units,
          },
          'BLOCK',
          make,
        );
        if (done && s.openEditor && (await app.openBlockEditor(done))) ctx.print(`블록 편집기: ${done}. 끝내려면 BCLOSE를 입력하십시오.`);
        return;
      }
    },
  });

  // ------------------------------------------------------------- -BLOCK (명령행)
  app.register({
    name: '-BLOCK',
    aliases: ['-B'],
    title: '블록 정의(명령행)',
    run: (ctx) => dashBlock(app, ctx),
  });
}

/**
 * -BLOCK: `블록 이름 입력 또는 [?]:` → (있으면) `블록 "이름"이(가) 이미 있습니다. 재정의하시겠습니까? [예(Y)/아니오(N)] <N>:` →
 * `삽입 기준점 지정 또는 [주석(A)]:` → `객체 선택:`. 고른 객체는 AutoCAD처럼 도면에서 지운다(OOPS로 되살린다).
 */
export async function dashBlock(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  let name = '';
  for (;;) {
    const t = await askWord(ctx, '블록 이름 입력 또는 [?]:');
    if (t === null) return;
    if (t === '?') {
      listBlocks(ctx, (await askWord(ctx, '나열할 블록 입력 <*>:')) ?? '*');
      continue;
    }
    const bad = blockNameProblem(t);
    if (bad) {
      ctx.print(bad, 'err');
      continue;
    }
    name = t;
    break;
  }
  const old = st.doc.blocks.get(tableKey(name));
  if (old) {
    const why = notRedefinable(old);
    if (why) {
      ctx.print(why, 'err');
      return;
    }
    if (!(await askYN(ctx, `블록 "${old.name}"이(가) 이미 있습니다. 재정의하시겠습니까?`, false))) return;
    name = old.name;
  }
  let annotative = false;
  let matchLayout = false;
  let base: Vec3 | null = null;
  for (;;) {
    const r = await ctx.getPoint('삽입 기준점 지정 또는 [주석(A)]:', { keywords: [{ key: 'A', label: '주석' }] });
    if ('point' in r) {
      base = { x: r.point.x, y: r.point.y, z: 0 };
      break;
    }
    if ('keyword' in r && r.keyword === 'A') {
      annotative = (await askOption(ctx, '주석 블록 작성 [예(Y)/아니오(N)] <예>:', [{ key: 'Y', label: '예' }, { key: 'N', label: '아니오' }], 'Y')) === 'Y';
      if (annotative) matchLayout = await askYN(ctx, '블록 방향을 배치에 일치시키겠습니까?', false);
      continue;
    }
    if ('enter' in r) return;
  }
  const hs = unlockedOnly(app, await ctx.getSelection('객체 선택:', { noPickfirst: true }));
  if (!hs.length) {
    ctx.print('객체가 선택되지 않았습니다.', 'err');
    return;
  }
  const rec = old ? st.doc.blockRecords.get(tableKey(old.name)) : undefined;
  commitDefinition(
    app,
    ctx,
    {
      name,
      base,
      handles: hs,
      mode: 'delete',
      description: old?.description,
      annotative: annotative || undefined,
      matchLayout,
      scaleUniformly: rec ? !rec.scalable : false,
      explodable: rec ? rec.explodable : true,
      units: rec?.insertUnits,
    },
    'BLOCK',
  );
}
