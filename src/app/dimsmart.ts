/**
 * 스마트 치수 DIM: `객체 선택 또는 첫 번째 치수보조선 원점 지정 또는 [각도(A)/기준선(B)/계속(C)/세로좌표(O)/정렬(G)/분산(D)/도면층(L)/명령 취소(U)]:`
 * - 마우스를 올린 객체에 맞는 치수를 미리 보여 준다: 선·폴리선 직선 세그먼트 → 선형(수평·수직) 또는 정렬, 원 → 지름, 호 → 반지름.
 *   객체 스냅 표지가 보일 때(근처점 제외) 누르면 점, 객체 위를 누르면 그 객체를 고른다.
 * - 선을 고른 뒤 다른 선을 누르면 두 선의 각도 치수, 원·호는 반지름·지름·꺾기·호 길이·각도로 바꿀 수 있다.
 * - 치수를 하나 만들면 첫 프롬프트로 돌아가 Enter(또는 Esc)까지 이어진다. 명령 취소(U)는 이 명령에서 만든 마지막 치수를 지운다.
 * - 기준선·계속은 선형·정렬·세로좌표 치수, 정렬(G)·분산(D)은 나란한 선형·정렬, 같은 꼭짓점의 각도, 같은 데이텀 방향의 세로좌표 치수.
 * - 도면층(L)은 DIMLAYER(이 명령이 만드는 새 치수의 도면층 — 이 브라우저에 저장, 처음 값 `.` = 현재 도면층).
 * 치수 객체·블록·연관은 DIMLINEAR 등과 같은 생성 함수(src/edit/dim)와 addDimension(dimcmds)을 쓴다.
 * 프롬프트는 AutoCAD 2026 한국어판을 따른다. 종류 추정·정렬·분산 계산은 src/edit/dim/smart.
 */
import type { DimensionEntity, Entity, Vec3 } from '../core/model';
import { tableKey } from '../core/model';
import { formatLength } from '../core/units';
import {
  createAlignedDimension,
  createAngular2LineDimension,
  createAngularDimension,
  createArcLengthDimension,
  createDiameterDimension,
  createLinearDimension,
  createOrdinateDimension,
  createRadialDimension,
  dimVars,
  generateDimensionGeometry,
} from '../edit/dim';
import { OSNAP, type PointRef, circlePointRef } from '../edit/dim/assoc';
import { createJoggedDimension } from '../edit/annot/create';
import { extDir, linearFeetW, spaceDimensions } from '../edit/annot/dimedit';
import { type SmartTarget, alignDimensions, distributeEqual, hoverDimLinePoint, linearChoice, parallelLines, pointOnCircle, smartTarget } from '../edit/dim/smart';
import type { App, Keyword, PointResult } from './app';
import { askAngle } from './annot2-common';
import { addDimension } from './dimcmds';
import { inheritedRef, objectRef, pointRef } from './dimassoc';
import { textDialog } from './draw';
import { commitResults } from './modify';
import { unlockedOnly } from './layers';
import { askText, loadPref, savePref } from './util2-ui';
import type { OverlayGeom, Pt } from './view';

const v3 = (p: Pt, z = 0): Vec3 => ({ x: p.x, y: p.y, z });
const DIMLAYER_PREF = 'opencad.DIMLAYER';

export const DIM_MAIN_PROMPT = '객체 선택 또는 첫 번째 치수보조선 원점 지정 또는 [각도(A)/기준선(B)/계속(C)/세로좌표(O)/정렬(G)/분산(D)/도면층(L)/명령 취소(U)]:';
const MAIN_KWS: Keyword[] = [
  { key: 'A', label: '각도' },
  { key: 'B', label: '기준선' },
  { key: 'C', label: '계속' },
  { key: 'O', label: '세로좌표' },
  { key: 'G', label: '정렬' },
  { key: 'D', label: '분산' },
  { key: 'L', label: '도면층' },
  { key: 'U', label: '명령 취소' },
];
const KW_M: Keyword = { key: 'M', label: '여러 줄 문자' };
const KW_T: Keyword = { key: 'T', label: '문자' };
const KW_N: Keyword = { key: 'N', label: '문자 각도' };
const KW_U: Keyword = { key: 'U', label: '명령 취소' };
const TEXT_KWS = [KW_M, KW_T, KW_N, KW_U];

/** 프롬프트 꼬리 `[여러 줄 문자(M)/…]:` */
const tail = (kws: Keyword[]) => `[${kws.map((k) => `${k.label}(${k.key})`).join('/')}]:`;

/** 치수 문자 옵션 값 */
interface TextOpts {
  text?: string;
  rot?: number;
}

/** DIMLAYER(이 브라우저): '.'이면 현재 도면층 */
export function dimLayerSetting(): string {
  const v = loadPref<string>(DIMLAYER_PREF, '.');
  return typeof v === 'string' && v ? v : '.';
}

type RadialMode = 'radius' | 'diameter' | 'jogged' | 'arclen' | 'angular';
const RADIAL_KW: Record<RadialMode, Keyword> = {
  radius: { key: 'R', label: '반지름' },
  diameter: { key: 'D', label: '지름' },
  jogged: { key: 'J', label: '꺾기' },
  arclen: { key: 'L', label: '호 길이' },
  angular: { key: 'A', label: '각도' },
};
const RADIAL_HEAD: Record<RadialMode, string> = {
  radius: '반지름 치수 위치 지정',
  diameter: '지름 치수 위치 지정',
  jogged: '치수선 위치 지정',
  arclen: '호 길이 치수 위치 지정',
  angular: '각도 치수 위치 지정',
};

export function registerDimSmartCommand(app: App): void {
  app.register({
    name: 'DIM',
    title: '치수',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      /** 이 명령에서 만든 단계(작업 수) — 명령 취소(U) */
      const steps: number[] = [];
      const dimStyle = String(doc.header.get('$DIMSTYLE') ?? 'Standard') || 'Standard';
      const dv = dimVars(doc, { dimStyle });
      const tol = () => app.view.overlay.pickbox * app.view.pixelSize();
      const layerOpt = (): string | undefined => {
        const l = dimLayerSetting();
        if (l === '.') return undefined;
        return doc.layers.get(tableKey(l))?.name;
      };
      const opts = (o: TextOpts) => ({ text: o.text, layer: layerOpt() });
      const withRot = (d: DimensionEntity, o: TextOpts): DimensionEntity => {
        if (o.rot) d.textRotation = o.rot;
        return d;
      };
      const geom = (d: DimensionEntity | null): OverlayGeom[] => {
        const pk = app.picker();
        if (!pk || !d) return [];
        try {
          return [pk.geometryOf(generateDimensionGeometry(doc, d).entities)];
        } catch {
          return [];
        }
      };
      const add = (d: DimensionEntity, refs: readonly (PointRef | null)[] = []) => {
        steps.push(addDimension(app, ctx, d, 'DIM', refs));
      };
      const undoLast = (): boolean => {
        const n = steps.pop();
        if (n === undefined) {
          ctx.print('명령 취소할 것이 없습니다.');
          return false;
        }
        st.session.undoLastStep(ctx.group, n);
        return true;
      };

      // ---------------------------------------------------------- 마우스 아래 객체
      /** 마지막 미리보기 자리와 그때 커서 아래 객체(누른 점이 같으면 그 객체를 고른 것) */
      let hover: { p: Pt; handle: string | null } | null = null;
      /** 누른 점이 마지막 미리보기 자리인지(화면 1픽셀 안 — 입력한 좌표는 보통 여기에 들지 않는다) */
      const sameSpot = (a: Pt, b: Pt) => {
        const s = Math.max(app.view.pixelSize(), 1e-12 * Math.max(1, Math.abs(b.x), Math.abs(b.y)));
        return Math.abs(a.x - b.x) <= s && Math.abs(a.y - b.y) <= s;
      };
      const objectAt = (p: Pt): string | null => {
        const snap = app.view.overlay.snap;
        if (snap && snap.kind !== 'nea') return null;
        const pk = app.picker();
        return pk ? pk.pick(p.x, p.y, tol()) : null;
      };
      const clickedHandle = (r: PointResult): string | null => {
        if (!('point' in r) || !hover) return null;
        if (r.snap && r.snap.kind !== 'nea') return null;
        if (!sameSpot(hover.p, r.point)) return null;
        return hover.handle;
      };
      const targetOf = (h: string | null, p: Pt): { e: Entity; t: SmartTarget } | null => {
        if (!h) return null;
        const e = doc.entityIndex.get(h);
        const t = smartTarget(e, p);
        return e && t ? { e, t } : null;
      };

      // ---------------------------------------------------------- 문자 옵션
      const textOption = async (key: string, o: TextOpts): Promise<boolean> => {
        if (key === 'T') {
          const t = await askText(ctx, `치수 문자를 입력 <${o.text ? o.text : '<>'}>:`, o.text ?? '');
          o.text = t === '<>' ? '' : t;
          return true;
        }
        if (key === 'M') {
          const t = await textDialog('치수 문자(<>는 측정값)', o.text || '<>', 0);
          if (t) o.text = t.text.replace(/\r?\n/g, '\\P');
          return true;
        }
        if (key === 'N') {
          const a = await askAngle(ctx, '치수 문자의 각도를 지정:', 0);
          o.rot = a ?? 0;
          return true;
        }
        return false;
      };

      // ---------------------------------------------------------- 선형·정렬
      const makeLinear = (p1: Pt, p2: Pt, q: Pt, o: TextOpts): DimensionEntity => {
        const c = linearChoice(p1, p2, q);
        const d = c.aligned ? createAlignedDimension(doc, v3(p1), v3(p2), v3(q), opts(o)) : createLinearDimension(doc, v3(p1), v3(p2), v3(q), { ...opts(o), rotation: c.rotation });
        return withRot(d, o);
      };

      /** 두 선의 각도 치수: 호 위치 */
      const angularTwoLines = async (e1: Entity, a: Extract<SmartTarget, { kind: 'line' }>, e2: Entity, b: Extract<SmartTarget, { kind: 'line' }>, o: TextOpts): Promise<void> => {
        if (parallelLines(a.a, a.b, b.a, b.b)) {
          ctx.print('선이 평행합니다.', 'err');
          return;
        }
        const make = (p: Pt) => withRot(createAngular2LineDimension(doc, v3(a.a), v3(a.b), v3(b.a), v3(b.b), v3(p), opts(o)), o);
        for (;;) {
          const r = await ctx.getPoint(`각도 치수 위치 지정 또는 ${tail(TEXT_KWS)}`, { keywords: TEXT_KWS, ghost: (p) => geom(make(p)) });
          if ('point' in r) {
            add(make(r.point), [objectRef(app, e1, OSNAP.END, a.a), objectRef(app, e1, OSNAP.END, a.b), objectRef(app, e2, OSNAP.END, b.a), objectRef(app, e2, OSNAP.END, b.b)]);
            return;
          }
          if (!('keyword' in r) || r.keyword === 'U') return;
          await textOption(r.keyword, o);
        }
      };

      /** 선(또는 폴리선 직선 세그먼트)을 고른 뒤 */
      const lineFlow = async (e: Entity, t: Extract<SmartTarget, { kind: 'line' }>): Promise<void> => {
        const o: TextOpts = {};
        let second: { p: Pt; hit: { e: Entity; t: SmartTarget } | null } | null = null;
        const otherLine = (p: Pt) => {
          const h = objectAt(p);
          const hit = targetOf(h, p);
          if (hit && hit.t.kind === 'line' && !(hit.e.handle === e.handle && hit.t.segment === t.segment)) return hit;
          return null;
        };
        for (;;) {
          const r = await ctx.getPoint(`치수선 위치 지정 또는 각도에 대한 두 번째 선 지정 ${tail(TEXT_KWS)}`, {
            keywords: TEXT_KWS,
            ghost: (p) => {
              const hit = otherLine(p);
              second = { p, hit };
              if (hit && hit.t.kind === 'line' && !parallelLines(t.a, t.b, hit.t.a, hit.t.b)) {
                // 두 선의 각도 미리보기(호는 두 선의 교점에서 커서 반대쪽이 아니라 두 선 사이)
                const mid = { x: (t.a.x + t.b.x + hit.t.a.x + hit.t.b.x) / 4, y: (t.a.y + t.b.y + hit.t.a.y + hit.t.b.y) / 4 };
                return geom(createAngular2LineDimension(doc, v3(t.a), v3(t.b), v3(hit.t.a), v3(hit.t.b), v3(mid), opts(o)));
              }
              return geom(makeLinear(t.a, t.b, p, o));
            },
          });
          if ('point' in r) {
            const s = second as { p: Pt; hit: { e: Entity; t: SmartTarget } | null } | null;
            if (s && sameSpot(s.p, r.point) && s.hit && s.hit.t.kind === 'line' && !(r.snap && r.snap.kind !== 'nea')) {
              await angularTwoLines(e, t, s.hit.e, s.hit.t, o);
              return;
            }
            add(makeLinear(t.a, t.b, r.point, o), [objectRef(app, e, OSNAP.END, t.a), objectRef(app, e, OSNAP.END, t.b)]);
            return;
          }
          if (!('keyword' in r) || r.keyword === 'U') return;
          await textOption(r.keyword, o);
        }
      };

      /** 두 점을 지정한 선형·정렬 */
      const pointFlow = async (r1: PointResult & { point: Pt }): Promise<void> => {
        const p1 = r1.point;
        const ref1 = pointRef(app, r1);
        const r2 = await ctx.getPoint('두 번째 치수보조선 원점 지정 또는 [명령 취소(U)]:', { base: p1, keywords: [KW_U] });
        if (!('point' in r2)) return;
        const p2 = r2.point;
        if (Math.hypot(p2.x - p1.x, p2.y - p1.y) < 1e-12) {
          ctx.print('두 점이 같습니다.', 'err');
          return;
        }
        const refs = [ref1, pointRef(app, r2)];
        const o: TextOpts = {};
        for (;;) {
          const r = await ctx.getPoint(`치수선 위치 지정 또는 ${tail(TEXT_KWS)}`, { keywords: TEXT_KWS, ghost: (p) => geom(makeLinear(p1, p2, p, o)) });
          if ('point' in r) {
            add(makeLinear(p1, p2, r.point, o), refs);
            return;
          }
          if (!('keyword' in r) || r.keyword === 'U') return;
          await textOption(r.keyword, o);
        }
      };

      // ---------------------------------------------------------- 원·호
      const radialFlow = async (e: Entity, t: Extract<SmartTarget, { kind: 'circle' | 'arc' }>, pick: Pt): Promise<void> => {
        const o: TextOpts = {};
        const isArc = t.kind === 'arc';
        const realArc = e.type === 'CIRCLE' || e.type === 'ARC';
        let mode: RadialMode = isArc ? 'radius' : 'diameter';
        const modes: RadialMode[] = isArc ? ['radius', 'diameter', 'jogged', 'arclen', 'angular'] : ['radius', 'diameter', 'jogged', 'angular'];
        const center = v3(t.c);
        // 원의 각도: 첫 끝점은 고른 점, 둘째 끝점은 묻는다
        let circleSecond: Pt | null = null;
        const arcEnds = () =>
          t.kind === 'arc'
            ? { a: { x: t.c.x + t.r * Math.cos(t.a0), y: t.c.y + t.r * Math.sin(t.a0) }, b: { x: t.c.x + t.r * Math.cos(t.a1), y: t.c.y + t.r * Math.sin(t.a1) } }
            : { a: pointOnCircle(t.c, t.r, pick), b: circleSecond ?? pick };
        const make = (p: Pt): DimensionEntity | null => {
          if (mode === 'radius' || mode === 'diameter') {
            const on = v3(pointOnCircle(t.c, t.r, p));
            const d = mode === 'radius' ? createRadialDimension(doc, center, t.r, on, opts(o)) : createDiameterDimension(doc, center, t.r, on, opts(o));
            d.textMid = v3(p);
            d.dimType |= 128;
            return withRot(d, o);
          }
          if (mode === 'arclen' && t.kind === 'arc') return withRot(createArcLengthDimension(doc, center, t.r, t.a0, t.a1, v3(p), opts(o)), o);
          if (mode === 'angular') {
            const { a, b } = arcEnds();
            return withRot(createAngularDimension(doc, center, v3(a), v3(b), v3(p), opts(o)), o);
          }
          return null;
        };
        const refsFor = (d: DimensionEntity): (PointRef | null)[] => {
          if (!realArc) return [];
          if (mode === 'radius') return [circlePointRef(e, d.defPoint4), objectRef(app, e, OSNAP.CEN, d.defPoint)];
          if (mode === 'diameter') return [circlePointRef(e, d.defPoint4), circlePointRef(e, d.defPoint)];
          if (mode === 'arclen') return [objectRef(app, e, OSNAP.END, d.defPoint2), objectRef(app, e, OSNAP.END, d.defPoint3), objectRef(app, e, OSNAP.CEN, d.defPoint4)];
          if (mode === 'angular') {
            if (e.type === 'ARC') return [objectRef(app, e, OSNAP.END, d.defPoint2), objectRef(app, e, OSNAP.END, d.defPoint3), objectRef(app, e, OSNAP.CEN, center)];
            return [circlePointRef(e, d.defPoint2), null, objectRef(app, e, OSNAP.CEN, center)];
          }
          return [];
        };
        for (;;) {
          const kws = [...modes.filter((m) => m !== mode).map((m) => RADIAL_KW[m]), KW_M, KW_T, KW_N, KW_U];
          const r = await ctx.getPoint(`${RADIAL_HEAD[mode]} 또는 ${tail(kws)}`, { keywords: kws, ghost: (p) => geom(make(p)) });
          if ('point' in r) {
            const d = make(r.point);
            if (d) add(d, refsFor(d));
            return;
          }
          if (!('keyword' in r) || r.keyword === 'U') return;
          const k = r.keyword;
          if (await textOption(k, o)) continue;
          const next = modes.find((m) => RADIAL_KW[m].key === k);
          if (!next) continue;
          if (next === 'jogged') {
            await joggedFlow(e, t, o);
            return;
          }
          if (next === 'angular' && t.kind === 'circle') {
            const b = await ctx.getPoint('각도의 두 번째 끝점 지정:', { base: t.c });
            if (!('point' in b)) continue;
            circleSecond = b.point;
          }
          mode = next;
        }
      };

      /** 꺾기 반지름(DIMJOGGED와 같은 흐름) */
      const joggedFlow = async (e: Entity, t: Extract<SmartTarget, { kind: 'circle' | 'arc' }>, o: TextOpts): Promise<void> => {
        const oc = await ctx.getPoint('중심 위치 재지정 지정:');
        if (!('point' in oc)) return;
        const center = v3(t.c);
        const ovr = v3(oc.point);
        const build = (tp: Pt, jog: Pt | null): DimensionEntity => {
          const a = Math.atan2(tp.y - t.c.y, tp.x - t.c.x);
          const chord = { x: t.c.x + t.r * Math.cos(a), y: t.c.y + t.r * Math.sin(a) };
          const s = (ovr.x - chord.x) * Math.cos(a) + (ovr.y - chord.y) * Math.sin(a);
          const j = jog ?? { x: chord.x + (Math.cos(a) * s) / 2, y: chord.y + (Math.sin(a) * s) / 2 };
          return withRot(createJoggedDimension(doc, center, t.r, v3(tp), ovr, v3(j), { text: o.text, layer: layerOpt() }), o);
        };
        let tp: Pt | null = null;
        const kws = [KW_M, KW_T, KW_N];
        while (!tp) {
          const p = await ctx.getPoint(`치수선 위치 지정 또는 ${tail(kws)}`, { keywords: kws, ghost: (q) => geom(build(q, null)) });
          if ('point' in p) tp = p.point;
          else if (!('keyword' in p)) return;
          else await textOption(p.keyword, o);
        }
        const tp0 = tp;
        const j = await ctx.getPoint('꺾기 위치 지정:', { ghost: (q) => geom(build(tp0, q)) });
        if (!('point' in j)) return;
        const d = build(tp0, j.point);
        const realArc = e.type === 'CIRCLE' || e.type === 'ARC';
        add(d, realArc ? [circlePointRef(e, d.defPoint4), objectRef(app, e, OSNAP.CEN, d.defPoint), null, null] : []);
      };

      // ---------------------------------------------------------- 각도(A)
      const angularOption = async (): Promise<void> => {
        const o: TextOpts = {};
        let make: ((p: Pt) => DimensionEntity) | null = null;
        let refs: (PointRef | null)[] = [];
        const r = await ctx.getEntity('호, 원, 선을 선택하거나 <정점 지정>:');
        if ('enter' in r) {
          const v = await ctx.getPoint('각도 정점 지정:');
          if (!('point' in v)) return;
          const rv = pointRef(app, v);
          const a = await ctx.getPoint('첫 번째 각도 끝점 지정:', { base: v.point });
          if (!('point' in a)) return;
          const ra = pointRef(app, a);
          const b = await ctx.getPoint('두 번째 각도 끝점 지정:', { base: v.point });
          if (!('point' in b)) return;
          refs = [ra, pointRef(app, b), rv];
          make = (p) => withRot(createAngularDimension(doc, v3(v.point), v3(a.point), v3(b.point), v3(p), opts(o)), o);
        } else if ('handle' in r) {
          const e = doc.entityIndex.get(r.handle);
          const t = smartTarget(e, r.point);
          app.clearSelection();
          if (e && t?.kind === 'line') {
            const r2 = await ctx.getEntity('두 번째 선 선택:');
            if (!('handle' in r2)) return;
            const e2 = doc.entityIndex.get(r2.handle);
            const t2 = smartTarget(e2, r2.point);
            app.clearSelection();
            if (!e2 || t2?.kind !== 'line') {
              ctx.print('선을 선택하십시오.', 'err');
              return;
            }
            await angularTwoLines(e, t, e2, t2, o);
            return;
          }
          if (e && t?.kind === 'arc') {
            const a = { x: t.c.x + t.r * Math.cos(t.a0), y: t.c.y + t.r * Math.sin(t.a0) };
            const b = { x: t.c.x + t.r * Math.cos(t.a1), y: t.c.y + t.r * Math.sin(t.a1) };
            if (e.type === 'ARC') refs = [objectRef(app, e, OSNAP.END, a), objectRef(app, e, OSNAP.END, b), objectRef(app, e, OSNAP.CEN, t.c)];
            make = (p) => withRot(createAngularDimension(doc, v3(t.c), v3(a), v3(b), v3(p), opts(o)), o);
          } else if (e && t?.kind === 'circle') {
            const first = pointOnCircle(t.c, t.r, r.point);
            const b = await ctx.getPoint('각도의 두 번째 끝점 지정:', { base: t.c });
            if (!('point' in b)) return;
            refs = [circlePointRef(e, first), pointRef(app, b), objectRef(app, e, OSNAP.CEN, t.c)];
            make = (p) => withRot(createAngularDimension(doc, v3(t.c), v3(first), v3(b.point), v3(p), opts(o)), o);
          } else {
            ctx.print('호, 원, 선을 선택하십시오.', 'err');
            return;
          }
        } else return;
        for (;;) {
          const p = await ctx.getPoint(`각도 치수 위치 지정 또는 ${tail(TEXT_KWS)}`, { keywords: TEXT_KWS, ghost: (q) => geom(make!(q)) });
          if ('point' in p) {
            add(make(p.point), refs);
            return;
          }
          if (!('keyword' in p) || p.keyword === 'U') return;
          await textOption(p.keyword, o);
        }
      };

      // ---------------------------------------------------------- 기준선(B)·계속(C)
      const chainable = (e: Entity | undefined): e is DimensionEntity => e?.type === 'DIMENSION' && !e.subtype && [0, 1, 6].includes(e.dimType & 7);
      const lastDim = (): DimensionEntity | null => {
        for (let i = app.lastCreated.length - 1; i >= 0; i--) {
          const e = doc.entityIndex.get(app.lastCreated[i]!);
          if (chainable(e)) return e;
        }
        return null;
      };
      /** 고른 점에 가까운 치수보조선의 원점(세로좌표는 피쳐 위치) */
      const nearestOrigin = (d: DimensionEntity, p: Pt): 'defPoint2' | 'defPoint3' => {
        if ((d.dimType & 7) === 6) return 'defPoint2';
        const { d1, d2 } = linearFeetW(d);
        const segDist = (a: Pt, b: Pt) => {
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const L = dx * dx + dy * dy || 1;
          const s = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L));
          return Math.hypot(a.x + dx * s - p.x, a.y + dy * s - p.y);
        };
        return segDist(d.defPoint2, d1) <= segDist(d.defPoint3, d2) ? 'defPoint2' : 'defPoint3';
      };
      /** 기준선 간격띄우기(처음 값 DIMDLI × DIMSCALE) */
      let baseOffset = dv.dli;
      const chainFlow = async (baseline: boolean): Promise<void> => {
        const kwO: Keyword = { key: 'O', label: '간격띄우기' };
        const askOffset = async () => {
          const r = await ctx.getPoint(`간격띄우기 거리 지정 <${formatLength(baseOffset, st.units)}>:`, { preferNumber: true });
          if ('text' in r && Number.isFinite(Number(r.text)) && Number(r.text) >= 0) baseOffset = Number(r.text);
          else if ('point' in r) {
            const r2 = await ctx.getPoint('두 번째 점 지정:', { base: r.point });
            if ('point' in r2) baseOffset = Math.hypot(r2.point.x - r.point.x, r2.point.y - r.point.y);
          }
        };
        /** 기준 치수와 원점 고르기. null이면 DIM 첫 프롬프트로 */
        const pickBase = async (allowLast: boolean): Promise<{ d: DimensionEntity; key: 'defPoint2' | 'defPoint3' } | null> => {
          for (;;) {
            const r = baseline
              ? await ctx.getEntity('기준선으로 첫 번째 치수보조선 원점 지정 또는 [간격띄우기(O)]:', [kwO])
              : await ctx.getEntity('계속할 첫 번째 치수보조선 원점 지정:');
            if ('keyword' in r) {
              await askOffset();
              continue;
            }
            if ('enter' in r) {
              const d = allowLast ? lastDim() : null;
              if (!d) return null;
              return { d, key: baseline || (d.dimType & 7) === 6 ? 'defPoint2' : 'defPoint3' };
            }
            const e = doc.entityIndex.get(r.handle);
            app.clearSelection();
            if (!chainable(e)) {
              ctx.print('선형·정렬·세로좌표 치수를 선택하십시오.', 'err');
              continue;
            }
            return { d: e, key: nearestOrigin(e, r.point) };
          }
        };
        let picked = await pickBase(true);
        if (!picked) return;
        let base = picked.d;
        let prev = base;
        let origin = base[picked.key];
        let originKey: 'defPoint2' | 'defPoint3' = picked.key;
        /** 이 기준에서 만든 치수(명령 취소용) */
        const made: DimensionEntity[] = [];
        const kws: Keyword[] = baseline ? [{ key: 'S', label: '선택' }, kwO, KW_U] : [{ key: 'S', label: '선택' }, KW_U];
        for (;;) {
          const make = (p: Pt): DimensionEntity => {
            const t = prev.dimType & 7;
            if (t === 6) {
              const xAxis = (prev.dimType & 64) !== 0;
              const end = xAxis ? { x: p.x, y: prev.defPoint3.y, z: 0 } : { x: prev.defPoint3.x, y: p.y, z: 0 };
              return createOrdinateDimension(doc, v3(p), end, { xAxis, style: prev.dimStyle, layer: layerOpt() });
            }
            const rot = t === 1 ? Math.atan2(prev.defPoint3.y - prev.defPoint2.y, prev.defPoint3.x - prev.defPoint2.x) : prev.rotation;
            let line = prev.defPoint;
            if (baseline) {
              const step = baseOffset;
              const e = extDir(prev);
              const n = { x: -Math.sin(rot), y: Math.cos(rot) };
              const side = Math.sign((prev.defPoint.x - origin.x) * n.x + (prev.defPoint.y - origin.y) * n.y) || 1;
              const k = (side * step) / ((e.x * n.x + e.y * n.y) || 1);
              line = { x: prev.defPoint.x + e.x * k, y: prev.defPoint.y + e.y * k, z: 0 };
            }
            return createLinearDimension(doc, origin, v3(p), line, { rotation: rot, style: prev.dimStyle, layer: layerOpt() });
          };
          const r = await ctx.getPoint(`두 번째 치수보조선 원점 지정 또는 ${tail(kws).replace(/:$/, '')} <선택>:`, { keywords: kws, ghost: (p) => geom(make(p)) });
          if ('point' in r) {
            const d = make(r.point);
            const refs: (PointRef | null)[] = (prev.dimType & 7) === 6 ? [null, pointRef(app, r)] : [inheritedRef(app, baseline ? base : prev, baseline ? originKey : made.length ? 'defPoint3' : originKey), pointRef(app, r)];
            add(d, refs);
            made.push(d);
            prev = d;
            if (!baseline) {
              origin = d.defPoint3;
              originKey = 'defPoint3';
            }
            continue;
          }
          if ('keyword' in r && r.keyword === 'O') {
            await askOffset();
            continue;
          }
          if ('keyword' in r && r.keyword === 'U') {
            if (!made.length) ctx.print('명령 취소할 것이 없습니다.');
            else if (undoLast()) {
              made.pop();
              // 되돌린 치수 앞의 치수로(없으면 기준)
              const back = made[made.length - 1];
              prev = back ?? base;
              if (!baseline) {
                origin = back ? back.defPoint3 : base[picked.key];
                originKey = back ? 'defPoint3' : picked.key;
              }
            }
            continue;
          }
          if ('enter' in r && made.length) return;
          // 선택(S) 또는 아직 만든 것이 없을 때 Enter
          picked = await pickBase(false);
          if (!picked) return;
          base = picked.d;
          prev = base;
          origin = base[picked.key];
          originKey = picked.key;
          made.length = 0;
        }
      };

      // ---------------------------------------------------------- 세로좌표(O)
      const ordinateFlow = async (): Promise<void> => {
        let made = 0;
        for (;;) {
          const f = await ctx.getPoint('피쳐 위치 지정 또는 [명령 취소(U)]:', { keywords: [KW_U] });
          if ('keyword' in f) {
            if (made > 0 && undoLast()) made--;
            else ctx.print('명령 취소할 것이 없습니다.');
            continue;
          }
          if (!('point' in f)) return;
          const fr = pointRef(app, f);
          const o: TextOpts = {};
          let xAxis: boolean | undefined;
          const kws: Keyword[] = [{ key: 'X', label: 'X데이텀' }, { key: 'Y', label: 'Y데이텀' }, KW_M, KW_T, KW_N, KW_U];
          for (;;) {
            const make = (p: Pt) => withRot(createOrdinateDimension(doc, v3(f.point), v3(p), { ...opts(o), xAxis }), o);
            const p = await ctx.getPoint(`지시선 끝점 지정 또는 ${tail(kws)}`, { base: f.point, keywords: kws, ghost: (q) => geom(make(q)) });
            if ('point' in p) {
              add(make(p.point), [null, fr]);
              made++;
              break;
            }
            if (!('keyword' in p) || p.keyword === 'U') break;
            if (p.keyword === 'X') xAxis = true;
            else if (p.keyword === 'Y') xAxis = false;
            else await textOption(p.keyword, o);
          }
        }
      };

      // ---------------------------------------------------------- 정렬(G)·분산(D)
      const dimsIn = (hs: string[]): DimensionEntity[] =>
        unlockedOnly(app, hs)
          .map((h) => doc.entityIndex.get(h))
          .filter((e): e is DimensionEntity => e?.type === 'DIMENSION');
      const pickDim = async (prompt: string, kws: Keyword[] = []): Promise<DimensionEntity | { keyword: string } | null> => {
        for (;;) {
          const r = await ctx.getEntity(prompt, kws);
          if ('keyword' in r) return { keyword: r.keyword };
          if (!('handle' in r)) return null;
          const e = doc.entityIndex.get(r.handle);
          app.clearSelection();
          if (e?.type === 'DIMENSION') return e;
          ctx.print('치수를 선택하십시오.', 'err');
        }
      };
      const commitChanged = (list: DimensionEntity[], label: string) => {
        if (!list.length) return;
        steps.push(commitResults(app, ctx, [{ replace: list }], label, { quiet: true }).ops);
      };
      const alignOption = async (): Promise<void> => {
        const base = await pickDim('기준 치수 선택:');
        if (!base || 'keyword' in base) return;
        const others = dimsIn(await ctx.getSelection('정렬할 치수 선택:', { noPickfirst: true }));
        app.clearSelection();
        const { changed, skipped } = alignDimensions(base, others);
        if (skipped.length) ctx.print(`기준 치수와 나란하지 않거나 중심·데이텀 방향이 다른 치수 ${skipped.length}개는 건너뛰었습니다.`);
        commitChanged(changed, 'DIM');
      };
      let distOffset = dv.dli;
      const distributeOption = async (): Promise<void> => {
        const k = await ctx.getPoint('분산 유형 입력 [동일(E)/간격띄우기(O)] <동일>:', {
          keywords: [
            { key: 'E', label: '동일' },
            { key: 'O', label: '간격띄우기' },
          ],
        });
        if (!('keyword' in k) && !('enter' in k)) return;
        if (!('keyword' in k) || k.keyword === 'E') {
          const dims = dimsIn(await ctx.getSelection('분산할 치수 선택:', { noPickfirst: true }));
          app.clearSelection();
          const r = distributeEqual(dims);
          if (r.count < 3) {
            ctx.print('나란한 선형 치수 또는 같은 꼭짓점의 각도 치수를 3개 이상 선택하십시오.', 'err');
            return;
          }
          if (r.skipped.length) ctx.print(`나란하지 않은 치수 ${r.skipped.length}개는 건너뛰었습니다.`);
          commitChanged(r.changed, 'DIM');
          return;
        }
        const kwO: Keyword = { key: 'O', label: '간격띄우기' };
        const askDist = async () => {
          const r = await ctx.getPoint(`간격띄우기 거리 지정 <${formatLength(distOffset, st.units)}>:`, { preferNumber: true });
          if ('text' in r && Number.isFinite(Number(r.text)) && Number(r.text) >= 0) distOffset = Number(r.text);
        };
        let base: DimensionEntity | null = null;
        while (!base) {
          const r = await pickDim('기준 치수 선택 또는 [간격띄우기(O)]:', [kwO]);
          if (!r) return;
          if ('keyword' in r) await askDist();
          else base = r;
        }
        let others: DimensionEntity[] = [];
        for (;;) {
          try {
            others = dimsIn(await ctx.getSelection('분산할 치수 선택 또는 [간격띄우기(O)]:', { keywords: [kwO], noPickfirst: true }));
            break;
          } catch (e) {
            if ((e as { keyword?: string }).keyword === 'O') {
              await askDist();
              continue;
            }
            throw e;
          }
        }
        app.clearSelection();
        const { changed, skipped } = spaceDimensions(base, others, distOffset);
        if (skipped.length) ctx.print(`기준 치수와 나란하지 않거나 꼭짓점이 다른 치수 ${skipped.length}개는 건너뛰었습니다.`);
        commitChanged(changed, 'DIM');
      };

      // ---------------------------------------------------------- 도면층(L)
      const layerOption = async (): Promise<void> => {
        const cur = dimLayerSetting();
        const r = await ctx.getPoint(`도면층 이름 입력 또는 도면층 이름을 지정할 객체 선택 또는 [현재 사용(.)] <"${cur === '.' ? '현재 사용' : cur}">:`, {
          keywords: [{ key: '.', label: '현재 사용' }],
          allowText: true,
        });
        let next: string | null = null;
        if ('keyword' in r) next = '.';
        else if ('text' in r) next = r.text.trim().replace(/^"(.*)"$/, '$1');
        else if ('point' in r) {
          const pk = app.picker();
          const h = pk?.pick(r.point.x, r.point.y, tol());
          const e = h ? doc.entityIndex.get(h) : undefined;
          if (!e) {
            ctx.print('객체를 찾을 수 없습니다.', 'err');
            return;
          }
          next = doc.layers.get(tableKey(e.layer))?.name ?? e.layer;
        }
        if (!next) return;
        if (next !== '.' && !doc.layers.has(tableKey(next))) ctx.print(`도면층 "${next}"이(가) 없어 새 치수는 현재 도면층에 만듭니다.`);
        savePref(DIMLAYER_PREF, next);
        ctx.print(`새 치수의 도면층 = ${next === '.' ? '현재 사용' : `"${next}"`}`);
      };

      // ---------------------------------------------------------- 첫 프롬프트
      for (;;) {
        const r = await ctx.getPoint(DIM_MAIN_PROMPT, {
          keywords: MAIN_KWS,
          ghost: (p) => {
            const h = objectAt(p);
            hover = { p, handle: h };
            const hit = targetOf(h, p);
            if (!hit) return [];
            const pk = app.picker();
            const hl = pk && h ? [pk.geometry(h)] : [];
            const off = Math.max(2 * dv.txt, 2 * dv.asz, 1e-9);
            const t = hit.t;
            let d: DimensionEntity | null = null;
            try {
              if (t.kind === 'line') d = makeLinear(t.a, t.b, hoverDimLinePoint(t.a, t.b, p, off), {});
              else if (t.kind === 'circle') d = createDiameterDimension(doc, v3(t.c), t.r, v3(pointOnCircle(t.c, t.r, p)), { layer: layerOpt() });
              else d = createRadialDimension(doc, v3(t.c), t.r, v3(pointOnCircle(t.c, t.r, p)), { layer: layerOpt() });
            } catch {
              d = null;
            }
            return [...hl, ...geom(d)];
          },
        });
        if ('enter' in r) return;
        if ('keyword' in r) {
          switch (r.keyword) {
            case 'A':
              await angularOption();
              break;
            case 'B':
              await chainFlow(true);
              break;
            case 'C':
              await chainFlow(false);
              break;
            case 'O':
              await ordinateFlow();
              break;
            case 'G':
              await alignOption();
              break;
            case 'D':
              await distributeOption();
              break;
            case 'L':
              await layerOption();
              break;
            case 'U':
              undoLast();
              break;
          }
          continue;
        }
        if (!('point' in r)) continue;
        const hit = targetOf(clickedHandle(r), r.point);
        hover = null;
        if (hit) {
          app.clearSelection();
          if (hit.t.kind === 'line') await lineFlow(hit.e, hit.t);
          else await radialFlow(hit.e, hit.t, r.point);
        } else await pointFlow(r);
      }
    },
  });
}
