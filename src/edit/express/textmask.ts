/**
 * TEXTMASK·TEXTUNMASK(Express Tools 문자 가리기) 계산(UI 없음).
 * 문자 상자를 간격띄우기 비율 × 문자 높이만큼 넓힌 사각형으로 가리기(WIPEOUT) 또는 솔리드(SOLID)를 만든다.
 * 가리개는 문자와 같은 도면층·공간에 문자 바로 뒤(그리기 순서)에 놓고, 문자와 이름 없는 그룹으로 묶는다.
 * 문자와 가리개의 짝은 문자의 확장 데이터(이 앱의 기록 OPENCAD_TEXTMASK)에 적는다:
 *   1000 가리개 종류(wipeout·solid) · 1040 간격띄우기 비율 · 1005 가리개 핸들 · 1005 그룹 핸들(있으면).
 */
import type { CadColor, CadDocument, Entity, EntityBase, FaceEntity, ImageEntity, Vec2, XData } from '../../core/model';
import { normalizeHandle } from '../../core/model';
import { makeWipeout } from '../geom/markup';
import { boxCorners, hasTextBox, textBox } from './textbox';

export const TEXTMASK_APP = 'OPENCAD_TEXTMASK';

export type MaskType = 'wipeout' | 'solid';

export const MASK_LABEL: Record<MaskType, string> = { wipeout: '가리기', solid: '솔리드' };

export interface MaskLink {
  type: MaskType;
  offset: number;
  /** 가리개 핸들 */
  mask: string;
  /** 문자와 가리개를 묶은 그룹 핸들 */
  group?: string;
}

/** TEXTMASK를 받는 객체 */
export function isMaskTarget(e: Entity): boolean {
  return hasTextBox(e) && e.type !== 'ATTRIB';
}

/** 가리개 다각형(WCS 평면도, 왼쪽 아래부터 반시계) */
export function maskPolygon(e: Entity, offsetFactor: number, doc: CadDocument): Vec2[] | null {
  const b = textBox(e, doc);
  if (!b || !(b.w > 0) || !(b.h > 0)) return null;
  return boxCorners(b, Math.max(0, offsetFactor) * b.height);
}

/** 가리개 객체(핸들 '' — 호출한 쪽이 붙인다). 상자가 없으면 null */
export function makeMask(e: Entity, opt: { type: MaskType; offset: number; color?: CadColor }, doc: CadDocument): ImageEntity | FaceEntity | null {
  const poly = maskPolygon(e, opt.offset, doc);
  if (!poly) return null;
  const b = textBox(e, doc)!;
  const base: Omit<EntityBase, 'type'> = {
    handle: '',
    layer: e.layer,
    linetype: 'ByLayer',
    color: { aci: 256 },
    lineweight: -1,
    ltscale: 1,
    transparency: -1,
  };
  if (e.paperSpace) base.paperSpace = true;
  if (e.owner) base.owner = e.owner;
  if (opt.type === 'wipeout') return makeWipeout(base, poly, b.z);
  const z = b.z;
  const [a, bb, c, d] = poly as [Vec2, Vec2, Vec2, Vec2];
  // SOLID 점 순서: 1·2·3·4 = 왼쪽 아래·오른쪽 아래·왼쪽 위·오른쪽 위
  return {
    ...base,
    color: opt.color ? { ...opt.color } : { aci: 8 },
    type: 'SOLID',
    points: [
      { x: a.x, y: a.y, z },
      { x: bb.x, y: bb.y, z },
      { x: d.x, y: d.y, z },
      { x: c.x, y: c.y, z },
    ],
    invisibleEdges: 0,
  } as FaceEntity;
}

/** 문자에 적힌 가리개 짝(없으면 null) */
export function readMaskLink(e: { xdata?: XData[] }): MaskLink | null {
  const x = e.xdata?.find((d) => d.app.toUpperCase() === TEXTMASK_APP);
  if (!x) return null;
  const type = x.items.find((i) => i.code === 1000)?.value;
  const offset = x.items.find((i) => i.code === 1040)?.value;
  const handles = x.items.filter((i) => i.code === 1005).map((i) => String(i.value));
  if (!handles[0]) return null;
  return {
    type: type === 'solid' ? 'solid' : 'wipeout',
    offset: typeof offset === 'number' ? offset : 0.35,
    mask: normalizeHandle(handles[0]),
    ...(handles[1] ? { group: normalizeHandle(handles[1]) } : {}),
  };
}

/** 짝을 넣거나(link) 지운(null) 확장 데이터. 다른 앱의 자료는 그대로 */
export function withMaskLink(xdata: XData[] | undefined, link: MaskLink | null): XData[] | undefined {
  const rest = (xdata ?? []).filter((d) => d.app.toUpperCase() !== TEXTMASK_APP);
  if (!link) return rest.length ? rest : undefined;
  const items: XData['items'] = [
    { code: 1000, value: link.type },
    { code: 1040, value: link.offset },
    { code: 1005, value: link.mask },
  ];
  if (link.group) items.push({ code: 1005, value: link.group });
  return [...rest, { app: TEXTMASK_APP, items }];
}

/** 가리개 객체인지(그 문자의 짝인지) */
export function isMaskOf(text: Entity, other: Entity | undefined): boolean {
  const l = readMaskLink(text);
  return !!l && !!other && normalizeHandle(other.handle) === l.mask;
}
