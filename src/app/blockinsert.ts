/**
 * 블록 삽입·속성: INSERT(대화상자 — 블록 미리보기, 삽입점·축척·회전 "화면상에 지정", 단일 축척, 블록 단위(INSUNITS) 축척,
 * 반복 배치, 분해, ATTDIA·ATTREQ), ATTDEF(모드·자리맞추기·문자 스타일·회전·확인·위치 잠금·이전 속성 정의 아래에 정렬),
 * 향상된 속성 편집기(EATTEDIT — 속성·문자 옵션·특성 탭).
 */
import type { AttribEntity, BlockDef, CadColor, Entity, InsertEntity, TextHAlign, TextVAlign, Vec3 } from '../core/model';
import { entityDefaults, tableKey } from '../core/model';
import { INSUNITS_NAMES } from '../core/units';
import { cloneEntity } from '../edit/session';
import { explodeEntity } from '../edit/geom';
import { insertUnitFactor } from '../edit/script/dash';
import type { App, CommandContext } from './app';
import type { DocState } from './docstate';
import { addEntities, currentProps } from './draw';
import { unlockedOnly } from './layers';
import { commitResults } from './modify';
import { previewOf } from './modify2-util';
import { askLine, askReal, fmt4 } from './dashcmds-ask';
import { attDia, attReq } from './sysvars';
import { blockGeometry, drawGeometry } from './blockpreview';
import { TEXT_JUSTIFY } from './textedit/commands';
import { h } from './ui/dom';
import { areaIn, checkIn, fail, group, numIn, numOf, pickList, resultDialog, row, selectIn, tabs, textIn } from './mgr-ui';
import type { Pt } from './view';

type MakeAttribs = (def: BlockDef, ins: Vec3, scale: Vec3, rot: number, values: Map<string, string>, handle: string) => AttribEntity[];

const D2R = Math.PI / 180;
const nonZero = (v: number) => (v === 0 ? '값은 0이 아니어야 합니다.' : null);

/** 사용자가 넣을 수 있는 블록 */
function insertable(st: DocState): BlockDef[] {
  return [...st.doc.blocks.values()].filter((b) => !b.name.startsWith('*') && !(b.flags & 4) && !b.name.includes('|')).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

// ---------------------------------------------------------------------------
// INSERT
// ---------------------------------------------------------------------------

interface InsertDialog {
  name: string;
  pointOnScreen: boolean;
  point: Vec3;
  scaleOnScreen: boolean;
  scale: Vec3;
  uniform: boolean;
  rotOnScreen: boolean;
  rotDeg: number;
  repeat: boolean;
  explode: boolean;
}

/** 문서별 직전 INSERT 대화상자 값 */
const lastInsert = new WeakMap<DocState, InsertDialog>();

function insertDialog(app: App, st: DocState, v: InsertDialog): Promise<InsertDialog | null> {
  const blocks = insertable(st);
  const name = selectIn(
    blocks.map((b) => ({ value: b.name, label: `${b.name}${b.description ? ` — ${b.description}` : ''}` })),
    v.name,
    '이름',
  );
  const canvas = h('canvas', { class: 'mgr-prev', width: 160, height: 120 }) as HTMLCanvasElement;
  const unitNote = h('div', { class: 'mgr-note' });
  const pScreen = checkIn(v.pointOnScreen, '삽입점 화면상에 지정');
  const px = numIn(v.point.x, '삽입점 X');
  const py = numIn(v.point.y, '삽입점 Y');
  const pz = numIn(v.point.z, '삽입점 Z');
  const sScreen = checkIn(v.scaleOnScreen, '축척 화면상에 지정');
  const sx = numIn(v.scale.x, '축척 X');
  const sy = numIn(v.scale.y, '축척 Y');
  const sz = numIn(v.scale.z, '축척 Z');
  const uniform = checkIn(v.uniform, '단일 축척');
  const rScreen = checkIn(v.rotOnScreen, '회전 화면상에 지정');
  const rot = numIn(v.rotDeg, '각도');
  const repeat = checkIn(v.repeat, '반복 배치');
  const explode = checkIn(v.explode, '분해');
  const sync = () => {
    const def = st.doc.blocks.get(tableKey(name.value));
    const rec = st.doc.blockRecords.get(tableKey(name.value));
    const forced = rec ? !rec.scalable : false;
    if (forced) uniform.checked = true;
    uniform.disabled = forced;
    for (const el of [px, py, pz]) el.disabled = pScreen.checked;
    sx.disabled = sScreen.checked;
    sy.disabled = sz.disabled = sScreen.checked || uniform.checked;
    rot.disabled = rScreen.checked;
    explode.disabled = rec ? !rec.explodable : false;
    if (explode.disabled) explode.checked = false;
    const bu = rec?.insertUnits ?? 0;
    const du = Number(st.doc.header.get('$INSUNITS') ?? 0) || 0;
    unitNote.textContent = `블록 단위: ${INSUNITS_NAMES[bu]?.name ?? '단위 없음'} · 비율: ${fmt4(insertUnitFactor(bu, du))}`;
    if (def) drawGeometry(canvas, blockGeometry(app, st.doc, def.name), getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#e8ebf0');
  };
  for (const el of [name, pScreen, sScreen, uniform, rScreen]) el.addEventListener('change', sync);
  const body = h(
    'div',
    { class: 'mgr-dlg' },
    h('div', { class: 'mgr-cols' }, h('div', { class: 'mgr-dlg' }, row('이름(N)', name), unitNote), canvas),
    h(
      'div',
      { class: 'mgr-cols' },
      group('삽입점', row('화면상에 지정(S)', pScreen), row('X', px), row('Y', py), row('Z', pz)),
      group('축척', row('화면상에 지정(E)', sScreen), row('X', sx), row('Y', sy), row('Z', sz), row('단일 축척(U)', uniform)),
      group('회전', row('화면상에 지정(C)', rScreen), row('각도(A)', rot)),
    ),
    h('div', { class: 'mgr-cols' }, row('반복 배치(R)', repeat), row('분해(D)', explode)),
  );
  setTimeout(sync);
  return resultDialog<InsertDialog>('삽입', body, {
    width: 680,
    submit: () => {
      const s = { x: numOf(sx), y: uniform.checked ? numOf(sx) : numOf(sy), z: uniform.checked ? numOf(sx) : numOf(sz) };
      if (!sScreen.checked && (![s.x, s.y, s.z].every(Number.isFinite) || s.x === 0 || s.y === 0 || s.z === 0)) return fail('축척은 0이 아닌 숫자여야 합니다.');
      if (!pScreen.checked && ![numOf(px), numOf(py), numOf(pz)].every(Number.isFinite)) return fail('삽입점: 숫자를 입력하십시오.');
      if (!rScreen.checked && !Number.isFinite(numOf(rot))) return fail('회전: 숫자를 입력하십시오.');
      return {
        name: name.value,
        pointOnScreen: pScreen.checked,
        point: { x: numOf(px) || 0, y: numOf(py) || 0, z: numOf(pz) || 0 },
        scaleOnScreen: sScreen.checked,
        scale: sScreen.checked ? v.scale : s,
        uniform: uniform.checked,
        rotOnScreen: rScreen.checked,
        rotDeg: rScreen.checked ? v.rotDeg : numOf(rot),
        repeat: repeat.checked,
        explode: explode.checked && !explode.disabled,
      };
    },
  });
}

/** 속성 값 받기: ATTREQ 0이면 기본값, ATTDIA 1이면 대화상자, 아니면 명령행(확인 속성은 두 번) */
async function attributeValues(app: App, ctx: CommandContext, def: BlockDef): Promise<Map<string, string> | null> {
  const values = new Map<string, string>();
  const defs = def.entities.filter((e): e is AttribEntity => e.type === 'ATTDEF' && !((e as AttribEntity).attFlags & 2));
  const askThese = defs.filter((d) => !(d.attFlags & 8));
  if (!askThese.length || !attReq(app)) return values;
  if (attDia()) {
    const ins = askThese.map((d) => (d.mtext ? areaIn(d.mtext.text.replace(/\\P/g, '\n'), d.tag, 2) : textIn(d.text, d.tag)));
    const body = h('div', { class: 'mgr-dlg' }, h('div', { class: 'mgr-note' }, `블록 이름: ${def.name}`), ...askThese.map((d, i) => row(d.prompt || d.tag, ins[i]!)));
    const r = await resultDialog('속성 편집', body, { width: 480, submit: () => ins.map((el) => el.value) });
    if (!r) return null;
    askThese.forEach((d, i) => values.set(d.tag, d.mtext ? r[i]!.replace(/\r?\n/g, '\\P') : r[i]!));
    return values;
  }
  ctx.print('속성 값 입력');
  const ask = (d: AttribEntity, cur: string) => askLine(ctx, `${d.prompt || d.tag}${cur ? ` <${cur}>` : ''}:`, cur);
  for (const d of askThese) values.set(d.tag, await ask(d, d.text));
  const verify = askThese.filter((d) => d.attFlags & 4);
  if (verify.length) {
    ctx.print('속성 값 확인');
    for (const d of verify) values.set(d.tag, await ask(d, values.get(d.tag) ?? ''));
  }
  return values;
}

/** 화면에서 축척(-INSERT와 같은 프롬프트) */
async function askScale(ctx: CommandContext, at: Pt, uniform: boolean): Promise<Vec3> {
  for (;;) {
    const r = await ctx.getPoint(`${uniform ? '축척 비율 지정' : 'X 축척 비율 입력, 반대 구석 지정, 또는 [구석(C)/XYZ(XYZ)]'} <${fmt4(1)}>:`, {
      base: at,
      preferNumber: true,
      allowText: true,
      keywords: uniform
        ? []
        : [
            { key: 'C', label: '구석' },
            { key: 'XYZ', label: 'XYZ' },
          ],
      rubber: uniform ? undefined : (q) => [{ pts: [at.x, at.y, q.x, at.y, q.x, q.y, at.x, q.y], closed: true, dashed: true }],
    });
    if ('enter' in r) return { x: 1, y: 1, z: 1 };
    if ('point' in r) {
      const x = r.point.x - at.x;
      const y = r.point.y - at.y;
      if (uniform) {
        const d = Math.hypot(x, y);
        if (d > 1e-12) return { x: d, y: d, z: d };
      } else if (Math.abs(x) > 1e-12 && Math.abs(y) > 1e-12) return { x, y, z: Math.abs(x) };
      ctx.print('값은 0이 아니어야 합니다.', 'err');
      continue;
    }
    if ('keyword' in r && r.keyword === 'XYZ') {
      const sx = await askReal(ctx, `X 축척 비율 지정 <${fmt4(1)}>:`, 1, nonZero);
      const sy = await askReal(ctx, 'Y 축척 비율 지정 <X 축척 비율 사용>:', sx, nonZero);
      const sz = await askReal(ctx, 'Z 축척 비율 지정 <X 축척 비율 사용>:', sx, nonZero);
      return { x: sx, y: sy, z: sz };
    }
    if ('keyword' in r && r.keyword === 'C') {
      const q = await ctx.getPoint('반대 구석 지정:', { base: at });
      if ('point' in q) {
        const x = q.point.x - at.x;
        const y = q.point.y - at.y;
        if (Math.abs(x) > 1e-12 && Math.abs(y) > 1e-12) return { x, y, z: Math.abs(x) };
      }
      continue;
    }
    if ('text' in r) {
      const v = Number(r.text.trim());
      if (Number.isFinite(v) && v !== 0) {
        if (uniform) return { x: v, y: v, z: Math.abs(v) };
        const sy = await askReal(ctx, 'Y 축척 비율 입력 <X 축척 비율 사용>:', v, nonZero);
        return { x: v, y: sy, z: Math.abs(v) };
      }
      ctx.print('숫자 값, 점 또는 옵션 키워드가 필요합니다.', 'err');
    }
  }
}

export async function runInsert(app: App, ctx: CommandContext, arg: string | undefined, make: MakeAttribs): Promise<void> {
  const st = app.active!;
  const blocks = insertable(st);
  if (!blocks.length) {
    ctx.print('이 도면에는 삽입할 블록이 없습니다. BLOCK 명령으로 먼저 만드십시오.', 'err');
    return;
  }
  const given = arg && st.doc.blocks.has(tableKey(arg)) ? st.doc.blocks.get(tableKey(arg))!.name : '';
  const prev = lastInsert.get(st);
  let v: InsertDialog = {
    name: given || (prev && st.doc.blocks.has(tableKey(prev.name)) ? prev.name : blocks[0]!.name),
    pointOnScreen: true,
    point: { x: 0, y: 0, z: 0 },
    scaleOnScreen: prev?.scaleOnScreen ?? false,
    scale: prev?.scale ?? { x: 1, y: 1, z: 1 },
    uniform: prev?.uniform ?? true,
    rotOnScreen: prev?.rotOnScreen ?? false,
    rotDeg: prev?.rotDeg ?? 0,
    repeat: prev?.repeat ?? false,
    explode: false,
  };
  if (!given) {
    const r = await insertDialog(app, st, v);
    if (!r) return;
    v = r;
    lastInsert.set(st, v);
  } else v = { ...v, scaleOnScreen: false, scale: { x: 1, y: 1, z: 1 }, rotOnScreen: false, rotDeg: 0, repeat: false };
  const def = st.doc.blocks.get(tableKey(v.name));
  if (!def) return;
  if (st.blockEdit && tableKey(st.blockEdit.name) === tableKey(def.name)) {
    ctx.print('블록을 자기 자신 안에 삽입할 수 없습니다.', 'err');
    return;
  }
  const rec = st.doc.blockRecords.get(tableKey(def.name));
  const f = insertUnitFactor(rec?.insertUnits ?? 0, Number(st.doc.header.get('$INSUNITS') ?? 0) || 0);
  if (f !== 1) ctx.print(`단위: ${INSUNITS_NAMES[rec?.insertUnits ?? 0]?.name ?? '단위 없음'}   변환:   ${fmt4(f)}`);
  for (;;) {
    let scale: Vec3 = { x: v.scale.x * f, y: v.scale.y * f, z: v.scale.z * f };
    let rot = v.rotDeg * D2R;
    const ghost = (p: Pt) => previewOf(app, [{ ...entityDefaults(), type: 'INSERT', handle: '', block: def.name, insert: { x: p.x, y: p.y, z: 0 }, scale, rotation: rot, columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0, attribs: [] } as InsertEntity]);
    let at: Vec3;
    if (v.pointOnScreen) {
      const r = await ctx.getPoint('삽입점 지정:', { ghost });
      if (!('point' in r)) return;
      at = { x: r.point.x, y: r.point.y, z: 0 };
    } else at = { ...v.point };
    if (v.scaleOnScreen) {
      const s = await askScale(ctx, at, v.uniform || (rec ? !rec.scalable : false));
      scale = { x: s.x * f, y: s.y * f, z: s.z * f };
    }
    if (v.rotOnScreen) {
      for (;;) {
        const r = await ctx.getPoint('회전 각도 지정 <0>:', { base: at, preferNumber: true, allowText: true });
        if ('enter' in r) {
          rot = 0;
          break;
        }
        if ('point' in r) {
          rot = Math.atan2(r.point.y - at.y, r.point.x - at.x);
          break;
        }
        if ('text' in r && Number.isFinite(Number(r.text))) {
          rot = Number(r.text) * D2R;
          break;
        }
        ctx.print('각도 또는 점이 필요합니다.', 'err');
      }
    }
    const handle = st.session.newHandle();
    const ins: InsertEntity = {
      ...entityDefaults(),
      ...currentProps(app),
      type: 'INSERT',
      handle,
      block: def.name,
      insert: at,
      scale,
      rotation: rot,
      columnCount: 1,
      rowCount: 1,
      columnSpacing: 0,
      rowSpacing: 0,
      attribs: [],
    };
    if (v.explode) {
      ins.handle = '';
      const r = explodeEntity(ins, st.doc);
      if (!r.add?.length) {
        ctx.print(r.message ?? '분해할 수 없는 블록입니다.', 'err');
        return;
      }
      const res = commitResults(app, ctx, [{ add: r.add, blocks: r.blocks }], 'INSERT', { quiet: true });
      app.lastCreated = res.added;
      ctx.print(`블록 "${def.name}"을(를) 분해해서 객체 ${res.added.length}개로 넣었습니다.`);
    } else {
      const values = await attributeValues(app, ctx, def);
      if (!values) return;
      ins.attribs = make(def, at, scale, rot, values, handle);
      app.lastCreated = addEntities(app, ctx, [ins], 'INSERT');
    }
    if (!v.repeat || !v.pointOnScreen) return;
  }
}

// ---------------------------------------------------------------------------
// ATTDEF
// ---------------------------------------------------------------------------

/** 문서별 직전 속성 정의(이전 속성 정의 아래에 정렬) */
const lastAttdef = new WeakMap<DocState, string>();

interface AttdefForm {
  invisible: boolean;
  constant: boolean;
  verify: boolean;
  preset: boolean;
  lock: boolean;
  tag: string;
  prompt: string;
  value: string;
  onScreen: boolean;
  point: Vec3;
  just: string;
  style: string;
  height: number;
  rotDeg: number;
  alignBelow: boolean;
}

const lastAttdefForm = new WeakMap<DocState, AttdefForm>();

function attdefDialog(st: DocState, v: AttdefForm, prevAtt: AttribEntity | null): Promise<AttdefForm | null> {
  const inv = checkIn(v.invisible, '보이지 않음');
  const con = checkIn(v.constant, '상수');
  const ver = checkIn(v.verify, '확인');
  const pre = checkIn(v.preset, '사전 설정');
  const lock = checkIn(v.lock, '위치 잠금');
  const tag = textIn(v.tag, '태그');
  const prompt = textIn(v.prompt, '프롬프트');
  const value = textIn(v.value, '기본값');
  const onScreen = checkIn(v.onScreen, '화면상에 지정');
  const px = numIn(v.point.x, 'X');
  const py = numIn(v.point.y, 'Y');
  const pz = numIn(v.point.z, 'Z');
  const just = selectIn(
    TEXT_JUSTIFY.map(([k, l]) => ({ value: k, label: l })),
    v.just,
    '자리맞추기',
  );
  const styles = [...st.doc.textStyles.values()].filter((s) => s.name && !(s.flags & 1)).map((s) => s.name);
  const style = selectIn(styles.map((n) => ({ value: n, label: n })), v.style, '문자 스타일');
  const height = numIn(v.height, '문자 높이');
  const rot = numIn(v.rotDeg, '회전');
  const below = checkIn(v.alignBelow && !!prevAtt, '이전 속성 정의 아래에 정렬');
  below.disabled = !prevAtt;
  const sync = () => {
    const b = below.checked;
    for (const el of [px, py, pz]) el.disabled = b || onScreen.checked;
    onScreen.disabled = b;
    just.disabled = style.disabled = height.disabled = rot.disabled = b;
    ver.disabled = pre.disabled = con.checked;
    prompt.disabled = con.checked;
  };
  for (const el of [below, onScreen, con]) el.addEventListener('change', sync);
  sync();
  const body = h(
    'div',
    { class: 'mgr-dlg' },
    h(
      'div',
      { class: 'mgr-cols' },
      group('모드', row('보이지 않음(I)', inv), row('상수(C)', con), row('확인(V)', ver), row('사전 설정(P)', pre), row('위치 잠금(K)', lock)),
      group('속성', row('태그(T)', tag), row('프롬프트(M)', prompt), row('기본값(L)', value)),
    ),
    h(
      'div',
      { class: 'mgr-cols' },
      group('삽입점', row('화면상에 지정(O)', onScreen), row('X', px), row('Y', py), row('Z', pz)),
      group('문자 설정', row('자리맞추기(J)', just), row('문자 스타일(S)', style), row('문자 높이(E)', height), row('회전(R)', rot)),
    ),
    row('이전 속성 정의 아래에 정렬(A)', below),
  );
  return resultDialog<AttdefForm>('속성 정의', body, {
    width: 660,
    submit: () => {
      const t = tag.value.trim();
      if (!t) return fail('태그를 입력하십시오.');
      if (/\s/.test(t)) return fail('태그에는 빈칸을 쓸 수 없습니다.');
      if (!below.checked && !(numOf(height) > 0)) return fail('문자 높이는 0보다 커야 합니다.');
      if (!below.checked && !Number.isFinite(numOf(rot))) return fail('회전: 숫자를 입력하십시오.');
      if (!onScreen.checked && !below.checked && ![numOf(px), numOf(py), numOf(pz)].every(Number.isFinite)) return fail('삽입점: 숫자를 입력하십시오.');
      return {
        invisible: inv.checked,
        constant: con.checked,
        verify: ver.checked && !con.checked,
        preset: pre.checked && !con.checked,
        lock: lock.checked,
        tag: t,
        prompt: con.checked ? '' : prompt.value,
        value: value.value,
        onScreen: onScreen.checked,
        point: { x: numOf(px) || 0, y: numOf(py) || 0, z: numOf(pz) || 0 },
        just: just.value,
        style: style.value,
        height: numOf(height),
        rotDeg: numOf(rot),
        alignBelow: below.checked,
      };
    },
  });
}

/** 이전 속성 정의 아래 줄의 자리(같은 자리맞추기·스타일·높이·회전, 줄 간격 = 높이 × 5/3) */
export function belowPrevious(prev: AttribEntity): { insert: Vec3; alignPoint?: Vec3 } {
  const d = prev.height * (5 / 3);
  const dx = Math.sin(prev.rotation) * d;
  const dy = -Math.cos(prev.rotation) * d;
  const mv = (p: Vec3): Vec3 => ({ x: p.x + dx, y: p.y + dy, z: p.z });
  return { insert: mv(prev.insert), alignPoint: prev.alignPoint ? mv(prev.alignPoint) : undefined };
}

async function runAttdef(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  const defH = Number(doc.header.get('$TEXTSIZE') ?? 2.5) || 2.5;
  const styleName = String(doc.header.get('$TEXTSTYLE') ?? 'Standard');
  const prevH = lastAttdef.get(st);
  const prevE = prevH ? doc.entityIndex.get(prevH) : undefined;
  const prevAtt = prevE?.type === 'ATTDEF' ? (prevE as AttribEntity) : null;
  const memo = lastAttdefForm.get(st);
  const v = await attdefDialog(
    st,
    {
      invisible: memo?.invisible ?? false,
      constant: memo?.constant ?? false,
      verify: memo?.verify ?? false,
      preset: memo?.preset ?? false,
      lock: memo?.lock ?? true,
      tag: '',
      prompt: '',
      value: '',
      onScreen: true,
      point: { x: 0, y: 0, z: 0 },
      just: memo?.just ?? 'L',
      style: doc.textStyles.get(tableKey(memo?.style ?? styleName))?.name ?? styleName,
      height: memo?.height ?? defH,
      rotDeg: memo?.rotDeg ?? 0,
      alignBelow: !!prevAtt,
    },
    prevAtt,
  );
  if (!v) return;
  lastAttdefForm.set(st, v);
  const J = TEXT_JUSTIFY.find((x) => x[0] === v.just) ?? TEXT_JUSTIFY[0]!;
  let halign = J[2] as TextHAlign;
  let valign = J[3] as TextVAlign;
  let insert: Vec3;
  let alignPoint: Vec3 | undefined;
  let height = v.height;
  let rotation = v.rotDeg * D2R;
  let style = v.style;
  if (v.alignBelow && prevAtt) {
    const p = belowPrevious(prevAtt);
    insert = p.insert;
    alignPoint = p.alignPoint;
    halign = prevAtt.halign;
    valign = prevAtt.valign;
    height = prevAtt.height;
    rotation = prevAtt.rotation;
    style = prevAtt.style;
  } else if (v.onScreen) {
    const r = await ctx.getPoint(halign === 0 && valign === 0 ? '시작점 지정:' : J[4]);
    if (!('point' in r)) return;
    insert = { x: r.point.x, y: r.point.y, z: 0 };
    if (halign === 3 || halign === 5) {
      const r2 = await ctx.getPoint('문자 기준선의 두 번째 끝점 지정:', { base: r.point, rubber: (q) => [{ pts: [r.point.x, r.point.y, q.x, q.y] }] });
      if (!('point' in r2)) return;
      alignPoint = { x: r2.point.x, y: r2.point.y, z: 0 };
      rotation = Math.atan2(r2.point.y - r.point.y, r2.point.x - r.point.x);
    } else if (halign !== 0 || valign !== 0) alignPoint = { ...insert };
  } else {
    insert = { ...v.point };
    if (halign !== 0 || valign !== 0) alignPoint = { ...insert };
  }
  const att: AttribEntity = {
    ...entityDefaults(),
    ...currentProps(app),
    type: 'ATTDEF',
    handle: '',
    insert,
    alignPoint,
    height,
    text: v.value,
    rotation,
    widthFactor: doc.textStyles.get(tableKey(style))?.widthFactor || 1,
    oblique: doc.textStyles.get(tableKey(style))?.oblique ?? 0,
    style,
    generation: 0,
    halign,
    valign,
    tag: v.tag.toUpperCase(),
    prompt: v.prompt || undefined,
    attFlags: (v.invisible ? 1 : 0) | (v.constant ? 2 : 0) | (v.verify ? 4 : 0) | (v.preset ? 8 : 0),
    lockPosition: v.lock || undefined,
  };
  const [h0] = addEntities(app, ctx, [att as Entity], 'ATTDEF');
  if (h0) lastAttdef.set(st, h0);
}

// ---------------------------------------------------------------------------
// 향상된 속성 편집기(EATTEDIT)
// ---------------------------------------------------------------------------

/** 자리맞추기 열쇠 → (가로, 세로) — 모듈 순환에서도 안전하게 부를 때 만든다 */
const HJ = (k: string): [TextHAlign, TextVAlign] => {
  const j = TEXT_JUSTIFY.find((x) => x[0] === k);
  return j ? [j[2], j[3]] : [0, 0];
};
const justKey = (a: AttribEntity) => TEXT_JUSTIFY.find((x) => x[2] === a.halign && x[3] === a.valign)?.[0] ?? 'L';

/** 블록 참조의 속성을 향상된 속성 편집기로 고친다(속성·문자 옵션·특성 탭). 바꿨으면 true */
export async function enhancedAttributeEditor(app: App, ctx: CommandContext | null, handle: string): Promise<boolean> {
  const st = app.active!;
  const e = st.doc.entityIndex.get(handle);
  if (e?.type !== 'INSERT' || !e.attribs.length) {
    (ctx ?? app.cmd).print('속성이 있는 블록이 아닙니다.', 'err');
    return false;
  }
  if (!unlockedOnly(app, [handle]).length) return false;
  const after = cloneEntity(e) as InsertEntity;
  const vis = after.attribs.filter((a) => !(a.attFlags & 2));
  if (!vis.length) {
    (ctx ?? app.cmd).print('편집할 수 있는 속성이 없습니다.', 'err');
    return false;
  }
  const def = st.doc.blocks.get(tableKey(e.block));
  const promptOf = (a: AttribEntity) => (def?.entities.find((x) => x.type === 'ATTDEF' && (x as AttribEntity).tag === a.tag) as AttribEntity | undefined)?.prompt ?? a.tag;
  let cur = vis[0]!;
  // 속성 탭
  const valueIn = textIn(cur.mtext ? cur.mtext.text.replace(/\\P/g, '\n') : cur.text, '값');
  const list = pickList<AttribEntity>(['태그', '프롬프트', '값'], (a) => [a.tag, promptOf(a), a.mtext ? a.mtext.text.replace(/\\P/g, ' ') : a.text], {
    height: 160,
    onPick: (a) => {
      if (!a) return;
      store();
      cur = a;
      load();
    },
  });
  // 문자 옵션 탭
  const styles = [...st.doc.textStyles.values()].filter((s) => s.name && !(s.flags & 1)).map((s) => s.name);
  const style = selectIn(styles.map((n) => ({ value: n, label: n })), cur.style, '문자 스타일');
  const just = selectIn(TEXT_JUSTIFY.map(([k, l]) => ({ value: k, label: l })), justKey(cur), '자리맞추기');
  const height = numIn(cur.height, '높이');
  const rot = numIn(cur.rotation / D2R, '회전');
  const wf = numIn(cur.widthFactor || 1, '폭 비율');
  const obl = numIn((cur.oblique || 0) / D2R, '기울기 각도');
  const back = checkIn((cur.generation & 2) !== 0, '반대로');
  const upside = checkIn((cur.generation & 4) !== 0, '거꾸로');
  // 특성 탭
  const layers = [...st.doc.layers.values()].map((l) => l.name);
  const layer = selectIn(layers.map((n) => ({ value: n, label: n })), cur.layer, '도면층');
  const lts = [...new Set(['ByLayer', 'ByBlock', ...[...st.doc.linetypes.values()].map((l) => l.name)])];
  const linetype = selectIn(lts.map((n) => ({ value: n, label: n })), cur.linetype || 'ByLayer', '선종류');
  const colorIn = textIn(colorText(cur.color), '색상');
  const lw = numIn(cur.lineweight, '선가중치');
  const err = h('div', { class: 'mgr-err' });
  function load(): void {
    valueIn.value = cur.mtext ? cur.mtext.text.replace(/\\P/g, '\n') : cur.text;
    style.value = cur.style;
    just.value = justKey(cur);
    height.value = String(+cur.height.toFixed(6));
    rot.value = String(+(cur.rotation / D2R).toFixed(6));
    wf.value = String(cur.widthFactor || 1);
    obl.value = String(+((cur.oblique || 0) / D2R).toFixed(6));
    back.checked = (cur.generation & 2) !== 0;
    upside.checked = (cur.generation & 4) !== 0;
    layer.value = cur.layer;
    linetype.value = cur.linetype || 'ByLayer';
    colorIn.value = colorText(cur.color);
    lw.value = String(cur.lineweight);
  }
  function store(): string | null {
    const t = valueIn.value;
    if (cur.mtext) cur.mtext.text = t.replace(/\r?\n/g, '\\P');
    cur.text = t.replace(/\r?\n/g, ' ');
    const nh = numOf(height);
    const nr = numOf(rot);
    const nw = numOf(wf);
    const no = numOf(obl);
    if (!(nh > 0)) return '높이는 0보다 커야 합니다.';
    if (!(nw > 0)) return '폭 비율은 0보다 커야 합니다.';
    if (!Number.isFinite(nr) || !Number.isFinite(no) || Math.abs(no) > 85) return '각도가 맞지 않습니다(기울기는 -85~85도).';
    const col = parseColor(colorIn.value);
    if (!col) return '색상: BYLAYER·BYBLOCK·1~255 또는 R,G,B를 입력하십시오.';
    const [hh, vv] = HJ(just.value);
    if ((hh !== cur.halign || vv !== cur.valign) && (hh !== 0 || vv !== 0) && !cur.alignPoint) cur.alignPoint = { ...cur.insert };
    cur.halign = hh;
    cur.valign = vv;
    // 높이·회전은 문자 기준점(정렬점)을 두고 바꾼다
    cur.height = nh;
    cur.rotation = nr * D2R;
    cur.widthFactor = nw;
    cur.oblique = no * D2R;
    cur.style = style.value;
    cur.generation = (cur.generation & ~6) | (back.checked ? 2 : 0) | (upside.checked ? 4 : 0);
    cur.layer = layer.value;
    cur.linetype = linetype.value;
    cur.color = col;
    cur.lineweight = Number.isFinite(numOf(lw)) ? numOf(lw) : cur.lineweight;
    if (cur.mtext) {
      cur.mtext.height = nh;
      cur.mtext.rotation = cur.rotation;
      cur.mtext.style = cur.style;
      cur.mtext.layer = cur.layer;
      cur.mtext.color = cur.color;
    }
    return null;
  }
  const t = tabs([
    { label: '속성', body: h('div', { class: 'mgr-dlg' }, list.el, row('값(V)', valueIn)) },
    { label: '문자 옵션', body: h('div', { class: 'mgr-dlg' }, row('문자 스타일(S)', style), row('자리맞추기(J)', just), row('높이(E)', height), row('회전(R)', rot), row('폭 비율(W)', wf), row('기울기 각도(O)', obl), row('반대로(K)', back), row('거꾸로(D)', upside)) },
    { label: '특성', body: h('div', { class: 'mgr-dlg' }, row('도면층(L)', layer), row('선종류(T)', linetype), row('색상(C)', colorIn), row('선가중치(W)', lw)) },
  ]);
  list.refresh(vis);
  list.select((a) => a === cur);
  const ok = await resultDialog(`향상된 속성 편집기 — 블록: ${e.block}`, h('div', { class: 'mgr-dlg' }, t.el, err), {
    width: 560,
    submit: () => {
      const m = store();
      return m ? fail(m) : true;
    },
  });
  if (!ok) return false;
  if (JSON.stringify(after) === JSON.stringify(e)) return false;
  const block = st.session.ownerOf(handle);
  if (!block) return false;
  st.session.commit({ label: 'EATTEDIT', ops: [{ kind: 'modify', block, before: e, after }] });
  return true;
}

function colorText(c: CadColor): string {
  if (c.rgb !== undefined) return `${(c.rgb >> 16) & 255},${(c.rgb >> 8) & 255},${c.rgb & 255}`;
  if (c.aci === 256) return 'BYLAYER';
  if (c.aci === 0) return 'BYBLOCK';
  return String(c.aci);
}

function parseColor(t: string): CadColor | null {
  const s = t.trim().toUpperCase();
  if (s === 'BYLAYER') return { aci: 256 };
  if (s === 'BYBLOCK') return { aci: 0 };
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n >= 1 && n <= 255 ? { aci: n } : null;
  }
  const m = /^(\d{1,3}),(\d{1,3}),(\d{1,3})$/.exec(s);
  if (m) {
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (r > 255 || g > 255 || b > 255) return null;
    return { aci: 7, rgb: (r << 16) | (g << 8) | b };
  }
  return null;
}

export function registerInsertAttdef(app: App, make: MakeAttribs): void {
  app.register({ name: 'INSERT', aliases: ['I', 'DDINSERT', 'CLASSICINSERT'], title: '블록 삽입', run: (ctx, arg) => runInsert(app, ctx, arg, make) });
  app.register({ name: 'ATTDEF', aliases: ['ATT', 'DDATTDEF'], title: '속성 정의', run: (ctx) => runAttdef(app, ctx) });
}
