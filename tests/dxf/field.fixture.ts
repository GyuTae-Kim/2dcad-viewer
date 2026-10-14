/**
 * AutoCAD 필드 시험 도면: MTEXT의 확장 사전 → ACAD_FIELD 사전 → TEXT → 맨 위 FIELD(_text) → 자식 FIELD 둘
 * (AcVar 날짜, AcObjProp 원 면적), 루트 사전 ACAD_FIELDLIST → FIELDLIST. AutoCAD가 쓴 FIELD 표본이 없어
 * DXF 참조·사양 20.4.76의 구조대로 만든다(DXF·DWG 쓰기 시험이 같이 쓴다).
 */
import type { CircleEntity, CadDocument, DictionaryObject, FieldObject, GenericObject, MTextEntity } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { EditSession } from '../../src/edit/session';
import { fieldListTags, fieldTags } from '../../src/io/fields';

export interface FieldFixture {
  doc: CadDocument;
  mtext: MTextEntity;
  circle: CircleEntity;
  template: string;
  handles: { top: string; date: string; area: string; list: string };
}

function field(over: Partial<FieldObject>): FieldObject {
  return { evaluator: '', code: '', children: [], objects: [], evalOptions: 63, filingOptions: 0, state: 31, evalStatus: 2, errorCode: 0, errorMessage: '', ...over };
}

/** withRaw가 참이면 DXF 리더처럼 원본 태그도 붙인다 */
export function fieldFixture(withRaw = true): FieldFixture {
  const doc = createNewDocument('metric');
  const s = new EditSession(doc, () => {});
  const nh = () => s.newHandle();
  const circle: CircleEntity = { ...entityDefaults(), type: 'CIRCLE', handle: nh(), center: { x: 50, y: 50, z: 0 }, radius: 10 };
  const mt: MTextEntity = { ...entityDefaults(), type: 'MTEXT', handle: nh(), insert: { x: 0, y: 0, z: 0 }, height: 2.5, width: 0, attachment: 1, drawingDirection: 1, text: '2026-01-02 날짜 314.16', style: 'Standard', rotation: 0, lineSpacingStyle: 1, lineSpacingFactor: 1, backgroundFlags: 0, backgroundScale: 1.5 };
  const xd = nh();
  const fd = nh();
  const top = nh();
  const date = nh();
  const area = nh();
  const list = nh();
  mt.xdict = xd;
  const dict = (h: string, owner: string, entries: [string, string][], hardOwner = false): DictionaryObject => ({ type: 'DICTIONARY', handle: h, owner, reactors: [owner], entries: new Map(entries), hardOwner, cloning: 1 });
  const fobj = (h: string, owner: string, f: FieldObject): GenericObject => {
    const o: GenericObject = { type: 'FIELD', handle: h, owner, reactors: [owner], field: f };
    if (withRaw) o.raw = fieldTags(f, 1032);
    return o;
  };
  const topF = field({ evaluator: '_text', code: '%<\\_FldIdx 0>% 날짜 %<\\_FldIdx 1>%', children: [date, area], value: { flags: 0, type: 4, value: '2026-01-02 날짜 314.16', unit: 0, format: '', text: '2026-01-02 날짜 314.16' }, valueString: '2026-01-02 날짜 314.16' });
  const dateF = field({ evaluator: 'AcVar', code: '\\AcVar Date \\f "yyyy-MM-dd"', value: { flags: 0, type: 4, value: '2026-01-02', unit: 0, format: 'yyyy-MM-dd', text: '2026-01-02' }, valueString: '2026-01-02', data: [{ key: 'ACFD_FIELDTEXT_CHECKSUM', value: { flags: 0, type: 2, value: 1234.5, unit: 0, format: '', text: '' } }] });
  const areaF = field({ evaluator: 'AcObjProp', code: '\\AcObjProp Object(%<\\_ObjIdx 0>%).Area \\f "%lu2"', objects: [circle.handle], value: { flags: 0, type: 2, value: 314.159, unit: 4, format: '%lu2', text: '314.16' }, valueString: '314.16' });
  const root = doc.objects.get(doc.rootDictionary!) as DictionaryObject;
  const root2: DictionaryObject = { ...root, entries: new Map([...root.entries, ['ACAD_FIELDLIST', list]]) };
  const listObj: GenericObject = { type: 'FIELDLIST', handle: list, owner: root.handle, reactors: [root.handle], raw: fieldListTags([top, date, area]) };
  s.commit({
    label: 'FIELD',
    ops: [
      { kind: 'add', block: MODEL_SPACE, entity: circle },
      { kind: 'add', block: MODEL_SPACE, entity: mt },
      { kind: 'object', key: xd, before: null, after: dict(xd, mt.handle, [['ACAD_FIELD', fd]], true) },
      { kind: 'object', key: fd, before: null, after: dict(fd, xd, [['TEXT', top]], true) },
      { kind: 'object', key: top, before: null, after: fobj(top, fd, topF) },
      { kind: 'object', key: date, before: null, after: fobj(date, top, dateF) },
      { kind: 'object', key: area, before: null, after: fobj(area, top, areaF) },
      { kind: 'object', key: list, before: null, after: listObj },
      { kind: 'object', key: root.handle, before: root, after: root2 },
    ],
  });
  const template = `%<\\AcVar Date \\f "yyyy-MM-dd">% 날짜 %<\\AcObjProp Object(%<\\_ObjId ${circle.handle}>%).Area \\f "%lu2">%`;
  return { doc, mtext: mt, circle, template, handles: { top, date, area, list } };
}
