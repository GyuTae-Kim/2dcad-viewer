/**
 * 필드 명령: FIELD(필드 대화상자 → 필드가 든 여러 줄 문자), UPDATEFIELD(필드 다시 계산), FIELDDISPLAY(필드 배경 표시 변수).
 * 프롬프트는 AutoCAD 2026 한국어판을 따른다. 필드 코드 해석·평가는 src/edit/field의 순수 함수가 한다.
 */
import type { CadDocument, Entity, MTextEntity } from '../core/model';
import { tableKey } from '../core/model';
import type { EditOp } from '../edit/session';
import type { App, CommandContext, Keyword } from './app';
import { CancelError } from './app';
import type { DocState } from './docstate';
import { currentProps } from './draw';
import { dialog, h } from './ui/dom';
import { objectField, varField } from '../edit/field/code';
import { type FieldContext, evaluateTemplate, objectProperty } from '../edit/field/evaluate';
import { formatDate } from '../edit/field/format';
import { applyTemplate, fieldTemplate, isFieldHost, updateEntityFields } from '../edit/field/store';

// ---------------------------------------------------------------------------
// FIELDDISPLAY(필드 배경 표시): AutoCAD처럼 도면이 아니라 사용자 설정이다
// ---------------------------------------------------------------------------

const DISPLAY_KEY = 'opencad.fielddisplay';
let display: number | null = null;
const displayListeners = new Set<(v: number) => void>();

/** FIELDDISPLAY 값(0 끔, 1 회색 배경). 화면 그리기가 읽는다 */
export function fieldDisplay(): number {
  if (display === null) {
    try {
      const v = localStorage.getItem(DISPLAY_KEY);
      display = v === '0' ? 0 : 1;
    } catch {
      display = 1;
    }
  }
  return display;
}

export function setFieldDisplay(v: number): void {
  display = v ? 1 : 0;
  try {
    localStorage.setItem(DISPLAY_KEY, String(display));
  } catch {
    /* 저장할 수 없는 환경 */
  }
  for (const f of displayListeners) f(display);
}

/** 값이 바뀌면 알림(화면 다시 그리기 연결용) */
export function onFieldDisplayChange(f: (v: number) => void): () => void {
  displayListeners.add(f);
  return () => displayListeners.delete(f);
}

// ---------------------------------------------------------------------------
// FIELDEVAL(필드 자동 업데이트): 1 열기, 2 저장, 4 플롯, 8 eTransmit, 16 재생성. AutoCAD는 도면에 두지만 저장 자리를
// 확인할 실물이 없어 FIELDDISPLAY처럼 이 브라우저의 사용자 설정에 둔다(기본 31 = 모두)
// ---------------------------------------------------------------------------

const EVAL_KEY = 'opencad.fieldeval';
let evalBits: number | null = null;

export type FieldEvent = 'open' | 'save' | 'plot' | 'etransmit' | 'regen';
const EVENT_BIT: Record<FieldEvent, number> = { open: 1, save: 2, plot: 4, etransmit: 8, regen: 16 };

export function fieldEval(): number {
  if (evalBits === null) {
    try {
      const v = Number(localStorage.getItem(EVAL_KEY));
      evalBits = localStorage.getItem(EVAL_KEY) !== null && Number.isInteger(v) && v >= 0 && v <= 31 ? v : 31;
    } catch {
      evalBits = 31;
    }
  }
  return evalBits;
}

export function setFieldEval(v: number): void {
  evalBits = Math.max(0, Math.min(31, Math.round(v)));
  try {
    localStorage.setItem(EVAL_KEY, String(evalBits));
  } catch {
    /* 저장할 수 없는 환경 */
  }
}

/**
 * 저장·플롯·재생성 등에서 필드를 다시 계산한다(FIELDEVAL의 그 비트가 켜졌을 때). 바꾼 필드 수.
 * 저장 직전이면 저장 날짜·파일 이름이 저장할 이름으로 바뀐다. 명령 취소 한 단계(UPDATEFIELD)로 확정한다.
 * 저장·플롯 명령이 시작할 때 부른다(그 명령 모듈이 이 함수를 부르게 리드가 잇는다).
 */
export function updateFieldsOn(app: App, event: FieldEvent, opt: { fileName?: string } = {}): number {
  const st = app.active;
  if (!st || !(fieldEval() & EVENT_BIT[event])) return 0;
  const r = fieldUpdateOps(st, undefined, opt.fileName);
  if (r.ops.length) st.session.commit({ label: 'UPDATEFIELD', ops: r.ops });
  return r.ops.length;
}

// ---------------------------------------------------------------------------
// 평가 환경
// ---------------------------------------------------------------------------

export function fieldContext(st: DocState, fileName?: string): FieldContext {
  return { doc: st.doc, fileName: fileName || st.saveName || st.name, fileSize: st.size, now: new Date() };
}

/**
 * 도면(또는 고른 객체)의 필드를 다시 계산하는 작업. 저장 직전(SaveDate·Filename)이나 REGEN에서 리더가 부를 수 있다.
 * handles가 없으면 모든 블록의 문자를 본다.
 */
export function fieldUpdateOps(st: DocState, handles?: Iterable<string>, fileName?: string): { ops: EditOp[]; found: number; updated: number; stale: number } {
  const ctx = fieldContext(st, fileName);
  const ops: EditOp[] = [];
  let found = 0;
  let updated = 0;
  let stale = 0;
  const visit = (block: string, e: Entity) => {
    const r = updateEntityFields(e, ctx);
    found += r.fields;
    stale += r.stale;
    // AutoCAD처럼 다시 계산한 필드를 모두 센다(값이 같아도)
    if (!r.stale) updated += r.fields;
    if (r.changed) ops.push({ kind: 'modify', block, before: e, after: r.entity });
  };
  if (handles) {
    for (const hd of handles) {
      const e = st.doc.entityIndex.get(hd);
      const b = st.session.ownerOf(hd);
      if (e && b) visit(b, e);
    }
  } else for (const [k, b] of st.doc.blocks) for (const e of b.entities) visit(k, e);
  return { ops, found, updated, stale };
}

// ---------------------------------------------------------------------------
// 필드 대화상자
// ---------------------------------------------------------------------------

type FieldKind = 'date' | 'file' | 'text' | 'size' | 'object' | 'sysvar';

interface FieldDef {
  id: string;
  cat: 'date' | 'doc' | 'obj' | 'etc';
  label: string;
  kind: FieldKind;
}

const CATEGORIES: { value: string; label: string }[] = [
  { value: 'all', label: '모두' },
  { value: 'date', label: '날짜 및 시간' },
  { value: 'doc', label: '문서' },
  { value: 'obj', label: '객체' },
  { value: 'etc', label: '기타' },
];

const FIELDS: FieldDef[] = [
  { id: 'CreateDate', cat: 'date', label: '작성 날짜', kind: 'date' },
  { id: 'Date', cat: 'date', label: '날짜', kind: 'date' },
  { id: 'SaveDate', cat: 'date', label: '저장 날짜', kind: 'date' },
  { id: 'LastSavedBy', cat: 'doc', label: '마지막 저장자', kind: 'text' },
  { id: 'Author', cat: 'doc', label: '작성자', kind: 'text' },
  { id: 'Title', cat: 'doc', label: '제목', kind: 'text' },
  { id: 'Comments', cat: 'doc', label: '주석', kind: 'text' },
  { id: 'Subject', cat: 'doc', label: '주제', kind: 'text' },
  { id: 'Keywords', cat: 'doc', label: '키워드', kind: 'text' },
  { id: 'Filename', cat: 'doc', label: '파일 이름', kind: 'file' },
  { id: 'FileSize', cat: 'doc', label: '파일 크기', kind: 'size' },
  { id: 'HyperlinkBase', cat: 'doc', label: '하이퍼링크 기준', kind: 'text' },
  { id: 'Object', cat: 'obj', label: '객체', kind: 'object' },
  { id: 'SysVar', cat: 'etc', label: '시스템 변수', kind: 'sysvar' },
];

const DATE_FORMATS = ['yyyy-MM-dd', 'yyyy.MM.dd', 'yy-MM-dd', 'M/d/yyyy', 'yyyy년 M월 d일', 'yyyy년 M월 d일 dddd', 'yyyy-MM-dd HH:mm', 'tt h:mm', 'HH:mm:ss'];

const CASES = [
  { value: '', label: '(없음)' },
  { value: '%tc1', label: '대문자' },
  { value: '%tc2', label: '소문자' },
  { value: '%tc3', label: '첫 대문자' },
  { value: '%tc4', label: '제목 대소문자' },
];

const OBJECT_PROPS: { id: string; label: string }[] = [
  { id: 'Area', label: '면적' },
  { id: 'Length', label: '길이' },
  { id: 'Circumference', label: '원주' },
  { id: 'Radius', label: '반지름' },
  { id: 'Diameter', label: '지름' },
  { id: 'Angle', label: '각도' },
  { id: 'Rotation', label: '회전' },
  { id: 'Height', label: '높이' },
  { id: 'Layer', label: '도면층' },
  { id: 'Linetype', label: '선종류' },
  { id: 'TextString', label: '문자 내용' },
  { id: 'Name', label: '이름' },
];

const TYPE_LABEL: Record<string, string> = {
  LINE: '선',
  CIRCLE: '원',
  ARC: '호',
  ELLIPSE: '타원',
  LWPOLYLINE: '폴리선',
  POLYLINE: '폴리선',
  SPLINE: '스플라인',
  TEXT: '문자',
  MTEXT: '여러 줄 문자',
  INSERT: '블록 참조',
  HATCH: '해치',
  POINT: '점',
  DIMENSION: '치수',
};

const SEL_CSS = 'width:100%;box-sizing:border-box;background:var(--bg-input);color:var(--text);border:1px solid var(--border-soft);border-radius:3px;font:inherit';
const IN_CSS = SEL_CSS + ';height:26px;padding:0 6px';

/**
 * 필드 대화상자. 확인하면 필드 코드(%<…>%)를 돌려준다. 객체 선택 단추는 대화상자를 잠시 숨기고 도면에서 고르게 한다.
 */
export function fieldDialog(app: App, ctx?: CommandContext, initial?: string): Promise<string | null> {
  const st = app.active!;
  const doc = st.doc;
  const fctx = fieldContext(st);
  return new Promise((resolve) => {
    let done = false;
    const cat = h('select', { 'aria-label': '필드 범주', style: IN_CSS }, ...CATEGORIES.map((c) => h('option', { value: c.value }, c.label)));
    const names = h('select', { size: 12, 'aria-label': '필드 이름', style: SEL_CSS + ';min-height:220px' });
    const opts = h('div', { style: 'display:flex;flex-direction:column;gap:6px' });
    const preview = h('div', { style: 'padding:4px 6px;min-height:22px;background:var(--bg-input);border:1px solid var(--border-soft);border-radius:3px;white-space:pre-wrap' });
    const expr = h('div', { style: 'font:12px var(--mono);color:var(--text-dim);word-break:break-all' });
    const err = h('div', { class: 'form-error', role: 'alert' });
    let code = '';
    let objHandle: string | null = null;
    const fillNames = () => {
      const c = cat.value;
      const list = FIELDS.filter((f) => c === 'all' || f.cat === c).sort((a, b) => a.label.localeCompare(b.label, 'ko'));
      const keep = names.value;
      names.innerHTML = '';
      for (const f of list) names.append(h('option', { value: f.id }, f.label));
      names.value = list.some((f) => f.id === keep) ? keep : (list[0]?.id ?? '');
      buildOptions();
    };
    const row = (label: string, el: HTMLElement) => h('label', { style: 'display:grid;grid-template-columns:90px 1fr;align-items:center;gap:6px' }, h('span', { style: 'color:var(--text-dim)' }, label), el);
    const select = (label: string, options: { value: string; label: string }[], value = '') => {
      const s = h('select', { 'aria-label': label, style: IN_CSS }, ...options.map((o) => h('option', { value: o.value }, o.label)));
      s.value = value || options[0]?.value || '';
      s.addEventListener('change', update);
      return s;
    };
    const input = (label: string, value: string) => {
      const i = h('input', { type: 'text', 'aria-label': label, style: IN_CSS });
      i.value = value;
      i.addEventListener('input', update);
      i.addEventListener('keydown', (ev) => ev.stopPropagation());
      return i;
    };
    let read: () => string = () => '';
    const precisionOptions = Array.from({ length: 9 }, (_, i) => ({ value: String(i), label: i === 0 ? '0' : `0.${'0'.repeat(i)}` }));
    function buildOptions(): void {
      opts.innerHTML = '';
      const def = FIELDS.find((f) => f.id === names.value);
      if (!def) {
        read = () => '';
        return update();
      }
      switch (def.kind) {
        case 'date': {
          const fmt = input('날짜 형식', DATE_FORMATS[0]!);
          const ex = h('select', { size: 6, 'aria-label': '예', style: SEL_CSS }, ...DATE_FORMATS.map((f) => h('option', { value: f }, `${formatDate(fctx.now, f)}   (${f})`)));
          ex.addEventListener('change', () => {
            fmt.value = ex.value;
            update();
          });
          opts.append(row('날짜 형식', fmt), row('예', ex));
          read = () => varField(def.id, fmt.value.trim());
          break;
        }
        case 'file': {
          const which = select('형식', [
            { value: '2', label: '파일 이름만' },
            { value: '1', label: '경로만' },
            { value: '3', label: '경로 및 파일 이름' },
          ]);
          const ext = h('input', { type: 'checkbox', 'aria-label': '파일 확장자 표시' });
          ext.checked = true;
          ext.addEventListener('change', update);
          const tc = select('대소문자', CASES);
          opts.append(row('형식', which), h('label', { style: 'display:flex;gap:6px;align-items:center' }, ext, '파일 확장자 표시'), row('대소문자', tc));
          read = () => {
            const bits = Number(which.value) | (ext.checked && which.value !== '1' ? 4 : 0);
            return varField('Filename', `${tc.value}%fn${bits}`);
          };
          break;
        }
        case 'text':
        case 'size': {
          const tc = def.kind === 'text' ? select('형식', CASES) : null;
          if (tc) opts.append(row('형식', tc));
          if (def.kind === 'text') opts.append(h('div', { class: 'form-note' }, '문서 특성 값은 도면 머리말 변수($AUTHOR 등)에서 읽습니다. 값이 없으면 ----로 표시됩니다.'));
          read = () => varField(def.id, tc?.value ?? '');
          break;
        }
        case 'object': {
          const who = h('div', { style: 'color:var(--text-dim)' }, objHandle ? describe(doc, objHandle) : '객체를 선택하십시오.');
          const pick = h('button', { class: 'btn', type: 'button', disabled: !ctx, title: ctx ? '' : '명령 안에서만 객체를 고를 수 있습니다' }, '객체 선택');
          const props = select('특성', []);
          const prec = select('정밀도', precisionOptions, '2');
          const fillProps = () => {
            const e = objHandle ? doc.entityIndex.get(objHandle) : undefined;
            const keep = props.value;
            props.innerHTML = '';
            for (const p of OBJECT_PROPS) if (e && objectProperty(e, p.id)) props.append(h('option', { value: p.id }, p.label));
            if ([...props.options].some((o) => o.value === keep)) props.value = keep;
          };
          pick.addEventListener('click', async () => {
            if (!ctx) return;
            back.style.display = 'none';
            try {
              const r = await ctx.getEntity('객체 선택:');
              if ('handle' in r) objHandle = r.handle;
            } catch (e) {
              if (!(e instanceof CancelError)) throw e;
            } finally {
              back.style.display = '';
            }
            who.textContent = objHandle ? describe(doc, objHandle) : '객체를 선택하십시오.';
            fillProps();
            update();
          });
          fillProps();
          opts.append(h('div', { style: 'display:flex;gap:8px;align-items:center' }, pick, who), row('특성', props), row('정밀도', prec));
          read = () => {
            if (!objHandle || !props.value) return '';
            const e = doc.entityIndex.get(objHandle);
            const v = e ? objectProperty(e, props.value) : null;
            const fmt = v && 'num' in v ? `%lu2%pr${prec.value}` : '';
            return objectField(objHandle, props.value, fmt);
          };
          break;
        }
        case 'sysvar': {
          const vars = [...doc.header.keys()]
            .filter((k) => typeof doc.header.get(k) !== 'object')
            .map((k) => k.slice(1))
            .sort();
          const v = select(
            '시스템 변수',
            vars.map((k) => ({ value: k, label: k })),
            vars.includes('LTSCALE') ? 'LTSCALE' : '',
          );
          const prec = select('정밀도', precisionOptions, '2');
          opts.append(row('시스템 변수', v), row('정밀도', prec));
          read = () => {
            const val = doc.header.get(`$${v.value}`);
            return varField(v.value.toLowerCase(), typeof val === 'number' ? `%lu2%pr${prec.value}` : '');
          };
          break;
        }
      }
      update();
    }
    function update(): void {
      code = read();
      expr.textContent = code || '';
      if (!code) {
        preview.textContent = '';
        return;
      }
      const r = evaluateTemplate(code, fctx);
      preview.textContent = r.text;
    }
    cat.addEventListener('change', fillNames);
    names.addEventListener('change', buildOptions);
    const body = h(
      'div',
      {},
      h(
        'div',
        { style: 'display:grid;grid-template-columns:180px 1fr;gap:12px' },
        h('div', { style: 'display:flex;flex-direction:column;gap:6px' }, row('필드 범주', cat), names),
        h('div', { style: 'display:flex;flex-direction:column;gap:8px' }, opts, row('미리보기', preview)),
      ),
      h('div', { style: 'margin-top:10px;color:var(--text-dim)' }, '필드 표현식:'),
      expr,
      err,
    );
    const back = dialog('필드', body, [
      { label: '취소', run: () => ((done = true), resolve(null)) },
      {
        label: '확인',
        primary: true,
        run: () => {
          if (!code) {
            err.textContent = names.value === 'Object' ? '객체와 특성을 고르십시오.' : '필드를 고르십시오.';
            return true;
          }
          done = true;
          resolve(code);
        },
      },
    ]);
    const box = back.querySelector('.dialog') as HTMLElement | null;
    if (box) box.style.width = 'min(640px, 100%)';
    if (initial) {
      const m = /\\AcVar\s+(\w+)/.exec(initial);
      const f = m ? FIELDS.find((x) => x.id.toUpperCase() === m[1]!.toUpperCase()) : undefined;
      if (f) names.value = f.id;
    }
    fillNames();
    new MutationObserver((_, obs) => {
      if (!back.isConnected) {
        obs.disconnect();
        if (!done) resolve(null);
      }
    }).observe(document.body, { childList: true });
  });
}

function describe(doc: CadDocument, handle: string): string {
  const e = doc.entityIndex.get(handle);
  return e ? `${TYPE_LABEL[e.type] ?? e.type} (${handle})` : '객체를 선택하십시오.';
}

// ---------------------------------------------------------------------------
// 등록
// ---------------------------------------------------------------------------

const JUSTIFY: Keyword[] = [
  { key: 'TL', label: '왼쪽 위' },
  { key: 'TC', label: '중심 위' },
  { key: 'TR', label: '오른쪽 위' },
  { key: 'ML', label: '왼쪽 중간' },
  { key: 'MC', label: '중간 중심' },
  { key: 'MR', label: '오른쪽 중간' },
  { key: 'BL', label: '왼쪽 아래' },
  { key: 'BC', label: '중심 아래' },
  { key: 'BR', label: '오른쪽 아래' },
];

/** 여러 줄 문자 서식에서 일반 문자를 필드 템플릿에 넣을 때(이미 서식 문자이므로 그대로) */
function hostTemplate(e: Entity): string {
  const t = fieldTemplate(e);
  if (t !== null) return t;
  return 'text' in e && typeof e.text === 'string' ? e.text : '';
}

export function registerFieldCommands(app: App): void {
  // ------------------------------------------------------------- FIELD
  app.register({
    name: 'FIELD',
    title: '필드',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const code = await fieldDialog(app, ctx);
      if (!code) return;
      let height = Number(doc.header.get('$TEXTSIZE') ?? 2.5) || 2.5;
      let attachment = 1;
      for (;;) {
        const r = await ctx.getPoint('시작점 지정 또는 [높이(H)/자리맞추기(J)/문자에 추가(A)]:', {
          keywords: [
            { key: 'H', label: '높이' },
            { key: 'J', label: '자리맞추기' },
            { key: 'A', label: '문자에 추가' },
          ],
        });
        if ('enter' in r) return;
        if ('keyword' in r) {
          if (r.keyword === 'H') {
            const v = await ctx.getPoint(`높이 지정 <${+height.toFixed(4)}>:`, { preferNumber: true });
            const n = 'text' in v ? Number(v.text) : NaN;
            if (n > 0) height = n;
            else if (!('enter' in v)) ctx.print('0보다 큰 값을 입력하십시오.', 'err');
            continue;
          }
          if (r.keyword === 'J') {
            const v = await ctx.getPoint(`자리맞추기 입력 [${JUSTIFY.map((k) => `${k.label}(${k.key})`).join('/')}] <${JUSTIFY[attachment - 1]!.label}(${JUSTIFY[attachment - 1]!.key})>:`, { keywords: JUSTIFY });
            if ('keyword' in v) attachment = JUSTIFY.findIndex((k) => k.key === v.keyword) + 1;
            continue;
          }
          // 기존 문자 끝에 필드를 붙인다
          const pick = await ctx.getEntity('문자, 여러 줄 문자 또는 속성 정의 선택:');
          if (!('handle' in pick)) continue;
          const e = doc.entityIndex.get(pick.handle);
          const block = st.session.ownerOf(pick.handle);
          if (!isFieldHost(e) || !block) {
            ctx.print('문자 객체가 아닙니다.', 'err');
            continue;
          }
          if (doc.layers.get(tableKey(e.layer))?.locked) {
            ctx.print('객체가 잠긴 도면층에 있습니다.', 'err');
            continue;
          }
          const after = applyTemplate(e, hostTemplate(e) + code, fieldContext(st));
          st.session.commit({ label: 'FIELD', ops: [{ kind: 'modify', block, before: e, after }] });
          ctx.print(`필드를 넣었습니다: ${after.text}`);
          return;
        }
        if (!('point' in r)) continue;
        const style = String(doc.header.get('$TEXTSTYLE') ?? 'Standard');
        const base: MTextEntity = {
          ...currentProps(app),
          type: 'MTEXT',
          handle: st.session.newHandle(),
          insert: { x: r.point.x, y: r.point.y, z: 0 },
          height,
          width: 0,
          attachment,
          drawingDirection: 1,
          text: '',
          style: doc.textStyles.get(tableKey(style))?.name ?? style,
          rotation: 0,
          lineSpacingStyle: 1,
          lineSpacingFactor: 1,
          backgroundFlags: 0,
          backgroundScale: 1.5,
        };
        const m = applyTemplate(base, code, fieldContext(st));
        const space = doc.blocks.get(st.space);
        if (space?.recordHandle) m.owner = space.recordHandle;
        st.session.commit({ label: 'FIELD', ops: [{ kind: 'add', block: st.space, entity: m }], group: ctx.group });
        app.lastCreated = [m.handle];
        return;
      }
    },
  });

  // ------------------------------------------------------------- UPDATEFIELD
  app.register({
    name: 'UPDATEFIELD',
    title: '필드 업데이트',
    async run(ctx) {
      const st = app.active!;
      const hs = await ctx.getSelection('객체 선택:');
      if (!hs.length) return;
      const r = fieldUpdateOps(st, hs);
      ctx.print(`${r.found}개의 필드를 찾았습니다.`);
      if (r.ops.length) st.session.commit({ label: 'UPDATEFIELD', ops: r.ops });
      if (r.stale) ctx.print(`다른 명령이 내용을 바꾼 문자 ${r.stale}개는 필드를 문자로 바꿨습니다.`);
      ctx.print(`${r.updated}개의 필드를 업데이트했습니다.`);
      app.clearSelection();
    },
  });

  // ------------------------------------------------------------- FIELDEVAL
  app.register({
    name: 'FIELDEVAL',
    title: '필드 자동 업데이트',
    transparent: true,
    noDoc: true,
    async run(ctx, arg) {
      let v = arg?.trim();
      if (!v) {
        const r = await ctx.getPoint(`FIELDEVAL에 대한 새 값 입력 <${fieldEval()}>:`, { preferNumber: true });
        if (!('text' in r)) return;
        v = r.text.trim();
      }
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 31) {
        ctx.print('0에서 31 사이의 정수를 입력하십시오.', 'err');
        return;
      }
      setFieldEval(n);
    },
  });

  // ------------------------------------------------------------- FIELDDISPLAY
  app.register({
    name: 'FIELDDISPLAY',
    title: '필드 배경 표시',
    transparent: true,
    noDoc: true,
    async run(ctx, arg) {
      let v = arg?.trim();
      if (!v) {
        const r = await ctx.getPoint(`FIELDDISPLAY에 대한 새 값 입력 <${fieldDisplay()}>:`, { preferNumber: true });
        if ('enter' in r) return;
        if (!('text' in r)) return;
        v = r.text.trim();
      }
      if (v !== '0' && v !== '1') {
        ctx.print('0 또는 1을 입력하십시오.', 'err');
        return;
      }
      setFieldDisplay(Number(v));
    },
  });
}

export { CancelError };
