/**
 * 문자 작성 명령: TEXT(DT·DTEXT, 단일 행 문자 — 도면 위 한 줄 편집기), MTEXT(MT·T, 여러 줄 문자 — 제자리 편집기).
 * 프롬프트와 옵션은 AutoCAD 2026 한국어판을 따른다. draw.ts가 registerTextCommands로 등록한다.
 */
import type { CadDocument, Entity, MTextColumns, MTextEntity, TextEntity, TextHAlign, TextVAlign } from '../../core/model';
import { entityDefaults, tableKey } from '../../core/model';
import { formatLength } from '../../core/units';
import { textStyleAnnotative } from '../../edit/annoscale/xdata';
import { applyTemplate } from '../../edit/field/store';
import type { App, CommandContext, Keyword } from '../app';
import type { DocState } from '../docstate';
import { addEntities, currentProps } from '../draw';
import type { Pt } from '../view';
import { type EditorResult, TextEditor, openTextEditor } from './editor';

const v3 = (p: Pt) => ({ x: p.x, y: p.y, z: 0 });
const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

/** 필드 평가 환경(fieldcmds.fieldContext와 같다) */
export function fieldCtx(st: DocState) {
  return { doc: st.doc, fileName: st.saveName || st.name, fileSize: st.size, now: new Date() };
}

function fmt(ctx: CommandContext, v: number): string {
  return formatLength(v, ctx.app.active!.units);
}

/** 길이 입력(숫자 또는 base에서 찍은 점까지) */
async function askLength(ctx: CommandContext, prompt: string, base: Pt | null, def?: number): Promise<number> {
  for (;;) {
    const r = await ctx.getPoint(def !== undefined ? `${prompt} <${fmt(ctx, def)}>:` : `${prompt}:`, { base, allowText: true });
    if ('enter' in r && def !== undefined) return def;
    if ('point' in r && base) return dist(base, r.point);
    if ('text' in r) {
      const v = parseFloat(r.text);
      if (Number.isFinite(v) && v > 0) return v;
    }
    ctx.print('0보다 큰 숫자를 입력하거나 점을 지정하십시오.', 'err');
  }
}

/** 각도 입력(도, 또는 base에서 찍은 점의 방향) */
async function askAngle(ctx: CommandContext, prompt: string, base: Pt | null, def = 0): Promise<number> {
  for (;;) {
    const r = await ctx.getPoint(`${prompt} <${+((def * 180) / Math.PI).toFixed(4)}>:`, { base, preferNumber: true });
    if ('enter' in r) return def;
    if ('point' in r && base) return Math.atan2(r.point.y - base.y, r.point.x - base.x);
    if ('text' in r) {
      const v = parseFloat(r.text);
      if (Number.isFinite(v)) return (v * Math.PI) / 180;
    }
    ctx.print('각도(도)를 입력하거나 점을 지정하십시오.', 'err');
  }
}

async function askInt(ctx: CommandContext, prompt: string, def: number, min: number, max: number): Promise<number> {
  for (;;) {
    const r = await ctx.getPoint(`${prompt} <${def}>:`, { preferNumber: true });
    if ('enter' in r) return def;
    if ('text' in r) {
      const v = parseInt(r.text, 10);
      if (Number.isFinite(v) && v >= min && v <= max) return v;
    }
    ctx.print(`${min}에서 ${max} 사이의 정수를 입력하십시오.`, 'err');
  }
}

/** 스타일 이름 입력(? = 목록). 취소·Enter면 지금 스타일 */
async function askStyle(ctx: CommandContext, doc: CadDocument, cur: string, prompt: string): Promise<string> {
  for (;;) {
    const r = await ctx.getPoint(`${prompt} <${cur}>:`, { allowText: true });
    if (!('text' in r)) return cur;
    const t = r.text.trim();
    if (t === '?') {
      const names = [...doc.textStyles.values()].filter((s) => s.name && !(s.flags & 1)).map((s) => s.name);
      ctx.print(`문자 스타일: ${names.join(', ')}`);
      continue;
    }
    const s = doc.textStyles.get(tableKey(t));
    if (!s || !s.name || s.flags & 1) {
      ctx.print(`문자 스타일 "${t}"을(를) 찾을 수 없습니다.`, 'err');
      continue;
    }
    return s.name;
  }
}

function styleLine(doc: CadDocument, name: string, ctx: CommandContext): void {
  const s = doc.textStyles.get(tableKey(name));
  const defH = Number(doc.header.get('$TEXTSIZE') ?? 2.5) || 2.5;
  ctx.print(`현재 문자 스타일: "${s?.name ?? name}"  문자 높이: ${fmt(ctx, s?.height || defH)}  주석: ${textStyleAnnotative(doc, name) ? '예' : '아니오'}`);
}

// ---------------------------------------------------------------------------
// TEXT 자리맞추기
// ---------------------------------------------------------------------------

/** [열쇠, 이름, 수평(72), 수직(73), 점 프롬프트] */
export const TEXT_JUSTIFY: [string, string, TextHAlign, TextVAlign, string][] = [
  ['L', '왼쪽', 0, 0, '문자 기준선의 시작점 지정:'],
  ['C', '중심', 1, 0, '문자 기준선의 중심점 지정:'],
  ['R', '오른쪽', 2, 0, '문자 기준선의 오른쪽 끝점 지정:'],
  ['A', '정렬', 3, 0, '문자 기준선의 첫 번째 끝점 지정:'],
  ['M', '중간', 4, 0, '문자의 중간점 지정:'],
  ['F', '맞춤', 5, 0, '문자 기준선의 첫 번째 끝점 지정:'],
  ['TL', '맨 위 왼쪽', 0, 3, '문자의 맨 위 왼쪽 점 지정:'],
  ['TC', '맨 위 중심', 1, 3, '문자의 맨 위 중심점 지정:'],
  ['TR', '맨 위 오른쪽', 2, 3, '문자의 맨 위 오른쪽 점 지정:'],
  ['ML', '중간 왼쪽', 0, 2, '문자의 중간 왼쪽 점 지정:'],
  ['MC', '중간 중심', 1, 2, '문자의 중간 중심점 지정:'],
  ['MR', '중간 오른쪽', 2, 2, '문자의 중간 오른쪽 점 지정:'],
  ['BL', '맨 아래 왼쪽', 0, 1, '문자의 맨 아래 왼쪽 점 지정:'],
  ['BC', '맨 아래 중심', 1, 1, '문자의 맨 아래 중심점 지정:'],
  ['BR', '맨 아래 오른쪽', 2, 1, '문자의 맨 아래 오른쪽 점 지정:'],
];

const JUSTIFY_PROMPT = `옵션 입력 [${TEXT_JUSTIFY.map(([k, l]) => `${l}(${k})`).join('/')}]:`;

/** 단일 행 문자의 한 줄(자리맞추기에 맞게 삽입점·정렬점) */
export function makeTextLine(base: Omit<TextEntity, 'type' | 'handle' | 'insert' | 'text' | 'halign' | 'valign' | 'alignPoint'>, text: string, just: { h: TextHAlign; v: TextVAlign }, p1: Pt, p2?: Pt): TextEntity {
  const e = { ...entityDefaults(), ...base, type: 'TEXT', handle: '', text, halign: just.h, valign: just.v } as TextEntity;
  if (just.h === 0 && just.v === 0) e.insert = v3(p1);
  else if ((just.h === 3 || just.h === 5) && p2) {
    e.insert = v3(p1);
    e.alignPoint = v3(p2);
  } else {
    e.insert = v3(p1);
    e.alignPoint = v3(p1);
  }
  return e;
}

/** 한 줄 편집기에서 받은 결과로 TEXT를 만든다(필드는 템플릿으로 평가) */
function finishText(app: App, e: TextEntity, r: EditorResult): TextEntity {
  return r.fields ? applyTemplate(e, r.text, fieldCtx(app.active!)) : e;
}

type LineEvent = { kind: 'line'; text: string; r: EditorResult } | { kind: 'move'; at: Pt; r: EditorResult } | { kind: 'end'; r: EditorResult | null } | { kind: 'cmd'; r: Awaited<ReturnType<CommandContext['getPoint']>> } | { kind: 'cmderr'; e: unknown };

// ---------------------------------------------------------------------------
// MTEXT 자리맞추기·열
// ---------------------------------------------------------------------------

const MTEXT_JUSTIFY: Keyword[] = [
  { key: 'TL', label: '맨 위 왼쪽' },
  { key: 'TC', label: '맨 위 중심' },
  { key: 'TR', label: '맨 위 오른쪽' },
  { key: 'ML', label: '중간 왼쪽' },
  { key: 'MC', label: '중간 중심' },
  { key: 'MR', label: '중간 오른쪽' },
  { key: 'BL', label: '맨 아래 왼쪽' },
  { key: 'BC', label: '맨 아래 중심' },
  { key: 'BR', label: '맨 아래 오른쪽' },
];

/** 회전된 상자(두 구석)에서 부착점·폭·높이 */
export function mtextBox(a: Pt, b: Pt, rot: number, attachment: number): { insert: Pt; width: number; height: number; corners: Pt[] } {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const lx = (b.x - a.x) * c + (b.y - a.y) * s;
  const ly = -(b.x - a.x) * s + (b.y - a.y) * c;
  const x0 = Math.min(0, lx);
  const x1 = Math.max(0, lx);
  const y0 = Math.min(0, ly);
  const y1 = Math.max(0, ly);
  const col = (attachment - 1) % 3;
  const row = Math.floor((attachment - 1) / 3);
  const ix = col === 0 ? x0 : col === 1 ? (x0 + x1) / 2 : x1;
  const iy = row === 0 ? y1 : row === 1 ? (y0 + y1) / 2 : y0;
  const W = (x: number, y: number): Pt => ({ x: a.x + x * c - y * s, y: a.y + x * s + y * c });
  return { insert: W(ix, iy), width: x1 - x0, height: y1 - y0, corners: [W(x0, y0), W(x1, y0), W(x1, y1), W(x0, y1)] };
}

export function registerTextCommands(app: App): void {
  // ------------------------------------------------------------- TEXT
  app.register({
    name: 'TEXT',
    aliases: ['DT', 'DTEXT'],
    title: '단일 행 문자',
    async run(ctx) {
      const st = app.active!;
      const d = st.doc;
      let styleName = String(d.header.get('$TEXTSTYLE') ?? 'Standard');
      const defH = Number(d.header.get('$TEXTSIZE') ?? 2.5) || 2.5;
      styleLine(d, styleName, ctx);
      let just = { h: 0 as TextHAlign, v: 0 as TextVAlign };
      let p1: Pt | null = null;
      let p2: Pt | undefined;
      for (;;) {
        const r = await ctx.getPoint('문자의 시작점 지정 또는 [자리맞추기(J)/스타일(S)]:', {
          keywords: [
            { key: 'J', label: '자리맞추기' },
            { key: 'S', label: '스타일' },
          ],
        });
        if ('point' in r) {
          p1 = r.point;
          break;
        }
        if (!('keyword' in r)) return;
        if (r.keyword === 'S') {
          styleName = await askStyle(ctx, d, styleName, '스타일 이름 또는 [?] 입력');
          styleLine(d, styleName, ctx);
          continue;
        }
        const j = await ctx.getPoint(JUSTIFY_PROMPT, { keywords: TEXT_JUSTIFY.map(([key, label]) => ({ key, label })) });
        if (!('keyword' in j)) continue;
        const def = TEXT_JUSTIFY.find(([k]) => k === j.keyword)!;
        just = { h: def[2], v: def[3] };
        const q = await ctx.getPoint(def[4]);
        if (!('point' in q)) return;
        p1 = q.point;
        if (def[0] === 'A' || def[0] === 'F') {
          const q2 = await ctx.getPoint('문자 기준선의 두 번째 끝점 지정:', { base: p1, rubber: (x) => [{ pts: [p1!.x, p1!.y, x.x, x.y] }] });
          if (!('point' in q2)) return;
          p2 = q2.point;
        }
        break;
      }
      const style = d.textStyles.get(tableKey(styleName));
      const anno = textStyleAnnotative(d, styleName);
      let height = style?.height || 0;
      if (!height && just.h !== 3) height = await askLength(ctx, anno ? '용지 문자 높이 지정' : '높이 지정', p1, defH);
      if (!height) height = defH;
      if (just.h !== 3 && d.header.get('$TEXTSIZE') !== height) st.session.commit({ label: 'TEXTSIZE', ops: [{ kind: 'header', name: '$TEXTSIZE', before: d.header.get('$TEXTSIZE'), after: height }], group: ctx.group });
      const rot = p2 ? Math.atan2(p2.y - p1.y, p2.x - p1.x) : await askAngle(ctx, '문자의 회전 각도 지정', p1, 0);
      const props = currentProps(app);
      const base = { ...props, height, rotation: rot, widthFactor: style?.widthFactor || 1, oblique: style?.oblique || 0, style: style?.name ?? styleName, generation: style?.generation ?? 0 };
      // 정렬(A)·맞춤(F)은 한 줄만(AutoCAD와 같다: 두 끝점이 그 줄의 것)
      const single = just.h === 3 || just.h === 5;
      const step = height * 1.667;
      let at: Pt = p1;
      // 도면 위 한 줄 편집기(DOM이 없는 곳 — 스크립트 시험 — 에서는 명령행만)
      const ed = typeof document !== 'undefined' && (app as { view?: unknown }).view ? new TextEditor(app, { mode: 'text', label: '단일 행 문자', text: '', height, style: base.style, at, rotation: rot, baseline: true, just, keepOnOutside: true, color: props.color, layer: props.layer, ctx, fields: true }) : null;
      const closed = ed ? ed.open() : null;
      // 명령행·스크립트의 문자 입력은 줄 끝까지(공백 포함)
      const prevSpaces = app.cmd.acceptSpaces;
      app.cmd.acceptSpaces = true;
      let ended = false;
      const commit = (text: string, r: EditorResult | null) => {
        if (!text) return;
        const e = makeTextLine(base, text, just, at, single ? p2 : undefined);
        addEntities(app, ctx, [r ? finishText(app, e, r) : e], 'TEXT');
      };
      const moveTo = (p: Pt) => {
        at = p;
        ed?.reset('');
        ed?.moveTo(at);
      };
      const next = () => moveTo({ x: at.x + Math.sin(rot) * step, y: at.y - Math.cos(rot) * step });
      try {
        while (!ended) {
          const evP = ed
            ? new Promise<LineEvent>((resolve) => {
                ed.hooks = {
                  onEnter: (r) => {
                    resolve({ kind: 'line', text: r.text, r });
                    return true;
                  },
                  onCanvasClick: (w, r) => {
                    resolve({ kind: 'move', at: w, r });
                    return true;
                  },
                };
                void closed!.then((r) => resolve({ kind: 'end', r }));
              })
            : null;
          const cmdP: Promise<LineEvent> = ctx.getPoint('문자 입력(빈 줄에서 Enter로 끝):', { allowText: true }).then(
            (r) => ({ kind: 'cmd', r }) as LineEvent,
            (e) => ({ kind: 'cmderr', e }) as LineEvent,
          );
          const ev = evP ? await Promise.race([evP, cmdP]) : await cmdP;
          // 편집기가 먼저 답했으면 명령행 요청만 거둔다(명령은 계속)
          if (ev.kind !== 'cmd' && ev.kind !== 'cmderr' && app.pendingInput) {
            app.cancel(true);
            await cmdP;
          }
          switch (ev.kind) {
            case 'line':
              if (!ev.text) {
                ended = true;
                break;
              }
              commit(ev.text, ev.r);
              if (single) ended = true;
              else next();
              break;
            case 'move':
              commit(ev.r.text, ev.r);
              moveTo(ev.at);
              break;
            case 'end':
              if (ev.r) commit(ev.r.text, ev.r);
              ended = true;
              break;
            case 'cmd': {
              const r = ev.r;
              if ('text' in r && r.text) {
                commit(r.text, null);
                if (single) ended = true;
                else next();
              } else if ('point' in r) {
                if (ed) commit(ed.result().text, ed.result());
                moveTo(r.point);
              } else ended = true;
              break;
            }
            case 'cmderr':
              ed?.cancel();
              throw ev.e;
          }
        }
      } finally {
        app.cmd.acceptSpaces = prevSpaces;
        if (ed?.isOpen) ed.cancel();
      }
    },
  });

  // ------------------------------------------------------------- MTEXT
  app.register({
    name: 'MTEXT',
    aliases: ['MT', 'T'],
    title: '여러 줄 문자',
    async run(ctx) {
      const st = app.active!;
      const d = st.doc;
      let styleName = String(d.header.get('$TEXTSTYLE') ?? 'Standard');
      const style0 = d.textStyles.get(tableKey(styleName));
      let height = style0?.height || Number(d.header.get('$TEXTSIZE') ?? 2.5) || 2.5;
      styleLine(d, styleName, ctx);
      const a0 = await ctx.getPoint('첫 번째 구석 지정:');
      if (!('point' in a0)) return;
      const a = a0.point;
      let attachment = 1;
      let rot = 0;
      let lsStyle = 1;
      let lsFactor = 1;
      let width: number | null = null;
      let columns: MTextColumns | undefined;
      let colHeight = 0;
      let corner: Pt | null = null;
      const rubber = (q: Pt) => {
        const bx = mtextBox(a, q, rot, attachment);
        return [{ pts: bx.corners.flatMap((c) => [c.x, c.y]), closed: true, dashed: true }];
      };
      while (width === null && !corner) {
        const r = await ctx.getPoint('반대 구석 지정 또는 [높이(H)/자리맞추기(J)/선 간격두기(L)/회전(R)/스타일(S)/폭(W)/열(C)]:', {
          base: a,
          rubber,
          keywords: [
            { key: 'H', label: '높이' },
            { key: 'J', label: '자리맞추기' },
            { key: 'L', label: '선 간격두기' },
            { key: 'R', label: '회전' },
            { key: 'S', label: '스타일' },
            { key: 'W', label: '폭' },
            { key: 'C', label: '열' },
          ],
        });
        if ('point' in r) {
          corner = r.point;
          break;
        }
        if (!('keyword' in r)) return;
        switch (r.keyword) {
          case 'H':
            height = await askLength(ctx, '높이 지정', a, height);
            break;
          case 'J': {
            const cur = MTEXT_JUSTIFY[attachment - 1]!;
            const j = await ctx.getPoint(`자리맞추기 입력 [${MTEXT_JUSTIFY.map((k) => `${k.label}(${k.key})`).join('/')}] <${cur.label}(${cur.key})>:`, { keywords: MTEXT_JUSTIFY });
            if ('keyword' in j) attachment = MTEXT_JUSTIFY.findIndex((k) => k.key === j.keyword) + 1;
            break;
          }
          case 'L': {
            const t = await ctx.getPoint(`선 간격두기 유형 입력 [최소(A)/정확하게(E)] <${lsStyle === 2 ? '정확하게(E)' : '최소(A)'}>:`, {
              keywords: [
                { key: 'A', label: '최소' },
                { key: 'E', label: '정확하게' },
              ],
            });
            if ('keyword' in t) lsStyle = t.keyword === 'E' ? 2 : 1;
            for (;;) {
              const v = await ctx.getPoint(`선 간격두기 비율 또는 간격두기 입력 <${+lsFactor.toFixed(4)}x>:`, { allowText: true });
              if (!('text' in v)) break;
              const s = v.text.trim();
              const n = parseFloat(s);
              if (/x$/i.test(s) && n > 0) {
                lsFactor = n;
                break;
              }
              if (n > 0) {
                // 간격두기(거리): 기본 줄 간격(문자 높이의 5/3)에 대한 비율로
                lsFactor = n / (height * 1.667);
                break;
              }
              ctx.print('비율(예: 1.5x) 또는 간격두기 거리를 입력하십시오.', 'err');
            }
            break;
          }
          case 'R':
            rot = await askAngle(ctx, '회전 각도 지정', a, rot);
            break;
          case 'S': {
            styleName = await askStyle(ctx, d, styleName, '스타일 이름 입력 또는 [?]');
            const s = d.textStyles.get(tableKey(styleName));
            if (s?.height) height = s.height;
            break;
          }
          case 'W':
            width = await askLength(ctx, '폭 지정', a);
            break;
          case 'C': {
            const t = await ctx.getPoint('열 유형 입력 [동적(D)/정적(S)/열 없음(N)] <동적(D)>:', {
              keywords: [
                { key: 'D', label: '동적' },
                { key: 'S', label: '정적' },
                { key: 'N', label: '열 없음' },
              ],
            });
            const kind = 'keyword' in t ? t.keyword : 'enter' in t ? 'D' : null;
            if (!kind) return;
            if (kind === 'N') {
              columns = undefined;
              break;
            }
            const gutterDef = +(height * 5).toFixed(4);
            if (kind === 'D') {
              const cw = await askLength(ctx, '열 폭 지정', a, +(height * 20).toFixed(4));
              const g = await askLength(ctx, '거터 폭 지정', null, gutterDef);
              colHeight = await askLength(ctx, '열 높이 지정', a, +(height * 10).toFixed(4));
              columns = { type: 2, count: 1, width: cw, gutter: g, autoHeight: false, flowReversed: false, heights: [colHeight] };
              width = cw;
            } else {
              const total = await askLength(ctx, '총 폭 지정', a, +(height * 40).toFixed(4));
              const n = await askInt(ctx, '열 수 지정', 2, 1, 100);
              const g = await askLength(ctx, '거터 폭 지정', null, gutterDef);
              colHeight = await askLength(ctx, '열 높이 지정', a, +(height * 10).toFixed(4));
              const cw = Math.max(height, (total - g * (n - 1)) / n);
              columns = { type: 1, count: n, width: cw, gutter: g, autoHeight: false, flowReversed: false, heights: [colHeight] };
              width = cw;
            }
            break;
          }
        }
      }
      let insert: Pt = a;
      let boxW = width ?? 0;
      if (corner) {
        const bx = mtextBox(a, corner, rot, attachment);
        insert = bx.insert;
        boxW = bx.width;
      }
      const s = d.textStyles.get(tableKey(styleName));
      const props = currentProps(app);
      const r = await openTextEditor(app, {
        mode: 'mtext',
        label: '여러 줄 문자',
        text: '',
        fields: true,
        height,
        style: s?.name ?? styleName,
        attachment,
        width: boxW,
        rotation: rot,
        at: insert,
        lineSpacingFactor: lsFactor,
        lineSpacingStyle: lsStyle,
        columns,
        rectHeight: colHeight || undefined,
        color: props.color,
        layer: props.layer,
        ctx,
      });
      if (!r || !r.plain.trim()) return;
      let e: MTextEntity = {
        ...entityDefaults(),
        ...props,
        type: 'MTEXT',
        handle: '',
        insert: v3(insert),
        height: r.height,
        width: r.width,
        attachment: r.attachment,
        drawingDirection: 1,
        text: r.text,
        style: r.style,
        rotation: rot,
        lineSpacingStyle: r.lineSpacingStyle,
        lineSpacingFactor: r.lineSpacingFactor,
        backgroundFlags: 0,
        backgroundScale: 1.5,
      };
      if (rot) e.direction = { x: Math.cos(rot), y: Math.sin(rot), z: 0 };
      if (r.columns && r.columns.type > 0) {
        e.columns = r.columns;
        if (r.rectHeight) e.rectHeight = r.rectHeight;
      }
      if (r.fields) e = applyTemplate(e, r.text, fieldCtx(st));
      addEntities(app, ctx, [e as Entity], 'MTEXT');
      app.lastCreated = [e.handle];
    },
  });
}
