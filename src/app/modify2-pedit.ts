/**
 * PEDIT(PE)·SPLINEDIT(SPE). 프롬프트와 옵션은 AutoCAD 2026 한국어판을 따른다. 계산은 src/edit/geom/pedit.ts·splinedit.ts.
 * 옵션 하나가 명령 취소 한 단계(명령 취소(U))이고, 명령 전체는 U 한 번으로 되돌린다.
 */
import type { Entity, SplineEntity, Vec2 } from '../core/model';
import { type EditResult, joinEntities, reverseEntity } from '../edit/geom';
import { entityPath } from '../edit/geom/path';
import { pathEnd, pathStart } from '../edit/geom/curve';
import {
  type PolyEntity,
  breakAtVertices,
  decurve,
  fitKind,
  fitPolyline,
  frameVerts,
  insertVertex,
  is3d,
  isClosed,
  isPolyline,
  moveVertex,
  polyEnds,
  removeVertex,
  setClosed,
  setLinetypeGen,
  setSegmentWidth,
  setVertexTangent,
  setWidth,
  splinePolyline,
  straightenBetween,
  splineToPolyline,
  toOcs,
  toPolyline,
  vertexPoint,
} from '../edit/geom/pedit';
import {
  closeSpline,
  cvAdd,
  cvCount,
  cvDelete,
  cvMove,
  cvWeight,
  elevateOrder,
  fitAdd,
  fitDelete,
  fitKink,
  fitMove,
  fitTangents,
  fitTolerance,
  isFitSpline,
  isPeriodicForm,
  isSplineClosed,
  openSpline,
  purgeFit,
  reverseSplineEntity,
} from '../edit/geom/splinedit';
import type { App, CommandContext, Keyword } from './app';
import { commitResults } from './modify';
import { askNumber, choose, hnum, previewOf } from './modify2-util';
import { unlockedOnly } from './layers';
import type { Pt } from './view';

interface Step {
  /** 작업 수 */
  n: number;
  /** 이 단계 전의 편집 대상 핸들 */
  hs: string[];
}

function nearestIndex(points: readonly Vec2[], p: Vec2): number {
  let best = -1;
  let bd = Infinity;
  points.forEach((q, i) => {
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

function kwsOf(list: [string, string][]): Keyword[] {
  return list.map(([key, label]) => ({ key, label }));
}

function textOf(list: [string, string][]): string {
  return list.map(([k, l]) => `${l}(${k})`).join('/');
}

export function registerPeditCommands(app: App): void {
  app.register({ name: 'PEDIT', aliases: ['PE'], title: '폴리선 편집', run: (ctx) => pedit(app, ctx) });
  app.register({ name: 'SPLINEDIT', aliases: ['SPE'], title: '스플라인 편집', run: (ctx) => splinedit(app, ctx) });
}

// ---------------------------------------------------------------------------
// 공통
// ---------------------------------------------------------------------------

function makeTools(app: App, ctx: CommandContext, label: string) {
  const st = app.active!;
  const steps: Step[] = [];
  return {
    steps,
    get: (h: string) => st.doc.entityIndex.get(h),
    /** 같은 핸들로 바꾼다 */
    apply(before: Entity, after: Entity | null, hs: string[] = [before.handle], msg = '이 옵션을 적용할 수 없습니다.'): boolean {
      if (!after) {
        ctx.print(msg, 'err');
        return false;
      }
      const a = commitResults(app, ctx, [{ replace: [{ ...after, handle: before.handle } as Entity] }], label, { quiet: true });
      if (a.ops) steps.push({ n: a.ops, hs });
      return a.ops > 0;
    },
    commit(res: EditResult[], hs: string[]) {
      const a = commitResults(app, ctx, res, label, { quiet: true });
      if (a.ops) steps.push({ n: a.ops, hs });
      return a;
    },
    /** 명령 취소: 되돌린 단계 전의 대상 핸들(없으면 null) */
    undo(): string[] | null {
      const s = steps.pop();
      if (!s) {
        ctx.print('명령 취소할 것이 없습니다.');
        return null;
      }
      st.session.undoLastStep(ctx.group, s.n);
      return s.hs;
    },
    mark(points: { p: Vec2; text?: string }[]) {
      app.view.overlay.marks = points.slice(0, 2000);
      app.view.requestOverlay();
    },
  };
}

// ---------------------------------------------------------------------------
// PEDIT
// ---------------------------------------------------------------------------

async function askConvert(ctx: CommandContext, prompt: string): Promise<boolean> {
  const r = await ctx.getPoint(prompt, { keywords: [{ key: 'Y', label: '예' }, { key: 'N', label: '아니오' }] });
  if ('keyword' in r) return r.keyword === 'Y';
  return 'enter' in r;
}

function convertible(e: Entity): boolean {
  return e.type === 'LINE' || e.type === 'ARC' || e.type === 'SPLINE';
}

function convertOne(e: Entity, precision: number): PolyEntity | null {
  if (e.type === 'SPLINE') return splineToPolyline(e, precision);
  return toPolyline(e);
}

async function pedit(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  const accept = hnum(doc, '$PEDITACCEPT', 0) === 1;
  const t = makeTools(app, ctx, 'PEDIT');
  try {
    // 먼저 고른 객체가 여럿이면 다중
    if (st.selection.size > 1) {
      const hs = unlockedOnly(app, [...st.selection]);
      st.selection.clear();
      return await peditMulti(app, ctx, t, hs, accept);
    }
    let h: string | null = st.selection.size === 1 ? [...st.selection][0]! : null;
    st.selection.clear();
    app.refreshSelectionOverlay();
    for (;;) {
      if (!h) {
        const r = await ctx.getEntity('폴리선 선택 또는 [다중(M)]:', [{ key: 'M', label: '다중' }]);
        if ('enter' in r) return;
        if ('keyword' in r) {
          const hs = unlockedOnly(app, await ctx.getSelection('객체 선택:', { noPickfirst: true }));
          return await peditMulti(app, ctx, t, hs, accept);
        }
        h = r.handle;
      }
      const e = t.get(h);
      if (!e || !unlockedOnly(app, [h]).length) {
        h = null;
        continue;
      }
      if (isPolyline(e)) break;
      if (convertible(e)) {
        ctx.print('선택된 객체가 폴리선이 아님');
        if (!accept && !(await askConvert(ctx, '폴리선으로 변환하겠습니까? <Y>'))) {
          h = null;
          continue;
        }
        let prec = 10;
        if (e.type === 'SPLINE') {
          const v = await askNumber(ctx, '정밀도 지정', 10, { int: true, min: 0, max: 99, distance: false });
          if (typeof v !== 'number') return;
          prec = v;
        }
        const np = convertOne(e, prec);
        if (!np) {
          ctx.print('폴리선으로 바꿀 수 없습니다.', 'err');
          h = null;
          continue;
        }
        const a = t.commit([{ remove: [e.handle], add: [np] }], [e.handle]);
        h = a.added[0] ?? null;
        break;
      }
      ctx.print((e as Entity).type === 'POLYLINE' ? '이 폴리선(메시·폴리페이스)은 편집할 수 없습니다.' : '객체가 폴리선이 아닙니다.', 'err');
      h = null;
    }
    if (!h) return;
    await peditOptions(app, ctx, t, h);
  } finally {
    app.view.overlay.marks = [];
    st.selection.clear();
    app.refreshSelectionOverlay();
  }
}

type Tools = ReturnType<typeof makeTools>;

async function peditOptions(app: App, ctx: CommandContext, t: Tools, h0: string): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  let h = h0;
  const segs = () => Math.round(hnum(doc, '$SPLINESEGS', 8)) || 8;
  for (;;) {
    const e = t.get(h);
    if (!e || !isPolyline(e)) return;
    app.setSelection([h]);
    const closed = isClosed(e);
    const d3 = is3d(e);
    const list: [string, string][] = d3
      ? [[closed ? 'O' : 'C', closed ? '열기' : '닫기'], ['E', '정점 편집'], ['S', '스플라인 곡선'], ['D', '비곡선화'], ['R', '반전'], ['U', '명령 취소']]
      : [[closed ? 'O' : 'C', closed ? '열기' : '닫기'], ['J', '결합'], ['W', '폭'], ['E', '정점 편집'], ['F', '맞춤'], ['S', '스플라인'], ['D', '비곡선화'], ['L', '선종류생성'], ['R', '반전'], ['U', '명령 취소']];
    const r = await ctx.getPoint(`옵션 입력 [${textOf(list)}]:`, { keywords: kwsOf(list) });
    if (!('keyword' in r)) return;
    switch (r.keyword) {
      case 'C':
      case 'O':
        t.apply(e, setClosed(e, r.keyword === 'C', segs()));
        break;
      case 'J': {
        if (closed) {
          ctx.print('폴리선이 닫혀 있어 결합할 수 없습니다.', 'err');
          break;
        }
        const sel = unlockedOnly(app, await ctx.getSelection('객체 선택:', { noPickfirst: true })).filter((x) => x !== h);
        const r2 = joinOnto(app, fitKind(e) === 'none' ? e : decurve(e), sel);
        if (!r2) {
          ctx.print('결합할 수 있는 객체가 없습니다.');
          break;
        }
        t.commit([{ replace: [r2.out], remove: r2.used }], [h]);
        ctx.print(`세그먼트 ${r2.used.length}개가 폴리선에 추가되었습니다.`);
        break;
      }
      case 'W': {
        const w = await askNumber(ctx, '모든 세그먼트에 대한 새 폭 지정', null, { min: 0 });
        if (typeof w === 'number') t.apply(e, setWidth(e, w, segs()));
        break;
      }
      case 'E':
        await vertexEdit(app, ctx, t, h);
        break;
      case 'F':
        t.apply(e, fitPolyline(e));
        break;
      case 'S': {
        const type = hnum(doc, '$SPLINETYPE', 6) === 5 ? 5 : 6;
        t.apply(e, splinePolyline(e, type, segs()));
        break;
      }
      case 'D':
        t.apply(e, decurve(e));
        break;
      case 'L': {
        const on = e.type === 'LWPOLYLINE' ? e.plinegen : (e.flags & 128) !== 0;
        const k = await choose(ctx, `폴리선 선종류 생성 옵션 입력 [켜기(ON)/끄기(OFF)] <${on ? '켜기' : '끄기'}>:`, [{ key: 'ON', label: '켜기' }, { key: 'OFF', label: '끄기' }], on ? 'ON' : 'OFF');
        t.apply(e, setLinetypeGen(e, k === 'ON'));
        break;
      }
      case 'R':
        t.apply(e, reverseEntity(e).replace?.[0] ?? null);
        break;
      case 'U': {
        const back = t.undo();
        if (back?.[0]) h = back[0];
        break;
      }
    }
  }
}

/** 폴리선 끝에 닿는 선·호·폴리선을 차례로 이어 붙인다 */
function joinOnto(app: App, pl: PolyEntity, handles: string[]): { out: Entity; used: string[] } | null {
  const doc = app.active!.doc;
  const pool = handles
    .map((x) => doc.entityIndex.get(x))
    .filter((x): x is Entity => !!x && (x.type === 'LINE' || x.type === 'ARC' || (isPolyline(x) && !isClosed(x) && fitKind(x) === 'none')));
  let cur: Entity = pl;
  const used: string[] = [];
  const ends = (x: Entity): Vec2[] => {
    if (isPolyline(x)) return polyEnds(x) ?? [];
    const p = entityPath(x);
    return p ? [pathStart(p), pathEnd(p)] : [];
  };
  let progress = true;
  while (progress) {
    progress = false;
    const ce = ends(cur);
    const size = Math.max(1, ...ce.map((q) => Math.max(Math.abs(q.x), Math.abs(q.y))));
    const tol = size * 1e-9;
    for (const o of pool) {
      if (used.includes(o.handle)) continue;
      const oe = ends(o);
      const touch = ce.some((a) => oe.some((b) => Math.hypot(a.x - b.x, a.y - b.y) <= tol));
      if (!touch) continue;
      const r = joinEntities([cur, o]);
      const out = r.replace?.find((x) => x.handle === cur.handle);
      if (!out) continue;
      cur = out;
      used.push(o.handle);
      progress = true;
    }
  }
  return used.length ? { out: cur, used } : null;
}

async function vertexEdit(app: App, ctx: CommandContext, t: Tools, h: string): Promise<void> {
  let i = 0;
  const show = (e: PolyEntity) => {
    const vs = frameVerts(e);
    if (!vs.length) return;
    i = Math.max(0, Math.min(i, vs.length - 1));
    t.mark([{ p: vertexPoint(e, vs[i]!), text: `${i + 1}` }]);
  };
  const segs = Math.round(hnum(app.active!.doc, '$SPLINESEGS', 8)) || 8;
  // 기본값은 마지막으로 고른 다음(N)·이전(P) — AutoCAD와 같다
  let dflt: 'N' | 'P' = 'N';
  const step = (e: PolyEntity, k: 'N' | 'P', at: number) => {
    const n = frameVerts(e).length;
    if (isClosed(e)) return k === 'N' ? (at + 1) % n : (at - 1 + n) % n;
    return k === 'N' ? Math.min(n - 1, at + 1) : Math.max(0, at - 1);
  };
  /** 끊기(B)·직선화(S): 표시한 정점에서 두 번째 정점으로 옮긴 뒤 실행(G) */
  const twoMarks = async (e: PolyEntity, first: number): Promise<number | null> => {
    let j = first;
    let d2: 'N' | 'P' = 'N';
    for (;;) {
      const vs = frameVerts(e);
      t.mark([
        { p: vertexPoint(e, vs[first]!), text: `${first + 1}` },
        ...(j !== first ? [{ p: vertexPoint(e, vs[j]!), text: `${j + 1}` }] : []),
      ]);
      const r = await ctx.getPoint(`옵션 입력 [다음(N)/이전(P)/실행(G)/종료(X)] <${d2}>:`, {
        keywords: kwsOf([
          ['N', '다음'],
          ['P', '이전'],
          ['G', '실행'],
          ['X', '종료'],
        ]),
      });
      const k: string | null = 'keyword' in r ? r.keyword : 'enter' in r ? d2 : null;
      if (!k || k === 'X') return null;
      if (k === 'G') return j;
      if (k === 'N' || k === 'P') {
        d2 = k;
        j = step(e, k, j);
      }
    }
  };
  try {
    for (;;) {
      const e = t.get(h);
      if (!e || !isPolyline(e)) return;
      const vs = frameVerts(e);
      show(e);
      const r = await ctx.getPoint(`정점 편집 옵션 입력 [다음(N)/이전(P)/끊기(B)/삽입(I)/이동(M)/재생성(R)/직선화(S)/접선(T)/폭(W)/종료(X)] <${dflt}>:`, {
        keywords: kwsOf([
          ['N', '다음'],
          ['P', '이전'],
          ['B', '끊기'],
          ['I', '삽입'],
          ['M', '이동'],
          ['R', '재생성'],
          ['S', '직선화'],
          ['T', '접선'],
          ['W', '폭'],
          ['X', '종료'],
        ]),
      });
      const k: string | null = 'keyword' in r ? r.keyword : 'enter' in r ? dflt : null;
      if (!k || k === 'X') return;
      const cur = vertexPoint(e, vs[i]!);
      if (k === 'N' || k === 'P') {
        dflt = k;
        i = step(e, k, i);
      } else if (k === 'R') {
        // 재생성: 화면을 다시 그린다(이 앱은 늘 최신이라 표시만 맞춘다)
        app.view.requestRender();
      } else if (k === 'B') {
        const j = await twoMarks(e, i);
        if (j === null) continue;
        const res = breakAtVertices(e, i, j, segs);
        if (!res) {
          ctx.print(i === j ? '끝 정점에서는 끊을 수 없습니다.' : '폴리선을 끊을 수 없습니다.', 'err');
          continue;
        }
        const after = { ...res.first, handle: e.handle } as Entity;
        t.commit([{ replace: [after], ...(res.second ? { add: [res.second as Entity] } : {}) }], [h]);
        i = Math.min(i, j);
      } else if (k === 'S') {
        const j = await twoMarks(e, i);
        if (j === null) continue;
        if (t.apply(e, straightenBetween(e, i, j, segs), [h], '직선화할 세그먼트가 없습니다.')) i = Math.min(i, j);
      } else if (k === 'T') {
        if (is3d(e)) {
          ctx.print('3D 폴리선에는 접선을 붙일 수 없습니다.', 'err');
          continue;
        }
        const q = await ctx.getPoint('접선 방향 지정:', { base: cur, preferNumber: true });
        let a: number | null = null;
        if ('point' in q && Math.hypot(q.point.x - cur.x, q.point.y - cur.y) > 1e-12) a = Math.atan2(q.point.y - cur.y, q.point.x - cur.x);
        else if ('text' in q && Number.isFinite(parseFloat(q.text))) a = (parseFloat(q.text) * Math.PI) / 180;
        if (a !== null) t.apply(e, setVertexTangent(e, i, a, segs));
      } else if (k === 'I') {
        const q = await ctx.getPoint('새 정점 위치 지정:', { base: cur, ghost: (p) => previewOf(app, [insertVertex(e, i, toOcs(e, p), segs)]) });
        if ('point' in q && t.apply(e, insertVertex(e, i, toOcs(e, q.point), segs))) i++;
      } else if (k === 'M') {
        const q = await ctx.getPoint('표시된 정점의 새 위치 지정:', { base: cur, ghost: (p) => previewOf(app, [moveVertex(e, i, toOcs(e, p), segs)]) });
        if ('point' in q) t.apply(e, moveVertex(e, i, toOcs(e, q.point), segs));
      } else if (k === 'D') {
        t.apply(e, removeVertex(e, i, segs), [h], '정점이 두 개뿐이라 지울 수 없습니다.');
      } else if (k === 'W') {
        if (is3d(e)) {
          ctx.print('3D 폴리선에는 폭이 없습니다.', 'err');
          continue;
        }
        const v = vs[i]!;
        const cw = e.type === 'LWPOLYLINE' ? e.constantWidth : 0;
        const sw = await askNumber(ctx, '다음 세그먼트의 시작 폭 지정', v.sw || cw, { min: 0 });
        if (typeof sw !== 'number') continue;
        const ew = await askNumber(ctx, '다음 세그먼트의 끝 폭 지정', sw, { min: 0 });
        if (typeof ew !== 'number') continue;
        t.apply(e, setSegmentWidth(e, i, sw, ew, segs));
      }
    }
  } finally {
    t.mark([]);
  }
}

async function peditMulti(app: App, ctx: CommandContext, t: Tools, hs0: string[], accept: boolean): Promise<void> {
  const doc = app.active!.doc;
  let hs = hs0.filter((h) => {
    const e = doc.entityIndex.get(h);
    return !!e && (isPolyline(e) || convertible(e));
  });
  const conv = hs.filter((h) => convertible(doc.entityIndex.get(h)!));
  if (conv.length) {
    const yes = accept || (await askConvert(ctx, '선, 호 및 스플라인을 폴리선으로 변환하겠습니까? [예(Y)/아니오(N)]? <Y>'));
    if (yes) {
      let prec = 10;
      if (conv.some((h) => doc.entityIndex.get(h)!.type === 'SPLINE')) {
        const v = await askNumber(ctx, '정밀도 지정', 10, { int: true, min: 0, max: 99, distance: false });
        if (typeof v !== 'number') return;
        prec = v;
      }
      const res: EditResult[] = [];
      for (const h of conv) {
        const np = convertOne(doc.entityIndex.get(h)!, prec);
        if (np) res.push({ remove: [h], add: [np] });
      }
      const a = t.commit(res, [...hs]);
      hs = [...hs.filter((h) => !conv.includes(h)), ...a.added];
    } else hs = hs.filter((h) => !conv.includes(h));
  }
  hs = hs.filter((h) => {
    const e = doc.entityIndex.get(h);
    return !!e && isPolyline(e);
  });
  if (!hs.length) {
    ctx.print('편집할 폴리선이 없습니다.');
    return;
  }
  const segs = Math.round(hnum(doc, '$SPLINESEGS', 8)) || 8;
  for (;;) {
    app.setSelection(hs);
    const list: [string, string][] = [
      ['C', '닫기'],
      ['O', '열기'],
      ['J', '결합'],
      ['W', '폭'],
      ['F', '맞춤'],
      ['S', '스플라인'],
      ['D', '비곡선화'],
      ['L', '선종류생성'],
      ['R', '반전'],
      ['U', '명령 취소'],
    ];
    const r = await ctx.getPoint(`옵션 입력 [${textOf(list)}]:`, { keywords: kwsOf(list) });
    if (!('keyword' in r)) return;
    const k = r.keyword;
    if (k === 'U') {
      const back = t.undo();
      if (back) hs = back.filter((h) => doc.entityIndex.has(h));
      continue;
    }
    const ents = hs.map((h) => doc.entityIndex.get(h)).filter((e): e is PolyEntity => !!e && isPolyline(e));
    if (k === 'J') {
      const list2 = ents.map((e) => (fitKind(e) === 'none' ? e : decurve(e)));
      const res = joinEntities(list2);
      if (!res.replace?.length && !res.add?.length) {
        ctx.print(res.message ?? '결합할 수 있는 객체가 없습니다.');
        continue;
      }
      const a = t.commit([res], [...hs]);
      if (res.message) ctx.print(res.message);
      const gone = new Set(res.remove ?? []);
      hs = [...hs.filter((h) => !gone.has(h)), ...a.added];
      continue;
    }
    let width = 0;
    let ltOn = false;
    if (k === 'W') {
      const w = await askNumber(ctx, '모든 세그먼트에 대한 새 폭 지정', null, { min: 0 });
      if (typeof w !== 'number') continue;
      width = w;
    }
    if (k === 'L') ltOn = (await choose(ctx, '폴리선 선종류 생성 옵션 입력 [켜기(ON)/끄기(OFF)] <끄기>:', [{ key: 'ON', label: '켜기' }, { key: 'OFF', label: '끄기' }], 'OFF')) === 'ON';
    const type = hnum(doc, '$SPLINETYPE', 6) === 5 ? 5 : 6;
    const res: EditResult[] = [];
    for (const e of ents) {
      let out: Entity | null = null;
      if (k === 'C') out = isClosed(e) ? null : setClosed(e, true, segs);
      else if (k === 'O') out = isClosed(e) ? setClosed(e, false, segs) : null;
      else if (k === 'W') out = is3d(e) ? null : setWidth(e, width, segs);
      else if (k === 'F') out = is3d(e) ? null : fitPolyline(e);
      else if (k === 'S') out = splinePolyline(e, type, segs);
      else if (k === 'D') out = decurve(e);
      else if (k === 'L') out = is3d(e) ? null : setLinetypeGen(e, ltOn);
      else if (k === 'R') out = reverseEntity(e).replace?.[0] ?? null;
      if (out) res.push({ replace: [{ ...out, handle: e.handle } as Entity] });
    }
    if (res.length) t.commit(res, [...hs]);
  }
}

// ---------------------------------------------------------------------------
// SPLINEDIT
// ---------------------------------------------------------------------------

async function splinedit(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const t = makeTools(app, ctx, 'SPLINEDIT');
  let h: string | null = st.selection.size === 1 ? [...st.selection][0]! : null;
  try {
    for (;;) {
      if (!h) {
        const r = await ctx.getEntity('스플라인 선택:');
        if (!('handle' in r)) return;
        h = r.handle;
      }
      const e = t.get(h);
      if (e?.type === 'SPLINE' && e.helix) ctx.print('나선은 스플라인 편집으로 고칠 수 없습니다.', 'err');
      else if (e?.type === 'SPLINE' && unlockedOnly(app, [h]).length) break;
      else ctx.print('스플라인이 아닙니다.', 'err');
      h = null;
    }
    for (;;) {
      const e = t.get(h) as SplineEntity | undefined;
      if (!e || e.type !== 'SPLINE') return;
      app.setSelection([h]);
      const fit = isFitSpline(e);
      const closed = isSplineClosed(e);
      const list: [string, string][] = [[closed ? 'O' : 'C', closed ? '열기' : '닫기'], ['J', '결합'], ...(fit ? ([['F', '맞춤 데이터']] as [string, string][]) : []), ['E', '정점 편집'], ['P', '폴리선으로 변환'], ['R', '반전'], ['U', '명령 취소'], ['X', '종료']];
      const r = await ctx.getPoint(`옵션 입력 [${textOf(list)}] <종료>:`, { keywords: kwsOf(list) });
      if (!('keyword' in r) || r.keyword === 'X') return;
      switch (r.keyword) {
        case 'C':
          t.apply(e, closeSpline(e), [h], '닫을 수 없는 스플라인입니다.');
          break;
        case 'O':
          t.apply(e, openSpline(e));
          break;
        case 'J': {
          const sel = unlockedOnly(app, await ctx.getSelection('결합할 객체 선택:', { noPickfirst: true })).filter((x) => x !== h);
          const others = sel.map((x) => st.doc.entityIndex.get(x)).filter((x): x is Entity => !!x);
          const res = joinEntities([e, ...others]);
          const out = res.replace?.find((x) => x.handle === e.handle);
          if (!out) {
            ctx.print('결합할 수 있는 객체가 없습니다.');
            break;
          }
          t.commit([res], [h]);
          if (res.message) ctx.print(res.message);
          break;
        }
        case 'F':
          await fitData(app, ctx, t, h);
          break;
        case 'E':
          await cvEdit(app, ctx, t, h);
          break;
        case 'P': {
          const v = await askNumber(ctx, '정밀도 지정', 10, { int: true, min: 0, max: 99, distance: false });
          if (typeof v !== 'number') break;
          const pl = splineToPolyline(e, v);
          if (!pl) break;
          t.commit([{ remove: [e.handle], add: [pl] }], [h]);
          return;
        }
        case 'R':
          t.apply(e, reverseSplineEntity(e));
          break;
        case 'U': {
          const back = t.undo();
          if (back?.[0]) h = back[0];
          break;
        }
      }
    }
  } finally {
    app.view.overlay.marks = [];
    st.selection.clear();
    app.refreshSelectionOverlay();
  }
}

const fitPts = (e: SplineEntity): Vec2[] => e.fitPoints.map((q) => ({ x: q.x, y: q.y }));
const cvPts = (e: SplineEntity): Vec2[] => {
  const n = cvCount(e);
  return e.controlPoints.slice(0, n).map((q) => ({ x: q.x, y: q.y }));
};

/** 다음·이전·점 선택으로 점을 고르며 편집하는 반복(이동·가중치) */
async function walkPoints(
  ctx: CommandContext,
  t: Tools,
  h: string,
  pts: (e: SplineEntity) => Vec2[],
  prompt: (e: SplineEntity, i: number) => string,
  act: (e: SplineEntity, i: number, r: { point: Pt } | { text: string }) => SplineEntity | null,
  opt: { number?: boolean; ghost?: (e: SplineEntity, i: number, p: Pt) => ReturnType<typeof previewOf> } = {},
): Promise<void> {
  let i = 0;
  for (;;) {
    const e = t.get(h) as SplineEntity | undefined;
    if (!e || e.type !== 'SPLINE') return;
    const list = pts(e);
    if (!list.length) return;
    i = Math.max(0, Math.min(i, list.length - 1));
    t.mark(list.map((p, k) => ({ p, text: k === i ? `${k + 1}` : undefined })));
    const r = await ctx.getPoint(`${prompt(e, i)} 또는 [다음(N)/이전(P)/점 선택(S)/종료(X)] <다음>:`, {
      base: list[i]!,
      preferNumber: opt.number,
      keywords: kwsOf([
        ['N', '다음'],
        ['P', '이전'],
        ['S', '점 선택'],
        ['X', '종료'],
      ]),
      ghost: opt.ghost ? (p) => opt.ghost!(e, i, p) : undefined,
    });
    if ('enter' in r) {
      i = (i + 1) % list.length;
      continue;
    }
    if ('keyword' in r) {
      if (r.keyword === 'X') return;
      if (r.keyword === 'N') i = (i + 1) % list.length;
      else if (r.keyword === 'P') i = (i - 1 + list.length) % list.length;
      else {
        const q = await ctx.getPoint('점 선택:');
        if ('point' in q) i = nearestIndex(list, q.point);
      }
      continue;
    }
    if ('point' in r || 'text' in r) t.apply(e, act(e, i, r));
  }
}

async function fitData(app: App, ctx: CommandContext, t: Tools, h: string): Promise<void> {
  try {
    for (;;) {
      const e = t.get(h) as SplineEntity | undefined;
      if (!e || e.type !== 'SPLINE' || !isFitSpline(e)) return;
      t.mark(fitPts(e).map((p) => ({ p })));
      const closed = isSplineClosed(e);
      const list: [string, string][] = [['A', '추가'], [closed ? 'O' : 'C', closed ? '열기' : '닫기'], ['D', '삭제'], ['K', '꼬임'], ['M', '이동'], ['P', '소거'], ['T', '접선'], ['L', '공차'], ['X', '종료']];
      const r = await ctx.getPoint(`맞춤 데이터 옵션 입력 [${textOf(list)}] <종료>:`, { keywords: kwsOf(list) });
      if (!('keyword' in r) || r.keyword === 'X') return;
      switch (r.keyword) {
        case 'A': {
          const q = await ctx.getPoint('스플라인에서 기존 맞춤점 지정 <종료>:');
          if (!('point' in q)) break;
          let i = nearestIndex(fitPts(e), q.point);
          let before = false;
          for (;;) {
            const cur = t.get(h) as SplineEntity;
            const fp = fitPts(cur);
            t.mark(fp.map((p, k) => ({ p, text: k === i ? `${k + 1}` : undefined })));
            const first = i === 0 && !closed;
            const n = await ctx.getPoint(first ? '새 맞춤점 지정 또는 [이후(A)/이전(B)] <종료>:' : '새 맞춤점 지정 <종료>:', {
              base: fp[i]!,
              keywords: first ? [{ key: 'A', label: '이후' }, { key: 'B', label: '이전' }] : [],
              ghost: (p) => previewOf(app, [fitAdd(cur, i, p, before)]),
            });
            if ('keyword' in n) {
              before = n.keyword === 'B';
              continue;
            }
            if (!('point' in n)) break;
            if (t.apply(cur, fitAdd(cur, i, n.point, before)) && !before) i++;
          }
          break;
        }
        case 'C':
          t.apply(e, closeSpline(e), [h], '맞춤점이 세 개 이상이어야 닫을 수 있습니다.');
          break;
        case 'O':
          t.apply(e, openSpline(e));
          break;
        case 'D':
          for (;;) {
            const cur = t.get(h) as SplineEntity;
            t.mark(fitPts(cur).map((p) => ({ p })));
            const q = await ctx.getPoint('맞춤점 지정 <종료>:');
            if (!('point' in q)) break;
            t.apply(cur, fitDelete(cur, nearestIndex(fitPts(cur), q.point)), [h], `맞춤점이 ${isSplineClosed(cur) ? 3 : 2}개보다 적어질 수 없습니다.`);
          }
          break;
        case 'K': {
          // 꼬임: 그 점에 맞춤점을 넣고 접선을 끊는다(맞춤 데이터는 꼬임을 담지 못해 조정점 정의가 된다)
          if (closed) {
            ctx.print('닫힌 스플라인에는 꼬임을 넣을 수 없습니다.', 'err');
            break;
          }
          const q = await ctx.getPoint('스플라인에 점 지정 <종료>:', { ghost: (p) => previewOf(app, [fitKink(e, p)]) });
          if (!('point' in q)) break;
          if (t.apply(e, fitKink(e, q.point), [h], '그 점에는 꼬임을 넣을 수 없습니다.')) ctx.print('꼬임을 넣었습니다. 맞춤 데이터는 조정점 정의로 바뀌었습니다.');
          break;
        }
        case 'M':
          await walkPoints(ctx, t, h, fitPts, () => '새 위치 지정', (x, i, rr) => ('point' in rr ? fitMove(x, i, rr.point) : null), { ghost: (x, i, p) => previewOf(app, [fitMove(x, i, p)]) });
          break;
        case 'P':
          t.apply(e, purgeFit(e));
          return;
        case 'T': {
          if (closed) {
            ctx.print('닫힌 스플라인에는 끝 접선이 없습니다.', 'err');
            break;
          }
          const fp = fitPts(e);
          const ask = async (prompt: string, base: Vec2): Promise<Vec2 | null | undefined> => {
            const q = await ctx.getPoint(prompt, { base, keywords: [{ key: 'S', label: '시스템 기본값' }] });
            if ('keyword' in q) return null;
            if ('point' in q) return { x: q.point.x - base.x, y: q.point.y - base.y };
            return undefined;
          };
          const s = await ask('시작 접선 지정 또는 [시스템 기본값(S)]:', fp[0]!);
          const en = await ask('끝 접선 지정 또는 [시스템 기본값(S)]:', fp[fp.length - 1]!);
          if (s === undefined && en === undefined) break;
          t.apply(e, fitTangents(e, s, en));
          break;
        }
        case 'L': {
          const v = await askNumber(ctx, '맞춤 공차 입력', e.fitTolerance || 1e-10, { min: 0, distance: false, text: (x) => x.toExponential(4).toUpperCase() });
          if (typeof v === 'number') {
            t.apply(e, fitTolerance(e, v));
            if (v > 1e-9) ctx.print('공차 값을 저장했습니다. 이 프로그램은 곡선을 맞춤점을 지나게 그립니다.');
          }
          break;
        }
      }
    }
  } finally {
    t.mark([]);
  }
}

async function cvEdit(app: App, ctx: CommandContext, t: Tools, h: string): Promise<void> {
  try {
    for (;;) {
      const e = t.get(h) as SplineEntity | undefined;
      if (!e || e.type !== 'SPLINE') return;
      t.mark(cvPts(e).map((p) => ({ p })));
      const list: [string, string][] = [['A', '추가'], ['D', '삭제'], ['E', '순서 올리기'], ['M', '이동'], ['W', '가중치'], ['X', '종료']];
      const r = await ctx.getPoint(`정점 편집 옵션 입력 [${textOf(list)}] <종료>:`, { keywords: kwsOf(list) });
      if (!('keyword' in r) || r.keyword === 'X') return;
      if (r.keyword === 'D') {
        for (;;) {
          const cur = t.get(h) as SplineEntity;
          t.mark(cvPts(cur).map((p) => ({ p })));
          const q = await ctx.getPoint('스플라인에서 점 지정 <종료>:');
          if (!('point' in q)) break;
          t.apply(cur, cvDelete(cur, nearestIndex(cvPts(cur), q.point)), [h], '정점이 너무 적어 더 지울 수 없습니다.');
        }
      } else if (r.keyword === 'E') {
        const order = e.degree + 1;
        const v = await askNumber(ctx, '새 순서 입력', Math.min(26, order + 1), { int: true, min: order, max: 26, distance: false });
        if (typeof v === 'number' && v > order) t.apply(e, elevateOrder(e, v), [h], '순서를 올릴 수 없습니다.');
      } else if (r.keyword === 'A') {
        if (isPeriodicForm(e)) {
          ctx.print('닫힌(주기) 스플라인에는 정점을 추가할 수 없습니다.', 'err');
          continue;
        }
        for (;;) {
          const cur = t.get(h) as SplineEntity;
          t.mark(cvPts(cur).map((p) => ({ p })));
          const q = await ctx.getPoint('스플라인에서 점 지정 <종료>:');
          if (!('point' in q)) break;
          t.apply(cur, cvAdd(cur, q.point));
        }
      } else if (r.keyword === 'M') {
        await walkPoints(ctx, t, h, cvPts, () => '새 위치 지정', (x, i, rr) => ('point' in rr ? cvMove(x, i, rr.point) : null), { ghost: (x, i, p) => previewOf(app, [cvMove(x, i, p)]) });
      } else if (r.keyword === 'W') {
        await walkPoints(
          ctx,
          t,
          h,
          cvPts,
          (x, i) => `새 가중치 입력(현재 = ${(x.weights?.[i] ?? 1).toFixed(4)})`,
          (x, i, rr) => {
            if (!('text' in rr)) return null;
            const w = parseFloat(rr.text);
            return w > 0 ? cvWeight(x, i, w) : null;
          },
          { number: true },
        );
      }
    }
  } finally {
    t.mark([]);
  }
}

/** MPEDIT(Express Tools): 고른 객체를 PEDIT 다중(M) 흐름으로 바로 편집한다(한 객체여도 다중 옵션) */
export async function peditMultiple(app: App, ctx: CommandContext, hs: string[], label = 'MPEDIT'): Promise<void> {
  const st = app.active!;
  const t = makeTools(app, ctx, label);
  try {
    await peditMulti(app, ctx, t, unlockedOnly(app, hs), hnum(st.doc, '$PEDITACCEPT', 0) === 1);
  } finally {
    app.view.overlay.marks = [];
    st.selection.clear();
    app.refreshSelectionOverlay();
  }
}
