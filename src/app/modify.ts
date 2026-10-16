/**
 * 수정 명령: MOVE, COPY, ROTATE, SCALE, MIRROR, OFFSET, TRIM, EXTEND, BREAK, BREAKATPOINT, LENGTHEN, EXPLODE,
 * ARRAYRECT, ARRAYPOLAR, COPYCLIP, CUTCLIP, COPYBASE, PASTECLIP
 * 프롬프트와 옵션은 AutoCAD 2026 한국어판을 따른다. 기하 계산은 src/edit/geom.
 */
import type { BlockDef, BlockRecord, CadDocument, Entity, HatchEntity } from '../core/model';
import { entityDefaults, tableKey } from '../core/model';
import { formatLength } from '../core/units';
import type { EditOp } from '../edit/session';
import { cloneEntity } from '../edit/session';
import {
  type EditResult,
  type LengthenMode,
  breakEntity,
  chamfer,
  chamferAngle,
  chamferPolyline,
  chamferPolylineAngle,
  copyEntity,
  explodeEntity,
  extendEntity,
  fillet,
  filletPolyline,
  gripMove,
  joinEntities,
  lengthenEntity,
  nearestPointOn,
  offsetEntity,
  stretch,
  transformEntity,
  trimEntity,
} from '../edit/geom';
import { entityPath } from '../edit/geom/path';
import { associatedHatches, boundaryEntitiesOf, dissociate, reactorUnlinks, rebuildAssociative } from '../edit/hatch';
import { pathLength } from '../edit/geom/curve';
import { dimensionBlockOps } from './dimcmds';
import { planFollow } from './dimassoc';
import type { App, CommandContext, Keyword } from './app';
import type { DocState } from './docstate';
import type { OverlayGeom, Pt } from './view';
import { unlockedOnly } from './layers';
import { form } from './ui/dom';
import { dynGripEdit } from './dynblock';
import { currentProps } from './draw';
import { constraintEditHook } from './constraints-hook';
import { arrayAssociativity, createAssocArray, setArrayAssociativity } from './assocarray';
import { registerArrayCommands } from './arraycmd';
import { registerMocoroCommand } from './mocoro';
import { crossingPick, fencePicks, lengthenToPoint } from '../edit/geom/modgeom';
import { arrayGripEdit } from './assocarray-grips';
import { gripDims, gripMoveMany, gripStretchValue, gripTakesValue } from '../edit/geom/gripops';
import { type GripOption, ctrlHeld, gripDimGeom, gripOptions, previewEntities, trackModifiers } from './gripmenu';
import { stretchSelection } from './editcmds2-stretch';
import { pasteDependencies } from './pastedeps';

// ---------------------------------------------------------------------------
// 변환 행렬(x' = a·x + c·y + e, y' = b·x + d·y + f)
// ---------------------------------------------------------------------------

export type Affine = [number, number, number, number, number, number];

export const translate = (dx: number, dy: number): Affine => [1, 0, 0, 1, dx, dy];

export function rotateAbout(c: Pt, a: number): Affine {
  const cs = Math.cos(a);
  const sn = Math.sin(a);
  return [cs, sn, -sn, cs, c.x - cs * c.x + sn * c.y, c.y - sn * c.x - cs * c.y];
}

export function scaleAbout(c: Pt, k: number): Affine {
  return [k, 0, 0, k, c.x * (1 - k), c.y * (1 - k)];
}

/** p→q 직선 대칭 */
export function mirrorAbout(p: Pt, q: Pt): Affine | null {
  let ux = q.x - p.x;
  let uy = q.y - p.y;
  const l = Math.hypot(ux, uy);
  if (l < 1e-12) return null;
  ux /= l;
  uy /= l;
  const a = ux * ux - uy * uy;
  const b = 2 * ux * uy;
  return [a, b, b, -a, p.x - a * p.x - b * p.y, p.y - b * p.x + a * p.y];
}

/** 두 변환을 잇는다(먼저 m1, 다음 m2) */
export function compose(m1: Affine, m2: Affine): Affine {
  return [
    m2[0] * m1[0] + m2[2] * m1[1],
    m2[1] * m1[0] + m2[3] * m1[1],
    m2[0] * m1[2] + m2[2] * m1[3],
    m2[1] * m1[2] + m2[3] * m1[3],
    m2[0] * m1[4] + m2[2] * m1[5] + m2[4],
    m2[1] * m1[4] + m2[3] * m1[5] + m2[5],
  ];
}

const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);
const ang = (a: Pt, b: Pt) => Math.atan2(b.y - a.y, b.x - a.x);
const deg = (r: number) => (r * 180) / Math.PI;
const num = (s: string) => {
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
};

// ---------------------------------------------------------------------------
// 끌기 미리보기
// ---------------------------------------------------------------------------

/** 고른 객체의 형상을 한 번 모아 두고, 변환만 바꿔 그린다 */
export class Ghost {
  private segs: number[] = [];
  private tris: number[] = [];

  /** 이미 있는 형상으로 */
  static of(g: OverlayGeom): Ghost {
    const x = new Ghost(null, []);
    x.segs = g.segs;
    x.tris = g.tris ?? [];
    return x;
  }

  constructor(app: App | null, handles: readonly string[], limit = 400_000) {
    if (!app) return;
    const pk = app.picker();
    if (!pk) return;
    for (const h of handles) {
      const g = pk.geometry(h);
      if (this.segs.length + g.segs.length > limit) break;
      for (const v of g.segs) this.segs.push(v);
      if (g.tris && this.tris.length < limit) for (const v of g.tris) this.tris.push(v);
    }
  }

  at(m: Affine): OverlayGeom[] {
    const map = (src: number[]) => {
      const out = new Array<number>(src.length);
      for (let i = 0; i + 1 < src.length; i += 2) {
        const x = src[i]!;
        const y = src[i + 1]!;
        out[i] = m[0] * x + m[2] * y + m[4];
        out[i + 1] = m[1] * x + m[3] * y + m[5];
      }
      return out;
    };
    return [{ segs: map(this.segs), tris: map(this.tris) }];
  }
}

/** 편집 결과(문서에 아직 없는 객체)의 형상 */
function resultGeom(app: App, res: EditResult): OverlayGeom[] {
  const pk = app.picker();
  if (!pk) return [];
  const list = [...(res.add ?? []), ...(res.replace ?? [])];
  return list.length ? [pk.geometryOf(list)] : [];
}

// ---------------------------------------------------------------------------
// 결과를 편집 작업으로
// ---------------------------------------------------------------------------

/** 새로 넣는 객체: 새 핸들, 소유자, 복사하면 안 되는 연결은 끊는다 */
function prepareNew(st: DocState, e: Entity, ownerHandle: string | undefined): void {
  e.handle = st.session.newHandle();
  if (ownerHandle) e.owner = ownerHandle;
  delete e.xdict;
  delete e.reactors;
  delete e.dwgRaw;
  if (e.type === 'INSERT')
    for (const a of e.attribs) {
      a.handle = st.session.newHandle();
      a.owner = e.handle;
      delete a.xdict;
      delete a.reactors;
      delete a.dwgRaw;
    }
}

/** 블록 정의를 넣거나 바꾸는 작업(익명 블록은 이름에 번호를 붙인다) */
function blockOps(st: DocState, b: BlockDef): EditOp[] {
  const doc = st.doc;
  const def: BlockDef = { ...b, entities: b.entities };
  if (/^\*[A-Z]$/i.test(def.name)) {
    let n = 1;
    while (doc.blocks.has(tableKey(`${def.name}${n}`))) n++;
    def.name = `${def.name}${n}`;
  }
  const key = tableKey(def.name);
  const before = doc.blocks.get(key) ?? null;
  const ops: EditOp[] = [];
  let record = doc.blockRecords.get(key);
  if (!record) {
    const rec: BlockRecord = { name: def.name, handle: def.recordHandle || st.session.newHandle(), flags: def.flags & 1, insertUnits: 0, explodable: true, scalable: true };
    ops.push({ kind: 'blockRecord', key, before: null, after: rec });
    record = rec;
  }
  def.recordHandle = record.handle;
  if (!def.handle) def.handle = before?.handle ?? st.session.newHandle();
  if (!def.endHandle) def.endHandle = before?.endHandle ?? st.session.newHandle();
  for (const e of def.entities) {
    if (!e.handle) e.handle = st.session.newHandle();
    e.owner = record.handle;
  }
  ops.push({ kind: 'blockDef', key, before, after: def });
  return ops;
}

export interface Applied {
  added: string[];
  changed: string[];
  removed: number;
  /** 작업 수(명령 안의 명령 취소용) */
  ops: number;
}

/**
 * 편집 결과들을 한 번에 적용한다.
 * opt.transform: 바뀐 객체가 모두 같은 변환(이동·회전·축척·대칭)을 받았으면 그 행렬(연관 치수가 정확히 따라가게)
 */
export function commitResults(app: App, ctx: CommandContext, results: EditResult[], label: string, opt: { quiet?: boolean; transform?: Affine } = {}): Applied {
  const st = app.active!;
  const doc = st.doc;
  // 파라메트릭 구속: 구속으로 이어진 객체를 결과에 더하고, 구속 기록 갱신 작업을 받는다
  const cons = constraintEditHook(st, results, label);
  if (!cons.ok) {
    ctx.print(cons.message ?? '구속조건을 유지하면서 객체를 편집할 수 없습니다.', 'err');
    return { added: [], changed: [], removed: 0, ops: 0 };
  }
  // 따라온 객체는 같은 변환을 받지 않았다
  if (cons.results !== results) opt = { ...opt, transform: undefined };
  results = cons.results;
  const ops: EditOp[] = [];
  const out: Applied = { added: [], changed: [], removed: 0, ops: 0 };
  // 블록 정의(치수 블록 등)가 먼저 있어야 참조가 그려진다
  const renamed = new Map<string, string>();
  for (const r of results)
    for (const b of r.blocks ?? []) {
      const bo = blockOps(st, b);
      const def = (bo[bo.length - 1] as { after: BlockDef }).after;
      if (def.name !== b.name) renamed.set(b.name, def.name);
      ops.push(...bo);
    }
  const fixBlock = (e: Entity) => {
    if (e.type === 'DIMENSION' && renamed.has(e.block ?? '')) e.block = renamed.get(e.block ?? '')!;
  };
  // 바뀌거나 새로 생긴 치수는 치수 생성기로 블록을 다시 만든다(AutoCAD처럼 치수 스타일대로)
  const extra = new Set<string>();
  const regen = (e: Entity, before: Entity | undefined) => {
    if (e.type !== 'DIMENSION') return;
    if (before?.type === 'DIMENSION') e.block = before.block;
    try {
      ops.push(...dimensionBlockOps(st, e, !!before, extra));
    } catch {
      /* 생성기가 못 다루면 커널이 만든 블록을 쓴다 */
    }
  };
  // 바꾸기(같은 핸들을 여러 번 바꾸면 마지막 것)
  const mod = new Map<string, Extract<EditOp, { kind: 'modify' }>>();
  for (const r of results)
    for (const e of r.replace ?? []) {
      fixBlock(e);
      const prev = mod.get(e.handle);
      if (prev) {
        prev.after = e;
        continue;
      }
      const before = doc.entityIndex.get(e.handle);
      const block = st.session.ownerOf(e.handle);
      if (!before || !block) continue;
      const op = { kind: 'modify' as const, block, before, after: e };
      mod.set(e.handle, op);
      out.changed.push(e.handle);
    }
  const userMod = new Set(mod.keys());
  // 연관 치수: 형상을 따라 정의점을 옮기고, 지운 형상·벗어난 정의점의 연관을 끊는다(형상 반응자도 맞춘다)
  const follow = (() => {
    const changes = new Map<string, Entity | null>();
    for (const [h, op] of mod) changes.set(h, op.after);
    for (const r of results) for (const h of r.remove ?? []) changes.set(h, null);
    return planFollow(st, changes, opt.transform);
  })();
  const noRegen = new Set<string>();
  for (const [h, e] of follow.entities) {
    const m = mod.get(h);
    if (m) {
      m.after = e;
      continue;
    }
    const before = doc.entityIndex.get(h);
    const block = st.session.ownerOf(h);
    if (!before || !block) continue;
    mod.set(h, { kind: 'modify', block, before, after: e });
    if (!follow.moved.has(h)) noRegen.add(h);
  }
  for (const op of mod.values()) {
    if (!noRegen.has(op.before.handle)) regen(op.after, op.before);
    ops.push(op);
  }
  ops.push(...follow.objectOps);
  // 연관 해치: 경계 객체가 바뀌면 해치 영역을 다시 만들고, 영역이 깨지면 연관을 끊는다
  const touched = new Set(mod.keys());
  for (const r of results) for (const h of r.remove ?? []) touched.add(h);
  for (const op of [...mod.values()]) {
    if (!userMod.has(op.before.handle)) continue;
    for (const hatch of associatedHatches(doc, op.before)) {
      if (touched.has(hatch.handle)) continue;
      touched.add(hatch.handle);
      const owner = st.session.ownerOf(hatch.handle);
      if (!owner) continue;
      const bnd = boundaryEntitiesOf(doc, hatch).map((e) => mod.get(e.handle)?.after ?? e);
      let nh: HatchEntity | null = null;
      try {
        nh = rebuildAssociative(doc, hatch, bnd);
      } catch {
        nh = null;
      }
      if (nh) {
        ops.push({ kind: 'modify', block: owner, before: hatch, after: { ...nh, handle: hatch.handle } });
        continue;
      }
      ops.push({ kind: 'modify', block: owner, before: hatch, after: dissociate(hatch) });
      for (const l of reactorUnlinks(doc, hatch)) {
        const m = mod.get(l.before.handle);
        if (m) {
          // 같은 편집에서 바뀐 다른 반응자(연관 치수 등)는 두고 이 해치만 뺀다
          const next = (m.after.reactors ?? []).filter((x) => x !== hatch.handle);
          const after = { ...m.after } as Entity;
          if (next.length) after.reactors = next;
          else delete after.reactors;
          m.after = after;
        } else {
          const ob = st.session.ownerOf(l.before.handle);
          if (ob) ops.push({ kind: 'modify', block: ob, before: l.before, after: l.after });
        }
      }
    }
  }
  // 지우기(블록마다 뒤에서부터: 되돌릴 때 같은 자리로)
  const rem: { block: string; entity: Entity; index: number }[] = [];
  const gone = new Set<string>();
  for (const r of results)
    for (const h of r.remove ?? []) {
      if (gone.has(h)) continue;
      gone.add(h);
      const e = doc.entityIndex.get(h);
      const block = st.session.ownerOf(h);
      if (!e || !block) continue;
      rem.push({ block, entity: e, index: doc.blocks.get(block)!.entities.indexOf(e) });
    }
  rem.sort((a, b) => (a.block === b.block ? b.index - a.index : a.block < b.block ? -1 : 1));
  for (const x of rem) ops.push({ kind: 'remove', ...x });
  out.removed = rem.length;
  // 더하기(지금 공간)
  const block = doc.blocks.get(st.space);
  for (const r of results)
    for (const e of r.add ?? []) {
      fixBlock(e);
      regen(e, undefined);
      prepareNew(st, e, block?.recordHandle);
      e.paperSpace = /^\*PAPER_SPACE/i.test(st.space) ? true : undefined;
      ops.push({ kind: 'add', block: st.space, entity: e });
      out.added.push(e.handle);
    }
  if (!opt.quiet) {
    const msgs = new Set(results.map((r) => r.message).filter((m): m is string => !!m));
    for (const m of msgs) ctx.print(m);
  }
  ops.push(...cons.ops);
  if (cons.message && !opt.quiet) ctx.print(cons.message);
  if (ops.length) st.session.commit({ label, ops, group: ctx.group });
  out.ops = ops.length;
  return out;
}

/** 명령 안에서 직전 단계 하나를 되돌린다 */
function undoStep(app: App, ctx: CommandContext, steps: number[]): void {
  const n = steps.pop();
  if (n === undefined) {
    ctx.print('명령 취소할 것이 없습니다.');
    return;
  }
  app.active!.session.undoLastStep(ctx.group, n);
}

// ---------------------------------------------------------------------------
// 입력 도우미
// ---------------------------------------------------------------------------

async function selectEditable(app: App, ctx: CommandContext): Promise<string[]> {
  const hs = unlockedOnly(app, await ctx.getSelection());
  return hs.filter((h) => app.active!.doc.entityIndex.has(h));
}

/** x,y 또는 x,y,z 문자열 → 변위 */
function parseVector(t: string): Pt | null {
  const m = /^\s*(-?[\d.]+(?:e-?\d+)?)\s*,\s*(-?[\d.]+(?:e-?\d+)?)(?:\s*,\s*-?[\d.]+(?:e-?\d+)?)?\s*$/i.exec(t);
  if (!m) return null;
  const x = parseFloat(m[1]!);
  const y = parseFloat(m[2]!);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

async function askDisplacement(ctx: CommandContext, def: Pt): Promise<Pt | null> {
  const st = ctx.app.active!;
  for (;;) {
    const r = await ctx.getPoint(`변위 지정 <${formatLength(def.x, st.units)}, ${formatLength(def.y, st.units)}, ${formatLength(0, st.units)}>:`, { allowText: true });
    if ('enter' in r) return def;
    if ('point' in r) return r.point;
    if ('text' in r) {
      const v = parseVector(r.text);
      if (v) return v;
    }
    ctx.print('변위는 x,y 형식으로 입력하십시오.', 'err');
  }
}

/** 기준점·두 번째 점(또는 변위). 고른 것이 없거나 취소하면 null */
async function askMove(ctx: CommandContext, ghost: Ghost, prompt: string, keywords: Keyword[], last: { disp: Pt }): Promise<{ base: Pt; disp: Pt } | { keyword: string } | null> {
  const r = await ctx.getPoint(prompt, { keywords: [{ key: 'D', label: '변위' }, ...keywords] });
  if ('keyword' in r && r.keyword !== 'D') return { keyword: r.keyword };
  if ('enter' in r || ('keyword' in r && r.keyword === 'D')) {
    const d = await askDisplacement(ctx, last.disp);
    if (!d) return null;
    return { base: { x: 0, y: 0 }, disp: d };
  }
  if (!('point' in r)) return null;
  const base = r.point;
  const r2 = await ctx.getPoint('두 번째 점 지정 또는 <첫 번째 점을 변위로 사용>:', { base, ghost: (p) => ghost.at(translate(p.x - base.x, p.y - base.y)) });
  if ('point' in r2) return { base, disp: { x: r2.point.x - base.x, y: r2.point.y - base.y } };
  if ('enter' in r2) return { base, disp: base };
  return null;
}

/** 각도 입력(숫자는 도, 점은 기준점에서의 방향) */
async function askAngle(ctx: CommandContext, prompt: string, base: Pt, def: number, opt: { keywords?: Keyword[]; ghost?: (a: number) => OverlayGeom[] } = {}): Promise<number | { keyword: string }> {
  for (;;) {
    const r = await ctx.getPoint(`${prompt} <${deg(def).toFixed(0)}>:`, {
      base,
      preferNumber: true,
      keywords: opt.keywords,
      ghost: opt.ghost ? (p) => opt.ghost!(ang(base, p)) : undefined,
    });
    if ('enter' in r) return def;
    if ('keyword' in r) return { keyword: r.keyword };
    if ('point' in r) return ang(base, r.point);
    if ('text' in r) {
      const v = num(r.text);
      if (v !== null) return (v * Math.PI) / 180;
    }
    ctx.print('각도(도)를 입력하거나 점을 지정하십시오.', 'err');
  }
}

/** 0이 아닌 양수 입력(축척·길이). 점은 기준점에서의 거리 */
async function askPositive(ctx: CommandContext, prompt: string, base: Pt | null, def: number | null, opt: { keywords?: Keyword[]; ghost?: (v: number) => OverlayGeom[] } = {}): Promise<number | { keyword: string }> {
  const st = ctx.app.active!;
  for (;;) {
    const r = await ctx.getPoint(def !== null ? `${prompt} <${formatLength(def, st.units)}>:` : `${prompt}:`, {
      base,
      preferNumber: true,
      keywords: opt.keywords,
      ghost: opt.ghost && base ? (p) => opt.ghost!(dist(base, p)) : undefined,
    });
    if ('enter' in r && def !== null) return def;
    if ('keyword' in r) return { keyword: r.keyword };
    if ('point' in r && base) {
      const d = dist(base, r.point);
      if (d > 1e-12) return d;
    }
    if ('text' in r) {
      const v = num(r.text);
      if (v !== null && v > 0) return v;
    }
    ctx.print('0보다 큰 값을 입력하십시오.', 'err');
  }
}

async function yesNo(ctx: CommandContext, prompt: string, def: boolean): Promise<boolean> {
  const r = await ctx.getPoint(`${prompt} [예(Y)/아니오(N)] <${def ? '예' : '아니오'}>:`, { keywords: [{ key: 'Y', label: '예' }, { key: 'N', label: '아니오' }] });
  if ('keyword' in r) return r.keyword === 'Y';
  return def;
}

function transformAll(st: DocState, hs: readonly string[], m: Affine, copy: boolean): EditResult[] {
  const doc = st.doc;
  const mirrorText = Number(doc.header.get('$MIRRTEXT') ?? 0) === 1;
  const mirrorHatch = Number(doc.header.get('$MIRRHATCH') ?? 0) === 1;
  const out: EditResult[] = [];
  for (const h of hs) {
    const e = doc.entityIndex.get(h);
    if (!e) continue;
    out.push(copy ? copyEntity(e, m, doc, { mirrorText, mirrorHatch }) : transformEntity(e, m, doc, { mirrorText, mirrorHatch }));
  }
  return out;
}

/** OFFSETGAPTYPE(AutoCAD는 레지스트리에 둔다 — 이 브라우저에 남긴다): 0 연장, 1 모깎기 호, 2 모따기 */
const GAP_KEY = 'opencad.offsetgaptype';
let gapMemo: 0 | 1 | 2 = 0;
export function offsetGapType(): 0 | 1 | 2 {
  try {
    const v = localStorage.getItem(GAP_KEY);
    if (v === '0' || v === '1' || v === '2') return Number(v) as 0 | 1 | 2;
  } catch {
    /* 저장소를 못 쓰면 이 창의 값 */
  }
  return gapMemo;
}
export function setOffsetGapType(v: 0 | 1 | 2): void {
  gapMemo = v;
  try {
    localStorage.setItem(GAP_KEY, String(v));
  } catch {
    /* 저장소를 못 쓰면 이 창에만 */
  }
}

/** 문서 단위로 기억하는 명령 기본값 */
const memo = new WeakMap<DocState, Record<string, number | string | boolean>>();
function mem(st: DocState): Record<string, number | string | boolean> {
  let m = memo.get(st);
  if (!m) {
    m = {};
    memo.set(st, m);
  }
  return m;
}

// ---------------------------------------------------------------------------
// 클립보드
// ---------------------------------------------------------------------------

interface Clip {
  doc: CadDocument;
  entities: Entity[];
  base: Pt;
}
let clipboard: Clip | null = null;

/** 이 앱 클립보드(선택하여 붙여넣기 PASTESPEC가 형식을 고르고 그림으로 붙일 때 읽는다). 비었으면 null */
export function clipboardContent(): { readonly doc: CadDocument; readonly entities: readonly Entity[]; readonly base: Pt } | null {
  return clipboard?.entities.length ? clipboard : null;
}

function extentsOf(app: App, hs: readonly string[]): [number, number, number, number] | null {
  const pk = app.picker();
  if (!pk) return null;
  let r: [number, number, number, number] | null = null;
  for (const h of hs) {
    const b = pk.box(h);
    if (!b) continue;
    if (!r) r = [b.minX, b.minY, b.maxX, b.maxY];
    else r = [Math.min(r[0], b.minX), Math.min(r[1], b.minY), Math.max(r[2], b.maxX), Math.max(r[3], b.maxY)];
  }
  return r;
}

/**
 * 다른 도면에서 붙여 넣을 때 없는 도면층·선종류·스타일(문자·치수·다중 지시선·테이블·여러 줄)·블록을 함께 가져온다(pastedeps.ts).
 * 익명 블록(*D·*U·*T …)은 이 도면의 같은 이름과 겹치지 않게 새 번호로 옮긴다. list의 객체는 이 도면의 이름을 가리키게 바뀐다
 */
export function importDependencies(st: DocState, src: CadDocument, list: Entity[]): EditOp[] {
  return pasteDependencies(st, src, list);
}

// ---------------------------------------------------------------------------

export function registerModifyCommands(app: App): void {
  // ------------------------------------------------------------- MOVE
  app.register({
    name: 'MOVE',
    aliases: ['M'],
    title: '이동',
    async run(ctx) {
      const st = app.active!;
      const hs = await selectEditable(app, ctx);
      if (!hs.length) return;
      const ghost = new Ghost(app, hs);
      const m = mem(st);
      const last = { disp: { x: Number(m.moveX ?? 0), y: Number(m.moveY ?? 0) } };
      const r = await askMove(ctx, ghost, '기준점 지정 또는 [변위(D)] <변위>:', [], last);
      if (!r || 'keyword' in r) return;
      m.moveX = r.disp.x;
      m.moveY = r.disp.y;
      if (!r.disp.x && !r.disp.y) return;
      st.selection.clear();
      const mv = translate(r.disp.x, r.disp.y);
      const a = commitResults(app, ctx, transformAll(st, hs, mv, false), 'MOVE', { transform: mv });
      app.refreshSelectionOverlay();
      ctx.print(`${a.changed.length + a.added.length}개를 옮겼습니다.`);
    },
  });

  // ------------------------------------------------------------- COPY
  app.register({
    name: 'COPY',
    aliases: ['CO', 'CP'],
    title: '복사',
    async run(ctx) {
      const st = app.active!;
      const hs = await selectEditable(app, ctx);
      if (!hs.length) return;
      const m = mem(st);
      const ghost = new Ghost(app, hs);
      for (;;) {
        const multiple = m.copyMode !== 'S';
        ctx.print(`현재 설정: 복사 모드 = ${multiple ? '다중(M)' : '단일(S)'}`);
        const r = await ctx.getPoint('기준점 지정 또는 [변위(D)/모드(O)] <변위>:', { keywords: [{ key: 'D', label: '변위' }, { key: 'O', label: '모드' }] });
        if ('keyword' in r && r.keyword === 'O') {
          const k = await ctx.getPoint(`복사 모드 옵션 입력 [단일(S)/다중(M)] <${multiple ? '다중' : '단일'}>:`, { keywords: [{ key: 'S', label: '단일' }, { key: 'M', label: '다중' }] });
          if ('keyword' in k) m.copyMode = k.keyword;
          continue;
        }
        if ('enter' in r || ('keyword' in r && r.keyword === 'D')) {
          const d = await askDisplacement(ctx, { x: Number(m.moveX ?? 0), y: Number(m.moveY ?? 0) });
          if (!d) return;
          commitResults(app, ctx, transformAll(st, hs, translate(d.x, d.y), true), 'COPY');
          return;
        }
        if (!('point' in r)) return;
        const base = r.point;
        const steps: number[] = [];
        let first = true;
        for (;;) {
          const kws: Keyword[] = first ? [{ key: 'A', label: '배열' }] : [{ key: 'A', label: '배열' }, { key: 'E', label: '종료' }, { key: 'U', label: '명령 취소' }];
          const prompt = first ? '두 번째 점 지정 또는 [배열(A)] <첫 번째 점을 변위로 사용>:' : '두 번째 점 지정 또는 [배열(A)/종료(E)/명령 취소(U)] <종료>:';
          const p = await ctx.getPoint(prompt, { base, keywords: kws, ghost: (q) => ghost.at(translate(q.x - base.x, q.y - base.y)) });
          if ('enter' in p) {
            if (first) steps.push(commitResults(app, ctx, transformAll(st, hs, translate(base.x, base.y), true), 'COPY').ops);
            return;
          }
          if ('keyword' in p) {
            if (p.keyword === 'E') return;
            if (p.keyword === 'U') {
              undoStep(app, ctx, steps);
              continue;
            }
            if (p.keyword === 'A') {
              const nr = await ctx.getPoint('배열할 항목 수 입력 <2>:', { preferNumber: true });
              const n = 'text' in nr ? Math.round(Number(nr.text)) : 2;
              if (!(n >= 2 && n <= 10000)) {
                ctx.print('2에서 10000 사이의 정수를 입력하십시오.', 'err');
                continue;
              }
              let fit = false;
              const ghostN = (q: { x: number; y: number }) => {
                const out: OverlayGeom[] = [];
                const dx = q.x - base.x;
                const dy = q.y - base.y;
                for (let i = 1; i < n && i < 50; i++) out.push(...ghost.at(translate(fit ? (dx * i) / (n - 1) : dx * i, fit ? (dy * i) / (n - 1) : dy * i)));
                return out;
              };
              let q = await ctx.getPoint('두 번째 점 지정 또는 [맞춤(F)]:', { base, keywords: [{ key: 'F', label: '맞춤' }], ghost: ghostN });
              if ('keyword' in q && q.keyword === 'F') {
                fit = true;
                q = await ctx.getPoint('두 번째 점 지정:', { base, ghost: ghostN });
              }
              if (!('point' in q)) continue;
              const dx = q.point.x - base.x;
              const dy = q.point.y - base.y;
              const res: EditResult[] = [];
              for (let i = 1; i < n; i++) res.push(...transformAll(st, hs, translate(fit ? (dx * i) / (n - 1) : dx * i, fit ? (dy * i) / (n - 1) : dy * i), true));
              steps.push(commitResults(app, ctx, res, 'COPY').ops);
              first = false;
              if (!multiple) return;
              continue;
            }
            continue;
          }
          if (!('point' in p)) return;
          const d = { x: p.point.x - base.x, y: p.point.y - base.y };
          m.moveX = d.x;
          m.moveY = d.y;
          steps.push(commitResults(app, ctx, transformAll(st, hs, translate(d.x, d.y), true), 'COPY').ops);
          first = false;
          if (!multiple) return;
        }
      }
    },
  });

  // ------------------------------------------------------------- ROTATE
  app.register({
    name: 'ROTATE',
    aliases: ['RO'],
    title: '회전',
    async run(ctx) {
      const st = app.active!;
      const angdir = Number(st.doc.header.get('$ANGDIR') ?? 0) === 1;
      const angbase = Number(st.doc.header.get('$ANGBASE') ?? 0);
      ctx.print(`UCS에서 현재 양의 각도: 측정 방향=${angdir ? '시계 방향' : '시계 반대 방향'} 기준 방향=${deg(angbase).toFixed(0)}`);
      const hs = await selectEditable(app, ctx);
      if (!hs.length) return;
      const b = await ctx.getPoint('기준점 지정:');
      if (!('point' in b)) return;
      const base = b.point;
      const ghost = new Ghost(app, hs);
      const m = mem(st);
      let copy = false;
      for (;;) {
        const r = await askAngle(ctx, '회전 각도 지정 또는 [복사(C)/참조(R)]', base, Number(m.rotate ?? 0), {
          keywords: [{ key: 'C', label: '복사' }, { key: 'R', label: '참조' }],
          ghost: (a) => ghost.at(rotateAbout(base, a)),
        });
        if (typeof r === 'number') {
          m.rotate = r;
          finish(r);
          return;
        }
        if (r.keyword === 'C') {
          copy = true;
          ctx.print('선택한 객체의 사본을 회전합니다.');
          continue;
        }
        if (r.keyword === 'R') {
          const ref = await ctx.getPoint(`참조 각도 지정 <${deg(Number(m.rotateRef ?? 0)).toFixed(0)}>:`, { preferNumber: true });
          let refAng = Number(m.rotateRef ?? 0);
          if ('text' in ref) refAng = ((num(ref.text) ?? 0) * Math.PI) / 180;
          else if ('point' in ref) {
            const p2 = await ctx.getPoint('두 번째 점 지정:', { base: ref.point });
            if (!('point' in p2)) return;
            refAng = ang(ref.point, p2.point);
          }
          m.rotateRef = refAng;
          const na = await askAngle(ctx, '새 각도 지정 또는 [점(P)]', base, 0, {
            keywords: [{ key: 'P', label: '점' }],
            ghost: (a) => ghost.at(rotateAbout(base, a - refAng)),
          });
          let newAng: number;
          if (typeof na === 'number') newAng = na;
          else {
            const q1 = await ctx.getPoint('첫 번째 점 지정:');
            if (!('point' in q1)) return;
            const q2 = await ctx.getPoint('두 번째 점 지정:', { base: q1.point });
            if (!('point' in q2)) return;
            newAng = ang(q1.point, q2.point);
          }
          m.rotate = newAng - refAng;
          finish(newAng - refAng);
          return;
        }
      }
      function finish(a: number): void {
        if (Math.abs(a % (2 * Math.PI)) < 1e-12 && !copy) return;
        st.selection.clear();
        const m = rotateAbout(base, a);
        commitResults(app, ctx, transformAll(st, hs, m, copy), 'ROTATE', { transform: m });
        app.refreshSelectionOverlay();
      }
    },
  });

  // ------------------------------------------------------------- SCALE
  app.register({
    name: 'SCALE',
    aliases: ['SC'],
    title: '축척',
    async run(ctx) {
      const st = app.active!;
      const hs = await selectEditable(app, ctx);
      if (!hs.length) return;
      const b = await ctx.getPoint('기준점 지정:');
      if (!('point' in b)) return;
      const base = b.point;
      const ghost = new Ghost(app, hs);
      const m = mem(st);
      let copy = false;
      for (;;) {
        const r = await askPositive(ctx, '축척 비율 지정 또는 [복사(C)/참조(R)]', base, Number(m.scale ?? 1), {
          keywords: [{ key: 'C', label: '복사' }, { key: 'R', label: '참조' }],
          ghost: (k) => ghost.at(scaleAbout(base, k)),
        });
        if (typeof r === 'number') {
          m.scale = r;
          finish(r);
          return;
        }
        if (r.keyword === 'C') {
          copy = true;
          ctx.print('선택한 객체의 사본을 축척합니다.');
          continue;
        }
        if (r.keyword === 'R') {
          let refLen = Number(m.scaleRef ?? 1);
          const ref = await ctx.getPoint(`참조 길이 지정 <${formatLength(refLen, st.units)}>:`, { preferNumber: true });
          if ('text' in ref) {
            const v = num(ref.text);
            if (v === null || v <= 0) {
              ctx.print('0보다 큰 값을 입력하십시오.', 'err');
              return;
            }
            refLen = v;
          } else if ('point' in ref) {
            // 점을 찍으면 두 점 사이 거리
            const p2 = await ctx.getPoint('두 번째 점 지정:', { base: ref.point });
            if (!('point' in p2)) return;
            refLen = dist(ref.point, p2.point);
            if (!(refLen > 0)) return;
          } else if (!('enter' in ref)) return;
          m.scaleRef = refLen;
          const nl = await askPositive(ctx, '새 길이 지정 또는 [점(P)]', base, 1, { keywords: [{ key: 'P', label: '점' }], ghost: (k) => ghost.at(scaleAbout(base, k / refLen)) });
          let newLen: number;
          if (typeof nl === 'number') newLen = nl;
          else {
            const q1 = await ctx.getPoint('첫 번째 점 지정:');
            if (!('point' in q1)) return;
            const q2 = await ctx.getPoint('두 번째 점 지정:', { base: q1.point });
            if (!('point' in q2)) return;
            newLen = dist(q1.point, q2.point);
          }
          if (!(newLen > 0)) return;
          finish(newLen / refLen);
          return;
        }
      }
      function finish(k: number): void {
        if (Math.abs(k - 1) < 1e-15 && !copy) return;
        st.selection.clear();
        const m = scaleAbout(base, k);
        commitResults(app, ctx, transformAll(st, hs, m, copy), 'SCALE', { transform: m });
        app.refreshSelectionOverlay();
      }
    },
  });

  // ------------------------------------------------------------- MIRROR
  app.register({
    name: 'MIRROR',
    aliases: ['MI'],
    title: '대칭',
    async run(ctx) {
      const st = app.active!;
      const hs = await selectEditable(app, ctx);
      if (!hs.length) return;
      const a = await ctx.getPoint('대칭선의 첫 번째 점 지정:');
      if (!('point' in a)) return;
      const p1 = a.point;
      const ghost = new Ghost(app, hs);
      const b = await ctx.getPoint('대칭선의 두 번째 점 지정:', {
        base: p1,
        ghost: (q) => {
          const mm = mirrorAbout(p1, q);
          return mm ? ghost.at(mm) : [];
        },
      });
      if (!('point' in b)) return;
      const mm = mirrorAbout(p1, b.point);
      if (!mm) {
        ctx.print('두 점이 같습니다.', 'err');
        return;
      }
      const erase = await yesNo(ctx, '원본 객체를 지우시겠습니까?', false);
      st.selection.clear();
      commitResults(app, ctx, transformAll(st, hs, mm, !erase), 'MIRROR', { transform: mm });
      app.refreshSelectionOverlay();
    },
  });

  // ------------------------------------------------------------- OFFSET
  app.register({
    name: 'OFFSET',
    aliases: ['O'],
    title: '간격띄우기',
    async run(ctx) {
      const st = app.active!;
      const m = mem(st);
      let erase = !!m.offsetErase;
      let layerCurrent = m.offsetLayer === 'C';
      let through = m.offsetDist === undefined || Number(m.offsetDist) < 0;
      let distance = through ? 1 : Number(m.offsetDist);
      for (;;) {
        ctx.print(`현재 설정: 원본 지우기=${erase ? '예' : '아니오'}  도면층=${layerCurrent ? '현재' : '원본'}  OFFSETGAPTYPE=${offsetGapType()}`);
        const r = await ctx.getPoint(`간격띄우기 거리 지정 또는 [통과점(T)/지우기(E)/도면층(L)] <${through ? '통과점' : formatLength(distance, st.units)}>:`, {
          preferNumber: true,
          keywords: [{ key: 'T', label: '통과점' }, { key: 'E', label: '지우기' }, { key: 'L', label: '도면층' }],
        });
        if ('enter' in r) break;
        if ('keyword' in r) {
          if (r.keyword === 'T') {
            through = true;
            break;
          }
          if (r.keyword === 'E') erase = await yesNo(ctx, '간격띄우기 후 원본 객체를 지우시겠습니까?', erase);
          if (r.keyword === 'L') {
            const k = await ctx.getPoint(`간격띄우기 객체에 대한 도면층 옵션 입력 [현재(C)/원본(S)] <${layerCurrent ? '현재' : '원본'}>:`, { keywords: [{ key: 'C', label: '현재' }, { key: 'S', label: '원본' }] });
            if ('keyword' in k) layerCurrent = k.keyword === 'C';
          }
          m.offsetErase = erase;
          m.offsetLayer = layerCurrent ? 'C' : 'S';
          continue;
        }
        if ('point' in r) {
          const p2 = await ctx.getPoint('두 번째 점 지정:', { base: r.point });
          if (!('point' in p2)) return;
          distance = dist(r.point, p2.point);
        } else if ('text' in r) {
          const v = num(r.text);
          if (v === null || v <= 0) {
            ctx.print('0보다 큰 값을 입력하십시오.', 'err');
            continue;
          }
          distance = v;
        }
        through = false;
        break;
      }
      m.offsetDist = through ? -1 : distance;
      const clayer = String(st.doc.header.get('$CLAYER') ?? '0');
      const steps: number[] = [];
      for (;;) {
        const pick = await ctx.getEntity('간격띄우기할 객체 선택 또는 [종료(E)/명령 취소(U)] <종료>:', [
          { key: 'E', label: '종료' },
          { key: 'U', label: '명령 취소' },
        ]);
        if ('enter' in pick) return;
        if ('keyword' in pick) {
          if (pick.keyword === 'E') return;
          undoStep(app, ctx, steps);
          continue;
        }
        let src = st.doc.entityIndex.get(pick.handle);
        if (!src) continue;
        let multiple = false;
        for (;;) {
          const e = src;
          const make = (p: Pt): EditResult => {
            let d = distance;
            if (through) {
              const q = nearestPointOn(e, p, st.doc);
              d = q ? Math.hypot(q.x - p.x, q.y - p.y) : 0;
              if (!(d > 1e-12)) return {};
            }
            const res = offsetEntity(e, d, p, { gapType: offsetGapType() });
            if (layerCurrent) for (const x of res.add ?? []) x.layer = clayer;
            return res;
          };
          const q = await ctx.getPoint(`${through ? '통과점' : '간격띄우기할 면의 점'} 지정 또는 [종료(E)/다중(M)/명령 취소(U)] <${multiple ? '다음 객체' : '종료'}>:`, {
            keywords: [{ key: 'E', label: '종료' }, { key: 'M', label: '다중' }, { key: 'U', label: '명령 취소' }],
            ghost: (p) => resultGeom(app, make(p)),
          });
          if ('enter' in q) {
            if (multiple) break;
            return;
          }
          if ('keyword' in q) {
            if (q.keyword === 'E') return;
            if (q.keyword === 'M') {
              multiple = true;
              continue;
            }
            undoStep(app, ctx, steps);
            break;
          }
          if (!('point' in q)) return;
          const res = make(q.point);
          if (!res.add?.length) {
            ctx.print(res.message ?? '해당 객체를 간격띄우기할 수 없습니다.');
            break;
          }
          if (erase) res.remove = [...(res.remove ?? []), e.handle];
          const a = commitResults(app, ctx, [res], 'OFFSET');
          steps.push(a.ops);
          if (!multiple) break;
          // 다중: 방금 만든 객체에서 다시
          const next = a.added[0] ? st.doc.entityIndex.get(a.added[0]) : undefined;
          if (!next) break;
          src = next;
        }
      }
    },
  });

  // OFFSETGAPTYPE: 폴리선 간격띄우기의 바깥 꼭짓점 틈(0 연장, 1 모깎기, 2 모따기)
  app.register({
    name: 'OFFSETGAPTYPE',
    title: '간격띄우기 틈 유형',
    async run(ctx, arg) {
      let t = arg?.trim();
      if (!t) {
        const r = await ctx.getPoint(`OFFSETGAPTYPE에 대한 새 값 입력 <${offsetGapType()}>:`, { preferNumber: true, allowText: true });
        if ('enter' in r) return;
        if (!('text' in r)) return;
        t = r.text.trim();
      }
      if (t !== '0' && t !== '1' && t !== '2') {
        ctx.print('0, 1, 2 가운데 하나가 필요합니다.', 'err');
        return;
      }
      setOffsetGapType(Number(t) as 0 | 1 | 2);
    },
  });

  // ------------------------------------------------------------- TRIM·EXTEND
  const trimLike = (mode: 'trim' | 'extend') => async (ctx: CommandContext) => {
    const st = app.active!;
    const m = mem(st);
    let quick = m[`${mode}Mode`] !== 'S';
    let edges: string[] | null = null;
    const steps: number[] = [];
    const label = mode === 'trim' ? 'TRIM' : 'EXTEND';
    let edgeMode = Number(st.doc.header.get('$EDGEMODE') ?? 0) === 1;
    // 투영(PROJMODE): 0 없음(같은 평면의 모서리만), 1 UCS, 2 뷰 — 평면도에서는 UCS와 뷰가 같다
    let proj = Number(st.doc.header.get('$PROJMODE') ?? 1);
    if (proj !== 0 && proj !== 2) proj = 1;
    const projLabel = () => (proj === 0 ? '없음' : proj === 2 ? '뷰' : 'UCS');
    const status = () => ctx.print(`현재 설정: 투영=${projLabel()}, 모서리=${edgeMode ? '연장' : '없음'}, 모드=${quick ? '빠른 작업' : '표준'}`);
    const zOf = (x: Entity) => entityPath(x)?.z ?? 0;
    /** Shift를 누른 채 고르면 반대 작업(자르기 ↔ 연장) */
    const opFor = (shift: boolean | undefined): 'trim' | 'extend' => (shift ? (mode === 'trim' ? 'extend' : 'trim') : mode);
    /** 객체 하나를 고른 점에서 자르기·연장(op). 바뀌었으면 true */
    const applyAt = (handle: string, point: Pt, quiet = false, op: 'trim' | 'extend' = mode): boolean => {
      const e = st.doc.entityIndex.get(handle);
      if (!e || !unlockedOnly(app, [handle]).length) return false;
      let cutters: Entity[];
      if (quick) {
        // 빠른 작업: 모든 객체가 경계. 자르기는 범위가 겹치는 것만, 연장은 공간 전체
        const pk = app.picker();
        const box = pk?.box(handle);
        const hs = op === 'trim' && pk && box && typeof pk.overlapping === 'function' ? pk.overlapping([box.minX, box.minY, box.maxX, box.maxY]) : (st.doc.blocks.get(st.space)?.entities ?? []).map((x) => x.handle);
        cutters = [];
        for (const h of hs) {
          if (h === handle) continue;
          const c = st.doc.entityIndex.get(h);
          if (c) cutters.push(c);
        }
        if (op === 'trim')
          for (const c of st.doc.blocks.get(st.space)?.entities ?? []) if ((c.type === 'XLINE' || c.type === 'RAY') && c.handle !== handle && !cutters.includes(c)) cutters.push(c);
      } else {
        cutters = (edges ?? []).filter((h) => h !== handle).map((h) => st.doc.entityIndex.get(h)).filter((x): x is Entity => !!x);
      }
      // 투영 없음: 같은 높이(평면)의 모서리만
      if (proj === 0) {
        const z = zOf(e);
        cutters = cutters.filter((c) => Math.abs(zOf(c) - z) <= 1e-9 * Math.max(1, Math.abs(z)));
      }
      const res =
        op === 'trim'
          ? trimEntity(e, cutters, point, { doc: st.doc, quick, extendEdges: edgeMode })
          : extendEntity(e, cutters, point, { doc: st.doc, extendEdges: edgeMode });
      if (!res.add?.length && !res.replace?.length && !res.remove?.length) {
        if (!quiet) ctx.print(res.message ?? '객체가 모서리와 교차하지 않습니다.');
        return false;
      }
      const a = commitResults(app, ctx, [res], op === 'trim' ? 'TRIM' : 'EXTEND', { quiet: true });
      steps.push(a.ops);
      // 표준 모드에서 잘린 경계 객체가 바뀌었으면 목록을 맞춘다
      if (edges) for (const h of a.added) edges.push(h);
      lastAdded = a.added;
      return true;
    };
    let lastAdded: string[] = [];
    /** 공간의 객체(고르기 상자로 먼저 거른다) */
    const candidates = (r: [number, number, number, number]): string[] => {
      const pk = app.picker();
      if (pk && typeof pk.overlapping === 'function') return pk.overlapping(r);
      return (st.doc.blocks.get(st.space)?.entities ?? []).map((x) => x.handle);
    };
    /** 걸치기(C)·울타리(F): 지나는 객체마다 그 점을 고른 것처럼. 한 번의 명령 취소(U) 단계로 */
    const applyMany = (picks: { handle: string; point: Pt }[], op: 'trim' | 'extend' = mode) => {
      const n0 = steps.length;
      let done = 0;
      for (const p of picks) {
        let h = p.handle;
        // 앞에서 잘려 둘로 나뉘었으면 그 점에 가까운 조각
        if (!st.doc.entityIndex.has(h) || (lastAdded.length && nearestPointOnHandle(h, p.point) > 1e-6)) {
          const alt = [h, ...lastAdded].filter((x) => st.doc.entityIndex.has(x)).sort((a, b) => nearestPointOnHandle(a, p.point) - nearestPointOnHandle(b, p.point))[0];
          if (!alt) continue;
          h = alt;
        }
        if (applyAt(h, p.point, true, op)) done++;
      }
      // 여러 단계를 명령 취소(U) 한 번에 되돌리게 합친다
      const merged = steps.splice(n0).reduce((s, v) => s + v, 0);
      if (merged) steps.push(merged);
      if (!done) ctx.print('객체가 모서리와 교차하지 않습니다.');
    };
    const nearestPointOnHandle = (h: string, p: Pt): number => {
      const e = st.doc.entityIndex.get(h);
      const q = e ? nearestPointOn(e, p, st.doc) : null;
      return q ? Math.hypot(q.x - p.x, q.y - p.y) : Infinity;
    };
    /** 걸치기 창(두 구석)이 지나는 객체마다 */
    const crossingThrough = (a: Pt, b: Pt, op: 'trim' | 'extend') => {
      const r: [number, number, number, number] = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
      const picks: { handle: string; point: Pt }[] = [];
      for (const h of candidates(r)) {
        const e = st.doc.entityIndex.get(h);
        const q = e ? crossingPick(e, r) : null;
        if (q) picks.push({ handle: h, point: q });
      }
      applyMany(picks, op);
    };
    /** 울타리(꺾은선)가 지나는 자리마다 */
    const fenceThrough = (fence: Pt[], op: 'trim' | 'extend') => {
      const xs = fence.map((p) => p.x);
      const ys = fence.map((p) => p.y);
      const picks: { handle: string; point: Pt }[] = [];
      for (const h of candidates([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)])) {
        const e = st.doc.entityIndex.get(h);
        if (e) for (const q of fencePicks(e, fence)) picks.push({ handle: h, point: q });
      }
      applyMany(picks, op);
    };
    status();
    for (;;) {
      if (!quick && !edges) {
        ctx.print(mode === 'trim' ? '절단 모서리 선택 ...' : '경계 모서리 선택 ...');
        const hs = await ctx.getSelection('객체 선택 또는 <모두 선택>:', { noPickfirst: true });
        edges = hs.length ? hs : [...(st.doc.blocks.get(st.space)?.entities ?? [])].map((e) => e.handle);
      }
      // 빠른 작업: [절단(경계) 모서리/걸치기/모드/프로젝트/지우기], 표준: [울타리/걸치기/모드/프로젝트/모서리/지우기/명령 취소]
      // Shift를 누른 채 고르면 반대 작업(자르기 ↔ 연장). 빈 곳을 누르면 빠른 작업은 두 점 울타리, 표준은 걸치기 창
      const kws: Keyword[] = quick
        ? [
            mode === 'trim' ? { key: 'T', label: '절단 모서리' } : { key: 'B', label: '경계 모서리' },
            { key: 'C', label: '걸치기' },
            { key: 'O', label: '모드' },
            { key: 'P', label: '프로젝트' },
            ...(mode === 'trim' ? [{ key: 'R', label: '지우기' }] : []),
            ...(steps.length ? [{ key: 'U', label: '명령 취소' }] : []),
          ]
        : [
            { key: 'F', label: '울타리' },
            { key: 'C', label: '걸치기' },
            { key: 'O', label: '모드' },
            { key: 'P', label: '프로젝트' },
            { key: 'E', label: '모서리' },
            ...(mode === 'trim' ? [{ key: 'R', label: '지우기' }] : []),
            { key: 'U', label: '명령 취소' },
          ];
      const prompt = `${mode === 'trim' ? '자를 객체 선택 또는 Shift 키를 누른 채 선택하여 연장' : '연장할 객체 선택 또는 Shift 키를 누른 채 선택하여 자르기'} 또는 [${kws.map((k) => `${k.label}(${k.key})`).join('/')}]:`;
      const pick = await ctx.getEntity(prompt, kws, { emptyPick: true });
      if ('enter' in pick) return;
      if ('empty' in pick) {
        const p0 = pick.point;
        const op = opFor(pick.shift);
        if (quick) {
          const q = await ctx.getPoint('다음 울타리 점 지정:', { base: p0, rubber: (p) => [{ pts: [p0.x, p0.y, p.x, p.y], dashed: true }] });
          if ('point' in q) fenceThrough([p0, q.point], op);
        } else {
          const q = await ctx.getPoint('반대 구석 지정:', { base: p0, rubber: (p) => [{ pts: [p0.x, p0.y, p.x, p0.y, p.x, p.y, p0.x, p.y], closed: true, dashed: true }] });
          if ('point' in q) crossingThrough(p0, q.point, op);
        }
        continue;
      }
      if ('keyword' in pick) {
        switch (pick.keyword) {
          case 'T':
          case 'B':
            quick = false;
            edges = null;
            break;
          case 'O': {
            const k = await ctx.getPoint(`${mode === 'trim' ? '자르기' : '연장'} 모드 옵션 입력 [빠른 작업(Q)/표준(S)] <${quick ? '빠른 작업' : '표준'}>:`, {
              keywords: [{ key: 'Q', label: '빠른 작업' }, { key: 'S', label: '표준' }],
            });
            if ('keyword' in k) {
              quick = k.keyword === 'Q';
              m[`${mode}Mode`] = k.keyword;
              edges = null;
            }
            status();
            break;
          }
          case 'P': {
            const k = await ctx.getPoint(`투영 옵션 입력 [없음(N)/UCS(U)/뷰(V)] <${projLabel()}>:`, {
              keywords: [{ key: 'N', label: '없음' }, { key: 'U', label: 'UCS' }, { key: 'V', label: '뷰' }],
            });
            if ('keyword' in k) {
              proj = k.keyword === 'N' ? 0 : k.keyword === 'V' ? 2 : 1;
              // 시스템 변수: 명령 취소 단계에 넣지 않는다(명령 안의 명령 취소(U)가 자르기 단계만 세게)
              st.doc.header.set('$PROJMODE', proj);
            }
            status();
            break;
          }
          case 'E': {
            const k = await ctx.getPoint(`암시적 모서리 연장 모드 입력 [연장(E)/연장 안 함(N)] <${edgeMode ? '연장' : '연장 안 함'}>:`, {
              keywords: [{ key: 'E', label: '연장' }, { key: 'N', label: '연장 안 함' }],
            });
            if ('keyword' in k) {
              edgeMode = k.keyword === 'E';
              st.doc.header.set('$EDGEMODE', edgeMode ? 1 : 0);
            }
            status();
            break;
          }
          case 'C': {
            const a = await ctx.getPoint('첫 번째 구석 지정:');
            if (!('point' in a)) break;
            const p0 = a.point;
            const b = await ctx.getPoint('반대 구석 지정:', { base: p0, rubber: (q) => [{ pts: [p0.x, p0.y, q.x, p0.y, q.x, q.y, p0.x, q.y], closed: true, dashed: true }] });
            if (!('point' in b)) break;
            crossingThrough(p0, b.point, opFor('shift' in b ? b.shift : undefined));
            break;
          }
          case 'F': {
            const fence: Pt[] = [];
            for (;;) {
              const last = fence[fence.length - 1];
              const q = await ctx.getPoint(fence.length ? '다음 울타리 점 지정 또는 [명령 취소(U)]:' : '첫 번째 울타리 점 지정:', {
                base: last ?? null,
                keywords: fence.length ? [{ key: 'U', label: '명령 취소' }] : [],
                rubber: (p) => [{ pts: [...fence, p].flatMap((v) => [v.x, v.y]), dashed: true }],
              });
              if ('keyword' in q) {
                fence.pop();
                continue;
              }
              if (!('point' in q)) break;
              fence.push(q.point);
            }
            if (fence.length >= 2) fenceThrough(fence, mode);
            break;
          }
          case 'R': {
            const hs = unlockedOnly(app, await ctx.getSelection('지울 객체 선택 또는 <종료>:', { noPickfirst: true }));
            if (hs.length) steps.push(commitResults(app, ctx, [{ remove: hs }], label).ops);
            break;
          }
          case 'U':
            undoStep(app, ctx, steps);
            break;
        }
        continue;
      }
      lastAdded = [];
      applyAt(pick.handle, pick.point, false, opFor(pick.shift));
    }
  };
  app.register({ name: 'TRIM', aliases: ['TR'], title: '자르기', run: trimLike('trim') });
  app.register({ name: 'EXTEND', aliases: ['EX'], title: '연장', run: trimLike('extend') });

  // ------------------------------------------------------------- BREAK
  app.register({
    name: 'BREAK',
    aliases: ['BR'],
    title: '끊기',
    async run(ctx) {
      const st = app.active!;
      const pick = await ctx.getEntity('객체 선택:');
      if (!('handle' in pick)) return;
      if (!unlockedOnly(app, [pick.handle]).length) return;
      const e = st.doc.entityIndex.get(pick.handle);
      if (!e) return;
      let p1 = pick.point;
      let r = await ctx.getPoint('두 번째 끊기점 지정 또는 [첫 번째 점(F)]:', { keywords: [{ key: 'F', label: '첫 번째 점' }] });
      if ('keyword' in r) {
        const f = await ctx.getPoint('첫 번째 끊기점 지정:');
        if (!('point' in f)) return;
        p1 = f.point;
        r = await ctx.getPoint('두 번째 끊기점 지정:', { base: p1 });
      }
      if (!('point' in r)) return;
      const res = breakEntity(e, p1, r.point);
      commitResults(app, ctx, [res], 'BREAK');
    },
  });
  app.register({
    name: 'BREAKATPOINT',
    title: '점에서 끊기',
    async run(ctx) {
      const st = app.active!;
      const pick = await ctx.getEntity('객체 선택:');
      if (!('handle' in pick)) return;
      if (!unlockedOnly(app, [pick.handle]).length) return;
      const e = st.doc.entityIndex.get(pick.handle);
      if (!e) return;
      const r = await ctx.getPoint('끊기점 지정:');
      if (!('point' in r)) return;
      commitResults(app, ctx, [breakEntity(e, r.point, r.point)], 'BREAKATPOINT');
    },
  });

  // ------------------------------------------------------------- LENGTHEN
  app.register({
    name: 'LENGTHEN',
    aliases: ['LEN'],
    title: '길이 조정',
    async run(ctx) {
      const st = app.active!;
      const m = mem(st);
      let mode: LengthenMode | 'dynamic' | null = null;
      let modeKey = String(m.lenMode ?? 'T');
      const modeLabel: Record<string, string> = { DE: '증분', P: '퍼센트', T: '합계', DY: '동적' };
      for (;;) {
        const r = await ctx.getEntity(`측정할 객체 선택 또는 [증분(DE)/퍼센트(P)/합계(T)/동적(DY)] <${modeLabel[modeKey] ?? '합계'}(${modeKey})>:`, [
          { key: 'DE', label: '증분' },
          { key: 'P', label: '퍼센트' },
          { key: 'T', label: '합계' },
          { key: 'DY', label: '동적' },
        ]);
        if ('handle' in r) {
          const e = st.doc.entityIndex.get(r.handle);
          const path = e ? entityPath(e) : null;
          if (path) {
            const len = pathLength(path);
            const arc = e?.type === 'ARC' ? `, 사이각: ${deg(((e.endAngle - e.startAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)).toFixed(4)}` : '';
            ctx.print(`현재 길이: ${formatLength(len, st.units)}${arc}`);
          } else ctx.print('곡선 객체가 아닙니다.');
          continue;
        }
        const key = 'keyword' in r ? r.keyword : modeKey;
        if (key === 'DE') {
          const v = await ctx.getPoint(`증분 길이 또는 [각도(A)] 입력 <${formatLength(Number(m.lenDelta ?? 0), st.units)}>:`, { preferNumber: true, keywords: [{ key: 'A', label: '각도' }] });
          if ('keyword' in v) {
            const a = await ctx.getPoint(`증분 각도 입력 <${deg(Number(m.lenAngle ?? 0)).toFixed(0)}>:`, { preferNumber: true });
            const av = 'text' in a ? num(a.text) : deg(Number(m.lenAngle ?? 0));
            if (av === null) return;
            m.lenAngle = (av * Math.PI) / 180;
            mode = { angleDelta: (av * Math.PI) / 180 };
          } else {
            const dv = 'text' in v ? num(v.text) : Number(m.lenDelta ?? 0);
            if (dv === null) return;
            m.lenDelta = dv;
            mode = { delta: dv };
          }
        } else if (key === 'P') {
          const v = await ctx.getPoint(`퍼센트 길이 입력 <${Number(m.lenPercent ?? 100).toFixed(4)}>:`, { preferNumber: true });
          const pv = 'text' in v ? num(v.text) : Number(m.lenPercent ?? 100);
          if (pv === null || pv <= 0) return;
          m.lenPercent = pv;
          mode = { percent: pv };
        } else if (key === 'T') {
          const v = await ctx.getPoint(`전체 길이 또는 [각도(A)] 지정 <${formatLength(Number(m.lenTotal ?? 1), st.units)}>:`, { preferNumber: true, keywords: [{ key: 'A', label: '각도' }] });
          if ('keyword' in v) {
            const a = await ctx.getPoint(`전체 각도 지정 <${deg(Number(m.lenTotalAngle ?? Math.PI / 3)).toFixed(0)}>:`, { preferNumber: true });
            const av = 'text' in a ? num(a.text) : deg(Number(m.lenTotalAngle ?? Math.PI / 3));
            if (av === null) return;
            m.lenTotalAngle = (av * Math.PI) / 180;
            mode = { totalAngle: (av * Math.PI) / 180 };
          } else {
            const tv = 'text' in v ? num(v.text) : Number(m.lenTotal ?? 1);
            if (tv === null || tv <= 0) return;
            m.lenTotal = tv;
            mode = { total: tv };
          }
        } else if (key === 'DY') mode = 'dynamic';
        else return;
        modeKey = key;
        m.lenMode = key;
        break;
      }
      const steps: number[] = [];
      for (;;) {
        const r = await ctx.getEntity('변경할 객체 선택 또는 [명령 취소(U)]:', [{ key: 'U', label: '명령 취소' }]);
        if ('enter' in r) return;
        if ('keyword' in r) {
          undoStep(app, ctx, steps);
          continue;
        }
        if (!unlockedOnly(app, [r.handle]).length) continue;
        const e = st.doc.entityIndex.get(r.handle);
        if (!e || !mode) continue;
        let res: EditResult;
        if (mode === 'dynamic') {
          // 동적: 고른 끝을 끌어 새 끝점을 찍는다(끝 구간을 연장한 곡선에 투영)
          const pick = r.point;
          const at = (p: Pt): EditResult => {
            const L = lengthenToPoint(e, pick, p);
            return L === null ? {} : lengthenEntity(e, { total: L }, pick);
          };
          const q = await ctx.getPoint('새 끝점 지정:', { ghost: (p) => resultGeom(app, at(p)) });
          if (!('point' in q)) continue;
          res = at(q.point);
        } else res = lengthenEntity(e, mode, r.point);
        if (!res.replace?.length && !res.add?.length) {
          ctx.print(res.message ?? '이 객체는 길이를 조정할 수 없습니다.');
          continue;
        }
        steps.push(commitResults(app, ctx, [res], 'LENGTHEN', { quiet: true }).ops);
      }
    },
  });

  // ------------------------------------------------------------- EXPLODE
  app.register({
    name: 'EXPLODE',
    aliases: ['X'],
    title: '분해',
    async run(ctx) {
      const st = app.active!;
      const hs = await selectEditable(app, ctx);
      if (!hs.length) return;
      const results: EditResult[] = [];
      let fail = 0;
      for (const h of hs) {
        const e = st.doc.entityIndex.get(h);
        if (!e) continue;
        const r = explodeEntity(e, st.doc);
        if (!r.add?.length && !r.remove?.length && !r.replace?.length) {
          fail++;
          continue;
        }
        results.push({ ...r, message: undefined });
      }
      st.selection.clear();
      const a = commitResults(app, ctx, results, 'EXPLODE');
      if (fail) ctx.print(`${fail}개는 분해할 수 없습니다.`);
      ctx.print(`${results.length}개를 분해해 객체 ${a.added.length}개를 만들었습니다.`);
      app.setSelection(a.added.slice(0, 5000));
    },
  });

  // ------------------------------------------------------------- ARRAYCLASSIC(예전 배열 대화상자)
  // ARRAY·ARRAYRECT·ARRAYPOLAR의 명령행 흐름은 src/app/arraycmd.ts(이 함수 끝에서 등록)
  const classicRect = async (ctx: CommandContext, hs: string[]) => {
    {
      const st = app.active!;
      const ext = extentsOf(app, hs) ?? [0, 0, 1, 1];
      const w = Math.max(ext[2] - ext[0], 1e-6);
      const hgt = Math.max(ext[3] - ext[1], 1e-6);
      ctx.print(`유형 = 직사각형  연관 = ${arrayAssociativity() ? '예' : '아니오'}`);
      const v = await form(
        '직사각형 배열',
        [
          { key: 'rows', label: '행 수', type: 'number', value: 3 },
          { key: 'cols', label: '열 수', type: 'number', value: 4 },
          { key: 'dy', label: '행 사이 간격', type: 'number', value: +(hgt * 1.5).toPrecision(6) },
          { key: 'dx', label: '열 사이 간격', type: 'number', value: +(w * 1.5).toPrecision(6) },
          { key: 'angle', label: '행 축 각도(도)', type: 'number', value: 0 },
          { key: 'assoc', label: '연관', type: 'check', value: arrayAssociativity() },
        ],
        {
          ok: '배열',
          note: '연관을 끄면 연관 배열이 아니라 각 항목을 따로 만듭니다.',
          validate: (x) => (Number(x.rows) >= 1 && Number(x.cols) >= 1 && Number(x.rows) * Number(x.cols) <= 100000 && Number(x.rows) * Number(x.cols) > 1 ? null : '행 × 열은 2에서 100000 사이여야 합니다.'),
        },
      );
      if (!v) return;
      const rows = Math.round(Number(v.rows));
      const cols = Math.round(Number(v.cols));
      const a = (Number(v.angle) * Math.PI) / 180;
      setArrayAssociativity(!!v.assoc);
      if (v.assoc) {
        createAssocArray(app, ctx, { kind: 'rect', handles: hs, rows, columns: cols, rowSpacing: Number(v.dy), columnSpacing: Number(v.dx), angle: a }, 'ARRAYRECT');
        return;
      }
      const ux = { x: Math.cos(a), y: Math.sin(a) };
      const uy = { x: -Math.sin(a), y: Math.cos(a) };
      const results: EditResult[] = [];
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          if (!r && !c) continue;
          const dx = ux.x * Number(v.dx) * c + uy.x * Number(v.dy) * r;
          const dy = ux.y * Number(v.dx) * c + uy.y * Number(v.dy) * r;
          results.push(...transformAll(st, hs, translate(dx, dy), true));
        }
      st.selection.clear();
      const res = commitResults(app, ctx, results, 'ARRAYRECT');
      app.refreshSelectionOverlay();
      ctx.print(`항목 ${rows * cols}개(새 객체 ${res.added.length}개)를 만들었습니다.`);
    }
  };

  const classicPolar = async (ctx: CommandContext, hs: string[]) => {
    {
      const st = app.active!;
      ctx.print(`유형 = 원형  연관 = ${arrayAssociativity() ? '예' : '아니오'}`);
      const c = await ctx.getPoint('배열의 중심점 지정:');
      if (!('point' in c)) return;
      const center = c.point;
      const v = await form(
        '원형 배열',
        [
          { key: 'n', label: '항목 수', type: 'number', value: 6 },
          { key: 'fill', label: '채울 각도(도, 음수는 시계 방향)', type: 'number', value: 360 },
          { key: 'rotate', label: '배열할 때 항목 회전', type: 'check', value: true },
          { key: 'assoc', label: '연관', type: 'check', value: arrayAssociativity() },
        ],
        { ok: '배열', validate: (x) => (Number(x.n) >= 2 && Number(x.n) <= 100000 && Number(x.fill) !== 0 ? null : '항목 수는 2 이상, 채울 각도는 0이 아니어야 합니다.') },
      );
      if (!v) return;
      const n = Math.round(Number(v.n));
      const fill = (Number(v.fill) * Math.PI) / 180;
      const full = Math.abs(Math.abs(fill) - 2 * Math.PI) < 1e-9;
      const step = full ? fill / n : fill / (n - 1);
      const rot = !!v.rotate;
      setArrayAssociativity(!!v.assoc);
      if (v.assoc) {
        createAssocArray(app, ctx, { kind: 'polar', handles: hs, center, items: n, fill, rotate: rot }, 'ARRAYPOLAR');
        return;
      }
      // 회전하지 않을 때는 선택 범위의 중심을 기준으로 옮긴다
      const ext = extentsOf(app, hs) ?? [center.x, center.y, center.x, center.y];
      const ref = { x: (ext[0] + ext[2]) / 2, y: (ext[1] + ext[3]) / 2 };
      const results: EditResult[] = [];
      for (let i = 1; i < n; i++) {
        const a = step * i;
        let mm: Affine;
        if (rot) mm = rotateAbout(center, a);
        else {
          const q = rotateAbout(center, a);
          const nx = q[0] * ref.x + q[2] * ref.y + q[4];
          const ny = q[1] * ref.x + q[3] * ref.y + q[5];
          mm = translate(nx - ref.x, ny - ref.y);
        }
        results.push(...transformAll(st, hs, mm, true));
      }
      st.selection.clear();
      const res = commitResults(app, ctx, results, 'ARRAYPOLAR');
      app.refreshSelectionOverlay();
      ctx.print(`항목 ${n}개(새 객체 ${res.added.length}개)를 만들었습니다.`);
    }
  };

  app.register({
    name: 'ARRAYCLASSIC',
    title: '배열(대화상자)',
    async run(ctx) {
      const hs = await selectEditable(app, ctx);
      if (!hs.length) return;
      const r = await ctx.getPoint('배열 유형 입력 [직사각형(R)/원형(PO)] <직사각형>:', {
        keywords: [
          { key: 'R', label: '직사각형' },
          { key: 'PO', label: '원형' },
        ],
      });
      if ('keyword' in r && r.keyword === 'PO') await classicPolar(ctx, hs);
      else if ('keyword' in r || 'enter' in r) await classicRect(ctx, hs);
    },
  });
  // ARRAY·ARRAYRECT·ARRAYPOLAR(명령행: 기본 배열 미리보기 → 그립·옵션)
  registerArrayCommands(app);
  // MOCORO(이동·복사·회전·축척 한 번에) — src/app/mocoro.ts
  registerMocoroCommand(app);

  // ------------------------------------------------------------- FILLET·CHAMFER
  const hnum = (st: DocState, k: string, def: number) => {
    const v = st.doc.header.get(k);
    return typeof v === 'number' && Number.isFinite(v) ? v : def;
  };
  /** 머리말 변수를 바꾸는 작업(명령 취소 묶음) */
  const setHeader = (st: DocState, ctx: CommandContext, name: string, value: number) => {
    const before = st.doc.header.get(name);
    if (before === value) return;
    st.session.commit({ label: name.slice(1), ops: [{ kind: 'header', name, before, after: value }], group: ctx.group });
  };
  const corner = (kind: 'fillet' | 'chamfer') => async (ctx: CommandContext) => {
    const st = app.active!;
    const m = mem(st);
    let trim = m.trimMode !== 'N';
    let multiple = false;
    const steps: number[] = [];
    const label = kind === 'fillet' ? 'FILLET' : 'CHAMFER';
    const status = () => {
      const mode = trim ? '자르기' : '자르지 않기';
      if (kind === 'fillet') ctx.print(`현재 설정: 모드 = ${mode}, 반지름 = ${formatLength(hnum(st, '$FILLETRAD', 0), st.units)}`);
      else if (m.chamferMethod === 'A') ctx.print(`(${mode} 모드) 현재 모따기 길이 = ${formatLength(hnum(st, '$CHAMFERC', 0), st.units)}, 각도 = ${deg(hnum(st, '$CHAMFERD', 0)).toFixed(0)}`);
      else ctx.print(`(${mode} 모드) 현재 모따기 거리1 = ${formatLength(hnum(st, '$CHAMFERA', 0), st.units)}, 거리2 = ${formatLength(hnum(st, '$CHAMFERB', 0), st.units)}`);
    };
    const askNum = async (prompt: string, def: number, angle = false): Promise<number | null> => {
      const r = await ctx.getPoint(`${prompt} <${angle ? deg(def).toFixed(0) : formatLength(def, st.units)}>:`, { preferNumber: true });
      if ('enter' in r) return def;
      if ('text' in r) {
        const v = num(r.text);
        if (v !== null && v >= 0) return angle ? (v * Math.PI) / 180 : v;
      }
      if ('point' in r && !angle) {
        const r2 = await ctx.getPoint('두 번째 점 지정:', { base: r.point });
        if ('point' in r2) return dist(r.point, r2.point);
      }
      return null;
    };
    const option = async (k: string): Promise<boolean> => {
      if (k === 'R') {
        const v = await askNum('모깎기 반지름 지정', hnum(st, '$FILLETRAD', 0));
        if (v !== null) setHeader(st, ctx, '$FILLETRAD', v);
        return true;
      }
      if (k === 'D') {
        const a = await askNum('첫 번째 모따기 거리 지정', hnum(st, '$CHAMFERA', 0));
        if (a === null) return true;
        const b = await askNum('두 번째 모따기 거리 지정', a);
        if (b === null) return true;
        setHeader(st, ctx, '$CHAMFERA', a);
        setHeader(st, ctx, '$CHAMFERB', b);
        m.chamferMethod = 'D';
        return true;
      }
      if (k === 'A') {
        const l = await askNum('첫 번째 선의 모따기 길이 지정', hnum(st, '$CHAMFERC', 0));
        if (l === null) return true;
        const a = await askNum('첫 번째 선으로부터 모따기 각도 지정', hnum(st, '$CHAMFERD', 0), true);
        if (a === null) return true;
        setHeader(st, ctx, '$CHAMFERC', l);
        setHeader(st, ctx, '$CHAMFERD', a);
        m.chamferMethod = 'A';
        return true;
      }
      if (k === 'E') {
        const r = await ctx.getPoint(`자르기 방법 입력 [거리(D)/각도(A)] <${m.chamferMethod === 'A' ? '각도' : '거리'}>:`, { keywords: [{ key: 'D', label: '거리' }, { key: 'A', label: '각도' }] });
        if ('keyword' in r) m.chamferMethod = r.keyword;
        return true;
      }
      if (k === 'T') {
        const r = await ctx.getPoint(`자르기 모드 옵션 입력 [자르기(T)/자르지 않기(N)] <${trim ? '자르기' : '자르지 않기'}>:`, { keywords: [{ key: 'T', label: '자르기' }, { key: 'N', label: '자르지 않기' }] });
        if ('keyword' in r) {
          trim = r.keyword === 'T';
          m.trimMode = r.keyword;
        }
        return true;
      }
      if (k === 'M') {
        multiple = true;
        return true;
      }
      if (k === 'U') {
        undoStep(app, ctx, steps);
        return true;
      }
      return false;
    };
    status();
    for (;;) {
      const kws: Keyword[] =
        kind === 'fillet'
          ? [{ key: 'U', label: '명령 취소' }, { key: 'P', label: '폴리선' }, { key: 'R', label: '반지름' }, { key: 'T', label: '자르기' }, { key: 'M', label: '다중' }]
          : [{ key: 'U', label: '명령 취소' }, { key: 'P', label: '폴리선' }, { key: 'D', label: '거리' }, { key: 'A', label: '각도' }, { key: 'T', label: '자르기' }, { key: 'E', label: '메서드' }, { key: 'M', label: '다중' }];
      const first = kind === 'fillet' ? '첫 번째 객체 선택' : '첫 번째 선 선택';
      const r1 = await ctx.getEntity(`${first} 또는 [${kws.map((k) => `${k.label}(${k.key})`).join('/')}]:`, kws);
      if ('enter' in r1) return;
      if ('keyword' in r1) {
        if (r1.keyword === 'P') {
          const rp = await ctx.getEntity('2D 폴리선 선택:');
          if (!('handle' in rp)) continue;
          const pl = st.doc.entityIndex.get(rp.handle);
          if (!pl || !unlockedOnly(app, [rp.handle]).length) continue;
          const res =
            kind === 'fillet'
              ? filletPolyline(pl, hnum(st, '$FILLETRAD', 0))
              : m.chamferMethod === 'A'
                ? chamferAngleAll(pl)
                : chamferPolyline(pl, hnum(st, '$CHAMFERA', 0), hnum(st, '$CHAMFERB', 0));
          steps.push(commitResults(app, ctx, [res], label).ops);
          if (!multiple) return;
          continue;
        }
        await option(r1.keyword);
        status();
        continue;
      }
      const e1 = st.doc.entityIndex.get(r1.handle);
      if (!e1 || !unlockedOnly(app, [r1.handle]).length) continue;
      for (;;) {
        const kws2: Keyword[] = kind === 'fillet' ? [{ key: 'R', label: '반지름' }] : [{ key: 'D', label: '거리' }, { key: 'A', label: '각도' }, { key: 'E', label: '메서드' }];
        const second = kind === 'fillet' ? '두 번째 객체 선택' : '두 번째 선 선택';
        const r2 = await ctx.getEntity(`${second} 또는 [${kws2.map((k) => `${k.label}(${k.key})`).join('/')}]:`, kws2);
        if ('keyword' in r2) {
          await option(r2.keyword);
          continue;
        }
        if (!('handle' in r2)) return;
        const e2 = st.doc.entityIndex.get(r2.handle);
        if (!e2 || !unlockedOnly(app, [r2.handle]).length) break;
        const res =
          kind === 'fillet'
            ? fillet(e1, r1.point, e2, r2.point, hnum(st, '$FILLETRAD', 0), { trim })
            : m.chamferMethod === 'A'
              ? chamferAngle(e1, r1.point, e2, r2.point, hnum(st, '$CHAMFERC', 0), hnum(st, '$CHAMFERD', 0), { trim })
              : chamfer(e1, r1.point, e2, r2.point, hnum(st, '$CHAMFERA', 0), hnum(st, '$CHAMFERB', 0), { trim });
        if (!res.add?.length && !res.replace?.length && !res.remove?.length) ctx.print(res.message ?? (kind === 'fillet' ? '이 객체는 모깎기할 수 없습니다.' : '이 객체는 모따기할 수 없습니다.'));
        else steps.push(commitResults(app, ctx, [res], label).ops);
        break;
      }
      if (!multiple) return;
    }
    function chamferAngleAll(pl: Entity): EditResult {
      // 각도 방법: 꼭짓점마다 사이각을 보고 두 번째 거리를 구한다(직각이 아닌 꼭짓점도 첫 선에서 잰 각도가 맞게)
      return chamferPolylineAngle(pl, hnum(st, '$CHAMFERC', 0), hnum(st, '$CHAMFERD', 0));
    }
  };
  app.register({ name: 'FILLET', aliases: ['F'], title: '모깎기', run: corner('fillet') });
  app.register({ name: 'CHAMFER', aliases: ['CHA'], title: '모따기', run: corner('chamfer') });

  // ------------------------------------------------------------- JOIN
  app.register({
    name: 'JOIN',
    aliases: ['J'],
    title: '결합',
    async run(ctx) {
      const st = app.active!;
      const hs = await selectEditable(app, ctx);
      if (!hs.length) return;
      const list = hs.map((h) => st.doc.entityIndex.get(h)).filter((e): e is Entity => !!e);
      const res = joinEntities(list);
      if (!res.add?.length && !res.replace?.length) {
        ctx.print(res.message ?? '결합할 수 있는 객체가 없습니다.');
        return;
      }
      st.selection.clear();
      const a = commitResults(app, ctx, [res], 'JOIN');
      app.refreshSelectionOverlay();
      ctx.print(`객체 ${list.length}개를 ${a.added.length + a.changed.length}개로 결합했습니다.`);
    },
  });

  // ------------------------------------------------------------- STRETCH
  app.register({
    name: 'STRETCH',
    aliases: ['S'],
    title: '신축',
    async run(ctx) {
      const st = app.active!;
      // 걸침 윈도우·걸침 폴리곤(CP) 선택과 신축 영역(src/app/editcmds2-stretch.ts)
      const sel = await stretchSelection(app, ctx);
      if (!sel) return;
      const ents = sel.handles.map((h) => st.doc.entityIndex.get(h)).filter((e): e is Entity => !!e);
      const poly = sel.poly;
      const ghostOf = (d: Pt): OverlayGeom[] => (ents.length <= 400 ? resultGeom(app, stretch(ents, poly, d, st.doc)) : []);
      const r = await ctx.getPoint('기준점 지정 또는 [변위(D)] <변위>:', { keywords: [{ key: 'D', label: '변위' }] });
      let d: Pt | null = null;
      if ('point' in r) {
        const base = r.point;
        const r2 = await ctx.getPoint('두 번째 점 지정 또는 <첫 번째 점을 변위로 사용>:', { base, ghost: (t) => ghostOf({ x: t.x - base.x, y: t.y - base.y }) });
        if ('point' in r2) d = { x: r2.point.x - base.x, y: r2.point.y - base.y };
        else if ('enter' in r2) d = base;
      } else if ('enter' in r || 'keyword' in r) d = await askDisplacement(ctx, { x: 0, y: 0 });
      if (!d || (!d.x && !d.y)) return;
      st.selection.clear();
      const res = stretch(ents, poly, d, st.doc);
      const out = commitResults(app, ctx, [res], 'STRETCH');
      app.refreshSelectionOverlay();
      ctx.print(`객체 ${out.changed.length + out.added.length}개를 신축했습니다.`);
    },
  });

  // ------------------------------------------------------------- 그립 편집
  // 모드: 신축·이동·회전·축척·대칭(Enter·스페이스로 순환하거나 ST·MO·RO·SC·MI — 오른쪽 클릭 메뉴는 앱이 키워드로 만든다).
  // 복사: C 또는 Ctrl(⌘)을 누른 채 찍기(다중 복사가 이어진다). 다중 복사 중 Ctrl을 누르고 있으면 첫 복사의 간격·각도의 배수로 스냅.
  // 여러 핫 그립(hotGrip.items[].point, 없으면 누른 그립 점)은 같은 변위로 신축한다. 그립 하나를 신축하는 중 입력한 값은
  // 결과 길이(선분 길이, 호 끝은 호 길이, 호 중간은 반지름, 폴리선 정점은 앞 세그먼트 길이)이고 미리보기에 동적 치수를 그린다.
  // 다기능 그립 옵션(src/app/gripmenu.ts): 메뉴에서 고르면 arg = 'opt:열쇠'로 바로 실행, 그립 편집 중에는 키워드로 고른다.
  app.register({
    name: 'GRIPEDIT',
    title: '그립 편집',
    async run(ctx, arg) {
      const st = app.active!;
      const doc = st.doc;
      const hot = app.hotGrip;
      app.hotGrip = null;
      if (!hot) return;
      const arr = hot.items.find((it) => it.id.startsWith('arr:'));
      if (arr) {
        await arrayGripEdit(app, ctx, arr.handle, arr.id);
        app.refreshSelectionOverlay();
        return;
      }
      const dyn = hot.items.find((it) => it.id.startsWith('dyn:'));
      if (dyn) {
        await dynGripEdit(app, ctx, dyn.handle, dyn.id);
        app.refreshSelectionOverlay();
        return;
      }
      const items = hot.items
        .filter((it) => unlockedOnly(app, [it.handle]).length)
        .map((it) => ({ handle: it.handle, id: it.id, point: (it as { point?: Pt }).point ?? hot.point }));
      const sel = unlockedOnly(app, [...st.selection]);
      if (!sel.length) return;
      trackModifiers();
      const modes = ['stretch', 'move', 'rotate', 'scale', 'mirror'] as const;
      const names = { stretch: '신축', move: '이동', rotate: '회전', scale: '축척', mirror: '대칭' } as const;
      const modeKw: Keyword[] = [
        { key: 'ST', label: '신축' },
        { key: 'MO', label: '이동' },
        { key: 'RO', label: '회전' },
        { key: 'SC', label: '축척' },
        { key: 'MI', label: '대칭' },
      ];
      let mi = 0;
      let base: Pt = hot.point;
      let copy = false;
      const steps: number[] = [];
      const ghost = new Ghost(app, sel);
      // 객체별 핫 그립. 한 객체의 같은 자리 그립은 하나만(타원형 호가 축 끝에서 끝나면 호의 끝)
      const byHandle = new Map<string, { handle: string; id: string; point: Pt }[]>();
      for (const it of items) {
        const l = byHandle.get(it.handle) ?? [];
        const k = l.findIndex((g) => g.point.x === it.point.x && g.point.y === it.point.y);
        if (k < 0) l.push(it);
        else if (it.id === 'start' || it.id === 'end') l[k] = it;
        byHandle.set(it.handle, l);
      }
      const grips = [...byHandle.values()].flat();
      // 그립 하나: 다기능 옵션(신축 밖의 것)과 신축 중 값 입력
      const single = grips.length === 1 ? grips[0]! : null;
      const singleEnt = single ? doc.entityIndex.get(single.handle) : undefined;
      const opts = single && singleEnt ? gripOptions(app, single, singleEnt, st).filter((o) => o.kind !== 'stretch') : [];
      const dynamic = !!(single && singleEnt && gripTakesValue(singleEnt, single.id));
      let cursor: Pt | null = null;
      const asCopy = (r: EditResult): EditResult => (copy ? { add: [...(r.replace ?? []), ...(r.add ?? [])] } : r);
      const changed = (res: EditResult[]) => res.flatMap((x) => [...(x.replace ?? []), ...(x.add ?? [])]);
      const geomOf = (res: EditResult[]): OverlayGeom[] => {
        const list = changed(res);
        return list.length ? resultGeom(app, { replace: previewEntities(doc, list) }) : [];
      };
      // 동적 치수: 신축한 그립 객체의 길이·각도(복사면 새 객체)
      const dimsGeom = (res: EditResult[]): OverlayGeom[] => {
        if (!dynamic || !single || !singleEnt) return [];
        const after = changed(res).find((x) => x.handle === single.handle);
        const dims = after ? gripDims(singleEnt, single.id, after) : [];
        return dims.length ? [gripDimGeom(dims, 10 * app.view.pixelSize(), st.units)] : [];
      };
      const stretchRes = (to: Pt): EditResult[] => {
        const d = { x: to.x - base.x, y: to.y - base.y };
        // 기준점 자리의 그립은 찍은 점 그대로(스냅한 점이 반올림으로 어긋나지 않게)
        const tgt = (p: Pt): Pt => (p.x === base.x && p.y === base.y ? to : { x: p.x + d.x, y: p.y + d.y });
        const out: EditResult[] = [];
        for (const [h, gs] of byHandle) {
          const e = doc.entityIndex.get(h);
          if (!e) continue;
          const r = gs.length === 1 ? gripMove(e, gs[0]!.id, tgt(gs[0]!.point), doc) : gripMoveMany(e, gs.map((g) => ({ id: g.id, to: tgt(g.point) })), doc);
          // 복사: 원본은 두고 바뀐 것을 새 객체로
          out.push(asCopy(r));
        }
        return out;
      };
      // 다중 복사의 간격 스냅: 첫 복사의 변위(신축·이동)·각도(회전)의 정수배
      let first: { d?: Pt; a?: number } | null = null;
      const snapPick = (mode: (typeof modes)[number], p: Pt): Pt => {
        if (!copy || !first || !ctrlHeld()) return p;
        const f = first.d;
        if ((mode === 'move' || mode === 'stretch') && f) {
          const ff = f.x * f.x + f.y * f.y;
          if (!(ff > 0)) return p;
          const t = ((p.x - base.x) * f.x + (p.y - base.y) * f.y) / ff;
          const k = Math.round(t) || Math.sign(t) || 1;
          return { x: base.x + f.x * k, y: base.y + f.y * k };
        }
        if (mode === 'rotate' && first.a) {
          const t = ang(base, p) / first.a;
          const k = Math.round(t) || Math.sign(t) || 1;
          const r = dist(base, p);
          return { x: base.x + r * Math.cos(first.a * k), y: base.y + r * Math.sin(first.a * k) };
        }
        return p;
      };
      // 다기능 옵션 실행(확정은 명령 취소 한 단계)
      const runOption = async (o: GripOption, at: Pt): Promise<void> => {
        ctx.print(`** ${o.label} **`);
        if (o.kind === 'command') {
          o.start?.();
          return;
        }
        let res: EditResult | null = null;
        if (o.kind === 'now') res = o.apply?.() ?? null;
        else {
          let last: Pt | null = null;
          const r = await ctx.getPoint(o.prompt ?? '대상점 지정:', {
            base: at,
            preferNumber: !!o.numeric,
            ghost: (p) => {
              last = p;
              const x = o.apply?.(p);
              return x && (x.replace?.length || x.add?.length) ? geomOf([x]) : [];
            },
          });
          if ('point' in r) res = o.apply?.(r.point) ?? null;
          else if ('text' in r && o.value) {
            const v = num(r.text);
            if (v !== null) res = o.value(v, last);
          }
        }
        if (!res) return;
        if (!res.replace?.length && !res.add?.length && !res.remove?.length) {
          if (res.message) ctx.print(res.message, 'err');
          return;
        }
        commitResults(app, ctx, [res], 'GRIP');
      };
      if (arg?.startsWith('opt:')) {
        const o = opts.find((x) => x.key === arg.slice(4));
        if (o && single) await runOption(o, single.point);
        app.refreshSelectionOverlay();
        return;
      }
      const xf = (mode: (typeof modes)[number], p: Pt): Affine | null => {
        if (mode === 'move') return translate(p.x - base.x, p.y - base.y);
        if (mode === 'rotate') return rotateAbout(base, ang(base, p));
        if (mode === 'scale') {
          const k = dist(base, p);
          return k > 1e-12 ? scaleAbout(base, k) : null;
        }
        if (mode === 'mirror') return mirrorAbout(base, p);
        return null;
      };
      for (;;) {
        const mode = modes[mi]!;
        const what = mode === 'stretch' ? '신축점' : mode === 'move' ? '이동점' : mode === 'rotate' ? '회전 각도' : mode === 'scale' ? '축척 비율' : '두 번째 점';
        ctx.print(`** ${names[mode]}${copy ? ' (다중)' : ''} **`);
        const r = await ctx.getPoint(`${what} 지정 또는 [기준점(B)/복사(C)/명령 취소(U)/종료(X)]:`, {
          base,
          // 회전·축척은 숫자가 각도·비율, 값을 받는 그립의 신축은 결과 길이(그 밖은 숫자 = 직접 거리)
          preferNumber: mode === 'rotate' || mode === 'scale' || (mode === 'stretch' && dynamic),
          keywords: [...modeKw, { key: 'B', label: '기준점' }, { key: 'C', label: '복사' }, { key: 'U', label: '명령 취소' }, { key: 'X', label: '종료' }, ...opts.map((o) => ({ key: o.key, label: o.label }))],
          ghost: (p0) => {
            cursor = p0;
            const p = snapPick(mode, p0);
            if (mode === 'stretch') {
              if (items.length > 200) return [];
              // 구속으로 이어진 객체도 따라오는 모습으로(풀 수 없으면 그립 결과만)
              let res = stretchRes(p);
              const cons = constraintEditHook(st, res, 'GRIP');
              if (cons.ok) res = cons.results;
              return [...geomOf(res), ...dimsGeom(res)];
            }
            const m = xf(mode, p);
            return m ? ghost.at(m) : [];
          },
        });
        if ('enter' in r) {
          // Enter·스페이스: 다음 모드
          mi = (mi + 1) % modes.length;
          continue;
        }
        if ('keyword' in r) {
          const k = r.keyword;
          const mk = modeKw.findIndex((x) => x.key === k);
          if (mk >= 0) {
            mi = mk;
            continue;
          }
          const o = opts.find((x) => x.key === k);
          if (o && single) {
            await runOption(o, single.point);
            break;
          }
          if (k === 'X') break;
          if (k === 'C') copy = true;
          if (k === 'U') undoStep(app, ctx, steps);
          if (k === 'B') {
            const b = await ctx.getPoint('기준점 지정:');
            if ('point' in b) base = b.point;
          }
          continue;
        }
        let results: EditResult[] = [];
        let xform: Affine | undefined;
        let step: { d?: Pt; a?: number } | null = null;
        if ('point' in r) {
          // Ctrl(⌘)을 누른 채 찍으면 복사(다중 복사로 이어진다)
          if (!copy && ctrlHeld()) copy = true;
          const p = snapPick(mode, r.point);
          if (mode === 'stretch') {
            results = stretchRes(p);
            step = { d: { x: p.x - base.x, y: p.y - base.y } };
          } else {
            const m = xf(mode, p);
            if (m) {
              results = transformAll(st, sel, m, copy);
              xform = m;
              step = mode === 'move' ? { d: { x: p.x - base.x, y: p.y - base.y } } : mode === 'rotate' ? { a: ang(base, p) } : null;
            }
          }
        } else if ('text' in r) {
          const v = num(r.text);
          if (v === null) continue;
          if (mode === 'stretch') {
            const one = single && singleEnt ? gripStretchValue(singleEnt, single.id, v, cursor, doc) : null;
            if (one) results = [asCopy(one)];
          } else if (mode === 'rotate') {
            xform = rotateAbout(base, (v * Math.PI) / 180);
            step = { a: (v * Math.PI) / 180 };
          } else if (mode === 'scale' && v > 0) xform = scaleAbout(base, v);
          if (xform) results = transformAll(st, sel, xform, copy);
        }
        if (!results.length) continue;
        // 바뀐 것 없이 안내만 있으면(길이가 너무 짧음 등) 알리고 다시 묻는다
        if (results.every((x) => !x.replace?.length && !x.add?.length && !x.remove?.length)) {
          const msg = results.find((x) => x.message)?.message;
          if (msg) ctx.print(msg, 'err');
          continue;
        }
        steps.push(commitResults(app, ctx, results, 'GRIP', { transform: xform }).ops);
        if (copy && !first && step) first = step;
        if (!copy) break;
      }
      app.refreshSelectionOverlay();
    },
  });

  // ------------------------------------------------------------- 클립보드
  const copyClip = async (ctx: CommandContext, cut: boolean, askBase: boolean) => {
    const st = app.active!;
    const hs = cut ? await selectEditable(app, ctx) : (await ctx.getSelection()).filter((h) => st.doc.entityIndex.has(h));
    if (!hs.length) return;
    let base: Pt;
    if (askBase) {
      const b = await ctx.getPoint('기준점 지정:');
      if (!('point' in b)) return;
      base = b.point;
    } else {
      const ext = extentsOf(app, hs);
      base = ext ? { x: ext[0], y: ext[1] } : { x: 0, y: 0 };
    }
    clipboard = { doc: st.doc, base, entities: hs.map((h) => cloneEntity(st.doc.entityIndex.get(h)!)) };
    if (cut) {
      st.selection.clear();
      commitResults(app, ctx, [{ remove: hs }], 'CUTCLIP');
      app.refreshSelectionOverlay();
    }
    ctx.print(`${hs.length}개를 클립보드에 ${cut ? '잘라' : '복사해'} 두었습니다.`);
  };
  app.register({ name: 'COPYCLIP', title: '클립보드로 복사', run: (ctx) => copyClip(ctx, false, false) });
  app.register({ name: 'CUTCLIP', title: '클립보드로 잘라내기', run: (ctx) => copyClip(ctx, true, false) });
  app.register({ name: 'COPYBASE', title: '기준점을 두고 복사', run: (ctx) => copyClip(ctx, false, true) });
  app.register({
    name: 'PASTECLIP',
    title: '붙여넣기',
    async run(ctx) {
      const st = app.active!;
      const clip = clipboard;
      if (!clip || !clip.entities.length) {
        ctx.print('클립보드가 비어 있습니다. 먼저 객체를 복사(Ctrl+C)하십시오.', 'err');
        return;
      }
      const pk = app.picker();
      const preview = pk && clip.doc === st.doc ? pk.geometryOf(clip.entities) : null;
      const pg = preview ? Ghost.of(preview) : null;
      const ghost = (p: Pt): OverlayGeom[] => (pg ? pg.at(translate(p.x - clip.base.x, p.y - clip.base.y)) : []);
      const r = await ctx.getPoint('삽입점 지정:', { ghost });
      if (!('point' in r)) return;
      const d = translate(r.point.x - clip.base.x, r.point.y - clip.base.y);
      const list = clip.entities.map((e) => cloneEntity(e));
      const deps = importDependencies(st, clip.doc, list);
      if (deps.length) st.session.commit({ label: 'PASTECLIP', ops: deps, group: ctx.group });
      const results: EditResult[] = list.map((e) => copyEntity(e, d, st.doc));
      st.selection.clear();
      const a = commitResults(app, ctx, results, 'PASTECLIP');
      app.setSelection(a.added.slice(0, 5000));
      ctx.print(`${a.added.length}개를 붙여 넣었습니다.`);
    },
  });
  app.register({
    name: 'PASTEORIG',
    title: '원래 좌표에 붙여넣기',
    async run(ctx) {
      const st = app.active!;
      const clip = clipboard;
      if (!clip || !clip.entities.length) {
        ctx.print('클립보드가 비어 있습니다. 먼저 객체를 복사(Ctrl+C)하십시오.', 'err');
        return;
      }
      // AutoCAD처럼 복사한 도면에는 쓸 수 없다(같은 자리에 겹친다)
      if (clip.doc === st.doc) {
        ctx.print('같은 도면에서 복사한 객체는 원래 좌표에 붙여 넣을 수 없습니다.', 'err');
        return;
      }
      const list = clip.entities.map((e) => cloneEntity(e));
      const deps = importDependencies(st, clip.doc, list);
      if (deps.length) st.session.commit({ label: 'PASTEORIG', ops: deps, group: ctx.group });
      st.selection.clear();
      const a = commitResults(app, ctx, list.map((e) => copyEntity(e, translate(0, 0), st.doc)), 'PASTEORIG');
      app.setSelection(a.added.slice(0, 5000));
      ctx.print(`${a.added.length}개를 원래 좌표에 붙여 넣었습니다.`);
    },
  });
  app.register({
    name: 'PASTEBLOCK',
    title: '블록으로 붙여넣기',
    async run(ctx) {
      const st = app.active!;
      const clip = clipboard;
      if (!clip || !clip.entities.length) {
        ctx.print('클립보드가 비어 있습니다. 먼저 객체를 복사(Ctrl+C)하십시오.', 'err');
        return;
      }
      const pk = app.picker();
      const preview = pk && clip.doc === st.doc ? pk.geometryOf(clip.entities) : null;
      const pg = preview ? Ghost.of(preview) : null;
      const r = await ctx.getPoint('삽입점 지정:', { ghost: (p) => (pg ? pg.at(translate(p.x - clip.base.x, p.y - clip.base.y)) : []) });
      if (!('point' in r)) return;
      const list = clip.entities.map((e) => cloneEntity(e));
      const deps = importDependencies(st, clip.doc, list);
      // AutoCAD처럼 A$C + 16진 8자리 이름의 블록(기준점 = 복사 기준점)
      let name = '';
      do name = `A$C${Math.floor(Math.random() * 0x100000000).toString(16).toUpperCase().padStart(8, '0')}`;
      while (st.doc.blocks.has(tableKey(name)));
      const recordHandle = st.session.newHandle();
      for (const e of list) {
        e.handle = st.session.newHandle();
        e.owner = recordHandle;
        delete e.xdict;
        delete e.reactors;
        if (e.type === 'INSERT') for (const at of e.attribs) at.handle = st.session.newHandle();
      }
      const record: BlockRecord = { name, handle: recordHandle, flags: 0, insertUnits: Number(st.doc.header.get('$INSUNITS') ?? 0) || 0, explodable: true, scalable: true };
      const def: BlockDef = {
        name,
        handle: st.session.newHandle(),
        recordHandle,
        basePoint: { x: clip.base.x, y: clip.base.y, z: 0 },
        flags: 0,
        layer: '0',
        entities: list,
        endHandle: st.session.newHandle(),
      };
      const space = st.doc.blocks.get(st.space)!;
      const ins: Entity = {
        ...entityDefaults(),
        ...currentProps(app),
        type: 'INSERT',
        handle: st.session.newHandle(),
        owner: space.recordHandle,
        block: name,
        insert: { x: r.point.x, y: r.point.y, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        rotation: 0,
        columnCount: 1,
        rowCount: 1,
        columnSpacing: 0,
        rowSpacing: 0,
        attribs: [],
      };
      if (/^\*PAPER_SPACE/i.test(st.space)) ins.paperSpace = true;
      st.selection.clear();
      st.session.commit({
        label: 'PASTEBLOCK',
        ops: [...deps, { kind: 'blockRecord', key: tableKey(name), before: null, after: record }, { kind: 'blockDef', key: tableKey(name), before: null, after: def }, { kind: 'add', block: st.space, entity: ins }],
        group: ctx.group,
      });
      app.setSelection([ins.handle]);
      ctx.print(`블록 "${name}"(객체 ${list.length}개)으로 붙여 넣었습니다.`);
    },
  });
}
