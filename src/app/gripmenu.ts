/**
 * 다기능 그립(AutoCAD 2026): 선택한 객체의 그립에 커서를 올리거나 그립을 오른쪽 클릭하면 보이는 옵션 메뉴(App.gripMenuProviders)와
 * 그립 편집(GRIPEDIT, src/app/modify.ts)이 함께 쓰는 도우미.
 *
 *  - gripOptions: 그립 하나의 옵션(신축이 첫 옵션). 폴리선 정점 추가·제거·호로/선으로 변환, 선·호 길이 조정, 호 반지름,
 *    스플라인 맞춤점·정점 추가·제거·정련·접선 방향, 치수 문자 옮기기(치수선과 함께·문자만·지시선과 함께)·치수선 위·수직 가운데·
 *    문자 위치 재설정, 치수선 끝의 연속·기준선 치수. 형상 계산은 src/edit/geom/gripops.ts.
 *  - registerGripMenu: 메뉴 항목을 고리로 단다. 항목은 그 그립을 핫 그립으로 GRIPEDIT를 시작한다(arg = 'opt:열쇠' — 옵션을 바로 실행,
 *    확정은 명령 취소 한 단계). 연속·기준선 치수는 그 치수로 DIMCONTINUE·DIMBASELINE을 시작한다.
 *  - ctrlHeld: 지금 Ctrl(⌘)을 누르고 있는지(그립 편집에서 Ctrl을 누른 채 찍으면 복사·간격 배수 스냅)
 *  - gripDimGeom: 그립 신축 미리보기에 덧그리는 동적 치수(가는 치수선과 단선 글꼴 문자)
 *  - previewEntities: 미리보기용 객체(치수는 치수 생성기로 다시 그린 블록 내용)
 */
import type { CadDocument, DimensionEntity, Entity, SplineEntity } from '../core/model';
import { formatAngle, formatLength, type UnitSettings } from '../core/units';
import { generateDimensionGeometry } from '../edit/dim';
import type { EditResult } from '../edit/geom';
import {
  type GripDim,
  arcRadiusGrip,
  arcRadiusTo,
  dimTextHome,
  dimTextMoveGrip,
  dimTextVertical,
  isGripPolyline,
  lengthenGrip,
  lengthenGripTo,
  polyAddVertex,
  polyRemoveVertex,
  polySegmentIsArc,
  polySegmentToArc,
  polySegmentToLine,
  splineCvDeleteGrip,
  splineCvInsertGrip,
  splineCvRefineGrip,
  splineFitAddGrip,
  splineFitDeleteGrip,
  splineFitTangentGrip,
} from '../edit/geom/gripops';
import { isFitSpline, isSplineClosed } from '../edit/geom/splinedit';
import { strokeFace } from '../text/fonts';
import type { App } from './app';
import type { DocState } from './docstate';
import { type GripMenuItem, addHook } from './hooks';
import { unlockedOnly } from './layers';
import type { OverlayGeom, Pt } from './view';

/** 그립 하나(App.gripList의 항목) */
export interface GripRef {
  readonly handle: string;
  readonly id: string;
  readonly point: Pt;
}

/** 다기능 그립 옵션 */
export interface GripOption {
  /** 그립 편집 중 명령 키워드의 열쇠(오른쪽 클릭 메뉴에 보인다). 신축은 'ST' */
  readonly key: string;
  readonly label: string;
  /** stretch = 그립 편집의 신축, point = 점(또는 값)을 받는다, now = 바로 실행, command = 다른 명령을 시작한다 */
  readonly kind: 'stretch' | 'point' | 'now' | 'command';
  /** point 옵션의 프롬프트 */
  readonly prompt?: string;
  /** 숫자도 받는다(길이·반지름) */
  readonly numeric?: boolean;
  /** 점 p로(now는 점 없이) 만든 결과 */
  apply?(p?: Pt): EditResult;
  /** 입력한 값으로 만든 결과 */
  value?(v: number, cursor: Pt | null): EditResult;
  /** command 옵션: 그 명령을 시작한다 */
  start?(): void;
}

const STRETCH: GripOption = { key: 'ST', label: '신축', kind: 'stretch' };
const NO_POINT: EditResult = { message: '점을 지정하십시오.' };

/** 그립 하나의 옵션(신축이 처음). 신축밖에 없으면 빈 배열 */
export function gripOptions(app: App, grip: GripRef, e: Entity, st: DocState): GripOption[] {
  const doc = st.doc;
  const id = grip.id;
  const out: GripOption[] = [];
  switch (e.type) {
    case 'LINE':
    case 'ARC':
    case 'ELLIPSE': {
      if (id === 'start' || id === 'end') {
        if (e.type === 'ELLIPSE' && Math.abs(e.endParam - e.startParam) >= Math.PI * 2 - 1e-6) break;
        out.push(STRETCH, {
          key: 'LE',
          label: '길이 조정',
          kind: 'point',
          prompt: '끝점 지정 또는 전체 길이 입력:',
          numeric: true,
          apply: (p) => (p ? lengthenGrip(e, id, p, doc) : NO_POINT),
          value: (v) => lengthenGripTo(e, id, v, doc),
        });
      } else if (e.type === 'ARC' && id === 'mid') {
        out.push(STRETCH, {
          key: 'RA',
          label: '반지름',
          kind: 'point',
          prompt: '반지름 지정:',
          numeric: true,
          apply: (p) => (p ? arcRadiusGrip(e, p, doc) : NO_POINT),
          value: (v) => arcRadiusTo(e, v),
        });
      }
      break;
    }
    case 'LWPOLYLINE':
    case 'POLYLINE': {
      if (!isGripPolyline(e) || !/^[vm]\d+$/.test(id)) break;
      out.push(STRETCH, { key: 'AD', label: '정점 추가', kind: 'point', prompt: '새 정점 지정:', apply: (p) => (p ? polyAddVertex(e, id, p) : NO_POINT) });
      if (id[0] === 'v') out.push({ key: 'RE', label: '정점 제거', kind: 'now', apply: () => polyRemoveVertex(e, id) });
      else if (polySegmentIsArc(e, Number(id.slice(1)))) out.push({ key: 'LI', label: '선으로 변환', kind: 'now', apply: () => polySegmentToLine(e, id) });
      else out.push({ key: 'AR', label: '호로 변환', kind: 'point', prompt: '호의 중간점 지정:', apply: (p) => (p ? polySegmentToArc(e, id, p) : NO_POINT) });
      break;
    }
    case 'SPLINE':
      out.push(...splineOptions(e, id));
      break;
    case 'DIMENSION':
      out.push(...dimOptions(app, e, id, doc));
      break;
    default:
      break;
  }
  return out;
}

function splineOptions(e: SplineEntity, id: string): GripOption[] {
  const i = Number(id.slice(1));
  if (!Number.isInteger(i) || i < 0) return [];
  if (id[0] === 'f' && isFitSpline(e)) {
    const out: GripOption[] = [
      { ...STRETCH, label: '맞춤점 신축' },
      { key: 'AD', label: '맞춤점 추가', kind: 'point', prompt: '새 맞춤점 지정:', apply: (p) => (p ? splineFitAddGrip(e, i, p) : NO_POINT) },
      { key: 'RE', label: '맞춤점 제거', kind: 'now', apply: () => splineFitDeleteGrip(e, i) },
    ];
    if (!isSplineClosed(e) && (i === 0 || i === e.fitPoints.length - 1))
      out.push({ key: 'TA', label: '접선 방향', kind: 'point', prompt: '접선 방향 지정:', apply: (p) => (p ? splineFitTangentGrip(e, i, p) : NO_POINT) });
    return out;
  }
  if (id[0] === 'c' && e.controlPoints.length >= 2) {
    return [
      { ...STRETCH, label: '정점 신축' },
      { key: 'AD', label: '정점 추가', kind: 'point', prompt: '새 정점 지정:', apply: (p) => (p ? splineCvInsertGrip(e, i, p) : NO_POINT) },
      { key: 'RF', label: '정점 정련', kind: 'now', apply: () => splineCvRefineGrip(e, i) },
      { key: 'RE', label: '정점 제거', kind: 'now', apply: () => splineCvDeleteGrip(e, i) },
    ];
  }
  return [];
}

function dimOptions(app: App, e: DimensionEntity, id: string, doc: CadDocument): GripOption[] {
  const kind = e.dimType & 7;
  if (id === 'textMid') {
    const home: GripOption = { key: 'HO', label: '문자 위치 재설정', kind: 'now', apply: () => dimTextHome(e) };
    // 세로좌표·꺾기 반지름 치수의 문자는 지시선 끝·치수선 위에만 놓인다
    if (kind === 6 || e.subtype === 'LARGE_RADIAL_DIMENSION') return [STRETCH, home];
    const mv = (key: string, label: string, mode: 0 | 1 | 2): GripOption => ({ key, label, kind: 'point', prompt: '대상점 지정:', apply: (p) => (p ? dimTextMoveGrip(e, mode, p, doc) : NO_POINT) });
    return [
      STRETCH,
      mv('DL', '치수선과 함께 이동', 0),
      mv('TX', '문자만 이동', 2),
      mv('LD', '지시선과 함께 이동', 1),
      { key: 'AB', label: '치수선 위', kind: 'now', apply: () => dimTextVertical(e, 1) },
      { key: 'VC', label: '수직 가운데', kind: 'now', apply: () => dimTextVertical(e, 0) },
      home,
    ];
  }
  // 치수선 끝: 선형·정렬 치수의 연속·기준선 치수(그 치수를 기준으로 DIMCONTINUE·DIMBASELINE)
  if (id === 'defPoint' && (kind === 0 || kind === 1) && !e.subtype) {
    return [
      STRETCH,
      { key: 'CO', label: '연속 치수', kind: 'command', start: () => startFromDimension(app, e.handle, 'DIMCONTINUE') },
      { key: 'BA', label: '기준선 치수', kind: 'command', start: () => startFromDimension(app, e.handle, 'DIMBASELINE') },
    ];
  }
  return [];
}

/**
 * 그 치수를 직전 치수로 보고 DIMCONTINUE·DIMBASELINE을 시작한다. 두 명령은 시작할 때(첫 입력을 묻기 전) 직전에 만든 객체에서
 * 기준 치수를 찾으므로, 명령을 시작하는 동안만 App.lastCreated를 그 치수로 두었다가 되돌린다
 */
function startFromDimension(app: App, handle: string, name: 'DIMCONTINUE' | 'DIMBASELINE'): void {
  const list = app.lastCreated;
  const saved = list.splice(0, list.length, handle);
  try {
    void app.run(name);
  } finally {
    // 명령이 그 사이 새 치수를 만들지 않았으면 원래 목록으로
    if (list.length === 1 && list[0] === handle) list.splice(0, 1, ...saved);
  }
}

// ---------------------------------------------------------------------------
// 메뉴 고리
// ---------------------------------------------------------------------------

/** 다기능 그립 메뉴를 단다(main.ts에서 한 번) */
export function registerGripMenu(app: App): void {
  trackModifiers();
  addHook(app.gripMenuProviders, {
    name: 'grip-options',
    items(grip, entity, st): GripMenuItem[] | null {
      // 잠긴 도면층의 객체는 그립 편집을 하지 않는다
      if (!unlockedOnly(app, [grip.handle]).length) return null;
      const opts = gripOptions(app, grip, entity, st);
      if (opts.length < 2) return null;
      return opts.map((o) => ({ label: o.label, run: () => runGripOption(app, grip, o) }));
    },
  });
}

/** 메뉴에서 고른 옵션: 연속·기준선은 그 명령을, 나머지는 그 그립을 핫 그립으로 GRIPEDIT를 시작한다 */
export function runGripOption(app: App, grip: GripRef, o: GripOption): void {
  if (o.kind === 'command') {
    o.start?.();
    return;
  }
  const point = { x: grip.point.x, y: grip.point.y };
  const item = { handle: grip.handle, id: grip.id, point };
  // 신축은 그 그립을 누른 것과 같다(같은 점에 겹친 다른 객체의 그립도 함께), 옵션은 그 그립 하나
  const tol = 1e-9 * Math.max(1, Math.abs(point.x) + Math.abs(point.y));
  const same = o.kind === 'stretch' ? (app.gripList ?? []).filter((g) => Math.abs(g.point.x - point.x) <= tol && Math.abs(g.point.y - point.y) <= tol).map((g) => ({ handle: g.handle, id: g.id, point: g.point })) : [];
  app.hotGrip = { point, items: same.length ? same : [item] };
  app.view.overlay.hotGrip = point;
  void app.run('GRIPEDIT', o.kind === 'stretch' ? undefined : `opt:${o.key}`);
}

// ---------------------------------------------------------------------------
// Ctrl 상태
// ---------------------------------------------------------------------------

const mods = { ctrl: false };
let tracking = false;

/** 창의 키·포인터 사건에서 Ctrl(⌘) 상태를 읽어 둔다(한 번만 단다) */
export function trackModifiers(): void {
  if (tracking || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  tracking = true;
  const f = (ev: Event) => {
    const k = ev as KeyboardEvent | PointerEvent;
    mods.ctrl = !!(k.ctrlKey || k.metaKey);
  };
  for (const t of ['keydown', 'keyup', 'pointerdown', 'pointermove', 'pointerup']) window.addEventListener(t, f, true);
  window.addEventListener('blur', () => {
    mods.ctrl = false;
  });
}

/** 지금 Ctrl(⌘)을 누르고 있는지 */
export function ctrlHeld(): boolean {
  return mods.ctrl;
}

/** 시험용: Ctrl 상태를 정한다 */
export function setCtrlHeld(on: boolean): void {
  mods.ctrl = on;
}

// ---------------------------------------------------------------------------
// 미리보기
// ---------------------------------------------------------------------------

/** 미리보기로 그릴 객체: 치수는 치수 생성기가 만든 블록 내용(문서에 아직 없는 블록 대신) */
export function previewEntities(doc: CadDocument, list: readonly Entity[]): Entity[] {
  const out: Entity[] = [];
  for (const e of list) {
    if (e.type !== 'DIMENSION') {
      out.push(e);
      continue;
    }
    try {
      const g = generateDimensionGeometry(doc, structuredClone(e));
      out.push(...g.entities.filter((x) => x.type !== 'POINT'));
    } catch {
      out.push(e);
    }
  }
  return out;
}

const readable = (a: number): number => {
  let r = a % (Math.PI * 2);
  if (r < 0) r += Math.PI * 2;
  return r > Math.PI / 2 + 1e-9 && r <= (Math.PI * 3) / 2 + 1e-9 ? r - Math.PI : r;
};

/** 단선 글꼴 문자의 선분(가운데 맞춤, 문자 높이 h, 각도 ang, 문자 가운데가 at) */
export function textSegs(out: number[], s: string, at: Pt, h: number, ang: number): void {
  const cs = Math.cos(ang);
  const sn = Math.sin(ang);
  const chars = [...s].map((ch) => {
    const code = ch.codePointAt(0)!;
    const gl = code === 0xb0 ? null : strokeFace.glyph(code);
    return { code, gl, adv: code === 0xb0 ? 0.5 : (gl?.advance ?? 0.7) };
  });
  const w = chars.reduce((n, c) => n + c.adv, 0);
  const put = (gx: number, gy: number) => out.push(at.x + (gx * cs - gy * sn) * h, at.y + (gx * sn + gy * cs) * h);
  let x = -w / 2;
  const y0 = -0.5;
  for (const c of chars) {
    if (c.code === 0xb0) {
      // 도(°): 작은 원
      const cx = x + 0.25;
      const cy = y0 + 0.85;
      for (let k = 0; k < 8; k++) {
        const a0 = (k / 8) * Math.PI * 2;
        const a1 = ((k + 1) / 8) * Math.PI * 2;
        put(cx + 0.15 * Math.cos(a0), cy + 0.15 * Math.sin(a0));
        put(cx + 0.15 * Math.cos(a1), cy + 0.15 * Math.sin(a1));
      }
    } else if (c.gl?.segs) {
      const g = c.gl.segs;
      for (let i = 0; i + 3 < g.length; i += 4) {
        put(x + g[i]!, y0 + g[i + 1]!);
        put(x + g[i + 2]!, y0 + g[i + 3]!);
      }
    }
    x += c.adv;
  }
}

/** 동적 치수(가는 치수선·보조선·화살표와 문자). h = 문자 높이(도면 단위, 보통 화면 10px) */
export function gripDimGeom(dims: readonly GripDim[], h: number, units: Pick<UnitSettings, 'lunits' | 'luprec' | 'aunits' | 'auprec'>): OverlayGeom {
  const s: number[] = [];
  const seg = (a: Pt, b: Pt) => s.push(a.x, a.y, b.x, b.y);
  const at = (p: Pt, u: Pt, k: number, n: Pt, m: number): Pt => ({ x: p.x + u.x * k + n.x * m, y: p.y + u.y * k + n.y * m });
  const off = 2 * h;
  let angleShown = false;
  for (const d of dims) {
    if (d.kind === 'aligned') {
      const L = Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y);
      if (!(L > 1e-12)) continue;
      const u = { x: (d.b.x - d.a.x) / L, y: (d.b.y - d.a.y) / L };
      const n = { x: -u.y, y: u.x };
      const a1 = at(d.a, u, 0, n, off);
      const b1 = at(d.b, u, 0, n, off);
      seg(at(d.a, u, 0, n, 0.4 * h), at(d.a, u, 0, n, off + 0.6 * h));
      seg(at(d.b, u, 0, n, 0.4 * h), at(d.b, u, 0, n, off + 0.6 * h));
      seg(a1, b1);
      const ah = Math.min(0.8 * h, L / 3);
      seg(a1, at(a1, u, ah, n, 0.25 * h));
      seg(a1, at(a1, u, ah, n, -0.25 * h));
      seg(b1, at(b1, u, -ah, n, 0.25 * h));
      seg(b1, at(b1, u, -ah, n, -0.25 * h));
      textSegs(s, formatLength(L, units), at({ x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 }, u, 0, n, 0.9 * h), h, readable(Math.atan2(u.y, u.x)));
      if (!angleShown) {
        // 각도: 기준점에서 +X 방향 기준선과 그 사이 호
        angleShown = true;
        let th = Math.atan2(u.y, u.x);
        if (th < 0) th += Math.PI * 2;
        const R = Math.min(4 * h, L * 0.6);
        seg(d.a, { x: d.a.x + R + h, y: d.a.y });
        const sw = th <= Math.PI ? th : th - Math.PI * 2;
        const N = Math.max(2, Math.ceil(Math.abs(sw) / (Math.PI / 24)));
        for (let k = 0; k < N; k++) {
          const t0 = (sw * k) / N;
          const t1 = (sw * (k + 1)) / N;
          seg({ x: d.a.x + R * Math.cos(t0), y: d.a.y + R * Math.sin(t0) }, { x: d.a.x + R * Math.cos(t1), y: d.a.y + R * Math.sin(t1) });
        }
        const tm = sw / 2;
        textSegs(s, formatAngle(th, units), { x: d.a.x + (R + 1.6 * h) * Math.cos(tm), y: d.a.y + (R + 1.6 * h) * Math.sin(tm) }, h, 0);
      }
    } else if (d.kind === 'arc') {
      const R = d.r + off;
      const N = Math.max(2, Math.ceil(Math.abs(d.sw) / (Math.PI / 24)));
      const P = (r: number, t: number): Pt => ({ x: d.c.x + r * Math.cos(t), y: d.c.y + r * Math.sin(t) });
      for (let k = 0; k < N; k++) seg(P(R, d.a0 + (d.sw * k) / N), P(R, d.a0 + (d.sw * (k + 1)) / N));
      for (const t of [d.a0, d.a0 + d.sw]) seg(P(d.r + 0.4 * h, t), P(R + 0.6 * h, t));
      const tm = d.a0 + d.sw / 2;
      textSegs(s, formatLength(Math.abs(d.sw) * d.r, units), P(R + 0.9 * h, tm), h, readable(tm + Math.PI / 2));
    } else {
      const L = Math.hypot(d.p.x - d.c.x, d.p.y - d.c.y);
      if (!(L > 1e-12)) continue;
      const u = { x: (d.p.x - d.c.x) / L, y: (d.p.y - d.c.y) / L };
      const n = { x: -u.y, y: u.x };
      seg(d.c, d.p);
      const ah = Math.min(0.8 * h, L / 3);
      seg(d.p, at(d.p, u, -ah, n, 0.25 * h));
      seg(d.p, at(d.p, u, -ah, n, -0.25 * h));
      textSegs(s, `R${formatLength(d.r, units)}`, at({ x: (d.c.x + d.p.x) / 2, y: (d.c.y + d.p.y) / 2 }, u, 0, n, 0.9 * h), h, readable(Math.atan2(u.y, u.x)));
    }
  }
  return { segs: s };
}
