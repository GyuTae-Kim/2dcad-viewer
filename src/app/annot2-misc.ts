/**
 * QDIM(빠른 치수), TOLERANCE(기하 공차), CENTERMARK(중심 표식), CENTERLINE(중심선).
 * 프롬프트는 AutoCAD 2026 한국어판을 따른다. 계산은 src/edit/annot(qdim·tolerance·center).
 */
import type { BlockDef, CadDocument, DimensionEntity, Entity, InsertEntity, LineEntity, LwPolylineEntity, MTextEntity, ToleranceEntity, Vec3 } from '../core/model';
import { entityDefaults, tableKey } from '../core/model';
import { dimVars } from '../edit/dim';
import { OSNAP, type PointRef, assocKeys, findRefAt, tolFor } from '../edit/dim/assoc';
import { type CenterSettings, centerLineSegment, centerMarkLines, defaultCenterSettings } from '../edit/annot/center';
import { type QdimGeometry, type QdimMode, qdimCreate, qdimGeometry } from '../edit/annot/qdim';
import { GDT_SYMBOLS, type MaterialCond, type TolSpec, buildToleranceText, emptySpec, toleranceLayout } from '../edit/annot/tolerance';
import { allocBlockName } from '../edit/geom/types';
import { STANDARD_LINETYPES, makeLinetype } from '../edit/linetypes';
import type { App, CommandContext, Keyword } from './app';
import { addEntities, currentProps } from './draw';
import { dimGhost } from './annot2-common';
import { attachAssociation, finishNewDimension } from './dimassoc';
import { unlockedOnly } from './layers';
import { commitResults } from './modify';
import { dialog, h } from './ui/dom';
import type { OverlayGeom, Pt } from './view';

const v3 = (p: Pt, z = 0): Vec3 => ({ x: p.x, y: p.y, z });

// ---------------------------------------------------------------------------
// QDIM
// ---------------------------------------------------------------------------

const QDIM_LABEL: Record<QdimMode, string> = { C: '연속', S: '다중', B: '기준선', O: '세로좌표', R: '반지름', D: '지름' };
const qdimMode = new WeakMap<CadDocument, QdimMode>();
/** 연관 치수 우선순위: 끝점(E) 또는 교차(I) */
const qdimPriority = new WeakMap<CadDocument, 'E' | 'I'>();

/**
 * QDIM 치수의 연관 참조: 정의점 자리에 스냅 점이 있는 고른 객체에 잇는다.
 * 끝점(E): 끝점·중심·노드·삽입점, 교차(I): 그 점에서 만나는 두 고른 객체의 교차점(없으면 끝점). 반지름·지름은 그 원·호.
 */
function qdimRefs(doc: CadDocument, d: DimensionEntity, ents: readonly Entity[], pri: 'E' | 'I'): (PointRef | null)[] {
  const t = d.dimType & 7;
  const pointKinds = pri === 'I' ? [OSNAP.INT, OSNAP.END, OSNAP.CEN, OSNAP.NODE, OSNAP.INS] : [OSNAP.END, OSNAP.CEN, OSNAP.NODE, OSNAP.INS];
  return assocKeys(d).map((k) => {
    if (!k) return null;
    const p = d[k];
    const tol = tolFor(p) * 10;
    if (t === 3 || t === 4) {
      if (k === 'defPoint4' || (t === 3 && k === 'defPoint')) return findRefAt(doc, ents, p, { tol, kinds: [OSNAP.NEAR], nearTol: tol });
      return findRefAt(doc, ents, p, { tol, kinds: [OSNAP.CEN] });
    }
    if (t === 6 && k === 'defPoint') return null;
    return findRefAt(doc, ents, p, { tol, kinds: pointKinds });
  });
}

function crossMarks(app: App, pts: readonly Pt[]): OverlayGeom {
  const s = 5 * app.view.pixelSize();
  const segs: number[] = [];
  for (const q of pts) segs.push(q.x - s, q.y - s, q.x + s, q.y + s, q.x - s, q.y + s, q.x + s, q.y - s);
  return { segs };
}

async function qdimEdit(app: App, ctx: CommandContext, g: QdimGeometry): Promise<void> {
  let adding = false;
  for (;;) {
    const r = await ctx.getPoint(adding ? '추가할 치수 점을 표시하거나 [제거(R)/종료(X)] <종료>:' : '제거할 치수 점을 표시하거나 [추가(A)/종료(X)] <종료>:', {
      keywords: adding
        ? [
            { key: 'R', label: '제거' },
            { key: 'X', label: '종료' },
          ]
        : [
            { key: 'A', label: '추가' },
            { key: 'X', label: '종료' },
          ],
      ghost: () => [crossMarks(app, g.points)],
    });
    if ('enter' in r || ('keyword' in r && r.keyword === 'X')) return;
    if ('keyword' in r) {
      adding = r.keyword === 'A';
      continue;
    }
    if (!('point' in r)) return;
    const q = r.point;
    if (adding) {
      if (!g.points.some((o) => Math.hypot(o.x - q.x, o.y - q.y) < 1e-9)) g.points.push({ x: q.x, y: q.y });
      ctx.print(`치수 점 하나가 추가됨`);
    } else {
      const tol = 10 * app.view.pixelSize();
      let best = -1;
      let bd = tol;
      g.points.forEach((o, i) => {
        const d = Math.hypot(o.x - q.x, o.y - q.y);
        if (d <= bd) {
          bd = d;
          best = i;
        }
      });
      if (best < 0) ctx.print('치수 점을 찾을 수 없습니다.', 'err');
      else {
        g.points.splice(best, 1);
        ctx.print('치수 점 하나가 제거됨');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// TOLERANCE 대화상자
// ---------------------------------------------------------------------------

const MC_OPTIONS: { value: MaterialCond; label: string }[] = [
  { value: '', label: '없음' },
  { value: 'M', label: 'Ⓜ 최대 재료' },
  { value: 'L', label: 'Ⓛ 최소 재료' },
  { value: 'S', label: 'Ⓢ 크기 무관' },
];

/** "기하학적 공차" 대화상자(취소하면 null) */
export function toleranceDialog(init: TolSpec = emptySpec()): Promise<TolSpec | null> {
  return new Promise((resolve) => {
    const s: TolSpec = structuredClone(init);
    let done = false;
    const sel = (value: string, options: { value: string; label: string }[], set: (v: string) => void, label: string) => {
      const el = h('select', { 'aria-label': label, onchange: (ev: Event) => set((ev.target as HTMLSelectElement).value) }, ...options.map((o) => h('option', { value: o.value }, o.label)));
      el.value = value;
      return el;
    };
    const inp = (value: string, set: (v: string) => void, label: string, width = 64) => {
      const el = h('input', { type: 'text', 'aria-label': label, style: `width:${width}px`, oninput: (ev: Event) => set((ev.target as HTMLInputElement).value) });
      el.value = value;
      el.addEventListener('keydown', (ev) => ev.stopPropagation());
      return el;
    };
    const chk = (value: boolean, set: (v: boolean) => void, label: string) => {
      const el = h('input', { type: 'checkbox', 'aria-label': label, title: label, onchange: (ev: Event) => set((ev.target as HTMLInputElement).checked) });
      el.checked = value;
      return el;
    };
    const symOpts = [{ value: '', label: '없음' }, ...GDT_SYMBOLS.map((g) => ({ value: g.key, label: g.label }))];
    const cell = (style = '') => h('td', { style: `padding:3px 4px;${style}` });
    const table = h('table', { style: 'border-collapse:collapse' });
    const head = h('tr');
    for (const t of ['기호', '공차 1', '공차 2', '데이텀 1', '데이텀 2', '데이텀 3']) head.append(h('th', { style: 'font-weight:normal;color:var(--text-dim);padding:2px 4px;text-align:left' }, t));
    table.append(head);
    s.rows.forEach((row, ri) => {
      const tr = h('tr');
      const c0 = cell();
      c0.append(sel(row.sym, symOpts, (v) => (row.sym = v), `${ri + 1}행 기호`));
      tr.append(c0);
      for (const [k, name] of [
        ['tol1', '공차 1'],
        ['tol2', '공차 2'],
      ] as const) {
        const c = cell('white-space:nowrap');
        const t = row[k];
        c.append(h('label', { title: '지름' }, chk(t.dia, (v) => (t.dia = v), `${ri + 1}행 ${name} 지름`), '⌀'), ' ', inp(t.value, (v) => (t.value = v), `${ri + 1}행 ${name} 값`), ' ', sel(t.mc, MC_OPTIONS, (v) => (t.mc = v as MaterialCond), `${ri + 1}행 ${name} 재료 조건`));
        tr.append(c);
      }
      row.datum.forEach((d, di) => {
        const c = cell('white-space:nowrap');
        c.append(inp(d.value, (v) => (d.value = v), `${ri + 1}행 데이텀 ${di + 1}`, 40), ' ', sel(d.mc, MC_OPTIONS, (v) => (d.mc = v as MaterialCond), `${ri + 1}행 데이텀 ${di + 1} 재료 조건`));
        tr.append(c);
      });
      table.append(tr);
    });
    const extra = h(
      'div',
      { class: 'form', style: 'margin-top:10px' },
      h('label', { class: 'form-row' }, h('span', {}, '높이(H)'), inp(s.height, (v) => (s.height = v), '높이', 90)),
      h('label', { class: 'form-row check' }, h('span', {}, '투영된 공차 영역 Ⓟ'), chk(s.projected, (v) => (s.projected = v), '투영된 공차 영역')),
      h('label', { class: 'form-row' }, h('span', {}, '데이텀 식별자(D)'), inp(s.datumId, (v) => (s.datumId = v), '데이텀 식별자', 60)),
    );
    const body = h('div', {}, h('div', { style: 'overflow-x:auto' }, table), extra);
    const back = dialog('기하학적 공차', body, [
      {
        label: '취소',
        run: () => {
          done = true;
          resolve(null);
        },
      },
      {
        label: '확인',
        primary: true,
        run: () => {
          done = true;
          resolve(s);
        },
      },
    ]);
    new MutationObserver((_, obs) => {
      if (!document.body.contains(back)) {
        obs.disconnect();
        if (!done) {
          done = true;
          resolve(null);
        }
      }
    }).observe(document.body, { childList: true });
  });
}

/** 공차 그림(선·문자)을 객체로: 미리보기와 확인용 */
export function toleranceEntities(app: App, doc: CadDocument, text: string, at: Pt, dimStyle: string): Entity[] {
  const v = dimVars(doc, { dimStyle });
  const hgt = v.txt;
  const style = v.textStyle;
  const measure = (t: string, hh: number) => {
    try {
      const l = app.text.layoutMText({ text: t, height: hh, width: 0, attachment: 4, lineSpacingStyle: 1, lineSpacingFactor: 1, style });
      return Number.isFinite(l.maxX - l.minX) ? l.maxX - l.minX : t.length * hh * 0.7;
    } catch {
      return t.length * hh * 0.7;
    }
  };
  const lay = toleranceLayout(text, hgt, v.gap, measure);
  const out: Entity[] = [];
  const base = { ...entityDefaults(), layer: '0', color: { aci: 0 } };
  for (const s of lay.strokes) {
    const pl: LwPolylineEntity = {
      ...base,
      type: 'LWPOLYLINE',
      vertices: s.pts.map((q) => ({ x: at.x + q.x, y: at.y + q.y, bulge: 0, startWidth: 0, endWidth: 0 })),
      closed: !!s.closed,
      plinegen: false,
      constantWidth: 0,
      elevation: 0,
    } as LwPolylineEntity;
    out.push(pl);
  }
  for (const t of lay.texts) {
    const m: MTextEntity = {
      ...base,
      type: 'MTEXT',
      insert: { x: at.x + t.x, y: at.y + t.y, z: 0 },
      height: hgt,
      width: 0,
      attachment: 4,
      drawingDirection: 1,
      text: t.text,
      style: v.txsty,
      rotation: 0,
      lineSpacingStyle: 1,
      lineSpacingFactor: 1,
      backgroundFlags: 0,
      backgroundScale: 1.5,
    };
    out.push(m);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 중심 표식·중심선
// ---------------------------------------------------------------------------

/** 선종류가 도면에 없으면 표준 정의로 올린다(같은 명령 묶음). 올리지 못하면 ByLayer */
function ensureLinetype(app: App, ctx: CommandContext, name: string): string {
  const st = app.active!;
  const key = tableKey(name);
  const have = st.doc.linetypes.get(key);
  if (have) return have.name;
  const def = STANDARD_LINETYPES.find((d) => d.name === key);
  if (!def) return 'ByLayer';
  const metric = Number(st.doc.header.get('$MEASUREMENT') ?? 1) === 1;
  const lt = makeLinetype(def, st.session.newHandle(), metric);
  st.session.commit({ label: 'LINETYPE', ops: [{ kind: 'linetype', key, before: null, after: lt }], group: ctx.group });
  return lt.name;
}

/** 선 묶음을 익명 블록 참조 하나로 넣는다(AutoCAD 중심 표식·중심선처럼 한 객체) */
function addCenterBlock(app: App, ctx: CommandContext, segs: [Pt, Pt][], s: CenterSettings, label: string, z = 0): void {
  const st = app.active!;
  const doc = st.doc;
  const lines: LineEntity[] = segs.map(([a, b]) => ({ ...entityDefaults(), layer: '0', color: { aci: 0 }, linetype: 'ByBlock', lineweight: -2, type: 'LINE', start: v3(a, z), end: v3(b, z) }));
  const name = allocBlockName(doc, '*U');
  const def: BlockDef = { name, handle: '', recordHandle: '', basePoint: { x: 0, y: 0, z: 0 }, flags: 1, entities: lines };
  const props = currentProps(app);
  const lt = ensureLinetype(app, ctx, s.ltype);
  const layer = s.layer === '.' || !s.layer ? props.layer : (doc.layers.get(tableKey(s.layer))?.name ?? props.layer);
  const ins: InsertEntity = {
    ...entityDefaults(),
    ...props,
    layer,
    linetype: lt,
    ltscale: s.ltscale > 0 ? s.ltscale : 1,
    type: 'INSERT',
    block: name,
    insert: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    rotation: 0,
    columnCount: 1,
    rowCount: 1,
    columnSpacing: 0,
    rowSpacing: 0,
    attribs: [],
  };
  commitResults(app, ctx, [{ add: [ins], blocks: [def] }], label, { quiet: true });
}

function centerSettings(app: App): CenterSettings {
  return defaultCenterSettings(Number(app.active!.doc.header.get('$MEASUREMENT') ?? 1) === 1);
}

/** 선택한 객체의 직선 구간(선, 폴리선 직선 세그먼트) */
function straightOf(e: Entity | undefined, pick: Pt): [Pt, Pt] | null {
  if (!e) return null;
  if (e.type === 'LINE') return [e.start, e.end];
  if (e.type === 'LWPOLYLINE' && e.vertices.length >= 2) {
    const vs = e.vertices;
    const n = e.closed ? vs.length : vs.length - 1;
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      const a = vs[i]!;
      const b = vs[(i + 1) % vs.length]!;
      if (a.bulge) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((pick.x - a.x) * dx + (pick.y - a.y) * dy) / L));
      const d = Math.hypot(a.x + dx * t - pick.x, a.y + dy * t - pick.y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    if (best < 0) return null;
    return [vs[best]!, vs[(best + 1) % vs.length]!];
  }
  return null;
}

/** 호·원(폴리선 호 세그먼트 포함)의 중심·반지름·중심각 */
function roundOf(e: Entity | undefined, pick: Pt): { c: Pt; r: number; sweep: number; z: number } | null {
  if (!e) return null;
  if (e.type === 'CIRCLE') return { c: e.center, r: e.radius, sweep: 2 * Math.PI, z: e.center.z };
  if (e.type === 'ARC') {
    let sw = e.endAngle - e.startAngle;
    while (sw <= 0) sw += 2 * Math.PI;
    return { c: e.center, r: e.radius, sweep: sw, z: e.center.z };
  }
  if (e.type === 'LWPOLYLINE') {
    const vs = e.vertices;
    let best: { c: Pt; r: number; sweep: number; z: number } | null = null;
    let bd = Infinity;
    for (let i = 0; i < (e.closed ? vs.length : vs.length - 1); i++) {
      const a = vs[i]!;
      const b = vs[(i + 1) % vs.length]!;
      if (!a.bulge) continue;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      if (!(d > 0)) continue;
      const th = 4 * Math.atan(a.bulge);
      const r = Math.abs(d / (2 * Math.sin(th / 2)));
      const hh = r * Math.cos(th / 2) * Math.sign(a.bulge);
      const c = { x: (a.x + b.x) / 2 - ((b.y - a.y) / d) * hh, y: (a.y + b.y) / 2 + ((b.x - a.x) / d) * hh };
      const dd = Math.abs(Math.hypot(pick.x - c.x, pick.y - c.y) - r);
      if (dd < bd) {
        bd = dd;
        best = { c, r, sweep: Math.abs(th), z: e.elevation };
      }
    }
    return best;
  }
  return null;
}

export function registerAnnot2Misc(app: App): void {
  // ------------------------------------------------------------- QDIM
  app.register({
    name: 'QDIM',
    title: '빠른 치수',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const hs = unlockedOnly(app, await ctx.getSelection('치수기입할 형상 선택:'));
      app.clearSelection();
      const ents = hs.map((h) => doc.entityIndex.get(h)).filter((e): e is Entity => !!e);
      const g = qdimGeometry(ents);
      if (!g.points.length && !g.circles.length) {
        ctx.print('치수를 기입할 점이 없습니다.', 'err');
        return;
      }
      let mode = qdimMode.get(doc) ?? 'C';
      let datum: Pt | null = null;
      const kws: Keyword[] = [
        { key: 'C', label: '연속' },
        { key: 'S', label: '다중' },
        { key: 'B', label: '기준선' },
        { key: 'O', label: '세로좌표' },
        { key: 'R', label: '반지름' },
        { key: 'D', label: '지름' },
        { key: 'P', label: '데이텀 점' },
        { key: 'E', label: '편집' },
        { key: 'T', label: '설정' },
      ];
      const style = String(doc.header.get('$DIMSTYLE') ?? '') || undefined;
      for (;;) {
        const r = await ctx.getPoint(`치수선의 위치 지정 또는 [연속(C)/다중(S)/기준선(B)/세로좌표(O)/반지름(R)/지름(D)/데이텀 점(P)/편집(E)/설정(T)] <${QDIM_LABEL[mode]}>:`, {
          keywords: kws,
          ghost: dimGhost(app, (p) => qdimCreate(doc, mode, g, p, { datum, style })),
        });
        if ('point' in r) {
          const dims = qdimCreate(doc, mode, g, r.point, { datum, style });
          if (!dims.length) {
            ctx.print(mode === 'R' || mode === 'D' ? '고른 객체에 호나 원이 없습니다.' : '치수를 만들 점이 부족합니다.', 'err');
            continue;
          }
          qdimMode.set(doc, mode);
          const a = commitResults(app, ctx, [{ add: dims }], 'QDIM', { quiet: true });
          const pri = qdimPriority.get(doc) ?? 'E';
          for (const h of a.added) {
            const d = doc.entityIndex.get(h);
            if (d?.type === 'DIMENSION') attachAssociation(app, ctx, h, qdimRefs(doc, d, ents, pri), 'QDIM');
          }
          finishNewDimension(app, ctx, a.added, 'QDIM');
          return;
        }
        if (!('keyword' in r)) return;
        const k = r.keyword;
        if (k === 'P') {
          const p = await ctx.getPoint('새 데이텀 점 선택:');
          if ('point' in p) datum = p.point;
        } else if (k === 'E') await qdimEdit(app, ctx, g);
        else if (k === 'T') {
          const cur = qdimPriority.get(doc) ?? 'E';
          const pr = await ctx.getPoint(`연관 치수 우선순위 [끝점(E)/교차(I)] <${cur === 'I' ? '교차' : '끝점'}>:`, {
            keywords: [
              { key: 'E', label: '끝점' },
              { key: 'I', label: '교차' },
            ],
          });
          if ('keyword' in pr) qdimPriority.set(doc, pr.keyword === 'I' ? 'I' : 'E');
        } else mode = k as QdimMode;
      }
    },
  });

  // ------------------------------------------------------------- TOLERANCE
  app.register({
    name: 'TOLERANCE',
    aliases: ['TOL'],
    title: '공차',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const spec = await toleranceDialog();
      if (!spec) return;
      const text = buildToleranceText(spec);
      if (!text) return;
      const dimStyle = String(doc.header.get('$DIMSTYLE') ?? 'Standard') || 'Standard';
      const p = await ctx.getPoint('공차 위치 입력:', {
        ghost: (q) => {
          const pk = app.picker();
          return pk ? [pk.geometryOf(toleranceEntities(app, doc, text, q, dimStyle))] : [];
        },
      });
      if (!('point' in p)) return;
      const props = currentProps(app);
      const ds = doc.dimStyles.get(tableKey(dimStyle));
      const e: ToleranceEntity = { ...entityDefaults(), ...props, type: 'TOLERANCE', handle: '', dimStyle: ds?.name ?? dimStyle, insert: v3(p.point), text, direction: { x: 1, y: 0, z: 0 } };
      addEntities(app, ctx, [e], 'TOLERANCE');
    },
  });

  // ------------------------------------------------------------- CENTERMARK
  app.register({
    name: 'CENTERMARK',
    aliases: ['CM'],
    title: '중심 표식',
    async run(ctx) {
      const st = app.active!;
      const s = centerSettings(app);
      for (;;) {
        const r = await ctx.getEntity('중심 표식을 추가할 원 또는 호 선택:');
        if (!('handle' in r)) return;
        const c = roundOf(st.doc.entityIndex.get(r.handle), r.point);
        if (!c) {
          ctx.print('원 또는 호를 선택하십시오.', 'err');
          continue;
        }
        const segs = centerMarkLines(c.c, c.r, c.sweep, s);
        if (segs.length) addCenterBlock(app, ctx, segs, s, 'CENTERMARK', c.z);
      }
    },
  });

  // ------------------------------------------------------------- CENTERLINE
  app.register({
    name: 'CENTERLINE',
    aliases: ['CL'],
    title: '중심선',
    async run(ctx) {
      const st = app.active!;
      const s = centerSettings(app);
      const pickLine = async (prompt: string): Promise<[Pt, Pt] | null> => {
        for (;;) {
          const r = await ctx.getEntity(prompt);
          if (!('handle' in r)) return null;
          const l = straightOf(st.doc.entityIndex.get(r.handle), r.point);
          if (l) return l;
          ctx.print('선 또는 폴리선의 직선 세그먼트를 선택하십시오.', 'err');
        }
      };
      const l1 = await pickLine('첫 번째 선 선택:');
      if (!l1) return;
      const l2 = await pickLine('두 번째 선 선택:');
      if (!l2) return;
      const seg = centerLineSegment(l1, l2, s.exe);
      if (!seg) {
        ctx.print('두 선이 같은 직선 위에 있어 중심선을 만들 수 없습니다.', 'err');
        return;
      }
      addCenterBlock(app, ctx, [seg], s, 'CENTERLINE');
    },
  });
}
