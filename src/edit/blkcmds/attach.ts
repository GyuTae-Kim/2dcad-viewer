/**
 * 래스터 이미지·PDF 언더레이 부착(UI 없음): IMAGEATTACH·PDFATTACH·PASTESPEC(이미지)가 쓴다.
 * - 이미지: 이미지 사전(ACAD_IMAGE_DICT)에 IMAGEDEF, IMAGE 객체와 그 반응자(IMAGEDEF_REACTOR).
 *   같은 파일의 정의가 이미 있으면 그것을 쓴다. 해상도 정보를 읽지 않으므로 AutoCAD처럼 축척 1 = 폭 1 도면 단위다.
 * - PDF: PDF 정의 사전(ACAD_PDFDEFINITIONS)에 PDFDEFINITION(이름 = 페이지 번호), PDFUNDERLAY 객체.
 *   언더레이 좌표는 1 = 1인치이므로 축척에 도면 단위(INSUNITS) 환산을 곱해 둔다.
 */
import type { CadDocument, CadObject, DictionaryObject, EntityBase, GenericObject, ImageDefObject, ImageEntity, UnderlayDefObject, UnderlayEntity, Vec3 } from '../../core/model';
import { entityDefaults } from '../../core/model';
import type { EditOp } from '../session';
import { INSUNITS_MM } from '../util/calc';

/** 루트 사전 아래 이름 붙은 사전(없으면 만든다). 만든 작업과 사전 */
function namedDict(doc: CadDocument, name: string, newHandle: () => string, ops: EditOp[], staged: Map<string, CadObject>): DictionaryObject | null {
  const get = (h: string | undefined) => (h ? (staged.get(h) ?? doc.objects.get(h)) : undefined);
  const root = get(doc.rootDictionary) as DictionaryObject | undefined;
  if (!root || (root.type !== 'DICTIONARY' && root.type !== 'ACDBDICTIONARYWDFLT')) return null;
  for (const [k, h] of root.entries) {
    if (k.toUpperCase() !== name) continue;
    const d = get(h);
    if (d && (d.type === 'DICTIONARY' || d.type === 'ACDBDICTIONARYWDFLT')) return d as DictionaryObject;
  }
  const dict: DictionaryObject = { type: 'DICTIONARY', handle: newHandle(), owner: root.handle, entries: new Map(), hardOwner: false, cloning: 1 };
  const nroot: DictionaryObject = { ...root, entries: new Map(root.entries) };
  nroot.entries.set(name, dict.handle);
  ops.push({ kind: 'object', key: dict.handle, before: null, after: dict });
  ops.push({ kind: 'object', key: root.handle, before: doc.objects.get(root.handle) ?? null, after: nroot });
  staged.set(dict.handle, dict);
  staged.set(root.handle, nroot);
  return dict;
}

/** 사전 항목 넣기(같은 이름이면 " (2)" …를 붙인다). 넣은 이름 */
function addEntry(doc: CadDocument, dict: DictionaryObject, want: string, handle: string, ops: EditOp[], staged: Map<string, CadObject>): string {
  const cur = (staged.get(dict.handle) as DictionaryObject | undefined) ?? dict;
  const taken = new Set([...cur.entries.keys()].map((k) => k.toUpperCase()));
  let name = want;
  for (let n = 2; taken.has(name.toUpperCase()); n++) name = `${want} (${n})`;
  const next: DictionaryObject = { ...cur, entries: new Map(cur.entries) };
  next.entries.set(name, handle);
  // 같은 사전을 여러 번 고치면 마지막 상태만 남긴다(이 작업 안에서 만든 사전이면 그 'object' 작업을 고친다)
  const prev = ops.findIndex((op) => op.kind === 'object' && op.key === dict.handle);
  if (prev >= 0) {
    const op = ops[prev] as Extract<EditOp, { kind: 'object' }>;
    ops[prev] = { ...op, after: next };
  } else ops.push({ kind: 'object', key: dict.handle, before: doc.objects.get(dict.handle) ?? null, after: next });
  staged.set(dict.handle, next);
  return name;
}

const baseOf = (f: string) => f.replace(/^.*[\\/]/, '');

export interface ImageAttach {
  /** 도면에 적을 파일 이름(경로) */
  fileName: string;
  widthPx: number;
  heightPx: number;
  space: string;
  /** 왼쪽 아래 모서리(WCS) */
  insert: Vec3;
  /** 이미지 폭(도면 단위) */
  width: number;
  rotation: number;
  props: Omit<EntityBase, 'type' | 'handle'>;
}

/** 이미지 부착 작업과 만든 이미지 객체 */
export function imageAttachOps(doc: CadDocument, o: ImageAttach, newHandle: () => string): { ops: EditOp[]; image: ImageEntity; def: ImageDefObject; reused: boolean } {
  const ops: EditOp[] = [];
  const staged = new Map<string, CadObject>();
  const key = baseOf(o.fileName).toLowerCase();
  let def = [...doc.objects.values()].find((x): x is ImageDefObject => x.type === 'IMAGEDEF' && baseOf((x as ImageDefObject).fileName).toLowerCase() === key) ?? null;
  const reused = !!def;
  const imgH = newHandle();
  const reactorH = newHandle();
  if (!def) {
    const dict = namedDict(doc, 'ACAD_IMAGE_DICT', newHandle, ops, staged);
    def = {
      type: 'IMAGEDEF',
      handle: newHandle(),
      owner: dict?.handle,
      fileName: o.fileName,
      imageSize: { x: o.widthPx, y: o.heightPx },
      pixelSize: { x: 1 / Math.max(1, o.widthPx), y: 1 / Math.max(1, o.widthPx) },
      loaded: true,
      resolutionUnits: 0,
      reactors: [...(dict ? [dict.handle] : []), reactorH],
    };
    ops.push({ kind: 'object', key: def.handle, before: null, after: def });
    if (dict) addEntry(doc, dict, baseOf(o.fileName).replace(/\.[^.]*$/, '') || 'image', def.handle, ops, staged);
  } else {
    const after: ImageDefObject = { ...def, loaded: true, reactors: [...(def.reactors ?? []), reactorH] };
    ops.push({ kind: 'object', key: def.handle, before: def, after });
    def = after;
  }
  const reactor: GenericObject = { type: 'IMAGEDEF_REACTOR', handle: reactorH, owner: imgH, raw: [{ code: 90, value: 2 }, { code: 330, value: imgH }] };
  ops.push({ kind: 'object', key: reactorH, before: null, after: reactor });
  const w = Math.max(1, def.imageSize.x || o.widthPx);
  const hpx = Math.max(1, def.imageSize.y || o.heightPx);
  const k = o.width / w;
  const c = Math.cos(o.rotation);
  const s = Math.sin(o.rotation);
  const image: ImageEntity = {
    ...entityDefaults(),
    ...o.props,
    type: 'IMAGE',
    handle: imgH,
    owner: doc.blocks.get(o.space)?.recordHandle,
    insert: { ...o.insert },
    uVector: { x: k * c, y: k * s, z: 0 },
    vVector: { x: -k * s, y: k * c, z: 0 },
    imageSize: { x: w, y: hpx },
    imageDef: def.handle,
    imageDefReactor: reactorH,
    displayFlags: 7,
    clipping: false,
    brightness: 50,
    contrast: 50,
    fade: 0,
    clipBoundaryType: 1,
    clipBoundary: [
      { x: -0.5, y: -0.5 },
      { x: w - 0.5, y: hpx - 0.5 },
    ],
  };
  if (/^\*PAPER_SPACE/i.test(o.space)) image.paperSpace = true;
  ops.push({ kind: 'add', block: o.space, entity: image });
  return { ops, image, def, reused };
}

/** INSUNITS → 1인치의 도면 단위 수(단위 없음이면 1) */
export function unitsPerInch(insunits: number): number {
  const u = INSUNITS_MM[insunits];
  return u ? 25.4 / u : 1;
}

export interface PdfAttach {
  fileName: string;
  /** 1부터 */
  page: number;
  space: string;
  insert: Vec3;
  /** 사용자 축척(1 = 실제 크기) */
  scale: number;
  rotation: number;
  /** 도면 INSUNITS */
  insunits: number;
  props: Omit<EntityBase, 'type' | 'handle'>;
}

export function pdfAttachOps(doc: CadDocument, o: PdfAttach, newHandle: () => string): { ops: EditOp[]; underlay: UnderlayEntity; def: UnderlayDefObject; reused: boolean } {
  const ops: EditOp[] = [];
  const staged = new Map<string, CadObject>();
  const key = baseOf(o.fileName).toLowerCase();
  const pageName = String(Math.max(1, Math.floor(o.page)));
  let def =
    [...doc.objects.values()].find((x): x is UnderlayDefObject => x.type === 'PDFDEFINITION' && baseOf((x as UnderlayDefObject).fileName).toLowerCase() === key && (Number.parseInt((x as UnderlayDefObject).name, 10) || 1) === Number(pageName)) ?? null;
  const reused = !!def;
  if (!def) {
    const dict = namedDict(doc, 'ACAD_PDFDEFINITIONS', newHandle, ops, staged);
    const d: UnderlayDefObject = { type: 'PDFDEFINITION', handle: newHandle(), owner: dict?.handle, fileName: o.fileName, name: pageName, reactors: dict ? [dict.handle] : undefined };
    ops.push({ kind: 'object', key: d.handle, before: null, after: d });
    if (dict) addEntry(doc, dict, `${baseOf(o.fileName).replace(/\.[^.]*$/, '')} - ${pageName}`, d.handle, ops, staged);
    def = d;
  }
  const k = o.scale * unitsPerInch(o.insunits);
  const underlay: UnderlayEntity = {
    ...entityDefaults(),
    ...o.props,
    type: 'PDFUNDERLAY',
    handle: newHandle(),
    owner: doc.blocks.get(o.space)?.recordHandle,
    definition: def.handle,
    insert: { ...o.insert },
    scale: { x: k, y: k, z: k },
    rotation: o.rotation,
    // 2 켜기, 8 배경에 맞춰 색 조정
    flags: 2 | 8,
    contrast: 20,
    fade: 25,
    clipBoundary: [],
  };
  if (/^\*PAPER_SPACE/i.test(o.space)) underlay.paperSpace = true;
  ops.push({ kind: 'add', block: o.space, entity: underlay });
  return { ops, underlay, def, reused };
}
