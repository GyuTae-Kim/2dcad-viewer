/**
 * 배치 뷰포트 명령: MVIEW(MV), MSPACE(MS)·PSPACE(PS), VPLAYER, LAYVPI, VPCLIP, CHSPACE
 * 프롬프트는 AutoCAD 2026 한국어판을 따른다.
 */
import type { Entity, LwVertex, ViewportEntity } from '../core/model';
import type { Affine } from '../edit/geom/math';
import { transformEntity } from '../edit/geom/transform';
import { MODEL_SPACE, entityDefaults, tableKey } from '../core/model';
import type { EditOp } from '../edit/session';
import type { App, CommandContext } from './app';
import type { DocState } from './docstate';
import { layoutViewports, outlineOf, paperInfo, viewportXf } from './scene';

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

/** 배치에 전체 용지 뷰포트(id 1)가 없으면 만든다(초기화하지 않은 배치) */
function overallOps(st: DocState): EditOp[] {
  const lay = st.layoutFor(st.space);
  if (!lay) return [];
  const vps = viewportsOf(st);
  if (vps.some((v) => v.id === 1) || (lay.viewport && vps.some((v) => v.handle === lay.viewport))) return [];
  const p = paperInfo(lay, null);
  const vp = makeViewport(st, [p.minX, p.minY, p.maxX, p.maxY]);
  vp.id = 1;
  vp.status = 1;
  vp.viewCenter = { x: vp.center.x, y: vp.center.y };
  vp.viewHeight = vp.height;
  return [{ kind: 'add', block: st.space, entity: vp, index: 0 }];
}

function add(ctx: CommandContext, st: DocState, ents: Entity[], label: string): void {
  const ops: EditOp[] = [...overallOps(st), ...ents.map((entity): EditOp => ({ kind: 'add', block: st.space, entity }))];
  st.session.commit({ label, ops, group: ctx.group });
}

function setFlags(ctx: CommandContext, st: DocState, vps: ViewportEntity[], f: (v: ViewportEntity) => Partial<ViewportEntity>, label: string): void {
  const ops: EditOp[] = vps.map((v) => ({ kind: 'modify', block: st.space, before: v, after: { ...v, ...f(v) } }));
  if (ops.length) st.session.commit({ label, ops, group: ctx.group });
}

/** 뷰포트 지정 [전체(A)/선택(S)/현재(C)/현재 제외(X)] */
async function pickVps(ctx: CommandContext, st: DocState, vps: ViewportEntity[], withExcept: boolean): Promise<ViewportEntity[]> {
  const cur = st.msVp?.handle;
  const r = await ctx.getPoint(`뷰포트 지정 [전체(A)/선택(S)/현재(C)${withExcept ? '/현재 제외(X)' : ''}] <현재>:`, {
    keywords: [
      { key: 'A', label: '전체' },
      { key: 'S', label: '선택' },
      { key: 'C', label: '현재' },
      ...(withExcept ? [{ key: 'X', label: '현재 제외' }] : []),
    ],
  });
  const k = 'keyword' in r ? r.keyword : 'C';
  if (k === 'A') return vps;
  if (k === 'X') return vps.filter((v) => v.handle !== cur);
  if (k === 'S') {
    if (st.msVp) app0(ctx).exitViewport(st);
    return pickViewports(ctx, st);
  }
  return vps.filter((v) => v.handle === cur);
}

const app0 = (ctx: CommandContext) => ctx.app;

async function pickViewports(ctx: CommandContext, st: DocState): Promise<ViewportEntity[]> {
  const hs = new Set(await ctx.getSelection('객체 선택:', { noPickfirst: true }));
  // 자르기 경계 객체를 고르면 그 뷰포트
  return viewportsOf(st).filter((v) => v.id !== 1 && (hs.has(v.handle) || (v.clipBoundary && hs.has(v.clipBoundary))));
}

/** 지금 배치의 뷰포트(전체 용지 뷰포트 제외, 꺼진 것 포함) */
function layoutVps(st: DocState): ViewportEntity[] {
  const lay = st.layoutFor(st.displaySpace);
  const b = lay ? st.doc.blocks.get(tableKey(lay.blockName)) : undefined;
  return (b?.entities ?? []).filter((e): e is ViewportEntity => e.type === 'VIEWPORT' && e.id !== 1);
}

/** 뷰포트별 동결 도면층을 바꾸는 편집 */
function freezeOps(st: DocState, vps: ViewportEntity[], names: string[], freeze: boolean): EditOp[] {
  const block = tableKey(st.layoutFor(st.displaySpace)!.blockName);
  const ops: EditOp[] = [];
  for (const v of vps) {
    const cur = new Map(v.frozenLayers.map((n) => [tableKey(n), n]));
    for (const n of names) {
      const L = st.doc.layers.get(tableKey(n));
      if (!L) continue;
      if (freeze) cur.set(tableKey(n), L.name);
      else cur.delete(tableKey(n));
    }
    const next = [...cur.values()];
    if (next.length !== v.frozenLayers.length || next.some((n, i) => n !== v.frozenLayers[i])) ops.push({ kind: 'modify', block, before: v, after: { ...v, frozenLayers: next } });
  }
  return ops;
}

/** 모형 → 종이(뷰포트 변환, 비틀림 없음) */
function modelToPaper(vp: ViewportEntity, st: DocState): Affine {
  const vx = viewportXf(st.doc, vp);
  return [vx.k, 0, 0, vx.k, vp.center.x - vx.refX * vx.k, vp.center.y - vx.refY * vx.k];
}

function invert(m: Affine): Affine {
  const det = m[0] * m[3] - m[1] * m[2];
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export function registerViewportCommands(app: App): void {
  app.register({
    name: 'VPLAYER',
    title: '뷰포트 도면층',
    async run(ctx) {
      const st = app.active!;
      if (!st.onLayout) {
        ctx.print('** 명령은 배치에서만 쓸 수 있습니다 **', 'err');
        return;
      }
      for (;;) {
        const r = await ctx.getPoint('옵션 입력 [?/동결(F)/동결 해제(T)/재설정(R)/새 동결(N)/뷰포트 기본 가시성(V)]:', {
          keywords: [
            { key: '?', label: '?' },
            { key: 'F', label: '동결' },
            { key: 'T', label: '동결 해제' },
            { key: 'R', label: '재설정' },
            { key: 'N', label: '새 동결' },
            { key: 'V', label: '뷰포트 기본 가시성' },
          ],
        });
        if (!('keyword' in r)) return;
        const vps = layoutVps(st);
        if (r.keyword === '?') {
          const vs = await pickVps(ctx, st, vps, false);
          for (const v of vs) ctx.print(`뷰포트 ${v.id}: ${v.frozenLayers.length ? v.frozenLayers.join(', ') : '동결된 도면층 없음'}`);
          continue;
        }
        if (r.keyword === 'N') {
          const t = await ctx.getPoint('모든 뷰포트에서 동결된 새 도면층 이름 입력:', { allowText: true });
          if (!('text' in t) || !t.text.trim()) continue;
          const names = t.text.split(',').map((x) => x.trim()).filter(Boolean);
          const ops: EditOp[] = [];
          for (const n of names) {
            if (st.doc.layers.has(tableKey(n))) continue;
            const base = st.doc.layers.get('0')!;
            ops.push({ kind: 'layer', key: tableKey(n), before: null, after: { ...base, name: n, handle: st.session.newHandle(), off: false, frozen: false, locked: false } });
          }
          if (ops.length) st.session.commit({ label: 'VPLAYER', ops, group: ctx.group });
          const fo = freezeOps(st, vps, names, true);
          if (fo.length) st.session.commit({ label: 'VPLAYER', ops: fo, group: ctx.group });
          continue;
        }
        if (r.keyword === 'V') {
          const t = await ctx.getPoint('도면층 이름 입력:', { allowText: true });
          if (!('text' in t)) continue;
          const v = await ctx.getPoint('새 뷰포트의 기본 가시성 [동결(F)/동결 해제(T)] <동결 해제>:', {
            keywords: [
              { key: 'F', label: '동결' },
              { key: 'T', label: '동결 해제' },
            ],
          });
          const frz = 'keyword' in v && v.keyword === 'F';
          const ops: EditOp[] = [];
          for (const n of t.text.split(',').map((x) => x.trim())) {
            const L = st.doc.layers.get(tableKey(n));
            // 새 뷰포트에서 동결(플래그 2)
            if (L) ops.push({ kind: 'layer', key: tableKey(n), before: L, after: { ...L, flags: frz ? L.flags | 2 : L.flags & ~2 } });
          }
          if (ops.length) st.session.commit({ label: 'VPLAYER', ops, group: ctx.group });
          continue;
        }
        const t = await ctx.getPoint(`${r.keyword === 'F' ? '동결할' : r.keyword === 'T' ? '동결 해제할' : '재설정할'} 도면층 이름 입력 또는 <객체를 선택하여 도면층 선택>:`, { allowText: true });
        let names: string[] = [];
        if ('text' in t && t.text.trim()) names = t.text.split(',').map((x) => x.trim());
        else {
          const hs = await ctx.getSelection('객체 선택:', { noPickfirst: true });
          names = [...new Set(hs.map((h) => st.doc.entityIndex.get(h)?.layer).filter((x): x is string => !!x))];
        }
        if (!names.length) continue;
        const vs = await pickVps(ctx, st, vps, true);
        // 재설정 = 새 뷰포트 기본 가시성대로
        const freeze = r.keyword === 'F';
        const ops =
          r.keyword === 'R'
            ? [...freezeOps(st, vs, names.filter((n) => (st.doc.layers.get(tableKey(n))?.flags ?? 0) & 2), true), ...freezeOps(st, vs, names.filter((n) => !((st.doc.layers.get(tableKey(n))?.flags ?? 0) & 2)), false)]
            : freezeOps(st, vs, names, freeze);
        if (ops.length) st.session.commit({ label: 'VPLAYER', ops, group: ctx.group });
      }
    },
  });

  app.register({
    name: 'LAYVPI',
    title: '뷰포트에서 도면층 격리',
    async run(ctx) {
      const st = app.active!;
      if (!st.msVp) {
        ctx.print('뷰포트에 들어간 모형 공간(MSPACE)에서 쓰십시오.', 'err');
        return;
      }
      const hs = await ctx.getSelection('현재 뷰포트에서 격리할 도면층의 객체 선택:');
      const names = [...new Set(hs.map((h) => st.doc.entityIndex.get(h)?.layer).filter((x): x is string => !!x))];
      if (!names.length) return;
      const others = layoutVps(st).filter((v) => v.handle !== st.msVp!.handle);
      const ops = freezeOps(st, others, names, true);
      if (ops.length) st.session.commit({ label: 'LAYVPI', ops, group: ctx.group });
      ctx.print(`도면층 ${names.join(', ')}을(를) 다른 뷰포트 ${others.length}개에서 동결했습니다.`);
    },
  });

  app.register({
    name: 'VPCLIP',
    title: '뷰포트 자르기',
    async run(ctx) {
      const st = app.active!;
      if (st.msVp) app.exitViewport(st);
      if (!st.onLayout) {
        ctx.print('** 명령은 배치에서만 쓸 수 있습니다 **', 'err');
        return;
      }
      const e = await ctx.getEntity('자를 뷰포트 선택:');
      if (!('handle' in e)) return;
      const vp = layoutVps(st).find((v) => v.handle === e.handle || v.clipBoundary === e.handle);
      if (!vp) {
        ctx.print('뷰포트를 선택하십시오.', 'err');
        return;
      }
      const r = await ctx.getPoint(`자르기 객체 선택 또는 [폴리곤(P)${vp.clipBoundary ? '/삭제(D)' : ''}] <폴리곤>:`, {
        keywords: [{ key: 'P', label: '폴리곤' }, ...(vp.clipBoundary ? [{ key: 'D', label: '삭제' }] : [])],
      });
      const block = st.space;
      if ('keyword' in r && r.keyword === 'D') {
        st.session.commit({ label: 'VPCLIP', ops: [{ kind: 'modify', block, before: vp, after: { ...vp, clipBoundary: undefined, flags: vp.flags & ~VP_NONRECT } }], group: ctx.group });
        return;
      }
      let clip: Entity | null = null;
      const ops: EditOp[] = [];
      if ('point' in r) {
        // 고른 점의 객체
        const h = app.picker()?.pick(r.point.x, r.point.y, app.view.overlay.pickbox * app.view.pixelSize());
        clip = h ? (st.doc.entityIndex.get(h) ?? null) : null;
        if (!clip || !outlineOf(clip)) {
          ctx.print('닫힌 폴리선·원·타원·스플라인을 선택하십시오.', 'err');
          return;
        }
      } else {
        const pts: Pt[] = [];
        for (;;) {
          const q = await ctx.getPoint(pts.length ? (pts.length >= 3 ? '다음 점 지정 또는 [닫기(C)/명령 취소(U)]:' : '다음 점 지정 또는 [명령 취소(U)]:') : '시작점 지정:', {
            base: pts[pts.length - 1] ?? null,
            keywords: pts.length ? [{ key: 'U', label: '명령 취소' }, ...(pts.length >= 3 ? [{ key: 'C', label: '닫기' }] : [])] : [],
            rubber: (p) => [{ pts: [...pts, p].flatMap((v) => [v.x, v.y]), closed: pts.length >= 2 }],
          });
          if ('point' in q) pts.push(q.point);
          else if ('keyword' in q && q.keyword === 'U') pts.pop();
          else break;
        }
        if (pts.length < 3) return;
        clip = { ...entityDefaults(), type: 'LWPOLYLINE', handle: st.session.newHandle(), owner: st.doc.blocks.get(block)?.recordHandle, paperSpace: true, vertices: pts.map((p) => ({ x: p.x, y: p.y, bulge: 0, startWidth: 0, endWidth: 0 })), closed: true, plinegen: false, constantWidth: 0, elevation: 0 } as Entity;
        ops.push({ kind: 'add', block, entity: clip });
      }
      const pts = outlineOf(clip)!;
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
      // 뷰포트 사각형을 경계 범위로 줄이되 모형 축척·위치는 그대로
      const vx = viewportXf(st.doc, vp);
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const refX = vx.refX + (cx - vp.center.x) / vx.k;
      const refY = vx.refY + (cy - vp.center.y) / vx.k;
      const after: ViewportEntity = {
        ...vp,
        center: { x: cx, y: cy, z: vp.center.z },
        width: x1 - x0,
        height: y1 - y0,
        viewHeight: (y1 - y0) / vx.k,
        viewCenter: { x: refX - vp.viewTarget.x, y: refY - vp.viewTarget.y },
        clipBoundary: clip.handle,
        flags: vp.flags | VP_NONRECT,
      };
      ops.push({ kind: 'modify', block, before: vp, after });
      st.session.commit({ label: 'VPCLIP', ops, group: ctx.group });
    },
  });

  app.register({
    name: 'CHSPACE',
    title: '공간 변경',
    async run(ctx) {
      const st = app.active!;
      if (!st.onLayout) {
        ctx.print('** 명령은 배치에서만 쓸 수 있습니다 **', 'err');
        return;
      }
      const hs = await ctx.getSelection('객체 선택:');
      if (!hs.length) return;
      const fromModel = !!st.msVp;
      let vp: ViewportEntity | null = st.msVp ? (st.doc.entityIndex.get(st.msVp.handle) as ViewportEntity) : null;
      if (!vp) {
        const vps = layoutViewports(st.doc, st.layoutFor(st.displaySpace)!);
        if (vps.length === 1) vp = vps[0]!;
        else {
          const e = await ctx.getEntity('대상 뷰포트 선택:');
          vp = 'handle' in e ? (vps.find((v) => v.handle === e.handle) ?? null) : null;
        }
      }
      if (!vp || vp.twistAngle) {
        ctx.print('비틀리지 않은 뷰포트가 필요합니다.', 'err');
        return;
      }
      const m2p = modelToPaper(vp, st);
      const m = fromModel ? m2p : invert(m2p);
      const fromKey = st.space;
      const toKey = fromModel ? st.msVp!.layout : MODEL_SPACE;
      const toBlock = st.doc.blocks.get(toKey);
      const removes: { op: EditOp; index: number }[] = [];
      const adds: EditOp[] = [];
      const src = st.doc.blocks.get(fromKey)?.entities ?? [];
      let n = 0;
      for (const h of hs) {
        const e = st.doc.entityIndex.get(h);
        if (!e || e.type === 'VIEWPORT') continue;
        const res = transformEntity(e, m, st.doc);
        const t = res.replace?.[0];
        if (!t) continue;
        const c = { ...t, handle: st.session.newHandle(), owner: toBlock?.recordHandle, paperSpace: fromModel ? true : undefined } as Entity;
        delete (c as { xdict?: unknown }).xdict;
        delete (c as { reactors?: unknown }).reactors;
        delete (c as { dwgRaw?: unknown }).dwgRaw;
        if (c.type === 'INSERT') for (const a of c.attribs) a.handle = st.session.newHandle();
        const index = src.indexOf(e);
        if (index < 0) continue;
        removes.push({ op: { kind: 'remove', block: fromKey, entity: e, index }, index });
        adds.push({ kind: 'add', block: toKey, entity: c });
        n++;
      }
      // 뒤에서부터 빼야 앞 객체의 자리가 그대로다
      const ops = [...removes.sort((a, b) => b.index - a.index).map((r) => r.op), ...adds];
      if (ops.length) st.session.commit({ label: 'CHSPACE', ops, group: ctx.group });
      ctx.print(`${n}개 객체를 ${fromModel ? '종이 공간으로' : '모형 공간으로'} 옮겼습니다.`);
    },
  });
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
          add(ctx, st, [vp], 'MVIEW');
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
