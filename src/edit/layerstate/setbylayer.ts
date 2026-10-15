/**
 * SETBYLAYER: 고른 객체의 색상·선종류·선가중치·투명도·재료·플롯 스타일을 ByLayer로 바꾼다.
 *
 * SETBYLAYERMODE(AutoCAD 시스템 변수, 기본 255) 비트: 1 색상, 2 선종류, 4 선가중치, 8 재료, 16 플롯 스타일,
 * 32 ByBlock도 ByLayer로, 64 블록 포함(블록 참조가 쓰는 블록 정의 안의 객체까지), 128 투명도.
 * ByBlock 값은 "ByBlock을 ByLayer로 변경" 답이 예일 때만 바꾼다. 잠긴 도면층의 객체는 바꾸지 않는다.
 * 블록 포함이면 블록 정의는 한 번씩만 고치고(중첩 포함), 외부 참조·배치·치수 블록은 건드리지 않는다.
 */
import type { CadDocument, Entity } from '../../core/model';
import { BYBLOCK, BYLAYER, LW_BYBLOCK, LW_BYLAYER, TRANSPARENCY_BYBLOCK, TRANSPARENCY_BYLAYER, normalizeHandle, tableKey } from '../../core/model';
import type { EditOp } from '../session';
import { cloneEntity, isLayoutBlock } from '../session';

export const SBL_COLOR = 1;
export const SBL_LINETYPE = 2;
export const SBL_LINEWEIGHT = 4;
export const SBL_MATERIAL = 8;
export const SBL_PLOTSTYLE = 16;
export const SBL_BYBLOCK = 32;
export const SBL_BLOCKS = 64;
export const SBL_TRANSPARENCY = 128;
export const SBL_DEFAULT = 255;

/** 설정 대화상자·"현재 활성 설정" 순서 */
export const SBL_PROPS: readonly { bit: number; label: string }[] = [
  { bit: SBL_COLOR, label: '색상' },
  { bit: SBL_LINETYPE, label: '선종류' },
  { bit: SBL_LINEWEIGHT, label: '선가중치' },
  { bit: SBL_TRANSPARENCY, label: '투명도' },
  { bit: SBL_MATERIAL, label: '재료' },
  { bit: SBL_PLOTSTYLE, label: '플롯 스타일' },
];

/** `현재 활성 설정:` 뒤의 글 */
export function activeSettingsText(mode: number): string {
  const s = SBL_PROPS.filter((p) => mode & p.bit).map((p) => p.label);
  return s.length ? s.join(' ') : '없음';
}

export interface SetByLayerOptions {
  /** 바꿀 특성(SETBYLAYERMODE의 특성 비트) */
  mode: number;
  /** ByBlock도 ByLayer로 */
  byBlock: boolean;
  /** 블록 정의 안의 객체까지 */
  includeBlocks: boolean;
  /** 이 도면층의 객체는 건너뛴다(잠긴 도면층) */
  skipLayer?: (layer: string) => boolean;
}

/** 재질 핸들이 ByBlock 재질인지(재질 사전의 이름) */
function materialNames(doc: CadDocument): Map<string, string> {
  const out = new Map<string, string>();
  for (const o of doc.objects.values()) {
    if (o.type !== 'MATERIAL') continue;
    const raw = (o as { raw?: { code: number; value: string | number }[] }).raw;
    const n = raw?.find((t) => t.code === 1)?.value;
    if (typeof n === 'string') out.set(normalizeHandle(o.handle), n.toUpperCase());
  }
  return out;
}

/** 객체 하나를 ByLayer로(바뀐 것이 없으면 null). 속성(INSERT의 attribs)도 함께 */
export function setByLayerEntity(e: Entity, o: SetByLayerOptions, isByBlockMaterial: (h: string) => boolean = () => false): Entity | null {
  const c = cloneEntity(e);
  let changed = fix(c, o, isByBlockMaterial);
  if (c.type === 'INSERT') {
    for (const a of c.attribs) {
      if (o.skipLayer?.(a.layer)) continue;
      if (fix(a, o, isByBlockMaterial)) changed = true;
    }
  }
  if (!changed) return null;
  delete c.dwgRaw;
  if (c.type === 'INSERT') for (const a of c.attribs) delete a.dwgRaw;
  return c;
}

function fix(c: Entity, o: SetByLayerOptions, isByBlockMaterial: (h: string) => boolean): boolean {
  let changed = false;
  const m = o.mode;
  if (m & SBL_COLOR && c.color.aci !== BYLAYER && (c.color.aci !== BYBLOCK || o.byBlock)) {
    c.color = { aci: BYLAYER };
    changed = true;
  }
  if (m & SBL_LINETYPE) {
    const k = tableKey(c.linetype || 'ByLayer');
    if (k !== 'BYLAYER' && (k !== 'BYBLOCK' || o.byBlock)) {
      c.linetype = 'ByLayer';
      changed = true;
    }
  }
  if (m & SBL_LINEWEIGHT && c.lineweight !== LW_BYLAYER && (c.lineweight !== LW_BYBLOCK || o.byBlock)) {
    c.lineweight = LW_BYLAYER;
    changed = true;
  }
  if (m & SBL_TRANSPARENCY && c.transparency !== TRANSPARENCY_BYLAYER && (c.transparency !== TRANSPARENCY_BYBLOCK || o.byBlock)) {
    c.transparency = TRANSPARENCY_BYLAYER;
    changed = true;
  }
  if (m & SBL_MATERIAL && c.material && (!isByBlockMaterial(c.material) || o.byBlock)) {
    delete c.material;
    changed = true;
  }
  if (m & SBL_PLOTSTYLE && c.plotStyle) {
    delete c.plotStyle;
    changed = true;
  }
  return changed;
}

/** 블록 정의를 고쳐도 되는지(외부 참조·배치·치수 블록은 안 된다) */
function editableBlock(doc: CadDocument, name: string): boolean {
  const k = tableKey(name);
  if (isLayoutBlock(k) || /^\*D\d*$/i.test(name)) return false;
  const b = doc.blocks.get(k);
  if (!b) return false;
  return !(b.flags & (4 | 8 | 16)) && !name.includes('|');
}

export interface SetByLayerResult {
  ops: EditOp[];
  /** 바뀐 고른 객체 수 */
  changed: number;
  /** 바뀐 블록 정의 안 객체 수 */
  nested: number;
  /** 고친 블록 정의 수 */
  blocks: number;
}

/** 고른 객체(공간 블록 키와 함께)를 ByLayer로 바꾸는 작업 */
export function setByLayerOps(doc: CadDocument, targets: readonly { block: string; entity: Entity }[], o: SetByLayerOptions): SetByLayerResult {
  const mats = materialNames(doc);
  const isBB = (h: string) => mats.get(normalizeHandle(h)) === 'BYBLOCK';
  const res: SetByLayerResult = { ops: [], changed: 0, nested: 0, blocks: 0 };
  const doneBlocks = new Set<string>();
  const visitBlock = (name: string) => {
    const k = tableKey(name);
    if (doneBlocks.has(k) || !editableBlock(doc, name)) return;
    doneBlocks.add(k);
    const b = doc.blocks.get(k)!;
    let any = false;
    for (const e of b.entities) {
      if (e.type === 'INSERT') visitBlock(e.block);
      if (o.skipLayer?.(e.layer)) continue;
      const c = setByLayerEntity(e, o, isBB);
      if (!c) continue;
      res.ops.push({ kind: 'modify', block: k, before: e, after: c });
      res.nested++;
      any = true;
    }
    if (any) res.blocks++;
  };
  for (const t of targets) {
    const e = t.entity;
    if (o.skipLayer?.(e.layer)) continue;
    const c = setByLayerEntity(e, o, isBB);
    if (c) {
      res.ops.push({ kind: 'modify', block: t.block, before: e, after: c });
      res.changed++;
    }
    if (o.includeBlocks && e.type === 'INSERT') visitBlock(e.block);
  }
  return res;
}
