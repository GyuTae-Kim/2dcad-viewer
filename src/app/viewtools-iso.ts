/**
 * 등각투영 제도: ISODRAFT, ISOPLANE, SNAPSTYL·SNAPISOPAIR 변수, 등각 격자·스냅·직교·극좌표/객체 스냅 추적,
 * 등각 십자선, ELLIPSE의 등각원(I). 계산은 src/edit/viewtools/iso.ts.
 *
 * 앱(app.ts)에는 확장 지점으로 붙는다: 점 해석 고리(App.pointFilters)가 객체 스냅이 잡히지 않은 점의 추적·격자 스냅·직교를
 * 등각으로 대신하고, 격자(gridInfo)는 등각일 때 직교 격자 대신 덧그림(extraOverlay)에 등각 격자를 그린다.
 * 설정은 도면에 저장한다: *Active 뷰포트 레코드의 스냅 스타일·등각평면(DXF R2000+ VPORT 77·78, R12는 머리말
 * $SNAPSTYLE·$SNAPISOPAIR도, DWG VPORT 객체 — src/io/vportsnap.ts). 명령 취소 단위가 아니라 바꾸면 수정 표시만 한다.
 */
import type { App, CommandContext, Keyword } from './app';
import type { DocState } from './docstate';
import type { VPortRecord } from '../core/model';
import type { Pt } from './view';
import { formatLength } from '../core/units';
import { currentUcs, toUcs, toWcs } from './ucs';
import { objectTrack, polarTrack } from './tracking';
import type { Acquired } from './tracking';
import { type ResolvedPoint, addHook } from './hooks';
import { activeVport, vportSnap } from '../io/vportsnap';
import { ellipsePoints, TAU } from '../geom/curves';
import { ISO_PLANE_KEYS, ISO_PLANE_NAMES, type IsoPlane, isoAxes, isoCircle, isoGridSegments, isoOrthoPoint, isoPolarAngles, isoSnapPoint, nextIsoPlane, toIsoPlane } from '../edit/viewtools/iso';

export interface IsoState {
  /** SNAPSTYL: 0 표준(직사각형), 1 등각투영 */
  style: 0 | 1;
  /** SNAPISOPAIR: 0 왼쪽, 1 위, 2 오른쪽 */
  pair: IsoPlane;
}

const listeners = new Set<() => void>();

/**
 * 도면의 등각 설정: *Active 뷰포트 레코드의 값(DXF 77·78, DWG VPORT), 레코드에 없으면 R12 DXF 머리말
 * $SNAPSTYLE·$SNAPISOPAIR, 그것도 없으면 0·0. 도면에서 바로 읽으므로 명령 취소(VPORTS 등)로 표가 바뀌어도 맞다.
 */
export function isoState(st: DocState | null): IsoState {
  if (!st) return { style: 0, pair: 0 };
  return vportSnap(st.doc, activeVport(st.doc));
}

const isActive = (v: VPortRecord) => v.name.toUpperCase() === '*ACTIVE';

/** *Active 레코드가 없는 도면(VPORT 표가 없는 DXF)에 둘 레코드: 지금 화면·격자·스냅(저장할 때 화면은 다시 맞춘다) */
function newActiveRecord(app: App, st: DocState): VPortRecord {
  const v = app.view;
  const cam = v.camera();
  const h = Math.max(1, v.height);
  return {
    name: '*Active',
    handle: st.session.newHandle(),
    flags: 0,
    lowerLeft: { x: 0, y: 0 },
    upperRight: { x: 1, y: 1 },
    center: { x: cam.cx, y: cam.cy },
    snapBase: { x: st.snap.baseX, y: st.snap.baseY },
    snapSpacing: { x: st.snap.x, y: st.snap.y },
    gridSpacing: { x: st.grid.x, y: st.grid.y },
    viewDirection: { x: 0, y: 0, z: 1 },
    viewTarget: { x: 0, y: 0, z: 0 },
    height: h / cam.scale,
    aspect: Math.max(1, v.width) / h,
    lensLength: 50,
    twist: 0,
  };
}

/**
 * 등각 설정을 도면에 기록한다: *Active 레코드(타일 뷰포트면 모두)의 snapStyle·snapIsoPair. 명령 취소 기록 없이
 * 문서와 워커 문서에 바로 쓰고 수정 표시만 한다(AutoCAD도 SNAPSTYL·F5는 명령 취소 단위가 아니다). 바뀌었으면 true
 */
export function storeIso(app: App, st: DocState, s: IsoState): boolean {
  const doc = st.doc;
  const same = (v: VPortRecord | undefined) => {
    const cur = vportSnap(doc, v);
    return cur.style === s.style && cur.pair === s.pair;
  };
  const before = doc.vports.slice();
  let after = before.map((v) => (!isActive(v) || same(v) ? v : { ...v, snapStyle: s.style, snapIsoPair: s.pair }));
  if (!after.some(isActive) && !same(undefined)) after = [{ ...newActiveRecord(app, st), snapStyle: s.style, snapIsoPair: s.pair }, ...after];
  if (after.length === before.length && after.every((v, i) => v === before[i])) return false;
  doc.vports.splice(0, doc.vports.length, ...after);
  app.engine?.edit(st.docId, [{ kind: 'vports', before, after }]);
  if (st.session) st.session.dirty = true;
  app.ui?.refreshTabs();
  return true;
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

/** 등각 설정을 바꾼다(명령 취소 단위가 아니다 — AutoCAD의 F5·상태 막대와 같다). 도면에 기록하고 수정 표시를 한다 */
export function setIso(app: App, st: DocState, patch: Partial<IsoState>): void {
  const cur = isoState(st);
  storeIso(app, st, { style: patch.style ?? cur.style, pair: patch.pair ?? cur.pair });
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

let gridInfoOrig: App['view']['gridInfo'] = null;
let gridHooked = false;
let crossOff = false;

/** 등각 격자 스냅(종이 공간에서 뷰포트 안에 들어간 MSPACE는 스냅하지 않는다 — 표준 격자 스냅과 같다) */
function isoGridSnap(st: DocState, w: Pt): Pt {
  if (st.msVp) return w;
  const u = currentUcs(st);
  return toWcs(u, isoSnapPoint(toUcs(u, w), { x: st.snap.baseX, y: st.snap.baseY }, st.snap.y));
}

/**
 * 등각투영 제도의 점 해석(App.pointFilters 고리). 객체 스냅은 App이 먼저 보고, 잡히지 않았을 때만 부른다.
 * 등각이 아니면 null(앱의 표준 추적·격자 스냅·직교).
 */
export function resolveIsoPoint(app: App, w: Pt, req: { readonly base: Pt | null; readonly acquired: readonly Acquired[] }): ResolvedPoint | null {
  const st = app.active;
  const plane = isoPlaneOf(st);
  if (plane === null || !st) return null;
  // 1) 극좌표·객체 스냅 추적: 등각 각도(30°·90°·150°…, UCS X축 기준)
  const tol = 8 * app.view.pixelSize();
  const fmt = (v: number) => formatLength(v, st.units);
  const u = currentUcs(st);
  const iso = isoPolarAngles().map((a) => a + u.angle);
  if (app.otrackOn && req.acquired.length) {
    const t = objectTrack(req.acquired, w, iso, tol, req.base, app.polarOn ? iso : null, fmt);
    if (t) return { p: t.p, snap: null, track: t };
  }
  if (req.base && app.polarOn && !app.orthoOn) {
    const t = polarTrack(req.base, w, iso, tol, fmt);
    if (t) return { p: t.p, snap: null, track: t };
  }
  // 2) 등각 격자 스냅
  let q = app.snapOn ? isoGridSnap(st, w) : w;
  // 3) 등각 직교: 평면의 두 축 중 가까운 쪽(UCS 기준)
  if (req.base && app.orthoOn) q = toWcs(u, isoOrthoPoint(toUcs(u, req.base), toUcs(u, q), plane));
  return { p: q, snap: null };
}

/** 점 해석 고리를 달고, 격자 표시를 등각 모드에 맞게 한다(한 번만) */
export function installIsoHooks(app: App): void {
  addHook(app.pointFilters, { name: 'iso', resolve: (w, req) => resolveIsoPoint(app, w, req) });
  // 표준 격자(CadView.gridInfo — App이 단 공개 고리)는 등각일 때 끄고, 등각 격자는 덧그림에서 그린다
  if (gridHooked || !app.view) return;
  gridHooked = true;
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
