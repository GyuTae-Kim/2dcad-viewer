/**
 * 주석 객체 편집(순수 함수): 주석 켜기·끄기, 축척 추가·삭제, 보이는 축척 바꾸기(CANNOSCALE), 위치 재설정(ANNORESET),
 * 다른 편집을 따라가기(이동·회전·축척), 복사본의 레코드 복제, 새로 만든 객체를 주석 객체로.
 *
 * 쓰는 형식:
 * - TEXT·MTEXT·블록 참조·한 줄 속성: AutoCAD 컨텍스트 레코드(축척마다 하나, 보이는 축척이 290 = 1).
 *   TEXT·MTEXT는 `AcadAnnotative {1, 1}`, 속성은 `{1, 0}`(실물과 같다). 레코드의 340은 SCALE 핸들이므로
 *   축척 리스트가 도면에 있어야 한다(부르는 쪽이 먼저 만든다).
 * - 치수·해치·다중 지시선: AutoCAD 레코드 형식을 이 프로그램이 확인하지 못해 자체 기록(OPENCAD_ANNOSCALE)에
 *   축척 이름만 둔다. 다른 축척의 그림은 그릴 때 계산한다. AutoCAD는 이 객체들을 보이는 크기의 일반 객체로 본다.
 * 모든 함수는 바뀐 객체(같으면 그 객체)를 돌려주고, 사전·레코드 편집은 ops에 더한다.
 */
import type { AttribEntity, BlockDef, BlockRecord, CadDocument, DimensionEntity, Entity, GenericObject, HatchEntity, InsertEntity, MLeaderEntity, MTextEntity, TextEntity, Vec2 } from '../../core/model';
import { tableKey } from '../../core/model';
import { generateDimensionGeometry } from '../dim/generate';
import { measureText } from '../dim/textbox';
import type { EditOp } from '../session';
import {
  type BlkFields,
  CLASS_ATTRIB,
  CLASS_BLKREF,
  CLASS_MTEXT,
  CLASS_TEXT,
  type ContextRecord,
  type MTextFields,
  type TextFields,
  addRecordOps,
  blkFields,
  blkRecordRaw,
  classVersion,
  contextChain,
  contextRecords,
  ensureChain,
  hasRecordEntries,
  hatchFields,
  hatchRecordWithLines,
  mtextFields,
  parseRecord,
  mtextRecordRaw,
  removeRecordOps,
  retagRecord,
  rewriteRecordOps,
  textFields,
  textRecordRaw,
} from './context';
import { type AnnoState, type ScaleIndex, type Similarity, annoKindOf, annoState, representation, scaleLines, scaleMLeader, simApply } from './represent';
import { type AnnoScale, changed, dictOf, factorOf, newDict, pendingObject, upper } from './scales';
import { annotativeFlag, blockAnnotative, dimStyleAnnotative, mleaderStyleAnnotative, ownRecord, textStyleAnnotative, withAnnotativeFlag, withOwnRecord } from './xdata';

export interface EditEnv {
  doc: CadDocument;
  alloc: () => string;
  idx: ScaleIndex;
  /** 이 변경에서 이미 쓴 블록 이름(대문자, 새 *D 이름이 겹치지 않게) */
  taken?: Set<string>;
}

export interface Edited {
  entity: Entity;
  ops: EditOp[];
}

const RECORD_KINDS = new Set(['text', 'mtext', 'insert']);

/** AutoCAD 레코드로 쓰는 종류인지(TEXT·MTEXT·블록 참조) */
export function usesRecords(e: Entity): boolean {
  const k = annoKindOf(e);
  return !!k && RECORD_KINDS.has(k);
}

function scaleOf(env: EditEnv, name: string): AnnoScale {
  const s = env.idx.name(name);
  if (!s) throw new Error(`축척 ${name}을(를) 찾지 못했습니다.`);
  return s;
}

function handleOf(env: EditEnv, name: string): string {
  const s = scaleOf(env, name);
  if (!s.handle) throw new Error('축척 리스트가 도면에 없습니다.');
  return upper(s.handle);
}

// ---------------------------------------------------------------------------
// 객체 데이터 → 레코드 필드
// ---------------------------------------------------------------------------

function textFieldsOf(t: TextEntity | AttribEntity): TextFields {
  return { halign: t.halign, rotation: t.rotation, insert: { x: t.insert.x, y: t.insert.y }, align: t.alignPoint ? { x: t.alignPoint.x, y: t.alignPoint.y } : { x: 0, y: 0 } };
}

function mtextFieldsOf(doc: CadDocument, m: MTextEntity): MTextFields {
  let dir = m.direction;
  if (!dir || Math.hypot(dir.x, dir.y, dir.z) < 1e-12) dir = { x: Math.cos(m.rotation), y: Math.sin(m.rotation), z: 0 };
  let ext = { w: 0, h: 0 };
  try {
    ext = measureText(m.text, m.height, doc.textStyles.get(tableKey(m.style)));
  } catch {
    /* 범위를 모르면 0(AutoCAD가 다시 계산한다) */
  }
  const f: MTextFields = {
    attachment: m.attachment,
    direction: dir,
    insert: { ...m.insert },
    width: m.width,
    rectHeight: m.rectHeight ?? 0,
    extWidth: m.width > 0 ? Math.min(ext.w, m.width) : ext.w,
    extHeight: ext.h,
    columnType: m.columns?.type ?? 0,
  };
  if (m.columns?.type) {
    f.columnCount = m.columns.count;
    f.columnWidth = m.columns.width;
    f.gutter = m.columns.gutter;
    f.autoHeight = m.columns.autoHeight;
    f.flowReversed = m.columns.flowReversed;
  }
  return f;
}

function blkFieldsOf(e: InsertEntity): BlkFields {
  return { rotation: e.rotation, insert: { ...e.insert }, scale: { ...e.scale } };
}

/** 객체(지금 데이터)의 레코드 원시 태그 */
function recordRawOf(env: EditEnv, e: Entity, scaleH: string, isDefault: boolean): { type: string; raw: ReturnType<typeof textRecordRaw> } | null {
  const ver = classVersion(env.doc);
  switch (e.type) {
    case 'TEXT':
      return { type: CLASS_TEXT, raw: textRecordRaw(ver, isDefault, scaleH, textFieldsOf(e as TextEntity)) };
    case 'ATTRIB':
      return { type: CLASS_ATTRIB, raw: textRecordRaw(ver, isDefault, scaleH, textFieldsOf(e as AttribEntity), true) };
    case 'MTEXT':
      return { type: CLASS_MTEXT, raw: mtextRecordRaw(ver, isDefault, scaleH, mtextFieldsOf(env.doc, e)) };
    case 'INSERT':
      return { type: CLASS_BLKREF, raw: blkRecordRaw(ver, isDefault, scaleH, blkFieldsOf(e)) };
    default:
      return null;
  }
}

/** 축척 k배(같은 자리)의 객체: 문자 높이·여러 줄 문자 폭·블록 축척과 속성(삽입점 기준) */
export function scaledInPlace<T extends Entity>(e: T, k: number): T {
  switch (e.type) {
    case 'TEXT':
    case 'ATTRIB':
    case 'ATTDEF': {
      const t = e as TextEntity;
      const out = { ...t, height: t.height * k } as TextEntity;
      // 정렬·맞춤 문자는 두 점 사이 거리도 바뀐다
      if (t.alignPoint && (t.halign === 3 || t.halign === 5)) out.alignPoint = { x: t.insert.x + (t.alignPoint.x - t.insert.x) * k, y: t.insert.y + (t.alignPoint.y - t.insert.y) * k, z: t.alignPoint.z };
      return out as unknown as T;
    }
    case 'MTEXT': {
      const m = e as MTextEntity;
      const out: MTextEntity = { ...m, height: m.height * k, width: m.width * k };
      if (m.rectHeight) out.rectHeight = m.rectHeight * k;
      if (m.columns) out.columns = { ...m.columns, width: m.columns.width * k, gutter: m.columns.gutter * k, heights: m.columns.heights.map((h) => h * k) };
      return out as unknown as T;
    }
    case 'INSERT': {
      const b = e as InsertEntity;
      const sim: Similarity = { from: b.insert, to: b.insert, rot: 0, k };
      return {
        ...b,
        scale: { x: b.scale.x * k, y: b.scale.y * k, z: b.scale.z * k },
        columnSpacing: b.columnSpacing * k,
        rowSpacing: b.rowSpacing * k,
        attribs: b.attribs.map((a) => {
          const p = simApply(sim, a.insert);
          const out = { ...a, insert: { x: p.x, y: p.y, z: a.insert.z }, height: a.height * k };
          if (a.alignPoint) {
            const q = simApply(sim, a.alignPoint);
            out.alignPoint = { x: q.x, y: q.y, z: a.alignPoint.z };
          }
          return out;
        }),
      } as unknown as T;
    }
    case 'HATCH': {
      const h = e as HatchEntity;
      if (h.solid || !h.patternLines.length) return e;
      return { ...h, patternLines: scaleLines(h.patternLines, k) } as unknown as T;
    }
    case 'MULTILEADER':
      return scaleMLeader(e as MLeaderEntity, k) as unknown as T;
    default:
      return e;
  }
}

// ---------------------------------------------------------------------------
// 치수 그림 다시 만들기(DIMSCALE = 배율)
// ---------------------------------------------------------------------------

/**
 * 치수의 그림을 DIMSCALE 재지정(없으면 스타일)으로 새 익명 블록에 다시 만든다.
 * 치수가 쓰던 블록은 그대로 둔다(다른 레코드가 가리킬 수 있다).
 */
export function regenerateDimension(env: EditEnv, d: DimensionEntity, dimscale: number | null, ops: EditOp[]): DimensionEntity {
  const doc = env.doc;
  const overrides: Record<number, string | number> = { ...(d.overrides ?? {}) };
  if (dimscale === null) delete overrides[40];
  else overrides[40] = dimscale;
  const out: DimensionEntity = { ...d, overrides: Object.keys(overrides).length ? overrides : undefined };
  const g = generateDimensionGeometry(doc, out);
  out.textMid = g.textMid;
  out.measurement = g.measurement;
  const pendingBlock = (name: string) => doc.blocks.has(tableKey(name)) || ops.some((o) => o.kind === 'blockDef' && o.key === tableKey(name) && o.after);
  for (const ab of g.arrowBlocks) {
    if (pendingBlock(ab.name)) continue;
    const key = tableKey(ab.name);
    const rec: BlockRecord = { name: ab.name, handle: env.alloc(), flags: 0, insertUnits: 0, explodable: true, scalable: true };
    for (const x of ab.entities) {
      x.handle = env.alloc();
      x.owner = rec.handle;
    }
    ops.push({ kind: 'blockRecord', key, before: null, after: rec });
    ops.push({ kind: 'blockDef', key, before: null, after: { name: ab.name, handle: env.alloc(), recordHandle: rec.handle, basePoint: { x: 0, y: 0, z: 0 }, flags: 0, entities: ab.entities, endHandle: env.alloc() } });
  }
  let n = 0;
  const taken = (env.taken ??= new Set());
  for (const k of [...doc.blocks.keys(), ...taken, ...ops.filter((o) => o.kind === 'blockDef').map((o) => o.key)]) {
    const m = /^\*D(\d+)$/.exec(k);
    if (m) n = Math.max(n, Number(m[1]));
  }
  const name = `*D${n + 1}`;
  const key = tableKey(name);
  taken.add(key);
  const recH = env.alloc();
  ops.push({ kind: 'blockRecord', key, before: null, after: { name, handle: recH, flags: 1, insertUnits: 0, explodable: true, scalable: true } });
  for (const x of g.entities) {
    x.handle = env.alloc();
    x.owner = recH;
  }
  const def: BlockDef = { name, handle: env.alloc(), recordHandle: recH, basePoint: { x: 0, y: 0, z: 0 }, flags: 1, entities: g.entities, endHandle: env.alloc() };
  ops.push({ kind: 'blockDef', key, before: null, after: def });
  out.block = name;
  return out;
}

// ---------------------------------------------------------------------------
// 주석 켜기·끄기
// ---------------------------------------------------------------------------

/** 레코드 사슬을 만들고 객체(와 속성)에 지금 데이터로 축척 하나의 레코드를 쓴다 */
function writeFirstRecords(env: EditEnv, e: Entity, scaleName: string, ops: EditOp[]): Entity {
  const h = handleOf(env, scaleName);
  let out = e;
  const rr = recordRawOf(env, e, h, true);
  if (!rr) return e;
  const chain = ensureChain(env.doc, e, env.alloc, ops);
  if (chain.newXdict) out = { ...out, xdict: chain.newXdict };
  // 이미 있던 레코드(주석이 아니던 시절의 것)는 지운다
  for (const r of contextRecords(env.doc, e)) removeRecordOps(env.doc, chain.scales, r, ops);
  addRecordOps(env.doc, chain.scales, rr.type, rr.raw, env.alloc, ops);
  if (out.type === 'INSERT') {
    const ins = out as InsertEntity;
    out = {
      ...ins,
      attribs: ins.attribs.map((a) => {
        const ar = recordRawOf(env, a, h, true);
        if (!ar || a.mtext) return a;
        let aa: AttribEntity = { ...a, xdata: withAnnotativeFlag(a.xdata, false) };
        const ac = ensureChain(env.doc, a, env.alloc, ops);
        if (ac.newXdict) aa = { ...aa, xdict: ac.newXdict };
        for (const r of contextRecords(env.doc, a)) removeRecordOps(env.doc, ac.scales, r, ops);
        addRecordOps(env.doc, ac.scales, ar.type, ar.raw, env.alloc, ops);
        return aa;
      }),
    };
  }
  return out;
}

/**
 * 주석 표지는 있지만 레코드가 없는 객체(확장 사전을 떼어 낸 복사본 등)에 지금 데이터로 축척 하나의 레코드를 준다(크기는 그대로).
 */
export function adoptRecords(env: EditEnv, e: Entity, scaleName: string): Edited {
  const ops: EditOp[] = [];
  if (!usesRecords(e) || e.xdict) return { entity: e, ops };
  const s = scaleOf(env, scaleName);
  return { entity: writeFirstRecords(env, e, s.name, ops), ops };
}

/**
 * 주석으로: 지금 크기가 용지 크기가 되고 모형 크기는 그 축척의 배율만큼 커진다(상태 = 그 축척 하나).
 * 블록 참조는 주석 블록일 때만(새로 넣은 참조). 이미 주석이면 그대로.
 */
export function makeAnnotative(env: EditEnv, e: Entity, scaleName: string, opt: { creating?: boolean } = {}): Edited {
  const ops: EditOp[] = [];
  const st = annoState(env.doc, e, env.idx);
  // 이미 주석이면 그대로(표지만 있고 레코드가 하나도 없는 것 — 새 주석 블록 참조 등 — 은 레코드를 만든다)
  if (st && (!st.foreign || hasRecordEntries(env.doc, e))) return { entity: e, ops };
  const s = scaleOf(env, scaleName);
  const f = factorOf(s);
  const name = s.name;
  switch (e.type) {
    case 'TEXT':
    case 'MTEXT': {
      // 새로 만든 여러 줄 문자의 폭은 모형에서 그린 사각형이므로 높이만 키운다
      const sc: Entity = opt.creating && e.type === 'MTEXT' ? { ...e, height: e.height * f } : scaledInPlace(e, f);
      const out = writeFirstRecords(env, { ...sc, xdata: withAnnotativeFlag(sc.xdata, true) }, name, ops);
      return { entity: out, ops };
    }
    case 'INSERT': {
      if (!blockAnnotative(env.doc, e.block)) return { entity: e, ops };
      const out = writeFirstRecords(env, scaledInPlace(e, f), name, ops);
      return { entity: out, ops };
    }
    case 'DIMENSION': {
      let out = regenerateDimension(env, e, f, ops);
      out = { ...out, xdata: withOwnRecord(out.xdata, { current: name, scales: [name] }) };
      return { entity: out, ops };
    }
    case 'HATCH':
    case 'MULTILEADER': {
      const out = scaledInPlace(e, f);
      return { entity: { ...out, xdata: withOwnRecord(out.xdata, { current: name, scales: [name] }) } as Entity, ops };
    }
    default:
      return { entity: e, ops };
  }
}

/** 주석 아님: 용지 크기로 돌아가고 레코드·자체 기록을 지운다(TEXT·MTEXT는 `{1, 0}`으로 남긴다) */
export function makeNonAnnotative(env: EditEnv, e: Entity): Edited {
  const ops: EditOp[] = [];
  const st = annoState(env.doc, e, env.idx);
  if (!st || st.foreign) return { entity: e, ops };
  const k = 1 / env.idx.factor(st.current);
  const chain = contextChain(env.doc, e);
  if (chain.scales) for (const r of st.records) removeRecordOps(env.doc, chain.scales, r, ops);
  let out: Entity = e;
  switch (e.type) {
    case 'TEXT':
    case 'MTEXT':
      out = { ...scaledInPlace(e, k), xdata: withAnnotativeFlag(e.xdata, false) };
      break;
    case 'INSERT':
      // 주석 블록의 참조는 블록을 따른다: 레코드만 지우고 크기는 그대로
      out = e;
      for (const a of (e as InsertEntity).attribs) {
        const ac = contextChain(env.doc, a);
        if (ac.scales) for (const r of contextRecords(env.doc, a)) removeRecordOps(env.doc, ac.scales, r, ops);
      }
      break;
    case 'DIMENSION': {
      const d = regenerateDimension(env, e, null, ops);
      out = { ...d, xdata: withOwnRecord(annotativeFlag(e.xdata) === undefined ? d.xdata : withAnnotativeFlag(d.xdata, false), null) };
      break;
    }
    case 'HATCH':
    case 'MULTILEADER': {
      const sc = scaledInPlace(e, k);
      out = { ...sc, xdata: withOwnRecord(annotativeFlag(e.xdata) === undefined ? sc.xdata : withAnnotativeFlag(sc.xdata, false), null) } as Entity;
      break;
    }
  }
  return { entity: out, ops };
}

// ---------------------------------------------------------------------------
// 축척 추가·삭제
// ---------------------------------------------------------------------------

/** 객체에 축척들을 더한다(새 표현은 지금 보이는 표현의 자리에서 시작) */
export function addScales(env: EditEnv, e: Entity, names: readonly string[]): Edited {
  const ops: EditOp[] = [];
  const st = annoState(env.doc, e, env.idx);
  if (!st || st.foreign) return { entity: e, ops };
  const todo = names.map((n) => scaleOf(env, n)).filter((s) => !st.byScale.has(s.name.toUpperCase()));
  if (!todo.length) return { entity: e, ops };
  if (usesRecords(e) && st.records.length) {
    let out = e;
    const chain = ensureChain(env.doc, e, env.alloc, ops);
    if (chain.newXdict) out = { ...out, xdict: chain.newXdict };
    const fCur = env.idx.factor(st.current);
    for (const s of todo) {
      const k = factorOf(s) / fCur;
      const rep = scaledInPlace(e, k);
      const rr = recordRawOf(env, rep, handleOf(env, s.name), false)!;
      addRecordOps(env.doc, chain.scales, rr.type, rr.raw, env.alloc, ops);
      if (rep.type === 'INSERT') {
        const attribs = (rep as InsertEntity).attribs;
        const own = (out as InsertEntity).attribs;
        const next = own.map((a, i) => {
          const ra = attribs[i]!;
          const ar = recordRawOf(env, ra, handleOf(env, s.name), false);
          if (!ar || a.mtext) return a;
          const ac = ensureChain(env.doc, a, env.alloc, ops);
          addRecordOps(env.doc, ac.scales, ar.type, ar.raw, env.alloc, ops);
          return ac.newXdict ? { ...a, xdict: ac.newXdict } : a;
        });
        out = { ...(out as InsertEntity), attribs: next };
      }
    }
    return { entity: out, ops };
  }
  // 자체 기록(레코드가 있는 치수·다중 지시선이면 새 축척만 자체 기록에)
  const existing = ownRecord(e.xdata);
  const curName = env.idx.name(st.current)?.name ?? st.current;
  const eq = (a: string) => (b: string) => a.toUpperCase() === b.toUpperCase();
  const scales = [...(existing?.scales ?? [])];
  if (!st.records.length && !scales.some(eq(curName))) scales.unshift(curName);
  for (const s of todo) if (!scales.some(eq(s.name))) scales.push(s.name);
  return { entity: { ...e, xdata: withOwnRecord(e.xdata, { current: curName, scales }) }, ops };
}

/** 보이는 축척을 바꾼다: 객체 데이터 = 그 축척의 표현, 그 레코드가 기본 */
export function switchScale(env: EditEnv, e: Entity, name: string): Edited {
  const ops: EditOp[] = [];
  const st = annoState(env.doc, e, env.idx);
  const k = name.toUpperCase();
  if (!st || st.foreign || !st.byScale.has(k) || st.current === k) return { entity: e, ops };
  let out = representation(env.doc, e, st, k, env.idx).entity;
  // 그릴 때 쓰는 가상 블록은 진짜 블록으로 만든다(자체 기록의 치수: DIMSCALE 재지정 = 그 배율)
  if (out.type === 'DIMENSION' && (!st.byScale.get(k) || /^\*OPENCAD_ANNO_/i.test(out.block))) out = regenerateDimension(env, e as DimensionEntity, env.idx.factor(k), ops);
  for (const r of st.records) {
    const nm = env.idx.handle(r.scale)?.name.toUpperCase();
    const want = nm === k;
    if (r.isDefault !== want) rewriteRecordOps(env.doc, r, retagRecord(r.raw, want), ops);
  }
  // 속성 레코드의 기본 표지도 옮긴다
  if (out.type === 'INSERT') {
    for (const a of (e as InsertEntity).attribs) {
      for (const r of contextRecords(env.doc, a)) {
        const want = env.idx.handle(r.scale)?.name.toUpperCase() === k;
        if (r.isDefault !== want) rewriteRecordOps(env.doc, r, retagRecord(r.raw, want), ops);
      }
    }
  }
  const own = ownRecord(e.xdata);
  if (own) out = { ...out, xdata: withOwnRecord(out.xdata, { ...own, current: env.idx.name(k)?.name ?? k }) };
  return { entity: out, ops };
}

/** 객체에서 축척들을 지운다. 축척은 하나 이상 남는다. 보이는 축척을 지우면 남은 첫 축척을 보인다 */
export function removeScales(env: EditEnv, e: Entity, names: readonly string[]): Edited & { kept: boolean } {
  const st = annoState(env.doc, e, env.idx);
  if (!st || st.foreign) return { entity: e, ops: [], kept: false };
  const drop = new Set(names.map((n) => n.toUpperCase()).filter((k) => st.byScale.has(k)));
  if (!drop.size) return { entity: e, ops: [], kept: false };
  const remain = st.scales.filter((k) => !drop.has(k));
  let kept = false;
  if (!remain.length) {
    // 마지막 하나는 남긴다(보이는 축척)
    drop.delete(st.current);
    remain.push(st.current);
    kept = true;
    if (!drop.size) return { entity: e, ops: [], kept };
  }
  let entity = e;
  const ops: EditOp[] = [];
  if (drop.has(st.current)) {
    const sw = switchScale(env, e, remain[0]!);
    entity = sw.entity;
    ops.push(...sw.ops);
  }
  const chain = contextChain(env.doc, e);
  for (const r of st.records) {
    const nm = env.idx.handle(r.scale)?.name.toUpperCase();
    if (nm && drop.has(nm) && chain.scales) removeRecordOps(env.doc, chain.scales, r, ops);
  }
  if (entity.type === 'INSERT') {
    for (const a of (entity as InsertEntity).attribs) {
      const ac = contextChain(env.doc, a);
      if (!ac.scales) continue;
      for (const r of contextRecords(env.doc, a)) {
        const nm = env.idx.handle(r.scale)?.name.toUpperCase();
        if (nm && drop.has(nm)) removeRecordOps(env.doc, ac.scales, r, ops);
      }
    }
  }
  const own = ownRecord(entity.xdata);
  if (own) {
    const scales = own.scales.filter((n) => !drop.has(n.toUpperCase()));
    const cur = scales.find((n) => n.toUpperCase() === own.current.toUpperCase()) ?? scales[0];
    entity = { ...entity, xdata: withOwnRecord(entity.xdata, scales.length ? { current: cur!, scales } : null) };
  }
  return { entity, ops, kept };
}

// ---------------------------------------------------------------------------
// 위치 재설정(ANNORESET)·다른 편집 따라가기·복사본
// ---------------------------------------------------------------------------

/** 모든 축척 표현의 위치를 지금 보이는 표현의 위치로(크기는 축척마다) */
export function resetScales(env: EditEnv, e: Entity): Edited {
  const ops: EditOp[] = [];
  const st = annoState(env.doc, e, env.idx);
  if (!st || st.foreign || !usesRecords(e)) return { entity: e, ops };
  const fCur = env.idx.factor(st.current);
  for (const r of st.records) {
    const s = env.idx.handle(r.scale);
    if (!s) continue;
    const rep = scaledInPlace(e, factorOf(s) / fCur);
    const rr = recordRawOf(env, rep, upper(r.scale), r.isDefault);
    if (rr) rewriteRecordOps(env.doc, r, rr.raw, ops);
    if (rep.type === 'INSERT') attribRecords(env, rep as InsertEntity, s.name.toUpperCase(), r.isDefault, ops);
  }
  return { entity: e, ops };
}

/** 블록 참조 표현 rep의 속성 데이터로 그 축척의 속성 레코드를 고쳐 쓴다 */
function attribRecords(env: EditEnv, rep: InsertEntity, name: string, isDefault: boolean, ops: EditOp[]): void {
  for (const a of rep.attribs) {
    if (!a.xdict || a.mtext) continue;
    for (const r of contextRecords(env.doc, a)) {
      if (env.idx.handle(r.scale)?.name.toUpperCase() !== name) continue;
      const rr = recordRawOf(env, a, upper(r.scale), isDefault);
      if (rr) rewriteRecordOps(env.doc, r, rr.raw, ops);
    }
  }
}

/** 두 상태 사이의 닮음 변환(문자·여러 줄 문자·블록 참조). 알 수 없으면 null */
export function similarityBetween(a: Entity, b: Entity): Similarity | null {
  if (a.type !== b.type) return null;
  switch (a.type) {
    case 'TEXT':
    case 'ATTRIB': {
      const t = b as TextEntity;
      if (!(a.height > 0)) return null;
      return { from: a.insert, to: t.insert, rot: t.rotation - a.rotation, k: t.height / a.height };
    }
    case 'MTEXT': {
      const m = b as MTextEntity;
      const ang = (x: MTextEntity) => (x.direction && Math.hypot(x.direction.x, x.direction.y) > 1e-12 ? Math.atan2(x.direction.y, x.direction.x) : x.rotation);
      if (!(a.height > 0)) return null;
      return { from: a.insert, to: m.insert, rot: ang(m) - ang(a), k: m.height / a.height };
    }
    case 'INSERT': {
      const i = b as InsertEntity;
      if (Math.abs(a.scale.x) < 1e-12) return null;
      return { from: a.insert, to: i.insert, rot: i.rotation - a.rotation, k: Math.abs(i.scale.x / a.scale.x) };
    }
    default:
      return null;
  }
}

function moveTextRecord(f: TextFields, s: Similarity): TextFields {
  return { ...f, insert: simApply(s, f.insert), align: f.align.x || f.align.y ? simApply(s, f.align) : f.align, rotation: f.rotation + s.rot };
}

/**
 * 다른 편집(이동·회전·축척·특성)이 객체를 before → after로 바꾸었을 때 레코드를 따라가게 한다.
 * 보이는 축척의 레코드는 after의 데이터로, 다른 축척은 before → after의 닮음 변환으로 옮긴다.
 * 치수·다중 지시선의 AutoCAD 레코드는 그 축척의 그림이 낡으므로 지우고 자체 기록으로 옮긴다(그릴 때 다시 계산).
 * 돌려주는 객체는 after(자체 기록이 바뀌면 그 XDATA를 고친 것).
 */
export function followEdit(env: EditEnv, before: Entity, after: Entity): Edited {
  const ops: EditOp[] = [];
  const st = annoState(env.doc, before, env.idx);
  if (!st || st.foreign || before.type !== after.type) return { entity: after, ops };
  // 이미 이 모듈이 레코드를 다룬 객체(사전이 바뀌었으면)는 건드리지 않는다
  if (upper(before.xdict) !== upper(after.xdict)) return { entity: after, ops };
  if (usesRecords(after)) {
    const sim = similarityBetween(before, after);
    for (const r of st.records) {
      const nm = env.idx.handle(r.scale)?.name.toUpperCase();
      if (!nm) continue;
      if (nm === st.current) {
        const rr = recordRawOf(env, after, upper(r.scale), true);
        if (rr) rewriteRecordOps(env.doc, r, rr.raw, ops);
        continue;
      }
      if (!sim) continue;
      if (r.kind === 'text' || r.kind === 'attrib') {
        const f = textFields(r);
        if (f && !f.multiline) rewriteRecordOps(env.doc, r, textRecordRaw(classVersion(env.doc), false, upper(r.scale), moveTextRecord(f, sim), r.kind === 'attrib'), ops);
      } else if (r.kind === 'mtext') {
        const f = mtextFields(r);
        if (f) {
          const p = simApply(sim, f.insert);
          const c = Math.cos(sim.rot);
          const n = Math.sin(sim.rot);
          const d = f.direction;
          rewriteRecordOps(
            env.doc,
            r,
            mtextRecordRaw(classVersion(env.doc), false, upper(r.scale), {
              ...f,
              insert: { x: p.x, y: p.y, z: f.insert.z },
              direction: { x: c * d.x - n * d.y, y: n * d.x + c * d.y, z: d.z },
              width: f.width * sim.k,
              rectHeight: f.rectHeight * sim.k,
              extWidth: f.extWidth * sim.k,
              extHeight: f.extHeight * sim.k,
              columnWidth: f.columnWidth !== undefined ? f.columnWidth * sim.k : undefined,
              gutter: f.gutter !== undefined ? f.gutter * sim.k : undefined,
            }),
            ops,
          );
        }
      } else if (r.kind === 'blkref') {
        const f = blkFields(r);
        if (f) {
          const p = simApply(sim, f.insert);
          rewriteRecordOps(env.doc, r, blkRecordRaw(classVersion(env.doc), false, upper(r.scale), { rotation: f.rotation + sim.rot, insert: { x: p.x, y: p.y, z: f.insert.z }, scale: { x: f.scale.x * sim.k, y: f.scale.y * sim.k, z: f.scale.z * sim.k } }), ops);
        }
      }
    }
    // 속성 레코드
    if (after.type === 'INSERT' && before.type === 'INSERT') {
      after.attribs.forEach((a, i) => {
        const b = before.attribs[i];
        if (!b || !a.xdict || a.mtext) return;
        for (const r of contextRecords(env.doc, b)) {
          const nm = env.idx.handle(r.scale)?.name.toUpperCase();
          if (nm === st.current) {
            const rr = recordRawOf(env, a, upper(r.scale), r.isDefault);
            if (rr) rewriteRecordOps(env.doc, r, rr.raw, ops);
          } else if (sim) {
            const f = textFields(r);
            if (f && !f.multiline) rewriteRecordOps(env.doc, r, textRecordRaw(classVersion(env.doc), r.isDefault, upper(r.scale), moveTextRecord(f, sim), true), ops);
          }
        }
      });
    }
    return { entity: after, ops };
  }
  // 해치: 다른 축척 레코드의 패턴 선을 지금 선의 배율 비로
  if (after.type === 'HATCH') {
    const fCur = env.idx.factor(st.current);
    for (const r of st.records) {
      const s = env.idx.handle(r.scale);
      if (!s || s.name.toUpperCase() === st.current) continue;
      const f = hatchFields(r);
      if (!f) continue;
      rewriteRecordOps(env.doc, r, hatchRecordWithLines(r.raw, scaleLines(after.patternLines, factorOf(s) / fCur)), ops);
    }
    return { entity: after, ops };
  }
  // 치수·다중 지시선: 다른 축척의 AutoCAD 레코드를 자체 기록으로
  if ((after.type === 'DIMENSION' || after.type === 'MULTILEADER') && st.records.length) {
    const others = st.records.filter((r) => env.idx.handle(r.scale)?.name.toUpperCase() !== st.current);
    if (!others.length) return { entity: after, ops };
    const chain = contextChain(env.doc, before);
    if (chain.scales) for (const r of others) removeRecordOps(env.doc, chain.scales, r, ops);
    const curName = env.idx.name(st.current)?.name ?? st.current;
    const names = st.scales.map((k) => env.idx.name(k)?.name ?? k);
    return { entity: { ...after, xdata: withOwnRecord(after.xdata, { current: curName, scales: names }) }, ops };
  }
  return { entity: after, ops };
}

/**
 * 복사본(확장 사전이 다른 객체의 것을 가리키는 새 객체)에 자기 사전과 레코드를 준다.
 * 레코드는 원본 → 복사본의 닮음 변환으로 옮긴다. 원본을 모르면(지워졌으면) 그대로 복제한다.
 */
export function cloneRecordsForCopy(env: EditEnv, copy: Entity, original: Entity | undefined): Edited {
  const ops: EditOp[] = [];
  const xd = dictOf(env.doc, copy.xdict);
  if (!xd || upper(xd.owner) === upper(copy.handle)) return { entity: copy, ops };
  const src = original ?? (env.doc.entityIndex.get(upper(xd.owner)) as Entity | undefined);
  const sim = src ? similarityBetween(src, copy) : null;
  const out = cloneChain(env, copy, xd, sim, ops);
  if (out.type === 'INSERT') {
    const ins = out as InsertEntity;
    out.attribs = ins.attribs.map((a, i) => {
      const ad = dictOf(env.doc, a.xdict);
      if (!ad || upper(ad.owner) === upper(a.handle)) return a;
      const sa = src?.type === 'INSERT' ? (src as InsertEntity).attribs[i] : undefined;
      return cloneChain(env, a, ad, sa ? similarityBetween(sa, a) ?? sim : sim, ops);
    });
  }
  return { entity: out, ops };
}

function cloneChain<T extends Entity>(env: EditEnv, e: T, xd: NonNullable<ReturnType<typeof dictOf>>, sim: Similarity | null, ops: EditOp[]): T {
  const doc = env.doc;
  const xh = env.alloc();
  const entries: [string, string][] = [];
  for (const [k, h] of xd.entries) {
    if (k.toUpperCase() !== 'ACDBCONTEXTDATAMANAGER') {
      entries.push([k, h]);
      continue;
    }
    const mgr = dictOf(doc, h);
    if (!mgr) continue;
    const mh = env.alloc();
    const mEntries: [string, string][] = [];
    for (const [k2, h2] of mgr.entries) {
      const sc = dictOf(doc, h2);
      if (!sc || k2.toUpperCase() !== 'ACDB_ANNOTATIONSCALES') continue;
      const sh = env.alloc();
      const sEntries: [string, string][] = [];
      for (const [k3, h3] of sc.entries) {
        const o = pendingObject(doc, ops, h3);
        if (!o) continue;
        const rh = env.alloc();
        let raw = (o as { raw?: ContextRecord['raw'] }).raw;
        const rec = raw ? parseRecord(o as GenericObject) : null;
        if (rec && sim) raw = movedRaw(env, rec, sim) ?? raw;
        ops.push({ kind: 'object', key: rh, before: null, after: changed(o, { handle: rh, owner: sh, reactors: [sh], raw } as never) });
        sEntries.push([k3, rh]);
      }
      ops.push({ kind: 'object', key: sh, before: null, after: newDict(sh, mh, sEntries) });
      mEntries.push([k2, sh]);
    }
    ops.push({ kind: 'object', key: mh, before: null, after: newDict(mh, xh, mEntries) });
    entries.push([k, mh]);
  }
  ops.push({ kind: 'object', key: xh, before: null, after: { type: 'DICTIONARY', handle: xh, owner: upper(e.handle), entries: new Map(entries), hardOwner: xd.hardOwner, cloning: xd.cloning } });
  return { ...e, xdict: xh };
}

/** 레코드를 닮음 변환으로 옮긴 원시 태그(모르는 종류면 null) */
function movedRaw(env: EditEnv, r: ContextRecord, s: Similarity): ContextRecord['raw'] | null {
  const ver = classVersion(env.doc);
  if (r.kind === 'text' || r.kind === 'attrib') {
    const f = textFields(r);
    return f && !f.multiline ? textRecordRaw(ver, r.isDefault, r.scale, moveTextRecord(f, s), r.kind === 'attrib') : null;
  }
  if (r.kind === 'blkref') {
    const f = blkFields(r);
    if (!f) return null;
    const p = simApply(s, f.insert);
    return blkRecordRaw(ver, r.isDefault, r.scale, { rotation: f.rotation + s.rot, insert: { x: p.x, y: p.y, z: f.insert.z }, scale: { x: f.scale.x * s.k, y: f.scale.y * s.k, z: f.scale.z * s.k } });
  }
  if (r.kind === 'mtext') {
    const f = mtextFields(r);
    if (!f) return null;
    const p = simApply(s, f.insert);
    const c = Math.cos(s.rot);
    const n = Math.sin(s.rot);
    const d = f.direction;
    return mtextRecordRaw(ver, r.isDefault, r.scale, { ...f, insert: { x: p.x, y: p.y, z: f.insert.z }, direction: { x: c * d.x - n * d.y, y: n * d.x + c * d.y, z: d.z }, width: f.width * s.k, rectHeight: f.rectHeight * s.k, extWidth: f.extWidth * s.k, extHeight: f.extHeight * s.k });
  }
  return null;
}

// ---------------------------------------------------------------------------
// 새 객체
// ---------------------------------------------------------------------------

/**
 * 새로 만든 객체가 주석이 되어야 하는지: 주석 문자 스타일의 TEXT·MTEXT, 주석 블록의 참조, 주석 치수 스타일의 치수,
 * 주석 다중 지시선 스타일의 다중 지시선. 이미 주석 표지·자체 기록·확장 사전이 있으면(복사본 등) 아니다.
 */
export function wantsAnnotative(doc: CadDocument, e: Entity): boolean {
  if (e.xdict || annotativeFlag(e.xdata) !== undefined || ownRecord(e.xdata)) return false;
  switch (e.type) {
    case 'TEXT':
    case 'MTEXT':
      return textStyleAnnotative(doc, e.style);
    case 'INSERT':
      return blockAnnotative(doc, e.block);
    case 'DIMENSION':
      return dimStyleAnnotative(doc, e.dimStyle);
    case 'MULTILEADER':
      return mleaderStyleAnnotative(doc, e.styleHandle);
    default:
      return false;
  }
}

/** 상태 요약(특성 팔레트 등): 축척 이름과 보이는 축척 */
export function scaleNames(env: Pick<EditEnv, 'doc' | 'idx'>, e: Entity): { current: string; scales: string[] } | null {
  const st: AnnoState | null = annoState(env.doc, e, env.idx);
  if (!st || st.foreign) return null;
  const nm = (k: string) => env.idx.name(k)?.name ?? k;
  return { current: nm(st.current), scales: st.scales.map(nm) };
}

export type { Vec2 };
