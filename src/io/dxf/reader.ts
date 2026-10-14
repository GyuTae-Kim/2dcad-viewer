/** DXF 파일 → CadDocument */
import type {
  AttribEntity,
  BlockDef,
  CadClass,
  CadDocument,
  Entity,
  HeaderValue,
  InsertEntity,
  LayoutObject,
  PolylineEntity,
  RawSection,
  TableHead,
} from '../../core/model';
import { MODEL_SPACE, PAPER_SPACE, createDocument, normalizeHandle, tableKey } from '../../core/model';
import { CadReadError } from '../../core/errors';
import { codepageToEncoding } from '../../core/codepage';
import { finalizeDocument } from '../../core/finalize';
import { type DxfRecord, type RecordStream, isStringCode, openDxf } from './records';
import { type EntityContext, parseEntity, parseVertex } from './entities';
import { createTableHandles, readTableEntry, resolveDimStyleHandles } from './tables';
import { parseObject } from './objects';
import { handle, int, name, num, parseXData, str } from './tagutil';

export interface DxfReadOptions {
  onProgress?: (fraction: number) => void;
  /** 이 수를 넘는 객체는 읽지 않고 경고한다 */
  maxEntities?: number;
}

const KNOWN_SECTIONS = new Set(['HEADER', 'CLASSES', 'TABLES', 'BLOCKS', 'ENTITIES', 'OBJECTS']);

function sectionName(rec: DxfRecord): string {
  const i = rec.codes.indexOf(2);
  return i >= 0 ? str(rec.values[i]).trim().toUpperCase() : '';
}

function readHeader(doc: CadDocument, rec: DxfRecord): void {
  const { codes, values } = rec;
  let varName = '';
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!;
    if (c === 9) {
      varName = str(values[i]).trim().toUpperCase();
      continue;
    }
    if (!varName) continue;
    let value: HeaderValue;
    if (c >= 10 && c <= 18) {
      const x = num(values[i]);
      let y = 0;
      let z = 0;
      let dims = 1;
      if (codes[i + 1] === c + 10) {
        y = num(values[i + 1]);
        i++;
        dims = 2;
        if (codes[i + 1] === c + 20) {
          z = num(values[i + 1]);
          i++;
          dims = 3;
        }
      }
      value = dims === 3 ? { x, y, z } : { x, y };
    } else if (isStringCode(c)) {
      value = str(values[i]);
    } else {
      value = num(values[i]);
    }
    // 같은 변수에 값이 여럿이면 첫 값을 둔다.
    if (!doc.header.has(varName)) {
      doc.header.set(varName, value);
      (doc.headerCodes ??= new Map()).set(varName, c);
    }
  }
}

/** TABLE 레코드(표 머리): 핸들·확장 사전·반응자·확장 자료 */
function readTableHead(doc: CadDocument, rec: DxfRecord): void {
  const { codes, values } = rec;
  let tableName = '';
  const head: TableHead = { handle: '' };
  let i = 0;
  for (; i < codes.length; i++) {
    const c = codes[i]!;
    if (c >= 1000) break;
    if (c === 2 && !tableName) tableName = str(values[i]).trim().toUpperCase();
    else if (c === 5 && !head.handle) head.handle = handle(values[i]);
    else if (c === 102) {
      const app = str(values[i]).trim().toUpperCase();
      let j = i + 1;
      for (; j < codes.length && codes[j] !== 102; j++) {
        if (app === '{ACAD_XDICTIONARY' && codes[j] === 360) head.xdict = handle(values[j]);
        else if (app === '{ACAD_REACTORS' && codes[j] === 330) (head.reactors ??= []).push(handle(values[j]));
      }
      i = j;
    }
  }
  if (i < codes.length) head.xdata = parseXData(codes, values, i);
  if (tableName && head.handle) (doc.tableHeads ??= new Map()).set(tableName, head);
}

function readClass(rec: DxfRecord): CadClass {
  const g = (code: number) => {
    const i = rec.codes.indexOf(code);
    return i >= 0 ? rec.values[i] : undefined;
  };
  return {
    dxfName: str(g(1)),
    cppName: str(g(2)),
    appName: str(g(3)),
    proxyFlags: int(g(90)),
    instanceCount: int(g(91)),
    wasProxy: int(g(280)) === 1,
    isEntity: int(g(281)) === 1,
  };
}

/** 객체 하나와 딸린 레코드(VERTEX…SEQEND, ATTRIB…SEQEND)를 읽는다. */
function takeEntity(rec: DxfRecord, stream: RecordStream, ctx: EntityContext): Entity | null {
  const e = parseEntity(rec, ctx);
  if (!e) return null;
  if (e.type === 'POLYLINE') {
    const pl = e as PolylineEntity;
    let p = stream.peek();
    const widths = { startWidth: pl.defaultStartWidth, endWidth: pl.defaultEndWidth };
    while (p && p.type === 'VERTEX') {
      pl.vertices.push(parseVertex(stream.next()!, widths));
      p = stream.peek();
    }
    if (p && p.type === 'SEQEND') stream.next();
  } else if (e.type === 'INSERT') {
    const ins = e as InsertEntity;
    let p = stream.peek();
    while (p && p.type === 'ATTRIB') {
      const a = parseEntity(stream.next()!, ctx);
      if (a && a.type === 'ATTRIB') ins.attribs.push(a as AttribEntity);
      p = stream.peek();
    }
    if (p && p.type === 'SEQEND') stream.next();
  }
  return e;
}

export function readDxf(data: Uint8Array, options: DxfReadOptions = {}): CadDocument {
  if (data.length === 0) throw new CadReadError('file.empty');
  const src = openDxf(data, codepageToEncoding);
  const stream = src.stream;
  const doc = createDocument('dxf');
  doc.version = src.version;
  doc.codepage = src.codepage;
  doc.binary = src.binary;
  const th = createTableHandles();
  const ctx: EntityContext = { version: src.version, unsupported: new Map() };
  const maxEntities = options.maxEntities ?? 3_000_000;
  let entityCount = 0;
  let skipped = 0;
  const looseEntities: Entity[] = [];
  let sawSection = false;
  let records = 0;
  let rawSection: RawSection | null = null;

  const progress = () => {
    if (options.onProgress && (++records & 4095) === 0) options.onProgress(stream.progress());
  };

  const addCounted = (list: Entity[], e: Entity) => {
    if (entityCount >= maxEntities) {
      skipped++;
      return;
    }
    entityCount++;
    list.push(e);
  };

  for (let rec = stream.next(); rec; rec = stream.next()) {
    progress();
    if (rec.type === 'EOF') break;
    if (rec.type !== 'SECTION') continue;
    sawSection = true;
    const sec = sectionName(rec);
    if (sec === 'HEADER') {
      readHeader(doc, rec);
      // HEADER 구역은 ENDSEC 레코드로 끝난다.
      while ((rec = stream.peek()) && rec.type !== 'ENDSEC' && rec.type !== 'EOF') stream.next();
      if (stream.peek()?.type === 'ENDSEC') stream.next();
      continue;
    }
    if (sec && !KNOWN_SECTIONS.has(sec)) {
      // 모델이 해석하지 않는 구역(THUMBNAILIMAGE, ACDSDATA …)은 다시 쓸 수 있게 원본 태그를 둔다.
      // 구역 이름(2) 뒤의 태그는 SECTION 레코드 안에 있다(THUMBNAILIMAGE의 90·310).
      rawSection = { name: sec, version: src.version, tags: [] };
      (doc.rawSections ??= []).push(rawSection);
      const ni = rec.codes.indexOf(2);
      for (let i = ni + 1; i < rec.codes.length; i++) rawSection.tags.push({ code: rec.codes[i]!, value: rec.values[i]! });
    }
    for (let r = stream.next(); r && r.type !== 'ENDSEC' && r.type !== 'EOF'; r = stream.next()) {
      progress();
      switch (sec) {
        case 'CLASSES':
          if (r.type === 'CLASS') doc.classes.push(readClass(r));
          break;
        case 'TABLES':
          if (r.type === 'TABLE') readTableHead(doc, r);
          else if (r.type !== 'ENDTAB') readTableEntry(doc, r, th);
          break;
        case 'BLOCKS': {
          if (r.type !== 'BLOCK') break;
          const codes = r.codes;
          const val = (c: number) => {
            const i = codes.indexOf(c);
            return i >= 0 ? r!.values[i] : undefined;
          };
          let blockName = name(val(2) ?? val(3));
          // R12는 모형·배치 공간을 $MODEL_SPACE·$PAPER_SPACE 블록으로 둔다.
          if (blockName.toUpperCase() === '$MODEL_SPACE') blockName = '*Model_Space';
          else if (blockName.toUpperCase() === '$PAPER_SPACE') blockName = '*Paper_Space';
          const b: BlockDef = {
            name: blockName,
            handle: val(5) !== undefined ? handle(val(5)) : '',
            recordHandle: val(330) !== undefined ? handle(val(330)) : '',
            basePoint: { x: num(val(10)), y: num(val(20)), z: num(val(30)) },
            flags: int(val(70)),
            entities: [],
          };
          const xref = val(1);
          if (xref !== undefined && str(xref)) b.xrefPath = str(xref);
          const desc = val(4);
          if (desc !== undefined && str(desc)) b.description = str(desc);
          const lay = val(8);
          if (lay !== undefined) b.layer = name(lay);
          for (let er = stream.next(); er && er.type !== 'ENDSEC' && er.type !== 'EOF'; er = stream.next()) {
            progress();
            if (er.type === 'ENDBLK') {
              const hi = er.codes.indexOf(5);
              if (hi >= 0) b.endHandle = handle(er.values[hi]);
              break;
            }
            const e = takeEntity(er, stream, ctx);
            if (e) addCounted(b.entities, e);
          }
          const key = tableKey(blockName);
          const prev = doc.blocks.get(key);
          if (prev && prev.entities.length && !b.entities.length) break;
          doc.blocks.set(key, b);
          break;
        }
        case 'ENTITIES': {
          const e = takeEntity(r, stream, ctx);
          if (e) addCounted(looseEntities, e);
          break;
        }
        case 'OBJECTS': {
          const o = parseObject(r);
          if (o) {
            if (!o.handle) break;
            doc.objects.set(o.handle, o);
            if (!doc.rootDictionary && o.type === 'DICTIONARY') doc.rootDictionary = o.handle;
          }
          break;
        }
        default:
          // 모델이 해석하지 않는 구역(THUMBNAILIMAGE, ACDSDATA …)은 다시 쓸 수 있게 원본 태그를 둔다.
          if (rawSection) {
            rawSection.tags.push({ code: 0, value: r.type });
            for (let i = 0; i < r.codes.length; i++) rawSection.tags.push({ code: r.codes[i]!, value: r.values[i]! });
          }
          break;
      }
    }
    rawSection = null;
  }

  if (!sawSection) throw new CadReadError('dxf.invalid', { reason: 'no_section' });

  // ENTITIES 구역의 객체를 소유 블록에 넣는다(R12는 67로 모형·배치를 나눈다).
  const recordName = (h: string | undefined) => (h ? th.blockRecords.get(h) : undefined);
  const ensure = (nm: string): BlockDef => {
    const key = tableKey(nm);
    let b = doc.blocks.get(key);
    if (!b) {
      b = { name: nm, handle: '', recordHandle: '', basePoint: { x: 0, y: 0, z: 0 }, flags: 0, entities: [] };
      doc.blocks.set(key, b);
    }
    return b;
  };
  const modelName = doc.blocks.get(MODEL_SPACE)?.name ?? '*Model_Space';
  const paperName = doc.blocks.get(PAPER_SPACE)?.name ?? '*Paper_Space';
  for (const e of looseEntities) {
    const owner = recordName(e.owner);
    const target = owner ?? (e.paperSpace ? paperName : modelName);
    ensure(target).entities.push(e);
  }

  // 배치
  for (const o of doc.objects.values()) {
    if (o.type !== 'LAYOUT') continue;
    const l = (o as LayoutObject).layout;
    l.blockName = recordName(l.blockRecord) ?? (l.name.toUpperCase() === 'MODEL' ? '*Model_Space' : '');
    if (!l.blockName) continue;
    doc.layouts.push(l);
  }

  // 표 핸들 풀기
  resolveDimStyleHandles(doc, th);
  for (const b of doc.blocks.values()) {
    for (const e of b.entities) {
      if (e.type === 'VIEWPORT') e.frozenLayers = e.frozenLayers.map((h) => th.layers.get(h) ?? h).filter(Boolean);
    }
  }

  assignMissingHandles(doc);

  if (ctx.unsupported.size) {
    const types = Object.fromEntries(ctx.unsupported);
    const count = [...ctx.unsupported.values()].reduce((a, b) => a + b, 0);
    doc.warnings.push({ code: 'entity.unsupported', message: '표시하지 않는 객체 종류가 있습니다.', count, detail: { types } });
  }
  if (skipped) {
    doc.warnings.push({ code: 'entity.limit', message: `객체가 너무 많아 ${skipped}개를 읽지 않았습니다.`, count: skipped });
  }
  options.onProgress?.(1);
  return finalizeDocument(doc);
}

/** 핸들이 없는 객체(R12 등)에 $HANDSEED 이후 핸들을 붙인다. 선택·편집이 핸들로 객체를 찾는다. */
function assignMissingHandles(doc: CadDocument): void {
  let max = 0n;
  const bump = (h: string) => {
    if (!h) return;
    try {
      const v = BigInt('0x' + h);
      if (v > max) max = v;
    } catch {
      /* 잘못된 핸들은 무시 */
    }
  };
  for (const b of doc.blocks.values()) {
    bump(b.handle);
    for (const e of b.entities) {
      bump(e.handle);
      if (e.type === 'INSERT') for (const a of e.attribs) bump(a.handle);
    }
  }
  for (const o of doc.objects.keys()) bump(o);
  const seed = doc.header.get('$HANDSEED');
  if (typeof seed === 'string') bump(seed);
  let next = max + 1n;
  const give = () => normalizeHandle((next++).toString(16));
  for (const b of doc.blocks.values()) {
    for (const e of b.entities) {
      if (!e.handle) e.handle = give();
      if (e.type === 'INSERT') for (const a of e.attribs) if (!a.handle) a.handle = give();
    }
  }
}
