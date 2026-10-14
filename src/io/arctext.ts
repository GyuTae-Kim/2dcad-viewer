/**
 * 원호 정렬 문자(ARCALIGNEDTEXT) 저장 형식.
 *
 * AutoCAD의 ARCALIGNEDTEXT는 Express Tools의 사용자 정의 객체이고, 그 DXF 그룹 코드·DWG 필드 배치를 실물 파일로
 * 확인할 수 없다(표본 도면에 없고 ezdxf도 모른다). 그래서 Autodesk 이름 아래 추측한 자료를 쓰지 않는다.
 * - DXF에서 읽은 ARCALIGNEDTEXT를 고치지 않았으면 DXF(R2000+)로 쓸 때 읽은 원본 태그를 그대로 쓴다(모르는 객체와 같은 길).
 * - 새로 만들었거나 고친 것, DWG·R12로 쓰는 것은 이 편집기의 기록으로 쓴다:
 *   익명 블록(*U) 하나 = 글자마다 가운데 맞춤 TEXT(빈칸 빼고) + 밑줄 ARC, 도면층 0·ByBlock 특성, 중심이 블록 원점.
 *   그 블록의 참조(INSERT, 삽입점 = 원호 중심, 회전 0, 축척 1)에 확장 자료 OPENCAD_ARCTEXT:
 *   1070 기록 판(1), 1005 따라가는 호의 핸들(있을 때), 1000 정의(블록 좌표, ASCII JSON, 250자씩).
 *   AutoCAD에서는 익명 블록 참조로 보이고(글자는 보이고 옮기고 분해할 수 있다), 이 편집기에서 다시 열면
 *   참조가 닮음 변환(이동·회전·균일 축척·대칭)으로 놓인 경우 원호 정렬 문자로 돌아온다(restoreArcTexts).
 */
import type { ArcTextEntity, BlockDef, BlockRecord, CadDocument, Entity, EntityBase, InsertEntity, ReadWarning, XData, XDataItem } from '../core/model';
import { tableKey } from '../core/model';
import { arcTextError, arcTextParts, arcTextSig } from '../text/arctext';

export const ARCTEXT_APP = 'OPENCAD_ARCTEXT';
const RECORD_VERSION = 1;

/** 정의(블록 좌표, 중심 0,0) */
interface RecordDef {
  t: string;
  r: number;
  a0: number;
  a1: number;
  s: string;
  f: string;
  bf: string;
  h: number;
  wf: number;
  cs: number;
  o: number;
  lo: number;
  ro: number;
  al: number;
  po: number;
  di: number;
  rv: boolean;
  b: boolean;
  i: boolean;
  u: boolean;
}

const asciiJson = (v: unknown): string => JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

/** 확장 자료 기록 */
export function arcTextRecord(e: ArcTextEntity, arcLive: boolean): XData {
  const d: RecordDef = {
    t: e.text,
    r: e.radius,
    a0: e.startAngle,
    a1: e.endAngle,
    s: e.style,
    f: e.font,
    bf: e.bigFont,
    h: e.height,
    wf: e.widthFactor,
    cs: e.charSpacing,
    o: e.offset,
    lo: e.leftOffset,
    ro: e.rightOffset,
    al: e.alignment,
    po: e.position,
    di: e.direction,
    rv: e.reversed,
    b: e.bold,
    i: e.italic,
    u: e.underline,
  };
  const json = asciiJson(d);
  const items: XDataItem[] = [{ code: 1070, value: RECORD_VERSION }];
  if (e.arc && arcLive) items.push({ code: 1005, value: e.arc });
  for (let i = 0; i < json.length; i += 250) items.push({ code: 1000, value: json.slice(i, i + 250) });
  return { app: ARCTEXT_APP, items };
}

/** 기록을 읽는다(판·모양이 맞지 않으면 null) */
export function readArcTextRecord(x: XData): { def: RecordDef; arc?: string } | null {
  const ver = x.items.find((i) => i.code === 1070);
  if (!ver || Number(ver.value) !== RECORD_VERSION) return null;
  const json = x.items
    .filter((i) => i.code === 1000)
    .map((i) => String(i.value))
    .join('');
  let d: RecordDef;
  try {
    d = JSON.parse(json) as RecordDef;
  } catch {
    return null;
  }
  const nums: (keyof RecordDef)[] = ['r', 'a0', 'a1', 'h', 'wf', 'cs', 'o', 'lo', 'ro', 'al', 'po', 'di'];
  if (typeof d !== 'object' || !d || typeof d.t !== 'string' || nums.some((k) => typeof d[k] !== 'number' || !Number.isFinite(d[k] as number))) return null;
  const h = x.items.find((i) => i.code === 1005);
  const out: { def: RecordDef; arc?: string } = { def: d };
  if (h && String(h.value).trim() && String(h.value).trim() !== '0') out.arc = String(h.value).trim().toUpperCase();
  return out;
}

/** 표시 특성과 공통 자료(확장 자료는 따로) */
function baseOf(e: Entity): Omit<EntityBase, 'type'> {
  const b: Omit<EntityBase, 'type'> = {
    handle: e.handle,
    layer: e.layer,
    linetype: e.linetype,
    color: e.color,
    lineweight: e.lineweight,
    ltscale: e.ltscale,
    transparency: e.transparency,
  };
  if (e.owner !== undefined) b.owner = e.owner;
  if (e.invisible) b.invisible = true;
  if (e.paperSpace) b.paperSpace = true;
  if (e.extrusion) b.extrusion = e.extrusion;
  if (e.xdict) b.xdict = e.xdict;
  if (e.reactors) b.reactors = e.reactors;
  if (e.plotStyle) b.plotStyle = e.plotStyle;
  if (e.material) b.material = e.material;
  if (e.hyperlink) b.hyperlink = e.hyperlink;
  return b;
}

/** 원본 태그를 그대로 쓸 수 있는지(DXF R2000+, 읽은 뒤 정의가 같다) */
export function arcTextRawOk(e: ArcTextEntity): boolean {
  return !!e.raw?.length && !!e.rawSig && e.rawSig === arcTextSig(e);
}

function nextAnonymous(doc: CadDocument): () => string {
  let n = 0;
  for (const b of doc.blocks.values()) {
    const m = /^\*U(\d+)$/i.exec(b.name);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return () => {
    let name: string;
    do name = `*U${++n}`;
    while (doc.blocks.has(tableKey(name)));
    return name;
  };
}

/**
 * 쓰기 전에 원호 정렬 문자를 쓸 수 있는 객체로 바꾼 문서(원래 문서는 바꾸지 않는다).
 * format이 'dxf'이고 R2000 이상이면 고치지 않은 원본은 원본 태그 그대로(모르는 객체로), 나머지는 익명 블록 참조 기록으로.
 */
export function arcTextsForWrite(doc: CadDocument, format: 'dxf' | 'dwg', version: string): { doc: CadDocument; warnings: ReadWarning[] } {
  let any = false;
  for (const b of doc.blocks.values()) {
    if (b.entities.some((e) => e.type === 'ARCALIGNEDTEXT')) {
      any = true;
      break;
    }
  }
  if (!any) return { doc, warnings: [] };
  const rawAllowed = format === 'dxf' && version !== 'AC1009';
  const blocks = new Map(doc.blocks);
  const blockRecords = new Map(doc.blockRecords);
  const entityIndex = new Map(doc.entityIndex);
  const appIds = new Map(doc.appIds);
  const out: CadDocument = { ...doc, blocks, blockRecords, entityIndex, appIds };
  const nextName = nextAnonymous(out);
  let kept = 0;
  let edited = 0;
  let recorded = 0;
  let dropped = 0;
  const convert = (e: ArcTextEntity): Entity | null => {
    if (rawAllowed && arcTextRawOk(e)) {
      kept++;
      const u: Entity = { ...baseOf(e), type: 'UNKNOWN', originalType: 'ARCALIGNEDTEXT', raw: e.raw };
      if (e.xdata) u.xdata = e.xdata;
      if (e.graphics) (u as { graphics?: Uint8Array }).graphics = e.graphics;
      return u;
    }
    const parts = arcTextError(e) ? [] : arcTextParts(e, { local: true });
    if (!parts.length) {
      dropped++;
      return null;
    }
    if (e.raw?.length) edited++;
    else recorded++;
    const name = nextName();
    const key = tableKey(name);
    const def: BlockDef = { name, handle: '', recordHandle: '', basePoint: { x: 0, y: 0, z: 0 }, flags: 1, entities: parts };
    const rec: BlockRecord = { name, handle: '', flags: 0, insertUnits: 0, explodable: true, scalable: true };
    blocks.set(key, def);
    blockRecords.set(key, rec);
    const arcLive = !!e.arc && doc.entityIndex.get(e.arc)?.type === 'ARC';
    const xdata = [...(e.xdata ?? []).filter((x) => x.app.toUpperCase() !== ARCTEXT_APP), arcTextRecord(e, arcLive)];
    const ins: InsertEntity = {
      ...baseOf(e),
      type: 'INSERT',
      block: name,
      insert: { ...e.center },
      scale: { x: 1, y: 1, z: 1 },
      rotation: 0,
      columnCount: 1,
      rowCount: 1,
      columnSpacing: 0,
      rowSpacing: 0,
      attribs: [],
      xdata,
    };
    return ins;
  };
  for (const [key, b] of doc.blocks) {
    if (!b.entities.some((e) => e.type === 'ARCALIGNEDTEXT')) continue;
    const list: Entity[] = [];
    for (const e of b.entities) {
      if (e.type !== 'ARCALIGNEDTEXT') {
        list.push(e);
        continue;
      }
      const c = convert(e);
      if (!c) {
        if (e.handle) entityIndex.delete(e.handle);
        continue;
      }
      list.push(c);
      if (c.handle) entityIndex.set(c.handle, c);
    }
    blocks.set(key, { ...b, entities: list });
  }
  if (recorded + edited && !appIds.has(tableKey(ARCTEXT_APP))) appIds.set(tableKey(ARCTEXT_APP), { name: ARCTEXT_APP, handle: '', flags: 0 });
  const warnings: ReadWarning[] = [];
  if (edited)
    warnings.push({
      code: 'arctext.converted',
      message: '편집한 원호 정렬 문자는 이 편집기의 원호 정렬 문자(한 줄 문자의 익명 블록 참조)로 저장했습니다. AutoCAD에서는 블록 참조로 보입니다.',
      count: edited,
    });
  if (recorded)
    warnings.push({
      code: 'arctext.saved_as_block',
      message: '원호 정렬 문자를 한 줄 문자의 익명 블록 참조(OPENCAD_ARCTEXT 기록)로 저장했습니다. AutoCAD에서는 블록 참조로 보이고, 이 편집기에서 다시 열면 원호 정렬 문자로 돌아옵니다.',
      count: recorded,
    });
  if (dropped) warnings.push({ code: 'arctext.dropped', message: '배치할 수 없는 원호 정렬 문자를 쓰지 않았습니다.', count: dropped });
  void kept;
  return { doc: out, warnings };
}

const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

/** 블록 참조 + 기록 → 원호 정렬 문자(참조가 닮음 변환이 아니거나 기록이 깨졌으면 null) */
export function arcTextFromRecord(ins: InsertEntity, def: BlockDef | undefined, rec: { def: RecordDef; arc?: string }): ArcTextEntity | null {
  const sx = ins.scale.x || 1;
  const sy = ins.scale.y || 1;
  if (!near(Math.abs(sx), Math.abs(sy), 1e-6)) return null;
  if (ins.columnCount > 1 || ins.rowCount > 1) return null;
  const s = Math.abs(sx);
  const mirror = sx * sy < 0;
  const c = Math.cos(ins.rotation);
  const si = Math.sin(ins.rotation);
  // 블록 좌표 → OCS: 회전 · 축척(sx, sy) · (p − 기준점)
  const lin = (x: number, y: number) => ({ x: c * sx * x - si * sy * y, y: si * sx * x + c * sy * y });
  const bp = def?.basePoint ?? { x: 0, y: 0, z: 0 };
  const o = lin(-bp.x, -bp.y);
  const dirAngle = (a: number) => {
    const v = lin(Math.cos(a), Math.sin(a));
    return Math.atan2(v.y, v.x);
  };
  const d = rec.def;
  const a0 = mirror ? dirAngle(d.a1) : dirAngle(d.a0);
  const a1 = mirror ? dirAngle(d.a0) : dirAngle(d.a1);
  const e: ArcTextEntity = {
    ...baseOf(ins),
    type: 'ARCALIGNEDTEXT',
    text: d.t,
    center: { x: ins.insert.x + o.x, y: ins.insert.y + o.y, z: ins.insert.z },
    radius: d.r * s,
    startAngle: a0,
    endAngle: a1,
    style: typeof d.s === 'string' && d.s ? d.s : 'Standard',
    font: typeof d.f === 'string' ? d.f : '',
    bigFont: typeof d.bf === 'string' ? d.bf : '',
    height: d.h * s,
    widthFactor: d.wf,
    charSpacing: d.cs * s,
    offset: d.o * s,
    leftOffset: d.lo * s,
    rightOffset: d.ro * s,
    alignment: [1, 2, 3, 4].includes(d.al) ? d.al : 1,
    position: d.po === 2 ? 2 : 1,
    direction: d.di === 2 ? 2 : 1,
    reversed: !!d.rv,
    bold: !!d.b,
    italic: !!d.i,
    underline: !!d.u,
  };
  const other = (ins.xdata ?? []).filter((x) => x.app.toUpperCase() !== ARCTEXT_APP);
  if (other.length) e.xdata = other;
  else delete e.xdata;
  if (rec.arc) e.arc = rec.arc;
  if (arcTextError(e)) return null;
  return e;
}

/**
 * 읽은 문서 정리(DXF·DWG 공통, 읽은 직후 한 번):
 * - OPENCAD_ARCTEXT 기록이 있는 블록 참조 → 원호 정렬 문자(그 익명 블록은 다른 참조가 없으면 지운다).
 * - DXF ARCALIGNEDTEXT가 가리키는 호가 있으면 그 호의 중심·반지름·각도를 쓴다(없거나 호가 아니면 연관 없음).
 * 바꾼 개수를 돌려준다.
 */
export function restoreArcTexts(doc: CadDocument): number {
  let n = 0;
  const converted = new Map<string, number>();
  for (const b of doc.blocks.values()) {
    for (let i = 0; i < b.entities.length; i++) {
      const e = b.entities[i]!;
      if (e.type === 'ARCALIGNEDTEXT') {
        if (e.arc) {
          const a = doc.entityIndex.get(e.arc);
          if (a?.type === 'ARC') {
            e.center = { ...a.center };
            e.radius = a.radius;
            e.startAngle = a.startAngle;
            e.endAngle = a.endAngle;
            if (a.extrusion) e.extrusion = { ...a.extrusion };
          } else delete e.arc;
          e.rawSig = arcTextSig(e);
        }
        continue;
      }
      if (e.type !== 'INSERT' || !e.xdata?.length || e.attribs.length) continue;
      const x = e.xdata.find((d) => d.app.toUpperCase() === ARCTEXT_APP);
      if (!x) continue;
      const rec = readArcTextRecord(x);
      if (!rec) continue;
      const at = arcTextFromRecord(e, doc.blocks.get(tableKey(e.block)), rec);
      if (!at) continue;
      if (at.arc && doc.entityIndex.get(at.arc)?.type !== 'ARC') delete at.arc;
      b.entities[i] = at;
      if (at.handle) doc.entityIndex.set(at.handle, at);
      const k = tableKey(e.block);
      converted.set(k, (converted.get(k) ?? 0) + 1);
      n++;
    }
  }
  if (!converted.size) return n;
  // 다른 참조가 없는 기록 블록은 지운다(저장할 때 다시 만든다)
  const refs = new Map<string, number>();
  const count = (e: Entity) => {
    if (e.type === 'INSERT') {
      const k = tableKey(e.block);
      refs.set(k, (refs.get(k) ?? 0) + 1);
    } else if (e.type === 'DIMENSION' && e.block) {
      const k = tableKey(e.block);
      refs.set(k, (refs.get(k) ?? 0) + 1);
    } else if (e.type === 'ACAD_TABLE' && e.block) {
      const k = tableKey(e.block);
      refs.set(k, (refs.get(k) ?? 0) + 1);
    }
  };
  for (const b of doc.blocks.values()) for (const e of b.entities) count(e);
  for (const k of converted.keys()) {
    if (refs.get(k)) continue;
    const def = doc.blocks.get(k);
    if (!def || !def.name.startsWith('*')) continue;
    for (const e of def.entities) if (e.handle) doc.entityIndex.delete(e.handle);
    doc.blocks.delete(k);
    doc.blockRecords.delete(k);
  }
  return n;
}
