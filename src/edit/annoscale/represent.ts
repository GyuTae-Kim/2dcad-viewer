/**
 * 주석 객체의 상태(지원 축척·보이는 축척)와 한 축척의 표현.
 *
 * - 객체 자체 데이터는 "보이는 축척"(기본 레코드 290 = 1, 자체 기록이면 그 current)의 표현이다.
 * - 축척 S의 표현: 크기 = 용지 크기 × S의 배율(도면 단위 ÷ 용지 단위). 용지 크기 = 지금 크기 ÷ 보이는 축척의 배율.
 *   위치·회전은 S의 레코드(TEXT·MTEXT·블록 참조·속성), 치수는 S 레코드의 익명 블록, 해치는 S 레코드의 패턴 선.
 *   레코드가 없고 자체 기록에만 있는 축척은 계산한다: 문자·블록은 같은 자리에서 크기만, 치수는 DIMSCALE = 배율로
 *   다시 그린 그림, 해치는 패턴 선 × 배율 비, 다중 지시선은 지시선 끝(연결선 시작)을 중심으로 배율 비만큼.
 * - 객체가 S를 지원하지 않으면 ANNOALLVISIBLE 1이면 지금 데이터대로, 0이면 숨긴다.
 * 축척은 이름(대문자)으로 가려낸다: 레코드는 SCALE 핸들, 자체 기록은 이름을 쓰기 때문이다.
 */
import type { AttribEntity, BlockDef, CadDocument, DimensionEntity, Entity, HatchEntity, HatchPatternLine, InsertEntity, MLeaderEntity, MTextEntity, TextEntity, Vec2, Vec3 } from '../../core/model';
import { generateDimensionGeometry } from '../dim/generate';
import { type AnnoScale, factorOf, scaleFromObject, scaleList, upper } from './scales';
import { type ContextRecord, blkFields, contextRecords, dimFields, hasRecordEntries, hatchFields, mtextFields, textFields } from './context';
import { annotativeFlag, blockAnnotative, ownRecord } from './xdata';

export type AnnoKind = 'text' | 'mtext' | 'insert' | 'dim' | 'hatch' | 'mleader' | 'leader';

/** 주석 객체가 될 수 있는 종류 */
export function annoKindOf(e: Entity): AnnoKind | null {
  switch (e.type) {
    case 'TEXT':
      return 'text';
    case 'MTEXT':
      return 'mtext';
    case 'INSERT':
      return 'insert';
    case 'DIMENSION':
      return 'dim';
    case 'HATCH':
      return 'hatch';
    case 'MULTILEADER':
      return 'mleader';
    case 'LEADER':
      return 'leader';
    default:
      return null;
  }
}

export interface AnnoState {
  kind: AnnoKind;
  /** AutoCAD 레코드(원시 태그를 읽을 수 있는 것) */
  records: ContextRecord[];
  /** 축척 이름(대문자) → 레코드(자체 기록뿐이면 null) */
  byScale: Map<string, ContextRecord | null>;
  /** 지원 축척 이름(대문자, 레코드 순서 뒤 자체 기록 순서) */
  scales: string[];
  /** 객체 자체 데이터가 보여 주는 축척(대문자 이름) */
  current: string;
  /** 자체 기록(OPENCAD_ANNOSCALE)을 쓰는 객체 */
  own: boolean;
  /** 주석 표지는 있지만 축척 정보를 읽을 수 없는 객체(그대로 그리고 편집하지 않는다) */
  foreign: boolean;
}

/** 축척 찾기 표(리스트 + 레코드가 가리키는 리스트 밖의 SCALE) */
export class ScaleIndex {
  readonly list: AnnoScale[];
  private readonly byName = new Map<string, AnnoScale>();
  private readonly byHandle = new Map<string, AnnoScale>();

  constructor(readonly doc: CadDocument) {
    this.list = scaleList(doc);
    for (const s of this.list) {
      this.byName.set(s.name.toUpperCase(), s);
      if (s.handle) this.byHandle.set(upper(s.handle), s);
    }
  }

  handle(h: string): AnnoScale | undefined {
    const k = upper(h);
    let s = this.byHandle.get(k);
    if (!s) {
      const o = scaleFromObject(this.doc.objects.get(k));
      if (o) {
        s = o;
        this.byHandle.set(k, o);
        if (!this.byName.has(o.name.toUpperCase())) this.byName.set(o.name.toUpperCase(), o);
      }
    }
    return s;
  }

  /** 같은 변경에서 만든 축척(아직 문서에 없는 SCALE 핸들)을 알린다 */
  adopt(list: readonly AnnoScale[]): void {
    for (const s of list) {
      this.byName.set(s.name.toUpperCase(), s);
      if (s.handle) this.byHandle.set(upper(s.handle), s);
    }
    this.list.splice(0, this.list.length, ...list);
  }

  name(n: string): AnnoScale | undefined {
    return this.byName.get(n.trim().toUpperCase());
  }

  factor(name: string): number {
    const s = this.name(name);
    return s ? factorOf(s) : 1;
  }
}

/** 객체의 주석 상태(주석 객체가 아니면 null) */
export function annoState(doc: CadDocument, e: Entity, index?: ScaleIndex): AnnoState | null {
  const kind = annoKindOf(e);
  if (!kind) return null;
  const flag = kind === 'insert' ? blockAnnotative(doc, (e as InsertEntity).block) || annotativeFlag(e.xdata) === true : annotativeFlag(e.xdata);
  const own = ownRecord(e.xdata);
  const recs = e.xdict ? contextRecords(doc, e) : [];
  // 표지가 "주석 아님"인 객체의 레코드는 쓰지 않는다(블록 참조는 블록을 따른다)
  const records = flag === false && kind !== 'insert' ? [] : recs;
  if (!records.length && !own) {
    // 표지만 있거나 레코드를 아직 풀 수 없는 객체(DWG 리더가 원시 태그를 남기지 않은 레코드)
    if (flag === true || (flag !== false && kind !== 'insert' && hasRecordEntries(doc, e))) return { kind, records: [], byScale: new Map(), scales: [], current: '', own: false, foreign: true };
    return null;
  }
  const idx = index ?? new ScaleIndex(doc);
  const byScale = new Map<string, ContextRecord | null>();
  const scales: string[] = [];
  let current = '';
  for (const r of records) {
    const s = idx.handle(r.scale);
    if (!s) continue;
    const k = s.name.toUpperCase();
    if (byScale.has(k)) continue;
    byScale.set(k, r);
    scales.push(k);
    if (r.isDefault && !current) current = k;
  }
  if (own) {
    for (const n of own.scales) {
      const k = n.toUpperCase();
      if (!idx.name(k) || byScale.has(k)) continue;
      byScale.set(k, null);
      scales.push(k);
    }
    if (!current && byScale.has(own.current.toUpperCase())) current = own.current.toUpperCase();
  }
  if (!scales.length) return { kind, records: [], byScale, scales: [], current: '', own: !!own, foreign: true };
  if (!current) current = scales[0]!;
  return { kind, records, byScale, scales, current, own: !!own && !records.length, foreign: false };
}

// ---------------------------------------------------------------------------
// 닮음 변환(위치·회전·균일 크기)
// ---------------------------------------------------------------------------

export interface Similarity {
  /** p' = to + R(rot)·k·(p − from) */
  from: Vec2;
  to: Vec2;
  rot: number;
  k: number;
}

export function simApply(s: Similarity, p: Vec2): Vec2 {
  const dx = (p.x - s.from.x) * s.k;
  const dy = (p.y - s.from.y) * s.k;
  const c = Math.cos(s.rot);
  const n = Math.sin(s.rot);
  return { x: s.to.x + c * dx - n * dy, y: s.to.y + n * dx + c * dy };
}

const v3 = (p: Vec2, z = 0): Vec3 => ({ x: p.x, y: p.y, z });

/** 문자·속성 객체를 닮음 변환 */
export function simText<T extends TextEntity | AttribEntity>(t: T, s: Similarity): T {
  const out = { ...t, insert: v3(simApply(s, t.insert), t.insert.z), height: t.height * s.k, rotation: t.rotation + s.rot } as T;
  if (t.alignPoint) out.alignPoint = v3(simApply(s, t.alignPoint), t.alignPoint.z);
  const mt = (t as AttribEntity).mtext;
  if (mt) (out as AttribEntity).mtext = simMText(mt, s);
  return out;
}

export function simMText(m: MTextEntity, s: Similarity): MTextEntity {
  const out: MTextEntity = { ...m, insert: v3(simApply(s, m.insert), m.insert.z), height: m.height * s.k, width: m.width * s.k, rotation: m.rotation + s.rot };
  if (m.rectHeight) out.rectHeight = m.rectHeight * s.k;
  if (m.direction) {
    const c = Math.cos(s.rot);
    const n = Math.sin(s.rot);
    out.direction = { x: c * m.direction.x - n * m.direction.y, y: n * m.direction.x + c * m.direction.y, z: m.direction.z };
  }
  if (m.columns) out.columns = { ...m.columns, width: m.columns.width * s.k, gutter: m.columns.gutter * s.k, heights: m.columns.heights.map((h) => h * s.k) };
  return out;
}

/** 블록 참조(와 속성)를 닮음 변환 */
export function simInsert(e: InsertEntity, s: Similarity): InsertEntity {
  return {
    ...e,
    insert: v3(simApply(s, e.insert), e.insert.z),
    rotation: e.rotation + s.rot,
    scale: { x: e.scale.x * s.k, y: e.scale.y * s.k, z: e.scale.z * s.k },
    columnSpacing: e.columnSpacing * s.k,
    rowSpacing: e.rowSpacing * s.k,
    attribs: e.attribs.map((a) => simText(a, s)),
  };
}

/** 패턴 선을 원점(첫 선의 기준점) 기준으로 k배 */
export function scaleLines(lines: readonly HatchPatternLine[], k: number, origin?: Vec2): HatchPatternLine[] {
  const o = origin ?? lines[0]?.base ?? { x: 0, y: 0 };
  return lines.map((l) => ({
    angle: l.angle,
    base: { x: o.x + (l.base.x - o.x) * k, y: o.y + (l.base.y - o.y) * k },
    offset: { x: l.offset.x * k, y: l.offset.y * k },
    dashes: l.dashes.map((d) => d * k),
  }));
}

/** 다중 지시선의 축척 기준점: 첫 지시선의 연결선 시작(없으면 내용 기준점) */
export function mleaderPivot(m: MLeaderEntity): Vec3 {
  const ld = m.context.leaders.find((l) => l.lastLeaderPoint);
  return ld?.lastLeaderPoint ?? m.context.contentBase;
}

/** 다중 지시선의 주석 부분(내용·문자 높이·화살표·연결선·간격)을 기준점에서 k배 */
export function scaleMLeader(m: MLeaderEntity, k: number, pivot: Vec3 = mleaderPivot(m)): MLeaderEntity {
  const P = (p: Vec3): Vec3 => ({ x: pivot.x + (p.x - pivot.x) * k, y: pivot.y + (p.y - pivot.y) * k, z: p.z });
  const c = m.context;
  const ctx: MLeaderEntity['context'] = {
    ...c,
    scale: c.scale * k,
    contentBase: P(c.contentBase),
    textHeight: c.textHeight * k,
    arrowSize: c.arrowSize * k,
    landingGap: c.landingGap * k,
    basePoint: P(c.basePoint),
    leaders: c.leaders.map((l) => ({ ...l, lastLeaderPoint: l.lastLeaderPoint ? P(l.lastLeaderPoint) : undefined, doglegLength: l.doglegLength * k })),
  };
  if (c.text) ctx.text = { ...c.text, location: P(c.text.location), width: c.text.width * k, height: c.text.height * k };
  if (c.block) ctx.block = { ...c.block, location: P(c.block.location), scale: { x: c.block.scale.x * k, y: c.block.scale.y * k, z: c.block.scale.z * k } };
  return { ...m, context: ctx, arrowSize: m.arrowSize * k, doglegLength: m.doglegLength * k };
}

// ---------------------------------------------------------------------------
// 한 축척의 표현
// ---------------------------------------------------------------------------

export interface View {
  entity: Entity;
  /** 표현이 쓰는 가상 블록(치수를 그 축척으로 다시 그린 그림) */
  blocks?: BlockDef[];
}

/** 축척 이름 k의 표현(같으면 그 객체 그대로). 상태가 그 축척을 지원해야 한다 */
export function representation(doc: CadDocument, e: Entity, st: AnnoState, k: string, idx: ScaleIndex): View {
  const name = k.toUpperCase();
  if (st.foreign || name === st.current || !st.byScale.has(name)) return { entity: e };
  const rec = st.byScale.get(name) ?? null;
  const ratio = idx.factor(name) / idx.factor(st.current);
  switch (e.type) {
    case 'TEXT':
      return { entity: textAt(e as TextEntity, rec, ratio) };
    case 'MTEXT':
      return { entity: mtextAt(e, rec, ratio) };
    case 'INSERT':
      return { entity: insertAt(doc, e, rec, ratio, name, idx) };
    case 'DIMENSION':
      return dimAt(doc, e, rec, idx.factor(name), name);
    case 'HATCH': {
      const f = rec ? hatchFields(rec) : null;
      if (f && f.lines.length) return { entity: { ...(e as HatchEntity), patternLines: f.lines } };
      if (e.solid || !e.patternLines.length) return { entity: e };
      return { entity: { ...e, patternLines: scaleLines(e.patternLines, ratio) } };
    }
    case 'MULTILEADER':
      return { entity: scaleMLeader(e, ratio) };
    default:
      return { entity: e };
  }
}

function textAt<T extends TextEntity | AttribEntity>(t: T, rec: ContextRecord | null, ratio: number): T {
  const f = rec ? textFields(rec) : null;
  if (!f || f.multiline) return { ...t, height: t.height * ratio };
  const out = { ...t, insert: { x: f.insert.x, y: f.insert.y, z: t.insert.z }, rotation: f.rotation, height: t.height * ratio, halign: f.halign as T['halign'] };
  if (t.alignPoint || t.halign || t.valign) out.alignPoint = { x: f.align.x, y: f.align.y, z: t.alignPoint?.z ?? t.insert.z };
  return out;
}

function mtextAt(m: MTextEntity, rec: ContextRecord | null, ratio: number): MTextEntity {
  const f = rec ? mtextFields(rec) : null;
  if (!f) return { ...m, height: m.height * ratio, width: m.width * ratio, rectHeight: m.rectHeight ? m.rectHeight * ratio : m.rectHeight };
  const out: MTextEntity = { ...m, insert: f.insert, attachment: f.attachment, width: f.width, height: m.height * ratio };
  if (Math.hypot(f.direction.x, f.direction.y, f.direction.z) > 1e-12) out.direction = f.direction;
  out.rectHeight = f.rectHeight > 0 ? f.rectHeight : undefined;
  if (m.columns) out.columns = { ...m.columns, width: f.columnWidth ?? m.columns.width * ratio, gutter: f.gutter ?? m.columns.gutter * ratio, count: f.columnCount || m.columns.count, heights: m.columns.heights.map((h) => h * ratio) };
  return out;
}

function insertAt(doc: CadDocument, e: InsertEntity, rec: ContextRecord | null, ratio: number, name: string, idx: ScaleIndex): InsertEntity {
  const f = rec ? blkFields(rec) : null;
  const sim: Similarity = f
    ? { from: e.insert, to: f.insert, rot: f.rotation - e.rotation, k: Math.abs(e.scale.x) > 1e-12 ? f.scale.x / e.scale.x : ratio }
    : { from: e.insert, to: e.insert, rot: 0, k: ratio };
  const out = simInsert(e, sim);
  if (f) {
    out.insert = { ...f.insert };
    out.rotation = f.rotation;
    out.scale = { ...f.scale };
  }
  // 속성: 자기 레코드가 있으면 그것, 없으면 블록 참조와 같은 닮음 변환
  out.attribs = e.attribs.map((a, i) => {
    if (!a.xdict) return out.attribs[i]!;
    const ar = contextRecords(doc, a).find((r) => idx.handle(r.scale)?.name.toUpperCase() === name);
    const af = ar ? textFields(ar) : null;
    if (!ar || !af || af.multiline) return out.attribs[i]!;
    return textAt(a, ar, sim.k);
  });
  return out;
}

/** 가상 블록 이름(이 축척으로 다시 그린 치수 그림) */
export function virtualDimBlock(handle: string, scale: string): string {
  return `*OPENCAD_ANNO_${handle}_${scale}`;
}

function dimAt(doc: CadDocument, d: DimensionEntity, rec: ContextRecord | null, factor: number, name: string): View {
  const f = rec ? dimFields(rec) : null;
  if (f && f.block && doc.blocks.get(f.block.toUpperCase())?.entities.length) {
    const out: DimensionEntity = { ...d, block: f.block, textMid: { x: f.textPos.x, y: f.textPos.y, z: d.textMid.z } };
    return { entity: out };
  }
  // 그 축척의 그림이 없으면 DIMSCALE = 배율로 다시 그린다
  try {
    const probe: DimensionEntity = { ...d, overrides: { ...(d.overrides ?? {}), 40: factor } };
    if (f) probe.textMid = { x: f.textPos.x, y: f.textPos.y, z: d.textMid.z };
    const g = generateDimensionGeometry(doc, probe);
    const bname = virtualDimBlock(d.handle, name.replace(/[^A-Z0-9]/gi, '_'));
    const blocks: BlockDef[] = [{ name: bname, handle: '', recordHandle: '', basePoint: { x: 0, y: 0, z: 0 }, flags: 1, entities: g.entities }];
    for (const ab of g.arrowBlocks) if (!doc.blocks.has(ab.name.toUpperCase())) blocks.push({ name: ab.name, handle: '', recordHandle: '', basePoint: { x: 0, y: 0, z: 0 }, flags: 0, entities: ab.entities });
    return { entity: { ...probe, block: bname, textMid: g.textMid }, blocks };
  } catch {
    return { entity: d };
  }
}

/** 축척 k에서 이 객체를 어떻게 그리는가: 표현, 그대로(지원하지 않음 + 모두 보임), null(숨김) */
export function viewAt(doc: CadDocument, e: Entity, k: string | null, allVisible: boolean, idx: ScaleIndex): View | null {
  if (!k) return { entity: e };
  const st = annoState(doc, e, idx);
  if (!st || st.foreign) return { entity: e };
  const name = k.toUpperCase();
  if (!st.byScale.has(name)) return allVisible ? { entity: e } : null;
  return representation(doc, e, st, name, idx);
}

/** 객체를 주석 객체로 다룰 수 있는지(주석 표지가 있거나 레코드·자체 기록이 있다) */
export function isAnnotative(doc: CadDocument, e: Entity, idx?: ScaleIndex): boolean {
  return !!annoState(doc, e, idx);
}
