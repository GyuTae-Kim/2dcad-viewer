/**
 * 그리기 명령: LINE, PLINE, CIRCLE, ARC, RECTANG, POLYGON, ELLIPSE, SPLINE, POINT, XLINE, RAY, DONUT, TEXT, MTEXT
 * 프롬프트와 옵션은 AutoCAD 2026 한국어판을 따른다.
 */
import type { CadColor, Entity, EntityBase, LwVertex, Vec2, Vec3 } from '../core/model';
import { tableKey } from '../core/model';
import { formatLength } from '../core/units';
import { arcPoints, bulgeArc, ccwSweep, clampedKnots, ellipsePoints, nurbsPoints, TAU } from '../geom/curves';
import type { EditOp } from '../edit/session';
import { registerUndoCommand } from './undocmd';
import { registerDraw3dCommands } from './draw3d';
import type { App, CommandContext, PointResult } from './app';
import { CancelError } from './app';
import type { Pt } from './view';
import { registerTextCommands } from './textedit/commands';
import { type EditorResult, type TextDialogOptions, richTextDialog } from './textedit';
import { unlockedOnly } from './layers';
import { followOps } from './dimassoc';
import { afterEditSolve } from './constraints-hook';
import { isoCircleEllipse, isoEllipseKeyword } from './viewtools-iso';
import { packLw, packLwPoints } from '../core/lwpoly';
import type { DocState } from './docstate';
import { type KnotParam, fitSplineNurbs, makeCvSpline, makeFitSpline, splineFromFitPolyline } from '../edit/geom/drawgeom';
import { type RectOptions, arcByCenter,arcByCenterAngle, arcByCenterChord, arcByDirection, arcByRadiusAngle, arcByRadiusEnd, bisectAngle, circleTTR, ellipseAngleToParam, ellipseParamToAngle, offsetLine, rectCorners, rectCornersFit, rectOtherCorner, rectOtherSide, rectVertices } from '../edit/geom/drawgeom';
import { entityPath } from '../edit/geom/path';
import { pathNearest } from '../edit/geom/curve';

// ---------------------------------------------------------------------------
// 공통
// ---------------------------------------------------------------------------

/** 새 객체의 공통 특성(현재 도면층·색·선종류·선가중치) */
export function currentProps(app: App): Omit<EntityBase, 'type' | 'handle'> {
  const d = app.active!.doc;
  const hv = (k: string) => d.header.get(k);
  const layer = typeof hv('$CLAYER') === 'string' && d.layers.has(tableKey(hv('$CLAYER') as string)) ? (hv('$CLAYER') as string) : '0';
  const cecolor = hv('$CECOLOR');
  const color: CadColor = { aci: typeof cecolor === 'number' ? cecolor : 256 };
  const lt = hv('$CELTYPE');
  const lw = hv('$CELWEIGHT');
  const lts = hv('$CELTSCALE');
  const th = hv('$THICKNESS');
  return {
    layer: d.layers.get(tableKey(layer))?.name ?? layer,
    color,
    linetype: typeof lt === 'string' && lt ? lt : 'ByLayer',
    lineweight: typeof lw === 'number' ? lw : -1,
    ltscale: typeof lts === 'number' && lts > 0 ? lts : 1,
    transparency: -1,
    // 두께(THICKNESS): 0이 아닐 때만 — 두께가 없는 객체 종류는 쓰기에서 버린다
    ...(typeof th === 'number' && th !== 0 && Number.isFinite(th) ? { thickness: th } : {}),
  };
}

/** 새 객체의 고도(ELEVATION, 배치에서는 PELEVATION — 좌표의 Z를 따로 주지 않은 점) */
export function currentElevation(app: App): number {
  const st = app.active;
  const v = st?.doc.header.get(st.isModel === false ? '$PELEVATION' : '$ELEVATION');
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 객체를 지금 공간에 넣는다(명령 묶음 안에서) */
export function addEntities(app: App, ctx: CommandContext, list: Entity[], label: string): string[] {
  const st = app.active!;
  const block = st.doc.blocks.get(st.space);
  const out: string[] = [];
  const ops = list.map((e) => {
    if (!e.handle) e.handle = st.session.newHandle();
    if (block?.recordHandle) e.owner = block.recordHandle;
    out.push(e.handle);
    return { kind: 'add' as const, block: st.space, entity: e };
  });
  st.session.commit({ label, ops, group: ctx.group });
  return out;
}

function pt(r: PointResult): Pt | null {
  return 'point' in r ? r.point : null;
}

const v3 = (p: Pt, z = 0): Vec3 => ({ x: p.x, y: p.y, z });
const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);
const ang = (a: Pt, b: Pt) => Math.atan2(b.y - a.y, b.x - a.x);

/** 숫자 입력(거리·반지름 등). 점을 찍으면 base에서 그 점까지 거리 */
async function getDistance(ctx: CommandContext, prompt: string, base: Pt | null, def?: number): Promise<number> {
  for (;;) {
    const r = await ctx.getPoint(def !== undefined ? `${prompt} <${fmt(ctx, def)}>:` : `${prompt}:`, { base, allowText: true });
    if ('enter' in r && def !== undefined) return def;
    if ('point' in r && base) return dist(base, r.point);
    if ('text' in r) {
      const v = parseFloat(r.text);
      if (Number.isFinite(v)) return v;
    }
    ctx.print('숫자를 입력하거나 점을 지정하십시오.', 'err');
  }
}

async function getAngle(ctx: CommandContext, prompt: string, base: Pt | null, def = 0): Promise<number> {
  for (;;) {
    const r = await ctx.getPoint(`${prompt} <${((def * 180) / Math.PI).toFixed(0)}>:`, { base, preferNumber: true });
    if ('enter' in r) return def;
    if ('point' in r && base) return ang(base, r.point);
    if ('text' in r) {
      const v = parseFloat(r.text);
      if (Number.isFinite(v)) return (v * Math.PI) / 180;
    }
    ctx.print('각도(도)를 입력하거나 점을 지정하십시오.', 'err');
  }
}

async function getInt(ctx: CommandContext, prompt: string, def: number, min: number, max: number): Promise<number> {
  for (;;) {
    const r = await ctx.getPoint(`${prompt} <${def}>:`, { allowText: true });
    if ('enter' in r) return def;
    if ('text' in r) {
      const v = parseInt(r.text, 10);
      if (Number.isFinite(v) && v >= min && v <= max) return v;
    }
    ctx.print(`${min}에서 ${max} 사이의 정수를 입력하십시오.`, 'err');
  }
}

function fmt(ctx: CommandContext, v: number): string {
  return formatLength(v, ctx.app.active!.units);
}

/** 그리기 명령의 기본값(도면마다, 여는 동안) */
const drawMemo = new WeakMap<DocState, Record<string, number | string | boolean>>();
function memOf(st: DocState): Record<string, number | string | boolean> {
  let m = drawMemo.get(st);
  if (!m) {
    m = {};
    drawMemo.set(st, m);
  }
  return m;
}

/** RECTANG 모드(AutoCAD처럼 도면을 여는 동안 기억한다) */
interface RectMode {
  chamfer: [number, number];
  fillet: number;
  elevation: number;
  thickness: number;
  width: number;
  rotation: number;
  length: number;
  breadth: number;
  area: number;
  areaBy: 'L' | 'W';
}
const rectModes = new WeakMap<DocState, RectMode>();
function rectModeOf(st: DocState): RectMode {
  let m = rectModes.get(st);
  if (!m) {
    m = { chamfer: [0, 0], fillet: 0, elevation: 0, thickness: 0, width: 0, rotation: 0, length: 10, breadth: 10, area: 100, areaBy: 'L' };
    rectModes.set(st, m);
  }
  return m;
}

/** `회전 각도 지정 또는 [점 선택(P)] <기본>:` — 숫자는 도, 점은 base에서의 방향, P는 두 점 */
async function rotationAngle(ctx: CommandContext, base: Pt, def: number): Promise<number> {
  for (;;) {
    const r = await ctx.getPoint(`회전 각도 지정 또는 [점 선택(P)] <${((def * 180) / Math.PI).toFixed(0)}>:`, { base, preferNumber: true, keywords: [{ key: 'P', label: '점 선택' }] });
    if ('enter' in r) return def;
    if ('point' in r) return ang(base, r.point);
    if ('keyword' in r) {
      const p1 = pt(await ctx.getPoint('첫 번째 점 지정:'));
      if (!p1) return def;
      const p2 = pt(await ctx.getPoint('두 번째 점 지정:', { base: p1 }));
      if (!p2) return def;
      return ang(p1, p2);
    }
    if ('text' in r) {
      const v = parseFloat(r.text);
      if (Number.isFinite(v)) return (v * Math.PI) / 180;
    }
    ctx.print('각도(도)를 입력하거나 점을 지정하십시오.', 'err');
  }
}

function circlePts(c: Pt, r: number): number[] {
  const p = arcPoints(c.x, c.y, Math.abs(r), 0, TAU, Math.abs(r) * 0.002 + 1e-9);
  return p;
}

/** 세 점을 지나는 원 */
export function circle3p(a: Pt, b: Pt, c: Pt): { c: Pt; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { c: { x: ux, y: uy }, r: Math.hypot(a.x - ux, a.y - uy) };
}

/** 세 점(시작·중간·끝)으로 호: 반시계 시작각·끝각 */
function arc3p(a: Pt, m: Pt, b: Pt): { c: Pt; r: number; a0: number; a1: number } | null {
  const k = circle3p(a, m, b);
  if (!k) return null;
  let a0 = ang(k.c, a);
  let a1 = ang(k.c, b);
  const am = ang(k.c, m);
  // m이 a0 → a1 반시계 구간에 있지 않으면 방향을 뒤집는다
  if (ccwSweep(a0, am) > ccwSweep(a0, a1)) [a0, a1] = [a1, a0];
  return { c: k.c, r: k.r, a0, a1 };
}

// ---------------------------------------------------------------------------

export function registerDrawCommands(app: App): void {
  const base = () => currentProps(app);

  // ------------------------------------------------------------- LINE
  app.register({
    name: 'LINE',
    aliases: ['L'],
    title: '선',
    async run(ctx) {
      const st = app.active!;
      const elev = currentElevation(app);
      let first: Pt | null = null;
      for (;;) {
        const r = await ctx.getPoint('첫 번째 점 지정:');
        if ('enter' in r) {
          // Enter = 직전 선의 끝점에서 이어 그리기
          if (app.lastPoint) first = app.lastPoint;
          else continue;
        } else first = pt(r);
        if (first) break;
      }
      const start = first;
      let prev = first;
      let count = 0;
      for (;;) {
        const kws = count >= 2 ? [{ key: 'C', label: '닫기' }, { key: 'U', label: '명령 취소' }] : [{ key: 'U', label: '명령 취소' }];
        const r = await ctx.getPoint(count >= 2 ? '다음 점 지정 또는 [닫기(C)/명령 취소(U)]:' : '다음 점 지정 또는 [명령 취소(U)]:', { base: prev, keywords: kws });
        if ('enter' in r) return;
        if ('keyword' in r) {
          if (r.keyword === 'U') {
            if (count > 0 && st.session.undoLastStep(ctx.group, 1)) {
              const last = st.doc.entityIndex.get(app.lastCreated[app.lastCreated.length - 1] ?? '');
              count--;
              prev = last && last.type === 'LINE' && count > 0 ? { x: last.end.x, y: last.end.y } : start;
              if (count === 0) prev = start;
            }
            continue;
          }
          if (r.keyword === 'C') {
            addEntities(app, ctx, [{ ...base(), type: 'LINE', handle: '', start: v3(prev, elev), end: v3(start, elev) } as Entity], 'LINE');
            app.lastPoint = start;
            return;
          }
          continue;
        }
        const p = pt(r)!;
        if (dist(prev, p) < 1e-12) continue;
        addEntities(app, ctx, [{ ...base(), type: 'LINE', handle: '', start: v3(prev, elev), end: v3(p, elev) } as Entity], 'LINE');
        prev = p;
        app.lastPoint = p;
        count++;
      }
    },
  });

  // ------------------------------------------------------------- PLINE
  app.register({
    name: 'PLINE',
    aliases: ['PL'],
    title: '폴리선',
    async run(ctx) {
      const st = app.active!;
      const startR = await ctx.getPoint('시작점 지정:');
      const s0 = pt(startR);
      if (!s0) return;
      let width0 = Number(st.doc.header.get('$PLINEWID') ?? 0) || 0;
      let width1 = width0;
      ctx.print(`현재의 선 폭은 ${fmt(ctx, width0)}입니다`);
      const verts: LwVertex[] = [{ x: s0.x, y: s0.y, bulge: 0, startWidth: width0, endWidth: width1 }];
      let arcMode = false;
      let handle: string | null = null;
      let closed = false;
      const elev = currentElevation(app);
      const entity = (): Entity =>
        ({
          ...base(),
          type: 'LWPOLYLINE',
          handle: handle ?? '',
          ...packLw(verts),
          closed,
          plinegen: false,
          constantWidth: 0,
          elevation: elev,
        }) as Entity;
      /** 접선 방향(마지막 선분 끝의 진행 방향) */
      const tangentAt = (): number | null => {
        if (verts.length < 2) return null;
        const a = verts[verts.length - 2]!;
        const b = verts[verts.length - 1]!;
        const arc = bulgeArc(a.x, a.y, b.x, b.y, a.bulge);
        if (!arc) return Math.atan2(b.y - a.y, b.x - a.x);
        const endAng = arc.a0 + arc.sweep;
        return endAng + (arc.sweep > 0 ? Math.PI / 2 : -Math.PI / 2);
      };
      const commit = () => {
        const st2 = app.active!;
        const e = entity();
        if (!handle) {
          if (verts.length < 2) return;
          handle = addEntities(app, ctx, [e], 'PLINE')[0]!;
        } else {
          const before = st2.doc.entityIndex.get(handle);
          if (before) st2.session.commit({ label: 'PLINE', ops: [{ kind: 'modify', block: st2.space, before, after: { ...e, owner: before.owner } as Entity }], group: ctx.group });
        }
      };
      const bulgeFor = (from: LwVertex, to: Pt): number => {
        const t = tangentAt();
        const chord = Math.atan2(to.y - from.y, to.x - from.x);
        const d = t === null ? 0 : chord - t;
        // 접선과 현 사이 각 = 중심각/2 → bulge = tan(중심각/4)
        const half = Math.atan2(Math.sin(d), Math.cos(d));
        return Math.tan(half / 2);
      };
      /** 호 구간 하나를 더한다(지금 정점의 볼록·폭, 끝점) */
      const pushArc = (last: LwVertex, bulge: number, ep: Pt) => {
        last.bulge = bulge;
        last.startWidth = width0;
        last.endWidth = width1;
        verts.push({ x: ep.x, y: ep.y, bulge: 0, startWidth: width1, endWidth: width1 });
        width0 = width1;
        commit();
        app.lastPoint = ep;
      };
      /** 호의 미리보기(볼록과 끝점) */
      const arcRubber = (bulge: number | null, ep: Pt | null) => {
        if (bulge === null || !ep) return [];
        const tmp = verts.map((v) => ({ ...v }));
        tmp[tmp.length - 1]!.bulge = bulge;
        return [{ pts: polyPreview([...tmp, { x: ep.x, y: ep.y, bulge: 0, startWidth: 0, endWidth: 0 }], false) }];
      };
      /** 호 모드의 각도(A)·중심(CE)·방향(D)·반지름(R)·두 번째 점(S). 처리했으면 true */
      const arcOption = async (k: string, last: LwVertex, lp: Pt): Promise<boolean> => {
        const tan = tangentAt();
        if (k === 'A') {
          const sw = await getAngle(ctx, '사이각 지정', null, Math.PI / 2);
          if (Math.abs(sw) < 1e-12) return true;
          const r = await ctx.getPoint('호의 끝점 지정(방향 전환은 Ctrl 키) 또는 [중심(CE)/반지름(R)]:', {
            base: lp,
            keywords: [
              { key: 'CE', label: '중심' },
              { key: 'R', label: '반지름' },
            ],
            rubber: (q) => arcRubber(Math.tan(sw / 4), q),
          });
          if ('point' in r) pushArc(last, Math.tan(sw / 4), r.point);
          else if ('keyword' in r && r.keyword === 'CE') {
            const c = pt(await ctx.getPoint('호의 중심점 지정:', { base: lp, rubber: (q) => { const a = arcByCenterAngle(lp, q, sw); return a ? arcRubber(a.bulge, a.end) : []; } }));
            const a = c ? arcByCenterAngle(lp, c, sw) : null;
            if (a) pushArc(last, a.bulge, a.end);
          } else if ('keyword' in r && r.keyword === 'R') {
            const R = await getDistance(ctx, '호의 반지름 지정', lp);
            const def = (tan ?? 0) + sw / 2;
            const dir = await getAngle(ctx, '호의 현 방향 지정', lp, def);
            const a = arcByRadiusAngle(lp, R, sw, dir);
            if (a) pushArc(last, a.bulge, a.end);
          }
          return true;
        }
        if (k === 'CE') {
          const c = pt(await ctx.getPoint('호의 중심점 지정:', { base: lp }));
          if (!c) return true;
          const r = await ctx.getPoint('호의 끝점 지정(방향 전환은 Ctrl 키) 또는 [각도(A)/길이(L)]:', {
            base: c,
            keywords: [
              { key: 'A', label: '각도' },
              { key: 'L', label: '길이' },
            ],
            rubber: (q) => {
              const a = arcByCenter(lp, c, q);
              return a ? arcRubber(a.bulge, a.end) : [];
            },
          });
          let a: { end: Pt; bulge: number } | null = null;
          if ('point' in r) a = arcByCenter(lp, c, r.point);
          else if ('keyword' in r && r.keyword === 'A') a = arcByCenterAngle(lp, c, await getAngle(ctx, '사이각 지정', null, Math.PI / 2));
          else if ('keyword' in r && r.keyword === 'L') a = arcByCenterChord(lp, c, await getDistance(ctx, '현의 길이 지정', lp));
          if (a) pushArc(last, a.bulge, a.end);
          else if (!('enter' in r)) ctx.print('호를 만들 수 없습니다.', 'err');
          return true;
        }
        if (k === 'D') {
          const dir = await getAngle(ctx, '호의 시작 방향 지정', lp, tan ?? 0);
          const ep = pt(await ctx.getPoint('호의 끝점 지정(방향 전환은 Ctrl 키):', { base: lp, rubber: (q) => arcRubber(arcByDirection(lp, dir, q), q) }));
          const b = ep ? arcByDirection(lp, dir, ep) : null;
          if (ep && b !== null) pushArc(last, b, ep);
          return true;
        }
        if (k === 'R') {
          const R = await getDistance(ctx, '호의 반지름 지정', lp);
          if (!(R > 0)) return true;
          const r = await ctx.getPoint('호의 끝점 지정(방향 전환은 Ctrl 키) 또는 [각도(A)]:', {
            base: lp,
            keywords: [{ key: 'A', label: '각도' }],
            rubber: (q) => arcRubber(arcByRadiusEnd(lp, R, q), q),
          });
          if ('point' in r) {
            const b = arcByRadiusEnd(lp, R, r.point);
            if (b === null) ctx.print('호를 만들 수 없습니다. 반지름이 너무 작습니다.', 'err');
            else pushArc(last, b, r.point);
          } else if ('keyword' in r) {
            const sw = await getAngle(ctx, '사이각 지정', null, Math.PI / 2);
            const dir = await getAngle(ctx, '호의 현 방향 지정', lp, (tan ?? 0) + sw / 2);
            const a = arcByRadiusAngle(lp, R, sw, dir);
            if (a) pushArc(last, a.bulge, a.end);
          }
          return true;
        }
        if (k === 'S') {
          const mp = pt(await ctx.getPoint('호의 두 번째 점 지정:', { base: lp }));
          if (!mp) return true;
          const ep = pt(await ctx.getPoint('호의 끝점 지정:', { base: mp }));
          if (!ep) return true;
          const a3 = arc3p(lp, mp, ep);
          if (!a3) return true;
          const sweep = ccwSweep(ang(a3.c, lp), ang(a3.c, ep));
          const ccw = ccwSweep(ang(a3.c, lp), ang(a3.c, mp)) <= sweep;
          pushArc(last, Math.tan((ccw ? sweep : -(TAU - sweep)) / 4), ep);
          return true;
        }
        return false;
      };
      for (;;) {
        const last = verts[verts.length - 1]!;
        const lp = { x: last.x, y: last.y };
        let r: PointResult;
        if (!arcMode) {
          const kws = [
            { key: 'A', label: '호' },
            ...(verts.length > 2 ? [{ key: 'C', label: '닫기' }] : []),
            { key: 'H', label: '반폭' },
            { key: 'L', label: '길이' },
            { key: 'U', label: '명령 취소' },
            { key: 'W', label: '폭' },
          ];
          r = await ctx.getPoint(verts.length > 2 ? '다음 점 지정 또는 [호(A)/닫기(C)/반폭(H)/길이(L)/명령 취소(U)/폭(W)]:' : '다음 점 지정 또는 [호(A)/반폭(H)/길이(L)/명령 취소(U)/폭(W)]:', {
            base: lp,
            keywords: kws,
            rubber: (q) => [{ pts: polyPreview([...verts, { x: q.x, y: q.y, bulge: 0, startWidth: 0, endWidth: 0 }], false) }],
          });
        } else {
          const kws = [
            { key: 'A', label: '각도' },
            { key: 'CE', label: '중심' },
            { key: 'CL', label: '닫기' },
            { key: 'D', label: '방향' },
            { key: 'H', label: '반폭' },
            { key: 'L', label: '선' },
            { key: 'R', label: '반지름' },
            { key: 'S', label: '두 번째 점' },
            { key: 'U', label: '명령 취소' },
            { key: 'W', label: '폭' },
          ];
          r = await ctx.getPoint('호의 끝점 지정(방향 전환은 Ctrl 키) 또는 [각도(A)/중심(CE)/닫기(CL)/방향(D)/반폭(H)/선(L)/반지름(R)/두 번째 점(S)/명령 취소(U)/폭(W)]:', {
            base: lp,
            keywords: kws,
            rubber: (q) => {
              const b = bulgeFor(last, q);
              const tmp = verts.map((v) => ({ ...v }));
              tmp[tmp.length - 1]!.bulge = b;
              return [{ pts: polyPreview([...tmp, { x: q.x, y: q.y, bulge: 0, startWidth: 0, endWidth: 0 }], false) }];
            },
          });
        }
        if ('enter' in r) break;
        if ('keyword' in r) {
          const k = r.keyword;
          if (k === 'A' && !arcMode) {
            arcMode = true;
            continue;
          }
          if (k === 'L' && arcMode) {
            arcMode = false;
            continue;
          }
          if (k === 'L' && !arcMode) {
            const len = await getDistance(ctx, '선의 길이 지정', lp);
            const t = tangentAt() ?? 0;
            verts.push({ x: lp.x + Math.cos(t) * len, y: lp.y + Math.sin(t) * len, bulge: 0, startWidth: width0, endWidth: width1 });
            commit();
            continue;
          }
          if (k === 'C' || k === 'CL') {
            if (arcMode) last.bulge = bulgeFor(last, { x: verts[0]!.x, y: verts[0]!.y });
            closed = true;
            commit();
            return;
          }
          if (k === 'U') {
            if (verts.length > 1) {
              verts.pop();
              verts[verts.length - 1]!.bulge = 0;
              if (handle && verts.length >= 2) commit();
              else if (handle && verts.length < 2) {
                st.session.undoLastStep(ctx.group, 1);
                handle = null;
              }
            }
            continue;
          }
          if (k === 'W' || k === 'H') {
            const half = k === 'H';
            const w0 = await getDistance(ctx, half ? '시작 반폭 지정' : '시작 폭 지정', lp, half ? width0 / 2 : width0);
            const w1 = await getDistance(ctx, half ? '끝 반폭 지정' : '끝 폭 지정', lp, w0);
            width0 = half ? w0 * 2 : w0;
            width1 = half ? w1 * 2 : w1;
            last.startWidth = width0;
            last.endWidth = width1;
            continue;
          }
          if (arcMode && (await arcOption(k, last, lp))) continue;
          continue;
        }
        const p = pt(r)!;
        if (arcMode) last.bulge = bulgeFor(last, p);
        last.startWidth = width0;
        last.endWidth = width1;
        verts.push({ x: p.x, y: p.y, bulge: 0, startWidth: width1, endWidth: width1 });
        width0 = width1;
        commit();
        app.lastPoint = p;
      }
    },
  });

  // ------------------------------------------------------------- CIRCLE
  app.register({
    name: 'CIRCLE',
    aliases: ['C'],
    title: '원',
    async run(ctx) {
      const r0 = await ctx.getPoint('원에 대한 중심점 지정 또는 [3점(3P)/2점(2P)/Ttr - 접선 접선 반지름(T)]:', {
        keywords: [
          { key: '3P', label: '3점' },
          { key: '2P', label: '2점' },
          { key: 'T', label: 'Ttr - 접선 접선 반지름' },
        ],
      });
      let c: Pt;
      let rad: number;
      if ('keyword' in r0 && r0.keyword === 'T') {
        // 접선 두 개와 반지름: 선·호·원(폴리선의 직선·호 구간 포함)을 연장해서 본다
        const pieceAt = async (prompt: string) => {
          for (;;) {
            const r = await ctx.getEntity(prompt);
            if (!('handle' in r)) return null;
            const e = app.active!.doc.entityIndex.get(r.handle);
            const path = e ? entityPath(e) : null;
            if (path && path.pieces.length) {
              const piece = path.pieces[pathNearest(path, r.point).i]!;
              if (piece.k === 'line' || piece.k === 'arc') return { piece, pick: r.point };
            }
            ctx.print('선, 호, 원을 선택하십시오.', 'err');
          }
        };
        const t1 = await pieceAt('원의 첫 번째 접점에 대한 객체 위의 점 지정:');
        if (!t1) return;
        const t2 = await pieceAt('원의 두 번째 접점에 대한 객체 위의 점 지정:');
        if (!t2) return;
        const prev = Number(app.active!.doc.header.get('$CIRCLERAD') ?? 0) || undefined;
        const R = await getDistance(ctx, '원의 반지름 지정', null, prev);
        const k = circleTTR(t1.piece, t1.pick, t2.piece, t2.pick, R);
        if (!k) {
          ctx.print('원이 존재하지 않습니다.', 'err');
          return;
        }
        c = k.c;
        rad = k.r;
      } else if ('keyword' in r0 && r0.keyword === '3P') {
        const a = pt(await ctx.getPoint('원 위의 첫 번째 점 지정:'));
        if (!a) return;
        const b = pt(await ctx.getPoint('원 위의 두 번째 점 지정:', { base: a }));
        if (!b) return;
        const p3 = pt(
          await ctx.getPoint('원 위의 세 번째 점 지정:', {
            rubber: (q) => {
              const k = circle3p(a, b, q);
              return k ? [{ pts: circlePts(k.c, k.r), closed: true }] : [];
            },
          }),
        );
        if (!p3) return;
        const k = circle3p(a, b, p3);
        if (!k) {
          ctx.print('세 점이 한 직선 위에 있습니다.', 'err');
          return;
        }
        c = k.c;
        rad = k.r;
      } else if ('keyword' in r0 && r0.keyword === '2P') {
        const a = pt(await ctx.getPoint('원 지름의 첫 번째 끝점 지정:'));
        if (!a) return;
        const b = pt(await ctx.getPoint('원 지름의 두 번째 끝점 지정:', { base: a, rubber: (q) => [{ pts: circlePts({ x: (a.x + q.x) / 2, y: (a.y + q.y) / 2 }, dist(a, q) / 2), closed: true }] }));
        if (!b) return;
        c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        rad = dist(a, b) / 2;
      } else {
        const p = pt(r0);
        if (!p) return;
        c = p;
        const prev = Number(app.active!.doc.header.get('$CIRCLERAD') ?? 0) || undefined;
        let diameter = false;
        for (;;) {
          const r = await ctx.getPoint(diameter ? '원의 지름을 지정함:' : `원의 반지름 지정 또는 [지름(D)]${prev ? ` <${fmt(ctx, prev)}>` : ''}:`, {
            base: c,
            keywords: diameter ? [] : [{ key: 'D', label: '지름' }],
            allowText: true,
            rubber: (q) => [{ pts: circlePts(c, diameter ? dist(c, q) / 2 : dist(c, q)), closed: true }],
          });
          if ('keyword' in r) {
            diameter = true;
            continue;
          }
          if ('enter' in r) {
            if (!prev) continue;
            rad = prev;
            break;
          }
          if ('text' in r) {
            const v = parseFloat(r.text);
            if (!(v > 0)) continue;
            rad = diameter ? v / 2 : v;
            break;
          }
          rad = diameter ? dist(c, r.point) / 2 : dist(c, r.point);
          break;
        }
      }
      if (!(rad > 0)) return;
      app.active!.doc.header.set('$CIRCLERAD', rad);
      addEntities(app, ctx, [{ ...base(), type: 'CIRCLE', handle: '', center: v3(c, currentElevation(app)), radius: rad } as Entity], 'CIRCLE');
    },
  });

  // ------------------------------------------------------------- ARC
  app.register({
    name: 'ARC',
    aliases: ['A'],
    title: '호',
    async run(ctx) {
      const r0 = await ctx.getPoint('호의 시작점 또는 [중심(C)] 지정:', { keywords: [{ key: 'C', label: '중심' }] });
      let c: Pt;
      let rad: number;
      let a0: number;
      let a1: number;
      if ('keyword' in r0) {
        const cp = pt(await ctx.getPoint('호의 중심점 지정:'));
        if (!cp) return;
        const sp = pt(await ctx.getPoint('호의 시작점 지정:', { base: cp }));
        if (!sp) return;
        c = cp;
        rad = dist(cp, sp);
        a0 = ang(cp, sp);
        const er = await ctx.getPoint('호의 끝점 지정(방향 전환은 Ctrl 키) 또는 [각도(A)/현의 길이(L)]:', {
          base: cp,
          keywords: [
            { key: 'A', label: '각도' },
            { key: 'L', label: '현의 길이' },
          ],
          rubber: (q) => [{ pts: arcPoints(c.x, c.y, rad, a0, ccwSweep(a0, ang(c, q)), rad * 0.002) }],
        });
        if ('keyword' in er && er.keyword === 'A') {
          const sw = await getAngle(ctx, '사이각 지정', null, Math.PI / 2);
          a1 = a0 + sw;
          if (sw < 0) [a0, a1] = [a1, a0];
        } else if ('keyword' in er && er.keyword === 'L') {
          const L = await getDistance(ctx, '현의 길이 지정', null);
          const sw = 2 * Math.asin(Math.min(1, L / (2 * rad)));
          a1 = a0 + sw;
        } else {
          const ep = pt(er);
          if (!ep) return;
          a1 = ang(c, ep);
        }
      } else {
        const sp = pt(r0);
        if (!sp) return;
        const mr = await ctx.getPoint('호의 두 번째 점 또는 [중심(C)/끝(E)] 지정:', {
          base: sp,
          keywords: [
            { key: 'C', label: '중심' },
            { key: 'E', label: '끝' },
          ],
        });
        if ('keyword' in mr && mr.keyword === 'C') {
          const cp = pt(await ctx.getPoint('호의 중심점 지정:', { base: sp }));
          if (!cp) return;
          c = cp;
          rad = dist(cp, sp);
          a0 = ang(cp, sp);
          const ep = pt(await ctx.getPoint('호의 끝점 지정:', { base: cp, rubber: (q) => [{ pts: arcPoints(c.x, c.y, rad, a0, ccwSweep(a0, ang(c, q)), rad * 0.002) }] }));
          if (!ep) return;
          a1 = ang(c, ep);
        } else if ('keyword' in mr && mr.keyword === 'E') {
          const ep = pt(await ctx.getPoint('호의 끝점 지정:', { base: sp }));
          if (!ep) return;
          const cr = await ctx.getPoint('호의 중심점 지정 또는 [각도(A)/방향(D)/반지름(R)]:', {
            base: ep,
            keywords: [
              { key: 'A', label: '각도' },
              { key: 'R', label: '반지름' },
            ],
          });
          if ('keyword' in cr && (cr.keyword === 'A' || cr.keyword === 'R')) {
            let sw: number;
            if (cr.keyword === 'A') sw = await getAngle(ctx, '사이각 지정', null, Math.PI / 2);
            else {
              const R = await getDistance(ctx, '호의 반지름 지정', ep);
              const chord = dist(sp, ep);
              sw = 2 * Math.asin(Math.min(1, chord / (2 * R)));
            }
            const chord = dist(sp, ep);
            rad = chord / (2 * Math.sin(Math.abs(sw) / 2));
            const mid = { x: (sp.x + ep.x) / 2, y: (sp.y + ep.y) / 2 };
            const hgt = rad * Math.cos(Math.abs(sw) / 2);
            const dx = (ep.x - sp.x) / chord;
            const dy = (ep.y - sp.y) / chord;
            c = { x: mid.x - dy * hgt, y: mid.y + dx * hgt };
            a0 = ang(c, sp);
            a1 = ang(c, ep);
          } else {
            const cp = pt(cr);
            if (!cp) return;
            c = cp;
            rad = dist(cp, sp);
            a0 = ang(cp, sp);
            a1 = ang(cp, ep);
          }
        } else {
          const mp = pt(mr);
          if (!mp) return;
          const ep = pt(
            await ctx.getPoint('호의 끝점 지정:', {
              base: mp,
              rubber: (q) => {
                const k = arc3p(sp, mp, q);
                return k ? [{ pts: arcPoints(k.c.x, k.c.y, k.r, k.a0, ccwSweep(k.a0, k.a1), k.r * 0.002) }] : [];
              },
            }),
          );
          if (!ep) return;
          const k = arc3p(sp, mp, ep);
          if (!k) {
            ctx.print('세 점이 한 직선 위에 있습니다.', 'err');
            return;
          }
          c = k.c;
          rad = k.r;
          a0 = k.a0;
          a1 = k.a1;
        }
      }
      addEntities(app, ctx, [{ ...base(), type: 'ARC', handle: '', center: v3(c, currentElevation(app)), radius: rad, startAngle: norm(a0), endAngle: norm(a1) } as Entity], 'ARC');
    },
  });

  // ------------------------------------------------------------- RECTANG
  app.register({
    name: 'RECTANG',
    aliases: ['REC', 'RECTANGLE'],
    title: '직사각형',
    async run(ctx) {
      const st = app.active!;
      const mode = rectModeOf(st);
      const f = (v: number) => fmt(ctx, v);
      // 기본값이 아닌 모드만 알린다(AutoCAD와 같다)
      const status = () => {
        const parts: string[] = [];
        if (mode.chamfer[0] || mode.chamfer[1]) parts.push(`모따기=${f(mode.chamfer[0])} x ${f(mode.chamfer[1])}`);
        if (mode.elevation) parts.push(`고도=${f(mode.elevation)}`);
        if (mode.fillet) parts.push(`모깎기=${f(mode.fillet)}`);
        if (mode.thickness) parts.push(`두께=${f(mode.thickness)}`);
        if (mode.width) parts.push(`폭=${f(mode.width)}`);
        if (parts.length) ctx.print(`현재 직사각형 모드: ${parts.join('  ')}`);
      };
      status();
      let a: Pt | null = null;
      while (!a) {
        const r = await ctx.getPoint('첫 번째 구석점 지정 또는 [모따기(C)/고도(E)/모깎기(F)/두께(T)/폭(W)]:', {
          keywords: [
            { key: 'C', label: '모따기' },
            { key: 'E', label: '고도' },
            { key: 'F', label: '모깎기' },
            { key: 'T', label: '두께' },
            { key: 'W', label: '폭' },
          ],
        });
        if ('enter' in r) return;
        if ('keyword' in r) {
          if (r.keyword === 'C') {
            const d1 = await getDistance(ctx, '직사각형의 첫 번째 모따기 거리 지정', null, mode.chamfer[0]);
            const d2 = await getDistance(ctx, '직사각형의 두 번째 모따기 거리 지정', null, mode.chamfer[1] || d1);
            mode.chamfer = [Math.max(0, d1), Math.max(0, d2)];
            if (mode.chamfer[0] || mode.chamfer[1]) mode.fillet = 0;
          } else if (r.keyword === 'E') mode.elevation = await getDistance(ctx, '직사각형의 고도 지정', null, mode.elevation);
          else if (r.keyword === 'F') {
            mode.fillet = Math.max(0, await getDistance(ctx, '직사각형의 모깎기 반지름 지정', null, mode.fillet));
            if (mode.fillet) mode.chamfer = [0, 0];
          } else if (r.keyword === 'T') mode.thickness = await getDistance(ctx, '직사각형의 두께 지정', null, mode.thickness);
          else if (r.keyword === 'W') mode.width = Math.max(0, await getDistance(ctx, '직사각형의 선 폭 지정', null, mode.width));
          status();
          continue;
        }
        a = pt(r);
      }
      const A = a;
      const opt = (): RectOptions => ({ chamfer: mode.chamfer, fillet: mode.fillet, width: mode.width });
      // 치수(D)로 길이·폭을 정했으면 커서가 있는 쪽(사분면)에 그 크기로
      let dims: { L: number; W: number } | null = null;
      const cornerFor = (q: Pt): Pt => {
        if (!dims) return q;
        const u = { x: Math.cos(mode.rotation), y: Math.sin(mode.rotation) };
        const lx = (q.x - A.x) * u.x + (q.y - A.y) * u.y;
        const ly = -(q.x - A.x) * u.y + (q.y - A.y) * u.x;
        return rectOtherCorner(A, dims.L, dims.W, mode.rotation, lx < 0 ? -1 : 1, ly < 0 ? -1 : 1);
      };
      const preview = (b: Pt) => [{ pts: polyPreview(rectVertices(rectCorners(A, cornerFor(b), mode.rotation), opt()), true), closed: true }];
      let b: Pt | null = null;
      for (;;) {
        const r = await ctx.getPoint('다른 구석점 지정 또는 [영역(A)/치수(D)/회전(R)]:', {
          base: A,
          keywords: [
            { key: 'A', label: '영역' },
            { key: 'D', label: '치수' },
            { key: 'R', label: '회전' },
          ],
          rubber: preview,
        });
        if ('enter' in r) return;
        if ('keyword' in r) {
          if (r.keyword === 'D') {
            const L = await getDistance(ctx, '직사각형의 길이 지정', null, mode.length);
            const W = await getDistance(ctx, '직사각형의 폭 지정', null, mode.breadth);
            if (!(L > 0) || !(W > 0)) continue;
            mode.length = L;
            mode.breadth = W;
            dims = { L, W };
            continue;
          }
          if (r.keyword === 'R') {
            mode.rotation = await rotationAngle(ctx, A, mode.rotation);
            continue;
          }
          // 영역(A): 넓이와 한 변으로 다른 변(모따기·모깎기 넓이 반영), 첫 구석점에서 +X·+Y 쪽으로
          const ar = await getDistance(ctx, '현재 단위에 직사각형 영역 입력', null, mode.area);
          if (!(ar > 0)) continue;
          mode.area = ar;
          const by = await ctx.getPoint(`영역 치수 계산 기준 [길이(L)/폭(W)] <${mode.areaBy === 'W' ? '폭' : '길이'}>:`, {
            keywords: [
              { key: 'L', label: '길이' },
              { key: 'W', label: '폭' },
            ],
          });
          if ('keyword' in by) mode.areaBy = by.keyword as 'L' | 'W';
          const byW = mode.areaBy === 'W';
          const side = await getDistance(ctx, byW ? '직사각형 폭 입력' : '직사각형 길이 입력', null, byW ? mode.breadth : mode.length);
          const other = rectOtherSide(ar, side, opt());
          if (!other) {
            ctx.print('0보다 큰 값을 입력하십시오.', 'err');
            continue;
          }
          const L = byW ? other : side;
          const W = byW ? side : other;
          mode.length = L;
          mode.breadth = W;
          b = rectOtherCorner(A, L, W, mode.rotation);
          break;
        }
        b = pt(r);
        if (b) {
          b = cornerFor(b);
          break;
        }
      }
      const corners = rectCorners(A, b, mode.rotation);
      const L = Math.hypot(corners[1]!.x - corners[0]!.x, corners[1]!.y - corners[0]!.y);
      const W = Math.hypot(corners[2]!.x - corners[1]!.x, corners[2]!.y - corners[1]!.y);
      if (L < 1e-12 || W < 1e-12) return;
      if (!rectCornersFit(L, W, opt())) ctx.print(mode.fillet ? '직사각형이 너무 작아 모깎기하지 않았습니다.' : '직사각형이 너무 작아 모따기하지 않았습니다.');
      const vs = rectVertices(corners, opt());
      const e = {
        ...base(),
        type: 'LWPOLYLINE',
        handle: '',
        ...packLw(vs),
        closed: true,
        plinegen: false,
        constantWidth: mode.width,
        elevation: mode.elevation || currentElevation(app),
      } as Entity;
      if (mode.thickness) e.thickness = mode.thickness;
      addEntities(app, ctx, [e], 'RECTANG');
    },
  });

  // ------------------------------------------------------------- POLYGON
  app.register({
    name: 'POLYGON',
    aliases: ['POL'],
    title: '폴리곤',
    async run(ctx) {
      const n = await getInt(ctx, '면의 수 입력', 4, 3, 1024);
      const cr = await ctx.getPoint('다각형의 중심을 지정 또는 [모서리(E)]:', { keywords: [{ key: 'E', label: '모서리' }] });
      let verts: Pt[];
      if ('keyword' in cr) {
        const a = pt(await ctx.getPoint('모서리의 첫 번째 끝점 지정:'));
        if (!a) return;
        const poly = (b: Pt) => {
          const side = dist(a, b);
          const out: Pt[] = [a];
          let dir = ang(a, b);
          let cur = a;
          for (let i = 1; i < n; i++) {
            cur = { x: cur.x + Math.cos(dir) * side, y: cur.y + Math.sin(dir) * side };
            out.push(cur);
            dir += TAU / n;
          }
          return out;
        };
        const b = pt(await ctx.getPoint('모서리의 두 번째 끝점 지정:', { base: a, rubber: (q) => [{ pts: poly(q).flatMap((p) => [p.x, p.y]), closed: true }] }));
        if (!b) return;
        verts = poly(b);
      } else {
        const c = pt(cr);
        if (!c) return;
        const mr = await ctx.getPoint('옵션을 입력 [원에 내접(I)/원에 외접(C)] <I>:', {
          keywords: [
            { key: 'I', label: '원에 내접' },
            { key: 'C', label: '원에 외접' },
          ],
        });
        const circ = 'keyword' in mr && mr.keyword === 'C';
        const poly = (q: Pt) => {
          let r = dist(c, q);
          let a0 = ang(c, q);
          if (circ) {
            // 외접: 커서까지가 변의 중점 거리
            r = r / Math.cos(Math.PI / n);
            a0 += Math.PI / n;
          }
          return Array.from({ length: n }, (_, i) => ({ x: c.x + r * Math.cos(a0 + (i * TAU) / n), y: c.y + r * Math.sin(a0 + (i * TAU) / n) }));
        };
        const rr = await ctx.getPoint('원의 반지름 지정:', { base: c, allowText: true, rubber: (q) => [{ pts: poly(q).flatMap((p) => [p.x, p.y]), closed: true }] });
        let q: Pt | null = pt(rr);
        if (!q && 'text' in rr) {
          const v = parseFloat(rr.text);
          if (v > 0) q = { x: c.x + v, y: c.y };
        }
        if (!q) return;
        verts = poly(q);
      }
      addEntities(app, ctx, [{ ...base(), type: 'LWPOLYLINE', handle: '', ...packLwPoints(verts), closed: true, plinegen: false, constantWidth: 0, elevation: currentElevation(app) } as Entity], 'POLYGON');
    },
  });

  // ------------------------------------------------------------- ELLIPSE
  app.register({
    name: 'ELLIPSE',
    aliases: ['EL'],
    title: '타원',
    async run(ctx) {
      // 등각투영 제도가 켜져 있으면 등각원(I)
      const isoKw = isoEllipseKeyword(app);
      const r0 = await ctx.getPoint(isoKw ? '타원의 축 끝점 지정 또는 [호(A)/중심(C)/등각원(I)]:' : '타원의 축 끝점 지정 또는 [호(A)/중심(C)]:', {
        keywords: [{ key: 'A', label: '호' }, { key: 'C', label: '중심' }, ...(isoKw ? [isoKw] : [])],
      });
      if ('keyword' in r0 && r0.keyword === 'I') {
        const ic = await isoCircleEllipse(app, ctx);
        if (ic) addEntities(app, ctx, [{ ...base(), type: 'ELLIPSE', handle: '', center: v3(ic.center), majorAxis: { ...ic.majorAxis, z: 0 }, ratio: ic.ratio, startParam: 0, endParam: TAU } as Entity], 'ELLIPSE');
        return;
      }
      let arcMode = false;
      let center: Pt;
      let major: Pt;
      if ('keyword' in r0 && r0.keyword === 'C') {
        const c = pt(await ctx.getPoint('타원의 중심 지정:'));
        if (!c) return;
        const e = pt(await ctx.getPoint('축의 끝점 지정:', { base: c }));
        if (!e) return;
        center = c;
        major = { x: e.x - c.x, y: e.y - c.y };
      } else {
        if ('keyword' in r0) arcMode = true;
        const a = 'keyword' in r0 ? pt(await ctx.getPoint('타원형 호의 축 끝점 지정:')) : pt(r0);
        if (!a) return;
        const b = pt(await ctx.getPoint('축의 다른 끝점 지정:', { base: a }));
        if (!b) return;
        center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        major = { x: b.x - center.x, y: b.y - center.y };
      }
      const ml = Math.hypot(major.x, major.y);
      if (ml < 1e-12) return;
      const ratioOf = (q: Pt) => {
        // 커서에서 장축까지 거리 = 단축 반지름
        const ux = major.x / ml;
        const uy = major.y / ml;
        const d = Math.abs(-(q.x - center.x) * uy + (q.y - center.y) * ux);
        return Math.max(1e-6, Math.min(1, d / ml));
      };
      const rr = await ctx.getPoint('다른 축으로 거리를 지정 또는 [회전(R)]:', {
        base: center,
        keywords: [{ key: 'R', label: '회전' }],
        allowText: true,
        rubber: (q) => [{ pts: ellipsePoints(center.x, center.y, major.x, major.y, ratioOf(q), 0, TAU, ml * 0.002), closed: true }],
      });
      let ratio: number;
      if ('keyword' in rr) {
        const a = await getAngle(ctx, '장축 주위로 회전 지정', null, 0);
        ratio = Math.max(1e-6, Math.abs(Math.cos(a)));
      } else if ('text' in rr) ratio = Math.max(1e-6, Math.min(1, parseFloat(rr.text) / ml));
      else {
        const q = pt(rr);
        if (!q) return;
        ratio = ratioOf(q);
      }
      // 단축이 더 길면 축을 바꾼다
      let mj = major;
      if (ratio > 1) {
        mj = { x: -major.y * ratio, y: major.x * ratio };
        ratio = 1 / ratio;
      }
      let p0 = 0;
      let p1 = TAU;
      if (arcMode) {
        // 각도는 장축에서 잰다. 매개변수(P)는 p(u) = c + a·cos(u) + b·sin(u)의 u(도), 사이각(I)은 시작 각도부터 잰 각도
        const axis = Math.atan2(mj.y, mj.x);
        const ml2 = Math.hypot(mj.x, mj.y);
        const toParam = (q: Pt) => ellipseAngleToParam(ang(center, q) - axis, ratio);
        const arcPreview = (u0: number, u1: number) => [{ pts: ellipsePoints(center.x, center.y, mj.x, mj.y, ratio, u0, u0 + ccwSweep(u0, u1), ml2 * 0.002) }];
        let useParam = false;
        let start: number | null = null;
        while (start === null) {
          const r = await ctx.getPoint(useParam ? '시작 매개변수 지정 또는 [각도(A)]:' : '시작 각도 지정 또는 [매개변수(P)]:', {
            base: center,
            preferNumber: true,
            keywords: [useParam ? { key: 'A', label: '각도' } : { key: 'P', label: '매개변수' }],
            rubber: (q) => [{ pts: [center.x, center.y, q.x, q.y], dashed: true }],
          });
          if ('keyword' in r) useParam = r.keyword === 'P';
          else if ('point' in r) start = toParam(r.point);
          else if ('text' in r && Number.isFinite(parseFloat(r.text))) {
            const v = (parseFloat(r.text) * Math.PI) / 180;
            start = useParam ? v : ellipseAngleToParam(v, ratio);
          } else if ('enter' in r) return;
        }
        const s0 = start;
        let end: number | null = null;
        while (end === null) {
          const r = await ctx.getPoint(useParam ? '끝 매개변수 지정 또는 [각도(A)/사이각(I)]:' : '끝 각도 지정 또는 [매개변수(P)/사이각(I)]:', {
            base: center,
            preferNumber: true,
            keywords: [useParam ? { key: 'A', label: '각도' } : { key: 'P', label: '매개변수' }, { key: 'I', label: '사이각' }],
            rubber: (q) => arcPreview(s0, toParam(q)),
          });
          if ('keyword' in r && r.keyword === 'I') {
            const inc = await getAngle(ctx, '호의 사이각 지정', null, Math.PI);
            end = ellipseAngleToParam(ellipseParamToAngle(s0, ratio) + inc, ratio);
          } else if ('keyword' in r) useParam = r.keyword === 'P';
          else if ('point' in r) end = toParam(r.point);
          else if ('text' in r && Number.isFinite(parseFloat(r.text))) {
            const v = (parseFloat(r.text) * Math.PI) / 180;
            end = useParam ? v : ellipseAngleToParam(v, ratio);
          } else if ('enter' in r) return;
        }
        p0 = norm(s0);
        p1 = norm(end);
        if (Math.abs(p1 - p0) < 1e-12) return;
      }
      addEntities(app, ctx, [{ ...base(), type: 'ELLIPSE', handle: '', center: v3(center, currentElevation(app)), majorAxis: { x: mj.x, y: mj.y, z: 0 }, ratio, startParam: p0, endParam: p1 } as Entity], 'ELLIPSE');
    },
  });

  // ------------------------------------------------------------- SPLINE
  app.register({
    name: 'SPLINE',
    aliases: ['SPL'],
    title: '스플라인',
    async run(ctx) {
      const st = app.active!;
      const m = memOf(st);
      const elev = currentElevation(app);
      const KNOT_LABEL: Record<KnotParam, string> = { chord: '현', sqrt: '제곱근', uniform: '균일' };
      let method: 'fit' | 'cv' = m.splMethod === 'cv' ? 'cv' : 'fit';
      let knots: KnotParam = m.splKnots === 'sqrt' || m.splKnots === 'uniform' ? m.splKnots : 'chord';
      let degree = typeof m.splDegree === 'number' ? m.splDegree : 3;
      const status = () => ctx.print(method === 'fit' ? `현재 설정: 메서드=맞춤   매듭=${KNOT_LABEL[knots]}` : `현재 설정: 메서드=CV   차수=${degree}`);
      status();
      // 첫 점 또는 메서드(M)·매듭(K)·차수(D)·객체(O)
      let first: Pt | null = null;
      while (!first) {
        const kws = [{ key: 'M', label: '메서드' }, method === 'fit' ? { key: 'K', label: '매듭' } : { key: 'D', label: '차수' }, { key: 'O', label: '객체' }];
        const r = await ctx.getPoint(method === 'fit' ? '첫 번째 점 지정 또는 [메서드(M)/매듭(K)/객체(O)]:' : '첫 번째 점 지정 또는 [메서드(M)/차수(D)/객체(O)]:', { keywords: kws });
        if ('enter' in r) return;
        if (!('keyword' in r)) {
          first = pt(r);
          continue;
        }
        if (r.keyword === 'M') {
          const k = await ctx.getPoint(`스플라인 작성 메서드 입력 [맞춤(F)/CV(C)] <${method === 'fit' ? '맞춤' : 'CV'}>:`, {
            keywords: [
              { key: 'F', label: '맞춤' },
              { key: 'C', label: 'CV' },
            ],
          });
          if ('keyword' in k) method = k.keyword === 'C' ? 'cv' : 'fit';
          m.splMethod = method;
        } else if (r.keyword === 'K') {
          const k = await ctx.getPoint(`매듭 매개변수화 입력 [현(C)/제곱근(S)/균일(U)] <${KNOT_LABEL[knots]}>:`, {
            keywords: [
              { key: 'C', label: '현' },
              { key: 'S', label: '제곱근' },
              { key: 'U', label: '균일' },
            ],
          });
          if ('keyword' in k) knots = k.keyword === 'S' ? 'sqrt' : k.keyword === 'U' ? 'uniform' : 'chord';
          m.splKnots = knots;
        } else if (r.keyword === 'D') {
          degree = await getInt(ctx, '스플라인 차수 입력', degree, 1, 10);
          m.splDegree = degree;
        } else if (r.keyword === 'O') {
          await splineFromObjects(ctx);
          return;
        }
        status();
      }
      const pts: Vec3[] = [v3(first, elev)];
      const last = () => ({ x: pts[pts.length - 1]!.x, y: pts[pts.length - 1]!.y });
      const tol = () => 0.001 * Math.max(1, dist(first!, last())) + 1e-9;
      const toXY = (xyz: number[]) => {
        const xy: number[] = [];
        for (let i = 0; i < xyz.length; i += 3) xy.push(xyz[i]!, xyz[i + 1]!);
        return xy;
      };
      let closed = false;
      let startTangent: Vec3 | undefined;
      let endTangent: Vec3 | undefined;
      let tolerance = typeof m.splTol === 'number' ? m.splTol : 0;
      const tangentFrom = async (prompt: string, from: Pt): Promise<Vec3 | undefined> => {
        const r = await ctx.getPoint(prompt, { base: from });
        if (!('point' in r) || dist(r.point, from) < 1e-12) return undefined;
        const l = dist(r.point, from);
        return { x: (r.point.x - from.x) / l, y: (r.point.y - from.y) / l, z: 0 };
      };
      for (;;) {
        const n = pts.length;
        let prompt: string;
        let kws: { key: string; label: string }[];
        if (method === 'fit') {
          kws = n === 1 ? [{ key: 'T', label: '시작 접촉부' }, { key: 'L', label: '공차' }] : [{ key: 'T', label: '끝 접촉부' }, { key: 'L', label: '공차' }, { key: 'U', label: '명령 취소' }, ...(n >= 3 ? [{ key: 'C', label: '닫기' }] : [])];
        } else kws = n === 1 ? [] : [...(n >= 3 ? [{ key: 'C', label: '닫기' }] : []), { key: 'U', label: '명령 취소' }];
        prompt = kws.length ? `다음 점 입력 또는 [${kws.map((k) => `${k.label}(${k.key})`).join('/')}]:` : '다음 점 입력:';
        const r = await ctx.getPoint(prompt, {
          base: last(),
          keywords: kws,
          rubber: (q) => {
            const all = [...pts, v3(q, elev)];
            if (method === 'cv') {
              const p = Math.max(1, Math.min(degree, all.length - 1));
              const poly = all.flatMap((v) => [v.x, v.y]);
              return [{ pts: toXY(nurbsPoints(p, clampedKnots(all.length, p), all, undefined, tol())) }, { pts: poly, dashed: true }];
            }
            const s = fitSplineNurbs(all, knots, startTangent);
            return [{ pts: toXY(nurbsPoints(s.degree, s.knots, s.ctrl, undefined, tol())) }];
          },
        });
        if ('enter' in r) break;
        if ('keyword' in r) {
          if (r.keyword === 'U' && pts.length > 1) pts.pop();
          else if (r.keyword === 'C') {
            closed = true;
            break;
          } else if (r.keyword === 'L') {
            tolerance = Math.max(0, await getDistance(ctx, '맞춤 공차 지정', null, tolerance));
            m.splTol = tolerance;
          } else if (r.keyword === 'T') {
            if (n === 1) startTangent = await tangentFrom('시작 접촉부 지정:', first);
            else {
              // 끝 접촉부를 정하면 곡선을 끝낸다(AutoCAD와 같다)
              endTangent = await tangentFrom('끝 접촉부 지정:', last());
              break;
            }
          }
          continue;
        }
        const p = pt(r);
        if (p && dist(p, last()) > 1e-12) pts.push(v3(p, elev));
      }
      if (pts.length < 2) return;
      const e = method === 'cv' ? makeCvSpline(base(), pts, degree, closed) : makeFitSpline(base(), pts, { knots, closed, startTangent, endTangent, tolerance });
      if (e) addEntities(app, ctx, [e], 'SPLINE');
    },
  });

  /** SPLINE 객체(O): 스플라인 맞춤 폴리선을 같은 곡선의 스플라인으로 바꾼다(원본은 지운다 — DELOBJ 기본값) */
  async function splineFromObjects(ctx: CommandContext): Promise<void> {
    const st = app.active!;
    const hs = unlockedOnly(app, await ctx.getSelection('객체 선택:', { noPickfirst: true }));
    const ops: EditOp[] = [];
    let bad = 0;
    for (const h of hs) {
      const e = st.doc.entityIndex.get(h);
      const block = st.session.ownerOf(h);
      const s = e ? splineFromFitPolyline(e) : null;
      if (!e || !block || !s) {
        bad++;
        continue;
      }
      s.handle = st.session.newHandle();
      s.owner = e.owner;
      const idx = st.doc.blocks.get(block)!.entities.indexOf(e);
      ops.push({ kind: 'remove', block, entity: e, index: idx }, { kind: 'add', block, entity: s, index: idx });
    }
    if (bad) ctx.print(`${bad}개는 스플라인 맞춤 폴리선이 아니라 변환하지 않았습니다.`);
    if (!ops.length) return;
    st.session.commit({ label: 'SPLINE', ops, group: ctx.group });
    ctx.print(`스플라인 ${ops.length / 2}개로 변환했습니다.`);
  }

  // ------------------------------------------------------------- POINT
  app.register({
    name: 'POINT',
    aliases: ['PO'],
    title: '점',
    async run(ctx) {
      const d = app.active!.doc;
      ctx.print(`현재 점 모드: PDMODE=${d.header.get('$PDMODE') ?? 0} PDSIZE=${d.header.get('$PDSIZE') ?? 0}`);
      for (;;) {
        const p = pt(await ctx.getPoint('점 지정:'));
        if (!p) return;
        addEntities(app, ctx, [{ ...base(), type: 'POINT', handle: '', position: v3(p, currentElevation(app)), angle: 0 } as Entity], 'POINT');
      }
    },
  });

  // ------------------------------------------------------------- XLINE·RAY
  app.register({
    name: 'XLINE',
    aliases: ['XL'],
    title: '구성선',
    async run(ctx) {
      const st = app.active!;
      const elev = currentElevation(app);
      const make = (b: Pt, dir: number) =>
        addEntities(app, ctx, [{ ...base(), type: 'XLINE', handle: '', base: v3(b, elev), direction: { x: Math.cos(dir), y: Math.sin(dir), z: 0 } } as Entity], 'XLINE');
      const xlinePreview = (b: Pt, dir: number) => {
        const L = 1e6;
        return [{ pts: [b.x - Math.cos(dir) * L, b.y - Math.sin(dir) * L, b.x + Math.cos(dir) * L, b.y + Math.sin(dir) * L] }];
      };
      /** 선 객체(선·구성선·광선·폴리선의 직선 구간) 고르기 → 그 직선의 두 점 */
      const pickLine = async (): Promise<{ a: Pt; b: Pt } | null> => {
        for (;;) {
          const r = await ctx.getEntity('선 객체 선택:');
          if (!('handle' in r)) return null;
          const e = st.doc.entityIndex.get(r.handle);
          const path = e ? entityPath(e) : null;
          const piece = path?.pieces.length ? path.pieces[pathNearest(path, r.point).i] : undefined;
          if (piece?.k === 'line' && Math.hypot(piece.b.x - piece.a.x, piece.b.y - piece.a.y) > 0) return { a: piece.a, b: piece.b };
          ctx.print('선택한 객체는 선이 아닙니다.', 'err');
        }
      };
      const r0 = await ctx.getPoint('점 지정 또는 [수평(H)/수직(V)/각도(A)/이등분(B)/간격띄우기(O)]:', {
        keywords: [
          { key: 'H', label: '수평' },
          { key: 'V', label: '수직' },
          { key: 'A', label: '각도' },
          { key: 'B', label: '이등분' },
          { key: 'O', label: '간격띄우기' },
        ],
      });
      if ('keyword' in r0 && r0.keyword === 'B') {
        // 이등분: 정점·시작점, 끝점마다 하나씩
        const v = pt(await ctx.getPoint('각도 정점 지정:'));
        if (!v) return;
        const a = pt(await ctx.getPoint('각도 시작점 지정:', { base: v }));
        if (!a) return;
        for (;;) {
          const b = pt(await ctx.getPoint('각도 끝점 지정:', { base: v, rubber: (q) => { const d = bisectAngle(v, a, q); return d === null ? [] : xlinePreview(v, d); } }));
          if (!b) return;
          const d = bisectAngle(v, a, b);
          if (d !== null) make(v, d);
        }
      }
      if ('keyword' in r0 && r0.keyword === 'O') {
        const m = memOf(st);
        const prev = typeof m.xlineOffset === 'number' ? m.xlineOffset : -1;
        const dr = await ctx.getPoint(`간격띄우기 거리 지정 또는 [통과점(T)] <${prev > 0 ? fmt(ctx, prev) : '통과점'}>:`, { preferNumber: true, keywords: [{ key: 'T', label: '통과점' }] });
        let d = prev;
        if ('keyword' in dr) d = -1;
        else if ('text' in dr) {
          const v = parseFloat(dr.text);
          if (!(v > 0)) {
            ctx.print('0보다 큰 값을 입력하십시오.', 'err');
            return;
          }
          d = v;
        } else if ('point' in dr) {
          const p2 = pt(await ctx.getPoint('두 번째 점 지정:', { base: dr.point }));
          if (!p2) return;
          d = dist(dr.point, p2);
        }
        m.xlineOffset = d;
        for (;;) {
          const ln = await pickLine();
          if (!ln) return;
          const len = dist(ln.a, ln.b);
          const dir = ang(ln.a, ln.b);
          const side = pt(
            await ctx.getPoint(d > 0 ? '간격띄우기할 면 지정:' : '통과점 지정:', {
              rubber: (q) => {
                if (d > 0) {
                  const o = offsetLine(ln.a, ln.b, d, q);
                  return o ? xlinePreview(o.base, dir) : [];
                }
                return xlinePreview(q, dir);
              },
            }),
          );
          if (!side) return;
          if (d > 0) {
            const o = offsetLine(ln.a, ln.b, d, side);
            if (o) make(o.base, dir);
          } else if (len > 0) make(side, dir);
        }
      }
      let fixed: number | null = null;
      let basePt: Pt | null = null;
      if ('keyword' in r0) {
        if (r0.keyword === 'H') fixed = 0;
        else if (r0.keyword === 'V') fixed = Math.PI / 2;
        else {
          // 각도: 숫자(도) 또는 참조(R) — 고른 선의 각도에 더한다
          for (;;) {
            const a = await ctx.getPoint('구성선 각도 입력 (0) 또는 [참조(R)]:', { preferNumber: true, keywords: [{ key: 'R', label: '참조' }] });
            if ('keyword' in a) {
              const ln = await pickLine();
              if (!ln) return;
              fixed = ang(ln.a, ln.b) + (await getAngle(ctx, '구성선 각도 입력', null, 0));
              break;
            }
            if ('enter' in a) {
              fixed = 0;
              break;
            }
            if ('point' in a) {
              const p2 = pt(await ctx.getPoint('두 번째 점 지정:', { base: a.point }));
              if (!p2) return;
              fixed = ang(a.point, p2);
              break;
            }
            if ('text' in a && Number.isFinite(parseFloat(a.text))) {
              fixed = (parseFloat(a.text) * Math.PI) / 180;
              break;
            }
            ctx.print('각도(도)를 입력하십시오.', 'err');
          }
        }
      } else basePt = pt(r0);
      for (;;) {
        const fx = fixed;
        const bp = basePt;
        const r = await ctx.getPoint('통과점을 지정:', { base: basePt, rubber: (q) => (fx !== null ? xlinePreview(q, fx) : bp && dist(bp, q) > 0 ? xlinePreview(bp, ang(bp, q)) : []) });
        const p = pt(r);
        if (!p) return;
        let b = basePt ?? p;
        let dir: number;
        if (fixed !== null) {
          b = p;
          dir = fixed;
        } else {
          if (dist(b, p) < 1e-12) continue;
          dir = ang(b, p);
        }
        make(b, dir);
      }
    },
  });
  app.register({
    name: 'RAY',
    title: '광선',
    async run(ctx) {
      const b = pt(await ctx.getPoint('시작점을 지정:'));
      if (!b) return;
      for (;;) {
        const p = pt(await ctx.getPoint('통과점을 지정:', { base: b }));
        if (!p) return;
        const a = ang(b, p);
        addEntities(app, ctx, [{ ...base(), type: 'RAY', handle: '', base: v3(b, currentElevation(app)), direction: { x: Math.cos(a), y: Math.sin(a), z: 0 } } as Entity], 'RAY');
      }
    },
  });

  // ------------------------------------------------------------- DONUT
  app.register({
    name: 'DONUT',
    aliases: ['DO', 'DOUGHNUT'],
    title: '도넛',
    async run(ctx) {
      const inner = await getDistance(ctx, '도넛의 내부 지름 지정', null, 0.5);
      const outer = await getDistance(ctx, '도넛의 외부 지름 지정', null, 1);
      const w = (outer - inner) / 2;
      const rm = (outer + inner) / 4;
      for (;;) {
        const c = pt(await ctx.getPoint('도넛의 중심 지정 <종료>:', { rubber: (q) => [{ pts: circlePts(q, outer / 2), closed: true }] }));
        if (!c) return;
        const vs: LwVertex[] = [
          { x: c.x - rm, y: c.y, bulge: 1, startWidth: w, endWidth: w },
          { x: c.x + rm, y: c.y, bulge: 1, startWidth: w, endWidth: w },
        ];
        addEntities(app, ctx, [{ ...base(), type: 'LWPOLYLINE', handle: '', ...packLw(vs), closed: true, plinegen: false, constantWidth: w, elevation: currentElevation(app) } as Entity], 'DONUT');
      }
    },
  });

  // ------------------------------------------------------------- TEXT·MTEXT
  // 도면 위 한 줄 편집기(DTEXT)와 여러 줄 문자 제자리 편집기: src/app/textedit/commands.ts
  registerTextCommands(app);

  // ------------------------------------------------------------- ERASE·U·REDO
  app.register({
    name: 'ERASE',
    aliases: ['E', 'DELETE'],
    title: '지우기',
    async run(ctx) {
      const st = app.active!;
      const hs = unlockedOnly(app, await ctx.getSelection());
      if (!hs.length) return;
      const ops = [];
      for (const hd of hs) {
        const e = st.doc.entityIndex.get(hd);
        const block = st.session.ownerOf(hd);
        if (!e || !block) continue;
        const idx = st.doc.blocks.get(block)!.entities.indexOf(e);
        ops.push({ kind: 'remove' as const, block, entity: e, index: idx });
      }
      st.selection.clear();
      // 지운 형상에 연관된 치수는 연관만 끊는다
      const f = followOps(st, new Map<string, Entity | null>(ops.map((o) => [o.entity.handle, null])));
      const cs = afterEditSolve(st, ops, 'ERASE');
      st.session.commit({ label: 'ERASE', ops: [...ops, ...f.ops, ...cs.extra], group: ctx.group });
      ctx.print(`${ops.length}개를 지웠습니다.`);
      if (cs.message) ctx.print(cs.message);
    },
  });
  app.register({
    name: 'U',
    title: '명령 취소',
    run(ctx) {
      const s = app.active!.session;
      if (s.undoControl === 'none') {
        ctx.print('명령 취소가 해제되어 있습니다. UNDO의 조정(C) 옵션으로 켜십시오.', 'err');
        return;
      }
      const tx = s.undo();
      ctx.print(tx ? `${tx.label} 명령을 취소했습니다.` : '되돌릴 것이 없습니다.');
    },
  });
  // UNDO(옵션: 작업 수·자동·조정·시작·끝·표식·뒤) — src/app/undocmd.ts
  registerUndoCommand(app);
  // 3DPOLY·3DFACE·TRACE — src/app/draw3d.ts
  registerDraw3dCommands(app);
  app.register({
    name: 'REDO',
    aliases: ['MREDO'],
    title: '명령 복구',
    run(ctx) {
      const tx = app.active!.session.redo();
      ctx.print(tx ? `${tx.label} 명령을 다시 실행했습니다.` : '다시 실행할 것이 없습니다.');
    },
  });
}

function norm(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

function polyPreview(vs: LwVertex[], closed: boolean): number[] {
  const out: number[] = [];
  if (!vs.length) return out;
  out.push(vs[0]!.x, vs[0]!.y);
  const n = vs.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = vs[i]!;
    const b = vs[(i + 1) % n]!;
    const arc = bulgeArc(a.x, a.y, b.x, b.y, a.bulge);
    if (!arc) out.push(b.x, b.y);
    else {
      const k = Math.max(4, Math.ceil(Math.abs(arc.sweep) / 0.1));
      for (let j = 1; j <= k; j++) {
        const t = arc.a0 + (arc.sweep * j) / k;
        out.push(arc.cx + arc.r * Math.cos(t), arc.cy + arc.r * Math.sin(t));
      }
    }
  }
  return out;
}

/**
 * 여러 줄 문자 편집기(제자리 편집기, src/app/textedit). opt.at이 있으면 그 점(부착점 opt.attachment)에, 없으면
 * 커서 자리에 뜬다. 결과 text는 MTEXT 서식 문자열(문단 \P, 서식 코드 포함)이고 나머지 값은 편집기가 바꾼 객체 특성이다.
 */
export function textDialog(title: string, initial: string, height: number, opt: TextDialogOptions = {}): Promise<EditorResult | null> {
  return richTextDialog(title, initial, height, opt);
}

export { CancelError };
export type { Vec2 };
