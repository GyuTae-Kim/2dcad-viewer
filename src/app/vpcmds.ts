/**
 * 배치 뷰포트 명령: MVIEW(MV)
 * 프롬프트는 AutoCAD 2026 한국어판을 따른다.
 */
import type { Entity, LwVertex, ViewportEntity } from '../core/model';
import { MODEL_SPACE, entityDefaults } from '../core/model';
import type { EditOp } from '../edit/session';
import type { App, CommandContext } from './app';
import type { DocState } from './docstate';
import { layoutViewports, outlineOf, paperInfo } from './scene';

type Pt = { x: number; y: number };
type Rect = [number, number, number, number];

/** 꺼진 뷰포트(상태 0 또는 플래그 0x20000) */
const VP_OFF = 0x20000;
/** 화면 표시 잠금 */
const VP_LOCKED = 0x4000;
/** 다각형 자르기 */
const VP_NONRECT = 0x10000;

function viewportsOf(st: DocState): ViewportEntity[] {
  return (st.doc.blocks.get(st.space)?.entities ?? []).filter((e): e is ViewportEntity => e.type === 'VIEWPORT');
}

function nextId(st: DocState): number {
  return Math.max(1, ...viewportsOf(st).map((v) => v.id)) + 1;
}

/** 사각형(종이 좌표)에 모형 범위를 맞춘 뷰포트 */
function makeViewport(st: DocState, r: Rect): ViewportEntity {
  const [x0, y0, x1, y1] = r;
  const w = x1 - x0;
  const h = y1 - y0;
  const vp: ViewportEntity = {
    ...entityDefaults(),
    type: 'VIEWPORT',
    handle: st.session.newHandle(),
    owner: st.doc.blocks.get(st.space)?.recordHandle,
    paperSpace: true,
    center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: 0 },
    width: w,
    height: h,
    status: 2,
    id: nextId(st),
    viewCenter: { x: 0, y: 0 },
    snapBase: { x: 0, y: 0 },
    snapSpacing: { x: 10, y: 10 },
    gridSpacing: { x: 10, y: 10 },
    viewDirection: { x: 0, y: 0, z: 1 },
    viewTarget: { x: 0, y: 0, z: 0 },
    lensLength: 50,
    frontClip: 0,
    backClip: 0,
    viewHeight: h,
    snapAngle: 0,
    twistAngle: 0,
    circleSides: 1000,
    flags: 32864,
    frozenLayers: [],
    renderMode: 0,
    ucsPerViewport: true,
  };
  const b = st.scenes.get(MODEL_SPACE)?.bounds;
  if (b && b.maxX > b.minX && w > 0 && h > 0) {
    vp.viewCenter = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    vp.viewHeight = Math.max(b.maxY - b.minY, ((b.maxX - b.minX) * h) / w) * 1.05;
  }
  return vp;
}

/** 맞춤(F): 인쇄 가능 영역(없으면 용지) */
function fitRect(st: DocState): Rect | null {
  const lay = st.layoutFor(st.space);
  if (!lay) return null;
  const p = paperInfo(lay, st.scenes.get(st.space)?.bounds ?? null);
  return p.printable ?? [p.minX, p.minY, p.maxX, p.maxY];
}

const norm = (a: Pt, b: Pt): Rect => [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
const box = (r: Rect) => [r[0], r[1], r[2], r[1], r[2], r[3], r[0], r[3]];

/** 사각형 영역을 n개로 나눈다 */
function split(r: Rect, n: number, how: string): Rect[] {
  const [x0, y0, x1, y1] = r;
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  if (n === 2) return how === 'H' ? [[x0, my, x1, y1], [x0, y0, x1, my]] : [[x0, y0, mx, y1], [mx, y0, x1, y1]];
  if (n === 4) return [[x0, my, mx, y1], [mx, my, x1, y1], [x0, y0, mx, my], [mx, y0, x1, my]];
  // 3
  const t3 = (a: number, b: number, i: number) => a + ((b - a) * i) / 3;
  switch (how) {
    case 'H':
      return [0, 1, 2].map((i) => [x0, t3(y1, y0, i + 1), x1, t3(y1, y0, i)] as Rect);
    case 'V':
      return [0, 1, 2].map((i) => [t3(x0, x1, i), y0, t3(x0, x1, i + 1), y1] as Rect);
    case 'A': // 위
      return [[x0, my, x1, y1], [x0, y0, mx, my], [mx, y0, x1, my]];
    case 'B': // 아래
      return [[x0, my, mx, y1], [mx, my, x1, y1], [x0, y0, x1, my]];
    case 'L': // 왼쪽
      return [[x0, y0, mx, y1], [mx, my, x1, y1], [mx, y0, x1, my]];
    default: // 오른쪽
      return [[x0, my, mx, y1], [x0, y0, mx, my], [mx, y0, x1, y1]];
  }
}

async function pickRect(ctx: CommandContext, prompt: string, allowFit: boolean, fallback: Rect | null): Promise<Rect | null> {
  const r = await ctx.getPoint(prompt, { keywords: allowFit ? [{ key: 'F', label: '맞춤' }] : [] });
  if ('enter' in r || ('keyword' in r && r.keyword === 'F')) return fallback;
  if (!('point' in r)) return null;
  const a = r.point;
  const q = await ctx.getPoint('반대 구석 지정:', { base: a, rubber: (p) => [{ pts: box(norm(a, p)), closed: true, dashed: true }] });
  if (!('point' in q)) return null;
  const rr = norm(a, q.point);
  return rr[2] - rr[0] > 1e-9 && rr[3] - rr[1] > 1e-9 ? rr : null;
}

function add(ctx: CommandContext, st: DocState, ents: Entity[], label: string): void {
  const ops: EditOp[] = ents.map((entity) => ({ kind: 'add', block: st.space, entity }));
  st.session.commit({ label, ops, group: ctx.group });
}

function setFlags(ctx: CommandContext, st: DocState, vps: ViewportEntity[], f: (v: ViewportEntity) => Partial<ViewportEntity>, label: string): void {
  const ops: EditOp[] = vps.map((v) => ({ kind: 'modify', block: st.space, before: v, after: { ...v, ...f(v) } }));
  if (ops.length) st.session.commit({ label, ops, group: ctx.group });
}

async function pickViewports(ctx: CommandContext, st: DocState): Promise<ViewportEntity[]> {
  const hs = new Set(await ctx.getSelection('객체 선택:', { noPickfirst: true }));
  // 자르기 경계 객체를 고르면 그 뷰포트
  return viewportsOf(st).filter((v) => v.id !== 1 && (hs.has(v.handle) || (v.clipBoundary && hs.has(v.clipBoundary))));
}

export function registerViewportCommands(app: App): void {
  app.register({
    name: 'MSPACE',
    aliases: ['MS'],
    title: '모형 공간(뷰포트)',
    run(ctx) {
      const st = app.active!;
      if (st.msVp) return;
      const lay = st.isModel ? null : st.layoutFor(st.space);
      if (!lay) {
        ctx.print('** 명령은 배치에서만 쓸 수 있습니다 **', 'err');
        return;
      }
      const vps = layoutViewports(st.doc, lay).filter((v) => !v.twistAngle);
      if (!vps.length) {
        ctx.print('활성 모형 공간 뷰포트가 없습니다.', 'err');
        return;
      }
      app.enterViewport(st, vps[0]!);
    },
  });
  app.register({
    name: 'PSPACE',
    aliases: ['PS'],
    title: '종이 공간',
    run() {
      const st = app.active!;
      if (st.msVp) app.exitViewport(st);
    },
  });
  app.register({
    name: 'MVIEW',
    aliases: ['MV'],
    title: '뷰포트 만들기',
    async run(ctx) {
      const st = app.active!;
      if (st.isModel || !st.layoutFor(st.space)) {
        ctx.print('MVIEW는 배치에서만 쓸 수 있습니다.', 'err');
        return;
      }
      await app.ensureScene(st, MODEL_SPACE);
      const fit = fitRect(st);
      const r = await ctx.getPoint('뷰포트 구석 지정 또는 [켜기(ON)/끄기(OFF)/맞춤(F)/잠금(L)/객체(O)/폴리곤(P)/2/3/4] <맞춤>:', {
        keywords: [
          { key: 'ON', label: '켜기' },
          { key: 'OFF', label: '끄기' },
          { key: 'F', label: '맞춤' },
          { key: 'L', label: '잠금' },
          { key: 'O', label: '객체' },
          { key: 'P', label: '폴리곤' },
          { key: '2', label: '2' },
          { key: '3', label: '3' },
          { key: '4', label: '4' },
        ],
      });
      if ('point' in r) {
        const a = r.point;
        const q = await ctx.getPoint('반대 구석 지정:', { base: a, rubber: (p) => [{ pts: box(norm(a, p)), closed: true, dashed: true }] });
        if (!('point' in q)) return;
        const rr = norm(a, q.point);
        if (rr[2] - rr[0] <= 1e-9 || rr[3] - rr[1] <= 1e-9) return;
        add(ctx, st, [makeViewport(st, rr)], 'MVIEW');
        ctx.print('모형을 재생성하는 중입니다.');
        return;
      }
      const kw = 'enter' in r ? 'F' : 'keyword' in r ? r.keyword : '';
      switch (kw) {
        case 'F':
          if (fit) add(ctx, st, [makeViewport(st, fit)], 'MVIEW');
          return;
        case 'ON':
        case 'OFF': {
          const vps = await pickViewports(ctx, st);
          const on = kw === 'ON';
          setFlags(ctx, st, vps, (v) => ({ status: on ? Math.max(2, v.id) : 0, flags: on ? v.flags & ~VP_OFF : v.flags | VP_OFF }), 'MVIEW');
          ctx.print(`뷰포트 ${vps.length}개를 ${on ? '켰습니다' : '껐습니다'}.`);
          return;
        }
        case 'L': {
          const s = await ctx.getPoint('뷰포트 뷰 잠금 [켜기(ON)/끄기(OFF)]:', {
            keywords: [
              { key: 'ON', label: '켜기' },
              { key: 'OFF', label: '끄기' },
            ],
          });
          if (!('keyword' in s)) return;
          const vps = await pickViewports(ctx, st);
          const on = s.keyword === 'ON';
          setFlags(ctx, st, vps, (v) => ({ flags: on ? v.flags | VP_LOCKED : v.flags & ~VP_LOCKED }), 'MVIEW');
          return;
        }
        case 'O': {
          const e = await ctx.getEntity('뷰포트를 자를 객체 선택:');
          if (!('handle' in e)) return;
          const ent = st.doc.entityIndex.get(e.handle);
          const pts = ent ? outlineOf(ent) : null;
          if (!ent || !pts || pts.length < 6) {
            ctx.print('닫힌 폴리선·원·타원·스플라인을 선택하십시오.', 'err');
            return;
          }
          let x0 = Infinity;
          let y0 = Infinity;
          let x1 = -Infinity;
          let y1 = -Infinity;
          for (let i = 0; i + 1 < pts.length; i += 2) {
            x0 = Math.min(x0, pts[i]!);
            x1 = Math.max(x1, pts[i]!);
            y0 = Math.min(y0, pts[i + 1]!);
            y1 = Math.max(y1, pts[i + 1]!);
          }
          const vp = makeViewport(st, [x0, y0, x1, y1]);
          vp.clipBoundary = ent.handle;
          vp.flags |= VP_NONRECT;
          st.session.commit({ label: 'MVIEW', ops: [{ kind: 'add', block: st.space, entity: vp }], group: ctx.group });
          return;
        }
        case 'P': {
          const pts: Pt[] = [];
          for (;;) {
            const prompt = pts.length === 0 ? '시작점 지정:' : pts.length < 3 ? '다음 점 지정 또는 [명령 취소(U)]:' : '다음 점 지정 또는 [닫기(C)/명령 취소(U)]:';
            const last = pts[pts.length - 1];
            const q = await ctx.getPoint(prompt, {
              base: last ?? null,
              keywords: pts.length ? [{ key: 'U', label: '명령 취소' }, ...(pts.length >= 3 ? [{ key: 'C', label: '닫기' }] : [])] : [],
              rubber: (p) => [{ pts: [...pts, p].flatMap((v) => [v.x, v.y]), closed: pts.length >= 2 }],
            });
            if ('point' in q) pts.push(q.point);
            else if ('keyword' in q && q.keyword === 'U') pts.pop();
            else break;
          }
          if (pts.length < 3) return;
          const vertices: LwVertex[] = pts.map((p) => ({ x: p.x, y: p.y, bulge: 0, startWidth: 0, endWidth: 0 }));
          const poly: Entity = { ...entityDefaults(), type: 'LWPOLYLINE', handle: st.session.newHandle(), owner: st.doc.blocks.get(st.space)?.recordHandle, paperSpace: true, vertices, closed: true, plinegen: false, constantWidth: 0, elevation: 0 } as Entity;
          const vp = makeViewport(st, [Math.min(...pts.map((p) => p.x)), Math.min(...pts.map((p) => p.y)), Math.max(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.y))]);
          vp.clipBoundary = poly.handle;
          vp.flags |= VP_NONRECT;
          add(ctx, st, [poly, vp], 'MVIEW');
          return;
        }
        case '2':
        case '3':
        case '4': {
          const n = Number(kw);
          let how = 'V';
          if (n === 2) {
            const s = await ctx.getPoint('뷰포트 배열 입력 [수평(H)/수직(V)] <수직>:', { keywords: [{ key: 'H', label: '수평' }, { key: 'V', label: '수직' }] });
            how = 'keyword' in s ? s.keyword : 'V';
          } else if (n === 3) {
            const s = await ctx.getPoint('뷰포트 배열 입력 [수평(H)/수직(V)/위(A)/아래(B)/왼쪽(L)/오른쪽(R)] <오른쪽>:', {
              keywords: [
                { key: 'H', label: '수평' },
                { key: 'V', label: '수직' },
                { key: 'A', label: '위' },
                { key: 'B', label: '아래' },
                { key: 'L', label: '왼쪽' },
                { key: 'R', label: '오른쪽' },
              ],
            });
            how = 'keyword' in s ? s.keyword : 'R';
          }
          const rr = await pickRect(ctx, '첫 번째 구석 지정 또는 [맞춤(F)] <맞춤>:', true, fit);
          if (!rr) return;
          const vps: ViewportEntity[] = [];
          for (const part of split(rr, n, how)) {
            const vp = makeViewport(st, part);
            vp.id = nextId(st) + vps.length;
            vps.push(vp);
          }
          add(ctx, st, vps, 'MVIEW');
          return;
        }
      }
    },
  });
}
