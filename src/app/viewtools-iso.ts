/**
 * 등각투영 제도: ISODRAFT, ISOPLANE, SNAPSTYL·SNAPISOPAIR 변수, 등각 격자·스냅·직교·극좌표/객체 스냅 추적,
 * 등각 십자선, ELLIPSE의 등각원(I). 계산은 src/edit/viewtools/iso.ts.
 *
 * 앱(app.ts)은 고치지 않고 고리로 붙는다: 점 해석(resolvePoint)·격자 스냅(snapToGrid)을 감싸고, 격자(gridInfo)는
 * 등각일 때 직교 격자 대신 덧그림(extraOverlay)에 등각 격자를 그린다.
 * 설정은 도면마다(이 세션만 — SNAPSTYL·SNAPISOPAIR는 DXF R2000+에서 VPORT 표 값이라 지금은 저장하지 않는다).
 */
import type { App, CommandContext, Keyword } from './app';
import type { DocState } from './docstate';
import type { CadDocument } from '../core/model';
import type { Pt, SnapKind } from './view';
import { formatLength } from '../core/units';
import { currentUcs, toUcs, toWcs } from './ucs';
import { objectTrack, polarTrack } from './tracking';
import type { Acquired, TrackResult } from './tracking';
import { ellipsePoints, TAU } from '../geom/curves';
import { ISO_PLANE_KEYS, ISO_PLANE_NAMES, type IsoPlane, isoAxes, isoCircle, isoGridSegments, isoOrthoPoint, isoPolarAngles, isoSnapPoint, nextIsoPlane, toIsoPlane } from '../edit/viewtools/iso';

export interface IsoState {
  /** SNAPSTYL: 0 표준(직사각형), 1 등각투영 */
  style: 0 | 1;
  /** SNAPISOPAIR: 0 왼쪽, 1 위, 2 오른쪽 */
  pair: IsoPlane;
}

const states = new WeakMap<CadDocument, IsoState>();
const listeners = new Set<() => void>();

/** 도면의 등각 설정(처음이면 머리말 $SNAPSTYLE·$SNAPISOPAIR — R12 DXF — 또는 0·0) */
export function isoState(st: DocState | null): IsoState {
  if (!st) return { style: 0, pair: 0 };
  let s = states.get(st.doc);
  if (!s) {
    const h = st.doc.header;
    const pair = h.get('$SNAPISOPAIR');
    s = { style: Number(h.get('$SNAPSTYLE') ?? 0) === 1 ? 1 : 0, pair: pair === undefined ? 0 : toIsoPlane(pair) };
    states.set(st.doc, s);
  }
  return s;
}

/** 등각투영 제도가 켜졌으면 그 평면, 아니면 null(블록 편집기·배치 종이 공간도 쓴다) */
export function isoPlaneOf(st: DocState | null): IsoPlane | null {
  const s = isoState(st);
  return st && s.style === 1 ? s.pair : null;
}

/** 등각 설정이 바뀌면(상태 막대가 듣는다). 돌려준 함수로 끊는다 */
export function onIsoChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** 등각 설정을 바꾼다(명령 취소 단위가 아니다 — AutoCAD의 F5·상태 막대와 같다) */
export function setIso(app: App, st: DocState, patch: Partial<IsoState>): void {
  const s = isoState(st);
  if (patch.style !== undefined) s.style = patch.style;
  if (patch.pair !== undefined) s.pair = patch.pair;
  app.view.requestOverlay();
  app.ui?.refreshStatus();
  for (const f of listeners) f();
}

/** F5·Ctrl+E: 다음 등각평면(`<등각평면 위>`). 리더가 app.ts 키 처리에서 부른다 */
export function cycleIsoPlane(app: App): void {
  const st = app.active;
  if (!st) return;
  const p = nextIsoPlane(isoState(st).pair);
  setIso(app, st, { pair: p });
  app.cmd.print(`<등각평면 ${ISO_PLANE_NAMES[p]}>`);
}

// ---------------------------------------------------------------------------
// 앱 고리
// ---------------------------------------------------------------------------

type Resolve = (w: Pt) => { p: Pt; snap: { p: Pt; kind: SnapKind; handle?: string; handle2?: string } | null; track?: TrackResult };
type PointReq = { kind: 'point'; base: Pt | null } | { kind: 'entity' | 'select' };

/** 앱의 비공개 멤버(고리를 거는 데만 쓴다) */
interface AppPrivate {
  resolvePoint: Resolve;
  snapToGrid: (w: Pt) => Pt;
  request: PointReq | null;
  acquired: Acquired[];
}

const priv = (app: App) => app as unknown as AppPrivate;

let gridInfoOrig: App['view']['gridInfo'] = null;
let crossOff = false;

/** 점 해석·격자 스냅·격자 표시를 등각 모드에 맞게 감싼다(한 번만) */
export function installIsoHooks(app: App): void {
  const p = priv(app);
  const resolve = p.resolvePoint.bind(app);
  const snap = p.snapToGrid.bind(app);
  p.snapToGrid = (w: Pt) => {
    const st = app.active;
    if (isoPlaneOf(st) === null || !st || st.msVp) return snap(w);
    const u = currentUcs(st);
    const q = isoSnapPoint(toUcs(u, w), { x: st.snap.baseX, y: st.snap.baseY }, st.snap.y);
    return toWcs(u, q);
  };
  p.resolvePoint = (w: Pt) => {
    const st = app.active;
    const plane = isoPlaneOf(st);
    const r = p.request;
    if (plane === null || !st || r?.kind !== 'point') return resolve(w);
    // 1) 객체 스냅은 그대로(추적·극좌표·직교·격자 스냅을 잠시 끄고 원래 해석을 부른다)
    const saved = { polar: app.polarOn, ortho: app.orthoOn, otrack: app.otrackOn, snap: app.snapOn };
    app.polarOn = app.orthoOn = app.otrackOn = app.snapOn = false;
    let res: ReturnType<Resolve>;
    try {
      res = resolve(w);
    } finally {
      app.polarOn = saved.polar;
      app.orthoOn = saved.ortho;
      app.otrackOn = saved.otrack;
      app.snapOn = saved.snap;
    }
    if (res.snap) return res;
    // 2) 극좌표·객체 스냅 추적: 등각 각도(30°·90°·150°…, UCS X축 기준)
    const tol = 8 * app.view.pixelSize();
    const fmt = (v: number) => formatLength(v, st.units);
    const u = currentUcs(st);
    const iso = isoPolarAngles().map((a) => a + u.angle);
    const acquired = p.acquired;
    if (app.otrackOn && acquired.length) {
      const t = objectTrack(acquired, w, iso, tol, r.base, app.polarOn ? iso : null, fmt);
      if (t) return { p: t.p, snap: null, track: t };
    }
    if (r.base && app.polarOn && !app.orthoOn) {
      const t = polarTrack(r.base, w, iso, tol, fmt);
      if (t) return { p: t.p, snap: null, track: t };
    }
    // 3) 등각 격자 스냅
    let q = app.snapOn ? p.snapToGrid(w) : w;
    // 4) 등각 직교: 평면의 두 축 중 가까운 쪽(UCS 기준)
    if (r.base && app.orthoOn) q = toWcs(u, isoOrthoPoint(toUcs(u, r.base), toUcs(u, q), plane));
    return { p: q, snap: null };
  };
  gridInfoOrig = app.view.gridInfo;
  app.view.gridInfo = () => {
    const gi = gridInfoOrig?.() ?? null;
    return gi && isoPlaneOf(app.active) !== null && !app.active?.msVp ? null : gi;
  };
}

/**
 * 등각 덧그림: 등각 격자(격자를 켰을 때)와 등각 십자선. 덧그림 고리(extraOverlay)에서 부른다.
 * 등각이 아니면 표준 십자선을 되돌린다.
 */
export function drawIsoOverlay(app: App, g: CanvasRenderingContext2D, W: (x: number, y: number) => Pt, dark: boolean): void {
  const st = app.active;
  const plane = isoPlaneOf(st);
  const o = app.view.overlay;
  if (plane === null || !st || st.msVp) {
    if (crossOff) {
      o.crosshair = true;
      crossOff = false;
    }
    return;
  }
  const u = currentUcs(st);
  // 등각 격자
  const gi = gridInfoOrig?.() ?? null;
  if (gi) {
    const vw = app.view.visibleWorld();
    const cs = [
      { x: vw[0], y: vw[1] },
      { x: vw[2], y: vw[1] },
      { x: vw[2], y: vw[3] },
      { x: vw[0], y: vw[3] },
    ].map((q) => toUcs(u, q));
    const rect: [number, number, number, number] = [Math.min(...cs.map((q) => q.x)), Math.min(...cs.map((q) => q.y)), Math.max(...cs.map((q) => q.x)), Math.max(...cs.map((q) => q.y))];
    if (gi.limits && u.angle === 0 && u.ox === 0 && u.oy === 0) {
      rect[0] = Math.max(rect[0], gi.limits[0]);
      rect[1] = Math.max(rect[1], gi.limits[1]);
      rect[2] = Math.min(rect[2], gi.limits[2]);
      rect[3] = Math.min(rect[3], gi.limits[3]);
    }
    const px = 1 / app.view.pixelSize();
    let s = gi.y;
    const major = Math.max(1, Math.round(gi.major));
    // 너무 촘촘하면 주 격자 배수로 넓힌다(표준 격자와 같은 규칙)
    for (let i = 0; i < 12 && s * px < 10; i++) s *= major > 1 ? major : 2;
    if (s * px >= 5) {
      const segs = isoGridSegments(rect, { x: gi.baseX, y: gi.baseY }, s, major);
      const stroke = (list: number[], color: string) => {
        if (!list.length) return;
        g.beginPath();
        for (let i = 0; i + 3 < list.length; i += 4) {
          const a = toWcs(u, { x: list[i]!, y: list[i + 1]! });
          const b = toWcs(u, { x: list[i + 2]!, y: list[i + 3]! });
          const A = W(a.x, a.y);
          const B = W(b.x, b.y);
          g.moveTo(A.x, A.y);
          g.lineTo(B.x, B.y);
        }
        g.strokeStyle = color;
        g.stroke();
      };
      g.save();
      g.lineWidth = 1;
      stroke(segs.minor, dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.07)');
      stroke(segs.major, dark ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.15)');
      g.restore();
    }
  }
  // 등각 십자선: 평면의 두 축 방향(표준 십자선은 끈다)
  if (o.crosshair) {
    o.crosshair = false;
    crossOff = true;
  }
  const c = o.cursor;
  if (!c) return;
  const L = Math.max(app.view.width, app.view.height) * 0.05 + 20;
  const pb = o.pickbox;
  g.save();
  g.strokeStyle = dark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.85)';
  g.lineWidth = 1;
  g.beginPath();
  for (const a0 of isoAxes(plane)) {
    const a = a0 + u.angle;
    const dx = Math.cos(a);
    const dy = -Math.sin(a);
    g.moveTo(c.x - dx * L, c.y - dy * L);
    g.lineTo(c.x - dx * pb, c.y - dy * pb);
    g.moveTo(c.x + dx * pb, c.y + dy * pb);
    g.lineTo(c.x + dx * L, c.y + dy * L);
  }
  g.stroke();
  g.strokeRect(Math.round(c.x) + 0.5 - pb, Math.round(c.y) + 0.5 - pb, pb * 2, pb * 2);
  g.restore();
}

// ---------------------------------------------------------------------------
// ELLIPSE 등각원(I)
// ---------------------------------------------------------------------------

/** ELLIPSE 첫 프롬프트에 더할 키워드(등각 제도가 켜졌을 때만) */
export function isoEllipseKeyword(app: App): Keyword | null {
  return isoPlaneOf(app.active) === null ? null : { key: 'I', label: '등각원' };
}

/**
 * ELLIPSE 등각원(I): `등각원의 중심 지정:` → `등각원의 반지름 지정 또는 [지름(D)]:`.
 * 지금 등각평면(UCS 회전 포함)에 맞는 타원(중심·장축 벡터·비율)을 돌려준다. 취소하면 null
 */
export async function isoCircleEllipse(app: App, ctx: CommandContext): Promise<{ center: Pt; majorAxis: Pt; ratio: number } | null> {
  const st = app.active;
  const plane = isoPlaneOf(st) ?? isoState(st).pair;
  const ua = currentUcs(st).angle;
  const shape = (r: number) => {
    const e = isoCircle(r, plane);
    const c = Math.cos(ua);
    const s = Math.sin(ua);
    return { majorAxis: { x: e.majorAxis.x * c - e.majorAxis.y * s, y: e.majorAxis.x * s + e.majorAxis.y * c }, ratio: e.ratio };
  };
  const c0 = await ctx.getPoint('등각원의 중심 지정:');
  if (!('point' in c0)) return null;
  const center = c0.point;
  let diameter = false;
  const preview = (r: number): { pts: number[]; closed: boolean }[] => {
    if (!(r > 0)) return [];
    const e = shape(r);
    return [{ pts: ellipsePoints(center.x, center.y, e.majorAxis.x, e.majorAxis.y, e.ratio, 0, TAU, r * 0.002), closed: true }];
  };
  for (;;) {
    const q = await ctx.getPoint(diameter ? '등각원의 지름 지정:' : '등각원의 반지름 지정 또는 [지름(D)]:', {
      base: center,
      keywords: diameter ? [] : [{ key: 'D', label: '지름' }],
      preferNumber: true,
      rubber: (p) => preview(Math.hypot(p.x - center.x, p.y - center.y) / (diameter ? 2 : 1)),
    });
    if ('keyword' in q) {
      diameter = true;
      continue;
    }
    let r = NaN;
    if ('text' in q) r = parseFloat(q.text) / (diameter ? 2 : 1);
    else if ('point' in q) r = Math.hypot(q.point.x - center.x, q.point.y - center.y) / (diameter ? 2 : 1);
    else return null;
    if (!(r > 0) || !Number.isFinite(r)) {
      ctx.print('값은 양수이고 0이 아니어야 합니다.', 'err');
      continue;
    }
    return { center, ...shape(r) };
  }
}

// ---------------------------------------------------------------------------
// 명령
// ---------------------------------------------------------------------------

const PLANE_KWS: Keyword[] = [
  { key: 'L', label: '왼쪽' },
  { key: 'T', label: '위' },
  { key: 'R', label: '오른쪽' },
];

const planeOfKey = (k: string): IsoPlane => (k === 'L' ? 0 : k === 'T' ? 1 : 2);

/** 정수 변수 묻기(`SNAPSTYL에 대한 새 값 입력 <0>:`) */
async function askInt(ctx: CommandContext, name: string, cur: number, ok: (n: number) => boolean, arg?: string): Promise<number | null> {
  let text = arg?.trim();
  for (;;) {
    if (text === undefined) {
      const r = await ctx.getPoint(`${name}에 대한 새 값 입력 <${cur}>:`, { allowText: true, preferNumber: true });
      if (!('text' in r)) return null;
      text = r.text.trim();
    }
    if (text === '') return null;
    const n = Number(text);
    if (/^-?\d+$/.test(text) && ok(n)) return n;
    ctx.print('값이 범위를 벗어났습니다.', 'err');
    if (arg !== undefined) return null;
    text = undefined;
  }
}

export function registerIsoCommands(app: App): void {
  app.register({
    name: 'ISODRAFT',
    title: '등각투영 제도',
    transparent: true,
    async run(ctx, arg) {
      const st = app.active!;
      const s = isoState(st);
      const cur = s.style === 1 ? `등각평면 ${ISO_PLANE_NAMES[s.pair]}` : '직교';
      let k = arg?.trim().toUpperCase();
      if (!k) {
        const r = await ctx.getPoint(`옵션 입력 [직교(O)/등각평면 왼쪽(L)/등각평면 위(T)/등각평면 오른쪽(R)] <${cur}>:`, {
          keywords: [{ key: 'O', label: '직교' }, ...PLANE_KWS.map((x) => ({ key: x.key, label: `등각평면 ${x.label}` }))],
        });
        if ('enter' in r) return;
        if (!('keyword' in r)) return;
        k = r.keyword;
      }
      if (k === 'O') {
        setIso(app, st, { style: 0 });
        ctx.print('<등각투영 제도 끄기>');
        return;
      }
      if (k !== 'L' && k !== 'T' && k !== 'R') {
        ctx.print('옵션이 올바르지 않습니다.', 'err');
        return;
      }
      const p = planeOfKey(k);
      setIso(app, st, { style: 1, pair: p });
      ctx.print(`<등각평면 ${ISO_PLANE_NAMES[p]}>`);
    },
  });

  app.register({
    name: 'ISOPLANE',
    title: '등각평면',
    transparent: true,
    async run(ctx, arg) {
      const st = app.active!;
      const s = isoState(st);
      const next = nextIsoPlane(s.pair);
      ctx.print(`현재 등각평면: ${ISO_PLANE_NAMES[s.pair]}`);
      let k = arg?.trim().toUpperCase();
      if (k === undefined) {
        const r = await ctx.getPoint(`등각평면 설정 입력 [왼쪽(L)/위(T)/오른쪽(R)] <${ISO_PLANE_NAMES[next]}>:`, { keywords: PLANE_KWS });
        if ('enter' in r) k = ISO_PLANE_KEYS[next]!;
        else if ('keyword' in r) k = r.keyword;
        else return;
      }
      if (k === '') k = ISO_PLANE_KEYS[next]!;
      if (k !== 'L' && k !== 'T' && k !== 'R') {
        ctx.print('옵션이 올바르지 않습니다.', 'err');
        return;
      }
      const p = planeOfKey(k);
      setIso(app, st, { pair: p });
      ctx.print(`현재 등각평면: ${ISO_PLANE_NAMES[p]}`);
      if (s.style !== 1) ctx.print('참고: 등각투영 제도(SNAPSTYL)가 꺼져 있어 십자선·스냅은 그대로입니다. ISODRAFT로 켜십시오.');
    },
  });

  app.register({
    name: 'SNAPSTYL',
    title: '스냅 스타일(0 표준, 1 등각투영)',
    transparent: true,
    async run(ctx, arg) {
      const st = app.active!;
      const v = await askInt(ctx, 'SNAPSTYL', isoState(st).style, (n) => n === 0 || n === 1, arg);
      if (v !== null) setIso(app, st, { style: v === 1 ? 1 : 0 });
    },
  });

  app.register({
    name: 'SNAPISOPAIR',
    title: '등각평면(0 왼쪽, 1 위, 2 오른쪽)',
    transparent: true,
    async run(ctx, arg) {
      const st = app.active!;
      const v = await askInt(ctx, 'SNAPISOPAIR', isoState(st).pair, (n) => n >= 0 && n <= 2, arg);
      if (v !== null) setIso(app, st, { pair: toIsoPlane(v) });
    },
  });
}
