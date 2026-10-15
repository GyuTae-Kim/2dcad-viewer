/**
 * 그리기 명령: LINE, PLINE, CIRCLE, ARC, RECTANG, POLYGON, ELLIPSE, SPLINE, POINT, XLINE, RAY, DONUT, TEXT, MTEXT
 * 프롬프트와 옵션은 AutoCAD 2026 한국어판을 따른다.
 */
import type { CadColor, Entity, EntityBase, LwVertex, Vec2, Vec3 } from '../core/model';
import { tableKey } from '../core/model';
import { formatLength } from '../core/units';
import { arcPoints, bulgeArc, ccwSweep, ellipsePoints, interpolateFitPoints, nurbsPoints, TAU } from '../geom/curves';
import type { App, CommandContext, PointResult } from './app';
import { CancelError } from './app';
import type { Pt } from './view';
import { dialog, h } from './ui/dom';
import { unlockedOnly } from './layers';
import { followOps } from './dimassoc';
import { afterEditSolve } from './constraints-hook';
import { textStyleAnnotative } from '../edit/annoscale/xdata';
import { isoCircleEllipse, isoEllipseKeyword } from './viewtools-iso';
import { packLw, packLwPoints } from '../core/lwpoly';

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
  return {
    layer: d.layers.get(tableKey(layer))?.name ?? layer,
    color,
    linetype: typeof lt === 'string' && lt ? lt : 'ByLayer',
    lineweight: typeof lw === 'number' ? lw : -1,
    ltscale: typeof lts === 'number' && lts > 0 ? lts : 1,
    transparency: -1,
  };
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
            addEntities(app, ctx, [{ ...base(), type: 'LINE', handle: '', start: v3(prev), end: v3(start) } as Entity], 'LINE');
            app.lastPoint = start;
            return;
          }
          continue;
        }
        const p = pt(r)!;
        if (dist(prev, p) < 1e-12) continue;
        addEntities(app, ctx, [{ ...base(), type: 'LINE', handle: '', start: v3(prev), end: v3(p) } as Entity], 'LINE');
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
      const entity = (): Entity =>
        ({
          ...base(),
          type: 'LWPOLYLINE',
          handle: handle ?? '',
          ...packLw(verts),
          closed,
          plinegen: false,
          constantWidth: 0,
          elevation: 0,
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
            { key: 'CL', label: '닫기' },
            { key: 'L', label: '선' },
            { key: 'S', label: '두 번째 점' },
            { key: 'U', label: '명령 취소' },
            { key: 'W', label: '폭' },
          ];
          r = await ctx.getPoint('호의 끝점 지정 또는 [각도(A)/닫기(CL)/선(L)/두 번째 점(S)/명령 취소(U)/폭(W)]:', {
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
          if (k === 'S' && arcMode) {
            const m = await ctx.getPoint('호의 두 번째 점 지정:', { base: lp });
            const mp = pt(m);
            if (!mp) continue;
            const e = await ctx.getPoint('호의 끝점 지정:', { base: mp });
            const ep = pt(e);
            if (!ep) continue;
            const a3 = arc3p(lp, mp, ep);
            if (!a3) continue;
            const sweep = ccwSweep(ang(a3.c, lp), ang(a3.c, ep));
            const ccw = ccwSweep(ang(a3.c, lp), ang(a3.c, mp)) <= sweep;
            const th = ccw ? sweep : -(TAU - sweep);
            last.bulge = Math.tan(th / 4);
            verts.push({ x: ep.x, y: ep.y, bulge: 0, startWidth: width0, endWidth: width1 });
            commit();
            continue;
          }
          if (k === 'A' && arcMode) {
            const a = await getAngle(ctx, '사이각 지정', null, Math.PI / 2);
            const e = await ctx.getPoint('호의 끝점 지정:', { base: lp });
            const ep = pt(e);
            if (!ep) continue;
            last.bulge = Math.tan(a / 4);
            verts.push({ x: ep.x, y: ep.y, bulge: 0, startWidth: width0, endWidth: width1 });
            commit();
            continue;
          }
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
      const r0 = await ctx.getPoint('원에 대한 중심점 지정 또는 [3점(3P)/2점(2P)]:', {
        keywords: [
          { key: '3P', label: '3점' },
          { key: '2P', label: '2점' },
        ],
      });
      let c: Pt;
      let rad: number;
      if ('keyword' in r0 && r0.keyword === '3P') {
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
      addEntities(app, ctx, [{ ...base(), type: 'CIRCLE', handle: '', center: v3(c), radius: rad } as Entity], 'CIRCLE');
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
      addEntities(app, ctx, [{ ...base(), type: 'ARC', handle: '', center: v3(c), radius: rad, startAngle: norm(a0), endAngle: norm(a1) } as Entity], 'ARC');
    },
  });

  // ------------------------------------------------------------- RECTANG
  app.register({
    name: 'RECTANG',
    aliases: ['REC', 'RECTANGLE'],
    title: '직사각형',
    async run(ctx) {
      const a = pt(await ctx.getPoint('첫 번째 구석점 지정:'));
      if (!a) return;
      const rectPts = (p: Pt) => [a.x, a.y, p.x, a.y, p.x, p.y, a.x, p.y];
      let b: Pt | null = null;
      for (;;) {
        const r = await ctx.getPoint('다른 구석점 지정 또는 [치수(D)]:', { base: a, keywords: [{ key: 'D', label: '치수' }], rubber: (q) => [{ pts: rectPts(q), closed: true }] });
        if ('keyword' in r) {
          const w = await getDistance(ctx, '직사각형의 길이 지정', null, 10);
          const hh = await getDistance(ctx, '직사각형의 폭 지정', null, 10);
          const q = pt(await ctx.getPoint('다른 구석점 지정(방향):', { base: a }));
          const sx = q && q.x < a.x ? -1 : 1;
          const sy = q && q.y < a.y ? -1 : 1;
          b = { x: a.x + sx * w, y: a.y + sy * hh };
          break;
        }
        b = pt(r);
        if (b) break;
        if ('enter' in r) return;
      }
      if (!b || Math.abs(b.x - a.x) < 1e-12 || Math.abs(b.y - a.y) < 1e-12) return;
      const vs: LwVertex[] = [
        { x: a.x, y: a.y },
        { x: b.x, y: a.y },
        { x: b.x, y: b.y },
        { x: a.x, y: b.y },
      ].map((p) => ({ ...p, bulge: 0, startWidth: 0, endWidth: 0 }));
      addEntities(app, ctx, [{ ...base(), type: 'LWPOLYLINE', handle: '', ...packLw(vs), closed: true, plinegen: false, constantWidth: 0, elevation: 0 } as Entity], 'RECTANG');
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
      addEntities(app, ctx, [{ ...base(), type: 'LWPOLYLINE', handle: '', ...packLwPoints(verts), closed: true, plinegen: false, constantWidth: 0, elevation: 0 } as Entity], 'POLYGON');
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
        const s = pt(await ctx.getPoint('시작 각도 지정:', { base: center }));
        const e = pt(await ctx.getPoint('끝 각도 지정:', { base: center }));
        if (!s || !e) return;
        const toParam = (q: Pt) => {
          const a = ang(center, q) - Math.atan2(mj.y, mj.x);
          return Math.atan2(Math.sin(a) / ratio, Math.cos(a));
        };
        p0 = norm(toParam(s));
        p1 = norm(toParam(e));
      }
      addEntities(app, ctx, [{ ...base(), type: 'ELLIPSE', handle: '', center: v3(center), majorAxis: { x: mj.x, y: mj.y, z: 0 }, ratio, startParam: p0, endParam: p1 } as Entity], 'ELLIPSE');
    },
  });

  // ------------------------------------------------------------- SPLINE
  app.register({
    name: 'SPLINE',
    aliases: ['SPL'],
    title: '스플라인',
    async run(ctx) {
      const fit: Vec3[] = [];
      const first = pt(await ctx.getPoint('첫 번째 점 지정:'));
      if (!first) return;
      fit.push(v3(first));
      let closed = false;
      for (;;) {
        const kws = [...(fit.length >= 3 ? [{ key: 'C', label: '닫기' }] : []), { key: 'U', label: '명령 취소' }];
        const r = await ctx.getPoint(fit.length >= 3 ? '다음 점 입력 또는 [닫기(C)/명령 취소(U)]:' : '다음 점 입력 또는 [명령 취소(U)]:', {
          base: { x: fit[fit.length - 1]!.x, y: fit[fit.length - 1]!.y },
          keywords: kws,
          rubber: (q) => {
            const pts = [...fit, v3(q)];
            if (pts.length < 2) return [];
            const s = interpolateFitPoints(pts);
            const xyz = nurbsPoints(s.degree, s.knots, s.ctrl, undefined, 0.001 * dist(first, q) + 1e-9);
            const xy: number[] = [];
            for (let i = 0; i < xyz.length; i += 3) xy.push(xyz[i]!, xyz[i + 1]!);
            return [{ pts: xy }];
          },
        });
        if ('enter' in r) break;
        if ('keyword' in r) {
          if (r.keyword === 'U' && fit.length > 1) fit.pop();
          if (r.keyword === 'C') {
            closed = true;
            break;
          }
          continue;
        }
        const p = pt(r);
        if (p) fit.push(v3(p));
      }
      if (fit.length < 2) return;
      const pts = closed ? [...fit, fit[0]!] : fit;
      const s = interpolateFitPoints(pts);
      addEntities(
        app,
        ctx,
        [
          {
            ...base(),
            type: 'SPLINE',
            handle: '',
            flags: (closed ? 1 : 0) | 8,
            degree: s.degree,
            knots: s.knots,
            controlPoints: s.ctrl,
            fitPoints: fit,
            knotTolerance: 1e-10,
            controlTolerance: 1e-10,
            fitTolerance: 1e-10,
          } as Entity,
        ],
        'SPLINE',
      );
    },
  });

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
        addEntities(app, ctx, [{ ...base(), type: 'POINT', handle: '', position: v3(p), angle: 0 } as Entity], 'POINT');
      }
    },
  });

  // ------------------------------------------------------------- XLINE·RAY
  app.register({
    name: 'XLINE',
    aliases: ['XL'],
    title: '구성선',
    async run(ctx) {
      const r0 = await ctx.getPoint('점 지정 또는 [수평(H)/수직(V)/각도(A)]:', {
        keywords: [
          { key: 'H', label: '수평' },
          { key: 'V', label: '수직' },
          { key: 'A', label: '각도' },
        ],
      });
      let fixed: number | null = null;
      let basePt: Pt | null = null;
      if ('keyword' in r0) {
        if (r0.keyword === 'H') fixed = 0;
        else if (r0.keyword === 'V') fixed = Math.PI / 2;
        else fixed = await getAngle(ctx, '구성선 각도 입력', null, 0);
      } else basePt = pt(r0);
      for (;;) {
        const r = await ctx.getPoint('통과점을 지정:', { base: basePt });
        const p = pt(r);
        if (!p) return;
        let b = basePt ?? p;
        let dir: number;
        if (fixed !== null) {
          b = p;
          dir = fixed;
        } else dir = ang(b, p);
        addEntities(app, ctx, [{ ...base(), type: 'XLINE', handle: '', base: v3(b), direction: { x: Math.cos(dir), y: Math.sin(dir), z: 0 } } as Entity], 'XLINE');
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
        addEntities(app, ctx, [{ ...base(), type: 'RAY', handle: '', base: v3(b), direction: { x: Math.cos(a), y: Math.sin(a), z: 0 } } as Entity], 'RAY');
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
        addEntities(app, ctx, [{ ...base(), type: 'LWPOLYLINE', handle: '', ...packLw(vs), closed: true, plinegen: false, constantWidth: w, elevation: 0 } as Entity], 'DONUT');
      }
    },
  });

  // ------------------------------------------------------------- TEXT
  app.register({
    name: 'TEXT',
    aliases: ['DT', 'DTEXT'],
    title: '단일 행 문자',
    async run(ctx) {
      const d = app.active!.doc;
      const styleName = String(d.header.get('$TEXTSTYLE') ?? 'Standard');
      const style = d.textStyles.get(tableKey(styleName));
      const defH = Number(d.header.get('$TEXTSIZE') ?? 2.5) || 2.5;
      // 주석 스타일이면 높이는 용지 문자 높이(AutoCAD와 같다)
      const anno = textStyleAnnotative(d, styleName);
      ctx.print(`현재 문자 스타일: "${style?.name ?? styleName}"  문자 높이: ${fmt(ctx, style?.height || defH)}  주석: ${anno ? '예' : '아니오'}`);
      const p0 = pt(await ctx.getPoint('문자의 시작점 지정:'));
      if (!p0) return;
      let height = style?.height || 0;
      if (!height) height = await getDistance(ctx, anno ? '용지 문자 높이 지정' : '높이 지정', p0, defH);
      d.header.set('$TEXTSIZE', height);
      const rot = await getAngle(ctx, '문자의 회전 각도 지정', p0, 0);
      let at = p0;
      app.cmd.acceptSpaces = true;
      try {
        for (;;) {
          const r = await ctx.getPoint('문자 입력(빈 줄에서 Enter로 끝):', { allowText: true });
          if ('enter' in r || !('text' in r)) break;
          addEntities(
            app,
            ctx,
            [
              {
                ...base(),
                type: 'TEXT',
                handle: '',
                insert: v3(at),
                height,
                text: r.text,
                rotation: rot,
                widthFactor: style?.widthFactor || 1,
                oblique: style?.oblique || 0,
                style: style?.name ?? styleName,
                generation: 0,
                halign: 0,
                valign: 0,
              } as Entity,
            ],
            'TEXT',
          );
          // 다음 줄
          const step = height * 1.667;
          at = { x: at.x + Math.sin(rot) * step, y: at.y - Math.cos(rot) * step };
        }
      } finally {
        app.cmd.acceptSpaces = false;
      }
    },
  });

  // ------------------------------------------------------------- MTEXT
  app.register({
    name: 'MTEXT',
    aliases: ['MT', 'T'],
    title: '여러 줄 문자',
    async run(ctx) {
      const d = app.active!.doc;
      const styleName = String(d.header.get('$TEXTSTYLE') ?? 'Standard');
      const defH = Number(d.header.get('$TEXTSIZE') ?? 2.5) || 2.5;
      const a = pt(await ctx.getPoint('첫 번째 구석 지정:'));
      if (!a) return;
      const b = pt(await ctx.getPoint('반대 구석 지정:', { base: a, rubber: (q) => [{ pts: [a.x, a.y, q.x, a.y, q.x, q.y, a.x, q.y], closed: true, dashed: true }] }));
      if (!b) return;
      const text = await textDialog('여러 줄 문자', '', defH);
      if (!text || !text.text.trim()) return;
      const left = Math.min(a.x, b.x);
      const top = Math.max(a.y, b.y);
      addEntities(
        app,
        ctx,
        [
          {
            ...base(),
            type: 'MTEXT',
            handle: '',
            insert: { x: left, y: top, z: 0 },
            height: text.height,
            width: Math.abs(b.x - a.x),
            attachment: 1,
            drawingDirection: 1,
            text: text.text.replace(/\r?\n/g, '\\P'),
            style: styleName,
            rotation: 0,
            lineSpacingStyle: 1,
            lineSpacingFactor: 1,
            backgroundFlags: 0,
            backgroundScale: 1.5,
          } as Entity,
        ],
        'MTEXT',
      );
    },
  });

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
    aliases: ['UNDO'],
    title: '명령 취소',
    run(ctx) {
      const tx = app.active!.session.undo();
      ctx.print(tx ? `${tx.label} 명령을 취소했습니다.` : '되돌릴 것이 없습니다.');
    },
  });
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

/** 여러 줄 문자 입력 대화상자 */
export function textDialog(title: string, initial: string, height: number): Promise<{ text: string; height: number } | null> {
  return new Promise((resolve) => {
    const ta = h('textarea', { style: 'width:100%;min-height:140px;background:var(--bg-input);color:var(--text);border:1px solid var(--border-soft);border-radius:4px;padding:8px;font:13px var(--font)' });
    (ta as HTMLTextAreaElement).value = initial;
    const hi = h('input', { type: 'number', step: 'any', min: '0', value: String(height), style: 'width:120px' });
    let done = false;
    const body = h('div', {}, h('div', { class: 'form-row' }, h('span', {}, '문자 높이'), hi), ta, h('div', { style: 'margin-top:6px;color:var(--text-dim)' }, '줄바꿈은 새 문단이 됩니다. 확인 = Ctrl+Enter'));
    const back = dialog(title, body, [
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
          resolve({ text: (ta as HTMLTextAreaElement).value, height: parseFloat((hi as HTMLInputElement).value) || height });
        },
      },
    ]);
    setTimeout(() => (ta as HTMLTextAreaElement).focus());
    ta.addEventListener('keydown', (ev) => {
      const k = ev as KeyboardEvent;
      k.stopPropagation();
      if (k.key === 'Enter' && (k.ctrlKey || k.metaKey)) (back.querySelector('footer .btn.primary') as HTMLButtonElement)?.click();
    });
    new MutationObserver(() => {
      if (!document.body.contains(back) && !done) {
        done = true;
        resolve(null);
      }
    }).observe(document.body, { childList: true });
  });
}

export { CancelError };
export type { Vec2 };
