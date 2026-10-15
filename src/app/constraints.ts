/**
 * 파라메트릭 구속 명령: GEOMCONSTRAINT(GCON)와 기하 구속 12종(GCCOINCIDENT … GCEQUAL), DIMCONSTRAINT(DCON)와 치수 구속
 * 7종(DCLINEAR·DCHORIZONTAL·DCVERTICAL·DCALIGNED·DCANGULAR·DCRADIUS·DCDIAMETER), AUTOCONSTRAIN, DELCONSTRAINT, PARAMETERS(PAR),
 * CONSTRAINTBAR(CBAR), DCDISPLAY. 프롬프트는 AutoCAD 2026 한국어판을 따른다.
 *
 * 풀이·저장·표시 도형은 src/edit/constraint. 다른 명령의 편집 뒤 다시 풀기는 constraints-hook.ts,
 * 화면 그리기는 constraints-draw.ts.
 * 한계: 치수 구속은 동적 구속만(주석 구속·DCCONVERT 없음), 연관 치수를 구속으로 바꾸기 없음.
 */
import type { Vec2 } from '../core/model';
import { formatLength } from '../core/units';
import { AUTO_DEFAULTS, type AutoSettings, autoConstrain } from '../edit/constraint/auto';
import { constraintDisplay, constraintGlyphs, setConstraintDisplay } from '../edit/constraint/glyphs';
import { MakeError, prepareDim, prepareGeo } from '../edit/constraint/make';
import { evaluateParams, nextDimName, nextParamName, numberText, paramNameProblem, parseParamExpr, replaceName, storeParamDefs } from '../edit/constraint/params';
import { cloneStore, foreignConstraintNotice, readStore } from '../edit/constraint/store';
import { addConstraints, dimValueProblem, evaluateStore, measureConstraint, removeConstraints, resolveParams } from '../edit/constraint/system';
import { type ConstraintStore, type DimConstraint, type DimType, type GeoConstraint, type GeoRef, type GeoType, GEO_LABEL, constraintHandles, dimPrefix } from '../edit/constraint/types';
import type { App, CommandContext, Keyword } from './app';
import type { DocState } from './docstate';
import { type Highlight as HL, Highlight, type Picked, commitOutcome, lockedInStore, nearestEnd, pickCurve, pickPoint, refPoint } from './constraints-pick';
import { askKeyword, askText, button, loadPref, modal, savePref, selectWithKeywords } from './util2-ui';
import { ask, form, h } from './ui/dom';
import { currentUcs } from './ucs';
import type { Pt } from './view';
import { installAcadConstraintSync } from './constraints-acad';

const kw = (key: string, label: string): Keyword => ({ key, label });

const isPicked = (r: unknown): r is Picked => !!r && typeof r === 'object' && 'ref' in r;

/** 명령이 끝나면 강조를 지운다 */
async function withHighlight(app: App, run: (hl: HL) => Promise<void>): Promise<void> {
  const hl = new Highlight(app);
  try {
    await run(hl);
  } finally {
    hl.clear();
  }
}

// ---------------------------------------------------------------------------
// 기하 구속 적용
// ---------------------------------------------------------------------------

function geo(type: GeoType, refs: GeoRef[], extra: Partial<GeoConstraint> = {}): GeoConstraint {
  return { id: 0, kind: 'geo', type, refs, ...extra };
}

/** 기하 구속 하나를 더한다(order: 고른 순서 — 뒤에 고른 객체가 맞춰 움직인다) */
function applyGeo(app: App, ctx: CommandContext, label: string, c: GeoConstraint, order: string[]): boolean {
  const st = app.active!;
  let prepared: GeoConstraint;
  try {
    prepared = prepareGeo(st.doc, c);
  } catch (e) {
    ctx.print(e instanceof MakeError ? e.message : String(e), 'err');
    return false;
  }
  const out = addConstraints(st.doc, readStore(st.doc), [prepared], { order, locked: lockedInStore(app) });
  if (!out.ok) {
    ctx.print(out.message ?? '구속조건을 적용할 수 없습니다.', 'err');
    return false;
  }
  return commitOutcome(app, ctx, label, out);
}

/** UCS 축(수평·수직 기준) */
function ucsAxis(st: DocState): number | undefined {
  const a = currentUcs(st).angle;
  return a ? a : undefined;
}

async function gcTwoCurves(app: App, ctx: CommandContext, label: string, type: GeoType, want: 'line' | 'circle' | 'curve' | 'lineOrCircle'): Promise<void> {
  await withHighlight(app, async (hl) => {
    const a = await pickCurve(app, ctx, '첫 번째 객체 선택:', want, hl);
    if (!isPicked(a)) return;
    const b = await pickCurve(app, ctx, '두 번째 객체 선택:', want, hl);
    if (!isPicked(b)) return;
    if (a.ref.h === b.ref.h && a.ref.part === b.ref.part) {
      ctx.print('같은 객체를 두 번 선택했습니다.', 'err');
      return;
    }
    applyGeo(app, ctx, label, geo(type, [a.ref, b.ref]), [a.ref.h, b.ref.h]);
  });
}

/** 다중(M): 첫 객체에 여러 객체를 차례로 */
async function gcMulti(app: App, ctx: CommandContext, label: string, type: GeoType, want: 'line' | 'lineOrCircle', hl: HL, first: Picked): Promise<void> {
  for (;;) {
    const b = await pickCurve(app, ctx, '객체 선택:', want, hl);
    if (!isPicked(b)) return;
    if (b.ref.h === first.ref.h && b.ref.part === first.ref.part) continue;
    applyGeo(app, ctx, label, geo(type, [first.ref, b.ref]), [first.ref.h, b.ref.h]);
  }
}

async function gcCoincident(app: App, ctx: CommandContext): Promise<void> {
  await withHighlight(app, async (hl) => {
    const r = await pickPoint(app, ctx, '첫 번째 점 선택 또는 [객체(O)/자동 구속(A)] <객체>:', hl, [kw('O', '객체'), kw('A', '자동 구속')]);
    if ('keyword' in r && r.keyword === 'A') {
      const hs = await ctx.getSelection('객체 선택:', { noPickfirst: false });
      if (!hs.length) return;
      const { n } = runAuto(app, ctx, 'GCCOINCIDENT', hs, { ...autoSettings(), types: ['COINCIDENT'] });
      if (n >= 0) ctx.print(`일치 구속조건 ${n}개 적용됨`);
      return;
    }
    if (isPicked(r)) {
      const b = await pickPoint(app, ctx, '두 번째 점 선택:', hl);
      if (!isPicked(b)) return;
      if (samePick(r, b)) {
        ctx.print('같은 점을 두 번 선택했습니다.', 'err');
        return;
      }
      applyGeo(app, ctx, 'GCCOINCIDENT', geo('COINCIDENT', [r.ref, b.ref]), [r.ref.h, b.ref.h]);
      return;
    }
    if ('keyword' in r && r.keyword !== 'O') return;
    // 객체(O): 객체 위에 점을 둔다
    const o = await pickCurve(app, ctx, '객체 선택:', 'curve', hl);
    if (!isPicked(o)) return;
    const p = await pickPoint(app, ctx, '점 선택:', hl);
    if (!isPicked(p)) return;
    if (p.ref.h === o.ref.h) {
      ctx.print('같은 객체의 점은 그 객체에 일치시킬 수 없습니다.', 'err');
      return;
    }
    applyGeo(app, ctx, 'GCCOINCIDENT', geo('COINCIDENT', [p.ref, o.ref]), [o.ref.h, p.ref.h]);
  });
}

const samePick = (a: Picked, b: Picked) => a.ref.h === b.ref.h && a.ref.part === b.ref.part;

async function gcCollinearOrEqual(app: App, ctx: CommandContext, label: string, type: 'COLLINEAR' | 'EQUAL'): Promise<void> {
  const want = type === 'COLLINEAR' ? 'line' : 'lineOrCircle';
  await withHighlight(app, async (hl) => {
    const a = await pickCurve(app, ctx, '첫 번째 객체 선택 또는 [다중(M)]:', want, hl, [kw('M', '다중')]);
    if ('keyword' in a && a.keyword === 'M') {
      const f = await pickCurve(app, ctx, '첫 번째 객체 선택:', want, hl);
      if (isPicked(f)) await gcMulti(app, ctx, label, type, want, hl, f);
      return;
    }
    if (!isPicked(a)) return;
    const b = await pickCurve(app, ctx, '두 번째 객체 선택:', want, hl);
    if (!isPicked(b)) return;
    if (samePick(a, b)) {
      ctx.print('같은 객체를 두 번 선택했습니다.', 'err');
      return;
    }
    if (type === 'EQUAL' && a.shape !== b.shape) {
      ctx.print('선은 선과, 호·원은 호·원과 같게 만들 수 있습니다.', 'err');
      return;
    }
    applyGeo(app, ctx, label, geo(type, [a.ref, b.ref]), [a.ref.h, b.ref.h]);
  });
}

async function gcFix(app: App, ctx: CommandContext): Promise<void> {
  await withHighlight(app, async (hl) => {
    const r = await pickPoint(app, ctx, '점 선택 또는 [객체(O)] <객체>:', hl, [kw('O', '객체')]);
    if (isPicked(r)) {
      applyGeo(app, ctx, 'GCFIX', geo('FIX', [r.ref]), [r.ref.h]);
      return;
    }
    if ('keyword' in r && r.keyword !== 'O') return;
    const o = await pickCurve(app, ctx, '객체 선택:', 'object', hl);
    if (!isPicked(o)) return;
    applyGeo(app, ctx, 'GCFIX', geo('FIX', [o.ref]), [o.ref.h]);
  });
}

async function gcHorizVert(app: App, ctx: CommandContext, type: 'HORIZONTAL' | 'VERTICAL'): Promise<void> {
  const st = app.active!;
  const label = type === 'HORIZONTAL' ? 'GCHORIZONTAL' : 'GCVERTICAL';
  const axis = ucsAxis(st);
  await withHighlight(app, async (hl) => {
    const r = await pickCurve(app, ctx, '객체 선택 또는 [2점(2P)] <2점>:', 'line', hl, [kw('2P', '2점')]);
    if (isPicked(r)) {
      applyGeo(app, ctx, label, geo(type, [r.ref], axis ? { axis } : {}), [r.ref.h]);
      return;
    }
    if ('keyword' in r && r.keyword !== '2P') return;
    const a = await pickPoint(app, ctx, '첫 번째 점 선택:', hl);
    if (!isPicked(a)) return;
    const b = await pickPoint(app, ctx, '두 번째 점 선택:', hl);
    if (!isPicked(b)) return;
    if (samePick(a, b)) {
      ctx.print('같은 점을 두 번 선택했습니다.', 'err');
      return;
    }
    applyGeo(app, ctx, label, geo(type, [a.ref, b.ref], axis ? { axis } : {}), [a.ref.h, b.ref.h]);
  });
}

async function gcSmooth(app: App, ctx: CommandContext): Promise<void> {
  await withHighlight(app, async (hl) => {
    const a = await pickCurve(app, ctx, '첫 번째 스플라인 곡선 선택:', 'spline', hl);
    if (!isPicked(a)) return;
    const ea = nearestEnd(app, a.ref.h, a.at);
    if (!ea) return;
    hl.mark(ea.p);
    for (;;) {
      const r = await ctx.getEntity('두 번째 곡선 선택:');
      if (!('handle' in r)) return;
      if (r.handle === a.ref.h) {
        ctx.print('같은 스플라인을 선택했습니다.', 'err');
        continue;
      }
      const e = app.entity(r.handle);
      if (!e || !['LINE', 'ARC', 'SPLINE', 'LWPOLYLINE', 'POLYLINE'].includes(e.type)) {
        ctx.print('선, 호, 열린 폴리선 또는 스플라인을 선택해야 합니다.', 'err');
        continue;
      }
      const eb = nearestEnd(app, r.handle, r.point);
      if (!eb) {
        ctx.print('끝점이 있는 곡선을 선택해야 합니다.', 'err');
        continue;
      }
      hl.add(r.handle);
      applyGeo(app, ctx, 'GCSMOOTH', geo('SMOOTH', [{ h: a.ref.h, part: ea.part }, { h: r.handle, part: eb.part }]), [r.handle, a.ref.h]);
      return;
    }
  });
}

async function gcSymmetric(app: App, ctx: CommandContext): Promise<void> {
  await withHighlight(app, async (hl) => {
    const r = await pickCurve(app, ctx, '첫 번째 객체 선택 또는 [2점(2P)] <2점>:', 'lineOrCircle', hl, [kw('2P', '2점')]);
    let a: Picked;
    let b: Picked;
    if (isPicked(r)) {
      a = r;
      const r2 = await pickCurve(app, ctx, '두 번째 객체 선택:', 'lineOrCircle', hl);
      if (!isPicked(r2)) return;
      if (r2.shape !== a.shape) {
        ctx.print('같은 종류의 객체(선과 선, 호·원과 호·원)를 선택해야 합니다.', 'err');
        return;
      }
      b = r2;
    } else {
      if ('keyword' in r && r.keyword !== '2P') return;
      const p1 = await pickPoint(app, ctx, '첫 번째 점 선택:', hl);
      if (!isPicked(p1)) return;
      const p2 = await pickPoint(app, ctx, '두 번째 점 선택:', hl);
      if (!isPicked(p2)) return;
      a = p1;
      b = p2;
    }
    if (samePick(a, b)) {
      ctx.print('같은 객체를 두 번 선택했습니다.', 'err');
      return;
    }
    const l = await pickCurve(app, ctx, '대칭 선 선택:', 'line', hl);
    if (!isPicked(l)) return;
    if (l.ref.h === a.ref.h || l.ref.h === b.ref.h) {
      if (l.ref.part === a.ref.part || l.ref.part === b.ref.part) {
        ctx.print('대칭 선은 대칭으로 만들 객체와 달라야 합니다.', 'err');
        return;
      }
    }
    applyGeo(app, ctx, 'GCSYMMETRIC', geo('SYMMETRIC', [a.ref, b.ref, l.ref]), [a.ref.h, l.ref.h, b.ref.h]);
  });
}

const GC_KEYS: { key: string; label: string; type: GeoType; cmd: string }[] = [
  { key: 'H', label: '수평', type: 'HORIZONTAL', cmd: 'GCHORIZONTAL' },
  { key: 'V', label: '수직', type: 'VERTICAL', cmd: 'GCVERTICAL' },
  { key: 'P', label: '직교', type: 'PERPENDICULAR', cmd: 'GCPERPENDICULAR' },
  { key: 'PA', label: '평행', type: 'PARALLEL', cmd: 'GCPARALLEL' },
  { key: 'T', label: '접선', type: 'TANGENT', cmd: 'GCTANGENT' },
  { key: 'SM', label: '부드럽게', type: 'SMOOTH', cmd: 'GCSMOOTH' },
  { key: 'C', label: '일치', type: 'COINCIDENT', cmd: 'GCCOINCIDENT' },
  { key: 'CON', label: '동심', type: 'CONCENTRIC', cmd: 'GCCONCENTRIC' },
  { key: 'COL', label: '동일선상', type: 'COLLINEAR', cmd: 'GCCOLLINEAR' },
  { key: 'S', label: '대칭', type: 'SYMMETRIC', cmd: 'GCSYMMETRIC' },
  { key: 'E', label: '동일', type: 'EQUAL', cmd: 'GCEQUAL' },
  { key: 'F', label: '고정', type: 'FIX', cmd: 'GCFIX' },
];

async function runGeo(app: App, ctx: CommandContext, type: GeoType): Promise<void> {
  switch (type) {
    case 'COINCIDENT':
      return gcCoincident(app, ctx);
    case 'COLLINEAR':
      return gcCollinearOrEqual(app, ctx, 'GCCOLLINEAR', 'COLLINEAR');
    case 'EQUAL':
      return gcCollinearOrEqual(app, ctx, 'GCEQUAL', 'EQUAL');
    case 'CONCENTRIC':
      return gcTwoCurves(app, ctx, 'GCCONCENTRIC', 'CONCENTRIC', 'curve');
    case 'FIX':
      return gcFix(app, ctx);
    case 'PARALLEL':
      return gcTwoCurves(app, ctx, 'GCPARALLEL', 'PARALLEL', 'line');
    case 'PERPENDICULAR':
      return gcTwoCurves(app, ctx, 'GCPERPENDICULAR', 'PERPENDICULAR', 'line');
    case 'HORIZONTAL':
    case 'VERTICAL':
      return gcHorizVert(app, ctx, type);
    case 'TANGENT':
      return gcTwoCurves(app, ctx, 'GCTANGENT', 'TANGENT', 'curve');
    case 'SMOOTH':
      return gcSmooth(app, ctx);
    case 'SYMMETRIC':
      return gcSymmetric(app, ctx);
  }
}

// ---------------------------------------------------------------------------
// 자동 구속
// ---------------------------------------------------------------------------

const AUTO_PREF = 'opencad.autoconstrain';

function autoSettings(): AutoSettings {
  const v = loadPref<Partial<AutoSettings>>(AUTO_PREF, {});
  return { ...AUTO_DEFAULTS, ...v, types: Array.isArray(v.types) && v.types.length ? v.types : AUTO_DEFAULTS.types };
}

/** 자동 구속을 적용하고 적용한 구속 수와 객체 수(실패하면 n = -1) */
function runAuto(app: App, ctx: CommandContext, label: string, handles: string[], settings: AutoSettings): { n: number; objects: number } {
  const st = app.active!;
  const store = readStore(st.doc);
  const cands = autoConstrain(st.doc, store, handles, settings, currentUcs(st).angle);
  if (!cands.length) return { n: 0, objects: 0 };
  const out = addConstraints(st.doc, store, cands, { noCheck: true, locked: lockedInStore(app) });
  if (!out.ok) {
    ctx.print(out.message ?? '구속조건을 적용할 수 없습니다.', 'err');
    return { n: -1, objects: 0 };
  }
  commitOutcome(app, ctx, label, out);
  const sel = new Set(handles);
  return { n: out.added.length, objects: new Set(out.added.flatMap(constraintHandles).filter((h) => sel.has(h))).size };
}

async function autoSettingsDialog(): Promise<void> {
  const cur = autoSettings();
  const types = AUTO_DEFAULTS.types;
  const v = await form(
    '구속조건 설정 - 자동 구속',
    [
      ...types.map((t) => ({ key: t, label: `${GEO_LABEL[t]} 적용`, type: 'check' as const, value: cur.types.includes(t) })),
      { key: 'tan', label: '접선 객체는 공유 교차점이 있어야 함', type: 'check', value: cur.tangentNeedsPoint },
      { key: 'perp', label: '직교 객체는 공유 교차점이 있어야 함', type: 'check', value: cur.perpNeedsPoint },
      { key: 'dist', label: '거리 공차', type: 'number', value: cur.distTol },
      { key: 'angle', label: '각도 공차(도)', type: 'number', value: cur.angleTol },
    ],
    { validate: (x) => (Number(x.dist) < 0 || Number(x.angle) < 0 ? '공차는 0 이상이어야 합니다.' : null) },
  );
  if (!v) return;
  savePref<AutoSettings>(AUTO_PREF, {
    types: types.filter((t) => v[t] === true),
    tangentNeedsPoint: v.tan === true,
    perpNeedsPoint: v.perp === true,
    distTol: Number(v.dist),
    angleTol: Number(v.angle),
  });
}

// ---------------------------------------------------------------------------
// 치수 구속
// ---------------------------------------------------------------------------

function fmtValue(st: DocState, c: Pick<DimConstraint, 'type'>, v: number): string {
  if (c.type === 'ANGLE') return `${Number(v.toFixed(Math.max(0, st.units.auprec)))}`;
  return formatLength(v, st.units);
}

/** 치수선 위치 미리보기(고무줄) */
function dimRubber(app: App, c: DimConstraint, name: string): (p: Pt) => { pts: number[]; closed?: boolean; fill?: boolean }[] {
  const st = app.active!;
  return (p) => {
    try {
      const c2 = prepareDim(st.doc, { ...c, type: c.type }, p);
      const v = measureConstraint(st.doc, c2);
      const gl = constraintGlyphs(st.doc, st.space, app.view.pixelSize(), { store: { constraints: [{ ...c2, name, value: v, expr: numberText(v) }], userParams: [], hiddenBars: [], nextId: 1 }, bars: false, dims: true });
      const out: { pts: number[]; closed?: boolean; fill?: boolean }[] = [];
      for (let i = 0; i + 3 < gl.dims.length; i += 4) out.push({ pts: gl.dims.slice(i, i + 4) });
      for (let i = 0; i + 5 < gl.arrows.length; i += 6) out.push({ pts: gl.arrows.slice(i, i + 6), closed: true, fill: true });
      return out;
    } catch {
      return [];
    }
  };
}

/** DCLINEAR: 치수선 자리로 수평·수직을 고른다(DIMLINEAR와 같은 규칙, UCS 기준) */
function linearKind(st: DocState, p: Vec2, q: Vec2, at: Vec2): 'HDIST' | 'VDIST' {
  const a = currentUcs(st).angle;
  const cs = Math.cos(-a);
  const sn = Math.sin(-a);
  const rot = (v: Vec2) => ({ x: v.x * cs - v.y * sn, y: v.x * sn + v.y * cs });
  const P = rot(p);
  const Q = rot(q);
  const A = rot(at);
  const out = (v: number, lo: number, hi: number) => (v < lo ? lo - v : v > hi ? v - hi : 0);
  const ox = out(A.x, Math.min(P.x, Q.x), Math.max(P.x, Q.x));
  const oy = out(A.y, Math.min(P.y, Q.y), Math.max(P.y, Q.y));
  if (oy > 0 && ox === 0) return 'HDIST';
  if (ox > 0 && oy === 0) return 'VDIST';
  if (ox === 0 && oy === 0) return Math.abs(Q.x - P.x) >= Math.abs(Q.y - P.y) ? 'HDIST' : 'VDIST';
  return oy >= ox ? 'HDIST' : 'VDIST';
}

/** 치수 문자(이름=식) 입력과 검사. Enter면 지금 값 */
async function askDimText(app: App, ctx: CommandContext, c: DimConstraint, store: ConstraintStore, measured: number): Promise<{ name: string; expr: string; value: number } | null> {
  const st = app.active!;
  const def = nextDimName(store, c);
  for (;;) {
    const t = (await askText(ctx, `치수 문자 = <${def}=${fmtValue(st, c, measured)}>:`, '')).trim();
    if (!t) return { name: def, expr: numberText(measured), value: measured };
    const eq = t.indexOf('=');
    const name = (eq >= 0 ? t.slice(0, eq) : def).trim();
    const expr = (eq >= 0 ? t.slice(eq + 1) : t).trim();
    const nameErr = paramNameProblem(name);
    if (nameErr) {
      ctx.print(nameErr, 'err');
      continue;
    }
    if (storeParamDefs(store).some((d) => d.name.toLowerCase() === name.toLowerCase())) {
      ctx.print(`매개변수 "${name}"이(가) 이미 있습니다.`, 'err');
      continue;
    }
    try {
      parseParamExpr(expr);
    } catch (e) {
      ctx.print(`식이 올바르지 않습니다: ${e instanceof Error ? e.message : String(e)}`, 'err');
      continue;
    }
    const ev = evaluateParams([...storeParamDefs(store), { name, expr, reference: false }], 1);
    const err = ev.errors.get(name.toLowerCase());
    const v = ev.values.get(name.toLowerCase());
    if (err || v === undefined) {
      ctx.print(err ?? '값을 구할 수 없습니다.', 'err');
      continue;
    }
    const why = dimValueProblem(c.type, v);
    if (why) {
      ctx.print(why, 'err');
      continue;
    }
    return { name, expr, value: v };
  }
}

/** 치수 구속을 만든다: 치수선 위치 → 값 → 적용(과도한 구속이면 참조로 만들지 묻는다) */
async function finishDim(app: App, ctx: CommandContext, label: string, base: DimConstraint, hl: HL, opt: { linear?: [Vec2, Vec2]; order?: string[] } = {}): Promise<void> {
  const st = app.active!;
  const store = readStore(st.doc);
  const name = nextDimName(store, base);
  let c = base;
  const r = await ctx.getPoint('치수선 위치 지정:', {
    ghost: hl.ghost,
    rubber: (p) => {
      const t = opt.linear ? linearKind(st, opt.linear[0], opt.linear[1], p) : c.type;
      return dimRubber(app, { ...c, type: t }, name.replace(/^[a-z]+/, dimPrefix(t)))(p);
    },
  });
  if (!('point' in r)) return;
  if (opt.linear) c = { ...c, type: linearKind(st, opt.linear[0], opt.linear[1], r.point) };
  try {
    c = prepareDim(st.doc, c, r.point);
  } catch (e) {
    ctx.print(e instanceof MakeError ? e.message : String(e), 'err');
    return;
  }
  const measured = measureConstraint(st.doc, c);
  if (!Number.isFinite(measured)) {
    ctx.print('측정할 수 없습니다.', 'err');
    return;
  }
  const v = await askDimText(app, ctx, c, store, measured);
  if (!v) return;
  c = { ...c, name: v.name, expr: v.expr, value: v.value };
  const order = opt.order ?? constraintHandles(c);
  let out = addConstraints(st.doc, readStore(st.doc), [c], { order, locked: lockedInStore(app) });
  if (!out.ok && out.reason === 'overconstrained') {
    const ans = await ask(label, '치수 구속조건을 추가하면 형상이 과도하게 구속됩니다.', [
      { label: '참조 구속조건 만들기', value: 'ref', primary: true },
      { label: '치수 구속조건 만들지 않음', value: 'no' },
    ]);
    if (ans !== 'ref') return;
    c = { ...c, reference: true, value: measured, expr: numberText(measured) };
    out = addConstraints(st.doc, readStore(st.doc), [c], { order, noCheck: true, locked: lockedInStore(app) });
  }
  if (!out.ok) {
    ctx.print(out.message ?? '구속조건을 적용할 수 없습니다.', 'err');
    return;
  }
  commitOutcome(app, ctx, label, out);
}

function dim(type: DimType, refs: GeoRef[], axis?: number): DimConstraint {
  return { id: 0, kind: 'dim', type, refs, name: '', expr: '0', value: 0, reference: false, offset: 0, ...(axis ? { axis } : {}) };
}

/** 두 구속점 또는 선 하나(O)의 두 끝 */
async function twoPoints(app: App, ctx: CommandContext, hl: HL, first: Awaited<ReturnType<typeof pickPoint>>): Promise<[GeoRef, GeoRef, Vec2, Vec2] | null> {
  if (isPicked(first)) {
    const b = await pickPoint(app, ctx, '두 번째 구속점 지정:', hl);
    if (!isPicked(b)) return null;
    if (samePick(first, b)) {
      ctx.print('같은 점을 두 번 선택했습니다.', 'err');
      return null;
    }
    return [first.ref, b.ref, first.point!, b.point!];
  }
  if ('keyword' in first && first.keyword !== 'O') return null;
  const o = await pickCurve(app, ctx, '객체 선택:', 'line', hl);
  if (!isPicked(o)) return null;
  const st = app.active!;
  const e = st.doc.entityIndex.get(o.ref.h)!;
  if (e.type === 'LINE') return [{ h: o.ref.h, part: 'S' }, { h: o.ref.h, part: 'E' }, e.start, e.end];
  // 폴리선 세그먼트: 그 세그먼트의 두 정점
  const i = Number(o.ref.part.slice(1));
  const n = e.type === 'LWPOLYLINE' ? e.vertices.length : e.type === 'POLYLINE' ? e.vertices.length : 0;
  const ra = { h: o.ref.h, part: `V${i}` };
  const rb = { h: o.ref.h, part: `V${(i + 1) % n}` };
  const pa = refPoint(app, ra);
  const pb = refPoint(app, rb);
  if (!pa || !pb) return null;
  return [ra, rb, pa, pb];
}



async function dcLinearLike(app: App, ctx: CommandContext, label: string, fixed?: 'HDIST' | 'VDIST'): Promise<void> {
  const st = app.active!;
  const axis = ucsAxis(st);
  await withHighlight(app, async (hl) => {
    const f = await pickPoint(app, ctx, '첫 번째 구속점 지정 또는 [객체(O)] <객체>:', hl, [kw('O', '객체')]);
    const pts = await twoPoints(app, ctx, hl, f);
    if (!pts) return;
    const base = dim(fixed ?? 'HDIST', [pts[0], pts[1]], axis);
    await finishDim(app, ctx, label, base, hl, fixed ? {} : { linear: [pts[2], pts[3]] });
  });
}

async function dcAligned(app: App, ctx: CommandContext, label = 'DCALIGNED'): Promise<void> {
  await withHighlight(app, async (hl) => {
    const f = await pickPoint(app, ctx, '첫 번째 구속점 지정 또는 [객체(O)/점과 선(P)/2선(2L)] <객체>:', hl, [kw('O', '객체'), kw('P', '점과 선'), kw('2L', '2선')]);
    if ('keyword' in f && f.keyword === 'P') {
      const p = await pickPoint(app, ctx, '구속점 선택:', hl);
      if (!isPicked(p)) return;
      const l = await pickCurve(app, ctx, '선 선택:', 'line', hl);
      if (!isPicked(l)) return;
      if (l.ref.h === p.ref.h && onSameSegment(p.ref, l.ref)) {
        ctx.print('점이 그 선 위에 있습니다.', 'err');
        return;
      }
      // 선을 기준으로 점이 움직인다
      await finishDim(app, ctx, label, dim('DIST', [p.ref, l.ref]), hl, { order: [l.ref.h, p.ref.h] });
      return;
    }
    if ('keyword' in f && f.keyword === '2L') {
      const a = await pickCurve(app, ctx, '첫 번째 선 선택:', 'line', hl);
      if (!isPicked(a)) return;
      const b = await pickCurve(app, ctx, '평행선으로 만들 두 번째 선 선택:', 'line', hl);
      if (!isPicked(b)) return;
      if (samePick(a, b)) {
        ctx.print('같은 선을 두 번 선택했습니다.', 'err');
        return;
      }
      await finishDim(app, ctx, label, dim('DIST', [a.ref, b.ref]), hl);
      return;
    }
    const pts = await twoPoints(app, ctx, hl, f);
    if (!pts) return;
    await finishDim(app, ctx, label, dim('DIST', [pts[0], pts[1]]), hl);
  });
}

/** 폴리선 정점이 그 세그먼트의 끝인지 */
function onSameSegment(p: GeoRef, l: GeoRef): boolean {
  if (!p.part.startsWith('V') || !l.part.startsWith('G')) return p.part === 'S' || p.part === 'E' || p.part === 'M';
  const i = Number(l.part.slice(1));
  const v = Number(p.part.slice(1));
  return v === i || v === i + 1;
}

async function dcAngular(app: App, ctx: CommandContext, label = 'DCANGULAR'): Promise<void> {
  await withHighlight(app, async (hl) => {
    const a = await pickCurve(app, ctx, '첫 번째 선 또는 호 선택 또는 [3점(3P)] <3점>:', 'lineOrCircle', hl, [kw('3P', '3점')]);
    if (isPicked(a)) {
      if (a.shape === 'circle') {
        const st = app.active!;
        const e = st.doc.entityIndex.get(a.ref.h)!;
        if (e.type === 'CIRCLE') {
          ctx.print('호 또는 선을 선택해야 합니다.', 'err');
          return;
        }
        await finishDim(app, ctx, label, dim('ANGLE', [a.ref]), hl);
        return;
      }
      const b = await pickCurve(app, ctx, '두 번째 선 선택:', 'line', hl);
      if (!isPicked(b)) return;
      if (samePick(a, b)) {
        ctx.print('같은 선을 두 번 선택했습니다.', 'err');
        return;
      }
      await finishDim(app, ctx, label, dim('ANGLE', [a.ref, b.ref]), hl);
      return;
    }
    if ('keyword' in a && a.keyword !== '3P') return;
    const o = await pickPoint(app, ctx, '각도 정점 지정:', hl);
    if (!isPicked(o)) return;
    const p = await pickPoint(app, ctx, '첫 번째 각도 구속점 지정:', hl);
    if (!isPicked(p)) return;
    const q = await pickPoint(app, ctx, '두 번째 각도 구속점 지정:', hl);
    if (!isPicked(q)) return;
    if (samePick(o, p) || samePick(o, q) || samePick(p, q)) {
      ctx.print('서로 다른 세 점을 선택해야 합니다.', 'err');
      return;
    }
    await finishDim(app, ctx, label, dim('ANGLE', [o.ref, p.ref, q.ref]), hl);
  });
}

async function dcRadial(app: App, ctx: CommandContext, type: 'RADIUS' | 'DIAMETER', label: string): Promise<void> {
  await withHighlight(app, async (hl) => {
    const a = await pickCurve(app, ctx, '호 또는 원 선택:', 'circle', hl);
    if (!isPicked(a)) return;
    await finishDim(app, ctx, label, dim(type, [a.ref]), hl);
  });
}

// ---------------------------------------------------------------------------
// 매개변수 관리자
// ---------------------------------------------------------------------------

interface ParamRow {
  /** 치수 구속 번호(사용자 매개변수면 undefined) */
  id?: number;
  /** 원래 이름(이름 바꾸기 추적) */
  orig: string;
  name: string;
  expr: string;
  description: string;
  reference: boolean;
  type: string;
  deleted: boolean;
}

function rowsOf(st: DocState, store: ConstraintStore): ParamRow[] {
  const rows: ParamRow[] = [];
  for (const c of store.constraints) {
    if (c.kind !== 'dim') continue;
    const type = c.type === 'ANGLE' ? '각도' : c.type === 'RADIUS' ? '반지름' : c.type === 'DIAMETER' ? '지름' : c.type === 'HDIST' ? '수평' : c.type === 'VDIST' ? '수직' : '정렬';
    rows.push({ id: c.id, orig: c.name, name: c.name, expr: c.reference ? fmtValue(st, c, c.value) : c.expr, description: c.description ?? '', reference: c.reference, type, deleted: false });
  }
  for (const u of store.userParams) rows.push({ orig: u.name, name: u.name, expr: u.expr, description: u.description ?? '', reference: false, type: '사용자', deleted: false });
  return rows;
}

/** 표의 줄로 새 구속 기록을 만든다(이름 바꾸면 다른 식의 이름도 바꾼다). 오류면 문자열 */
function storeFromRows(store: ConstraintStore, rows: ParamRow[]): ConstraintStore | string {
  const live = rows.filter((r) => !r.deleted);
  const seen = new Set<string>();
  for (const r of live) {
    const why = paramNameProblem(r.name);
    if (why) return `${r.name || '(빈 이름)'}: ${why}`;
    const k = r.name.trim().toLowerCase();
    if (seen.has(k)) return `이름 "${r.name}"이(가) 겹칩니다.`;
    seen.add(k);
    if (!r.reference) {
      if (!r.expr.trim()) return `${r.name}: 식을 입력하십시오.`;
      try {
        parseParamExpr(r.expr);
      } catch (e) {
        return `${r.name}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }
  // 이름 바꾸기: 다른 식에 남은 옛 이름을 새 이름으로
  const renames = live.filter((r) => r.orig && r.orig.toLowerCase() !== r.name.trim().toLowerCase());
  for (const r of live)
    if (!r.reference) {
      let e = r.expr;
      for (const rn of renames) if (rn !== r) e = replaceName(e, rn.orig, rn.name.trim());
      r.expr = e;
    }
  let s = cloneStore(store);
  // 지운 치수 구속 → 구속 지우기(그 이름을 읽던 식에는 값), 지운 사용자 매개변수 → 값을 써 넣는다
  const delDims = rows.filter((r) => r.deleted && r.id !== undefined).map((r) => r.id!);
  s = removeConstraints(s, delDims);
  const byId = new Map(live.filter((r) => r.id !== undefined).map((r) => [r.id!, r]));
  s.constraints = s.constraints.map((c) => {
    if (c.kind !== 'dim') return c;
    const r = byId.get(c.id);
    if (!r) return c;
    const out: DimConstraint = { ...c, name: r.name.trim(), description: r.description || undefined };
    if (!c.reference) out.expr = r.expr.trim();
    if (!out.description) delete out.description;
    return out;
  });
  const users = live.filter((r) => r.id === undefined);
  const delUsers = rows.filter((r) => r.deleted && r.id === undefined && r.orig);
  const ev = evaluateParams(storeParamDefs(store), 1);
  for (const d of delUsers) {
    const v = ev.values.get(d.orig.toLowerCase()) ?? 0;
    const lit = `(${numberText(v)})`;
    s.constraints = s.constraints.map((c) => (c.kind === 'dim' && !c.reference ? { ...c, expr: replaceName(c.expr, d.orig, lit) } : c));
    for (const u of users) u.expr = replaceName(u.expr, d.orig, lit);
  }
  s.userParams = users.map((u) => ({ name: u.name.trim(), expr: u.expr.trim(), value: 0, ...(u.description ? { description: u.description } : {}) }));
  return s;
}

async function parametersManager(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const store = readStore(st.doc);
  const rows = rowsOf(st, store);
  const body = h('div', { class: 'u2-col' });
  const err = h('div', { class: 'u2-err', role: 'alert' });
  const tbody = h('tbody');
  const table = h('table', { class: 'u2-table' }, h('thead', {}, h('tr', {}, h('th', {}, '이름'), h('th', {}, '식'), h('th', {}, '값'), h('th', {}, '유형'), h('th', {}, '설명'), h('th', {}, ''))), tbody);
  const valueCells = new Map<ParamRow, HTMLTableCellElement>();
  const refresh = () => {
    const s = storeFromRows(store, rows.map((r) => ({ ...r })));
    if (typeof s === 'string') {
      err.textContent = s;
      return;
    }
    const ev = evaluateStore(st.doc, s);
    err.textContent = '';
    for (const [r, cell] of valueCells) {
      const k = r.name.trim().toLowerCase();
      const v = ev.values.get(k);
      const e = ev.errors.get(k);
      cell.textContent = e ? '오류' : v === undefined ? '' : r.type === '각도' ? `${numberText(Number(v.toFixed(8)))}°` : formatLength(v, st.units);
      cell.title = e ?? '';
      if (e && !err.textContent) err.textContent = `${r.name}: ${e}`;
    }
  };
  const render = () => {
    tbody.innerHTML = '';
    valueCells.clear();
    for (const r of rows) {
      if (r.deleted) continue;
      const name = h('input', { type: 'text', 'aria-label': '이름', value: r.name, style: 'width:90px' }) as HTMLInputElement;
      name.addEventListener('input', () => {
        r.name = name.value;
        refresh();
      });
      const expr = h('input', { type: 'text', 'aria-label': '식', value: r.expr, style: 'width:150px', disabled: r.reference }) as HTMLInputElement;
      expr.addEventListener('input', () => {
        r.expr = expr.value;
        refresh();
      });
      const desc = h('input', { type: 'text', 'aria-label': '설명', value: r.description, style: 'width:120px' }) as HTMLInputElement;
      desc.addEventListener('input', () => (r.description = desc.value));
      for (const i of [name, expr, desc]) i.addEventListener('keydown', (ev) => ev.stopPropagation());
      const val = h('td', { class: 'num' });
      valueCells.set(r, val);
      const del = button('삭제', () => {
        r.deleted = true;
        render();
      });
      tbody.append(h('tr', {}, h('td', {}, name), h('td', {}, expr), val, h('td', {}, r.reference ? `${r.type}(참조)` : r.type), h('td', {}, desc), h('td', {}, del)));
    }
    refresh();
  };
  const addUser = button('사용자 매개변수 추가', () => {
    const tmp = { ...store, userParams: [...store.userParams, ...rows.filter((r) => r.id === undefined).map((r) => ({ name: r.name, expr: r.expr, value: 0 }))], constraints: store.constraints };
    rows.push({ orig: '', name: nextParamName(tmp, 'user'), expr: '1', description: '', reference: false, type: '사용자', deleted: false });
    render();
  });
  body.append(h('div', { class: 'u2-list', style: 'max-height:340px;min-height:160px' }, table), h('div', { class: 'u2-row' }, addUser), h('div', { class: 'u2-note' }, '식에는 수, + − * / ^, 괄호, 함수(sin·cos·sqrt …, 각도는 도), pi와 다른 매개변수 이름을 쓸 수 있습니다.'), err);
  render();
  const m = modal<{ store: ConstraintStore; entities: Map<string, import('../core/model').Entity> }>(
    '매개변수 관리자',
    body,
    [
      { label: '취소', value: () => null as never },
      {
        label: '확인',
        primary: true,
        value: () => {
          const s = storeFromRows(store, rows.map((r) => ({ ...r })));
          if (typeof s === 'string') {
            err.textContent = s;
            return undefined;
          }
          const out = resolveParams(st.doc, store, s, { locked: lockedInStore(app) });
          if (!out.ok) {
            err.textContent = out.message ?? '구속조건을 만족하는 형상을 찾지 못했습니다.';
            return undefined;
          }
          return { store: out.store ?? s, entities: out.entities };
        },
      },
    ],
    'wide',
  );
  const res = await m.done;
  if (!res) return;
  commitOutcome(app, ctx, 'PARAMETERS', res);
  ctx.print(`매개변수를 적용했습니다(바뀐 객체 ${res.entities.size}개).`);
}

// ---------------------------------------------------------------------------
// 등록
// ---------------------------------------------------------------------------

export function registerConstraintCommands(app: App): void {
  installAcadConstraintSync(app);
  app.register({
    name: 'GEOMCONSTRAINT',
    aliases: ['GCON'],
    title: '기하학적 구속조건',
    async run(ctx) {
      const keys = GC_KEYS.map((k) => kw(k.key, k.label));
      const r = await askKeyword(ctx, `구속조건 유형 입력 [${GC_KEYS.map((k) => `${k.label}(${k.key})`).join('/')}] <일치>:`, keys, 'C');
      const k = typeof r === 'string' ? GC_KEYS.find((x) => x.key === r) : null;
      if (!k) {
        if (r !== null) ctx.print('옵션을 입력하십시오.', 'err');
        return;
      }
      await runGeo(app, ctx, k.type);
    },
  });
  for (const k of GC_KEYS)
    app.register({
      name: k.cmd,
      title: `${k.label} 구속조건`,
      run: (ctx) => runGeo(app, ctx, k.type),
    });

  app.register({
    name: 'AUTOCONSTRAIN',
    title: '자동 구속',
    async run(ctx) {
      for (;;) {
        const r = await selectWithKeywords(ctx, '객체 선택 또는 [설정(S)]:', [kw('S', '설정')], true);
        if (!Array.isArray(r)) {
          if (r.keyword === 'S') await autoSettingsDialog();
          continue;
        }
        if (!r.length) return;
        const { n, objects } = runAuto(app, ctx, 'AUTOCONSTRAIN', r, autoSettings());
        if (n < 0) return;
        ctx.print(`${n}개의 구속조건을 ${objects}개의 객체에 적용함`);
        return;
      }
    },
  });

  app.register({
    name: 'DELCONSTRAINT',
    title: '구속조건 삭제',
    async run(ctx) {
      ctx.print('선택한 객체에서 모든 구속조건을 제거합니다…');
      const hs = await ctx.getSelection('객체 선택:');
      if (!hs.length) return;
      const st = app.active!;
      const store = readStore(st.doc);
      const set = new Set(hs);
      const ids = store.constraints.filter((c) => c.refs.some((r) => set.has(r.h))).map((c) => c.id);
      if (!ids.length) {
        ctx.print('선택한 객체에 구속조건이 없습니다.');
        return;
      }
      commitOutcome(app, ctx, 'DELCONSTRAINT', { entities: new Map(), store: removeConstraints(store, ids) });
      ctx.print(`${ids.length}개의 구속조건을 제거했습니다.`);
    },
  });

  app.register({
    name: 'CONSTRAINTBAR',
    aliases: ['CBAR'],
    title: '구속 막대',
    async run(ctx) {
      const st = app.active!;
      const hs = await ctx.getSelection('객체 선택:');
      const opts = [kw('S', '표시'), kw('H', '숨기기'), kw('R', '재설정')];
      const r = await askKeyword(ctx, '옵션 입력 [표시(S)/숨기기(H)/재설정(R)]<표시>:', opts, 'S');
      const k = typeof r === 'string' ? r : 'S';
      const store = readStore(st.doc);
      if (!hs.length) {
        // 고른 것이 없으면 모든 구속 막대
        setConstraintDisplay(st.doc, { bars: k !== 'H' });
        const s = { ...store, hiddenBars: k === 'H' ? store.hiddenBars : [] };
        if (s.hiddenBars.length !== store.hiddenBars.length) commitOutcome(app, ctx, 'CONSTRAINTBAR', { entities: new Map(), store: s });
        app.view.requestOverlay();
        return;
      }
      const hidden = new Set(store.hiddenBars);
      for (const x of hs) if (k === 'H') hidden.add(x);
      else hidden.delete(x);
      if (k !== 'H') setConstraintDisplay(st.doc, { bars: true });
      commitOutcome(app, ctx, 'CONSTRAINTBAR', { entities: new Map(), store: { ...store, hiddenBars: [...hidden] } });
      app.view.requestOverlay();
    },
  });

  app.register({
    name: 'DCDISPLAY',
    title: '동적 구속조건 표시',
    async run(ctx) {
      const st = app.active!;
      const hs = await ctx.getSelection('객체 선택:');
      const r = await askKeyword(ctx, '옵션 입력 [표시(S)/숨기기(H)] <표시>:', [kw('S', '표시'), kw('H', '숨기기')], 'S');
      const hide = r === 'H';
      const store = readStore(st.doc);
      if (!hs.length) {
        setConstraintDisplay(st.doc, { dims: !hide });
        app.view.requestOverlay();
        return;
      }
      const set = new Set(hs);
      const s: ConstraintStore = {
        ...store,
        constraints: store.constraints.map((c) => {
          if (c.kind !== 'dim' || !c.refs.some((x) => set.has(x.h))) return c;
          const out: DimConstraint = { ...c, hidden: hide };
          if (!hide) delete out.hidden;
          return out;
        }),
      };
      if (!hide) setConstraintDisplay(st.doc, { dims: true });
      commitOutcome(app, ctx, 'DCDISPLAY', { entities: new Map(), store: s });
    },
  });

  // 치수 구속
  app.register({ name: 'DCLINEAR', title: '선형 치수 구속조건', run: (ctx) => dcLinearLike(app, ctx, 'DCLINEAR') });
  app.register({ name: 'DCHORIZONTAL', title: '수평 치수 구속조건', run: (ctx) => dcLinearLike(app, ctx, 'DCHORIZONTAL', 'HDIST') });
  app.register({ name: 'DCVERTICAL', title: '수직 치수 구속조건', run: (ctx) => dcLinearLike(app, ctx, 'DCVERTICAL', 'VDIST') });
  app.register({ name: 'DCALIGNED', title: '정렬 치수 구속조건', run: (ctx) => dcAligned(app, ctx) });
  app.register({ name: 'DCANGULAR', title: '각도 치수 구속조건', run: (ctx) => dcAngular(app, ctx) });
  app.register({ name: 'DCRADIUS', title: '반지름 치수 구속조건', run: (ctx) => dcRadial(app, ctx, 'RADIUS', 'DCRADIUS') });
  app.register({ name: 'DCDIAMETER', title: '지름 치수 구속조건', run: (ctx) => dcRadial(app, ctx, 'DIAMETER', 'DCDIAMETER') });
  app.register({
    name: 'DIMCONSTRAINT',
    aliases: ['DCON'],
    title: '치수 구속조건',
    async run(ctx) {
      ctx.print('현재 설정: 구속조건 폼 = 동적');
      const keys = [kw('LI', '선형'), kw('H', '수평'), kw('V', '수직'), kw('A', '정렬'), kw('AN', '각도'), kw('R', '반지름'), kw('D', '지름'), kw('F', '폼')];
      for (;;) {
        const r = await ctx.getEntity('변환할 연관 치수 선택 또는 [선형(LI)/수평(H)/수직(V)/정렬(A)/각도(AN)/반지름(R)/지름(D)/폼(F)] <정렬>:', keys);
        if ('handle' in r) {
          ctx.print('연관 치수를 구속조건으로 바꾸는 변환은 지원하지 않습니다. 옵션으로 치수 구속조건을 만드십시오.', 'err');
          continue;
        }
        const k = 'keyword' in r ? r.keyword : 'A';
        switch (k) {
          case 'LI':
            return dcLinearLike(app, ctx, 'DIMCONSTRAINT');
          case 'H':
            return dcLinearLike(app, ctx, 'DIMCONSTRAINT', 'HDIST');
          case 'V':
            return dcLinearLike(app, ctx, 'DIMCONSTRAINT', 'VDIST');
          case 'A':
            return dcAligned(app, ctx, 'DIMCONSTRAINT');
          case 'AN':
            return dcAngular(app, ctx, 'DIMCONSTRAINT');
          case 'R':
            return dcRadial(app, ctx, 'RADIUS', 'DIMCONSTRAINT');
          case 'D':
            return dcRadial(app, ctx, 'DIAMETER', 'DIMCONSTRAINT');
          case 'F':
            ctx.print('이 앱은 동적 구속조건만 만듭니다(주석 구속조건은 지원하지 않음).');
            continue;
        }
      }
    },
  });

  app.register({
    name: 'PARAMETERS',
    aliases: ['PAR'],
    title: '매개변수 관리자',
    run: (ctx) => parametersManager(app, ctx),
  });
}

/** 도면을 열 때 AutoCAD가 만든 구속을 읽은 결과 안내(있으면 명령행에 한 줄). main.ts의 onOpened에서 부른다 */
export function noteForeignConstraints(app: App, st: DocState): void {
  const msg = foreignConstraintNotice(st.doc);
  if (msg) app.cmd.print(`참고: ${msg}`);
}

/** 지금 도면의 구속 표시 상태 */
export function constraintDisplayOf(st: DocState): { bars: boolean; dims: boolean } {
  return constraintDisplay(st.doc);
}

