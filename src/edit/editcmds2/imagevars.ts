/**
 * 래스터 이미지·PDF 언더레이 조정값과 이미지 품질(화면·DOM 없음).
 * - IMAGEADJUST: 밝기·대비·흐리기(0~100, 기본 50·50·0).
 * - PDFADJUST: 흐리기(0~80, 기본 25)·대비(0~100, 기본 20)·단색(언더레이 플래그 4).
 * - IMAGEQUALITY: 이름 있는 객체 사전 ACAD_IMAGE_VARS(RASTERVARIABLES)의 그룹 71(0 초안, 1 높음).
 */
import type { CadDocument, GenericObject, ImageEntity, RawTag, UnderlayEntity } from '../../core/model';
import { FRAME_DICT, FRAME_TYPE, frameVarObject, frameVarTags, rootDictionary } from '../../core/framevars';
import type { EditOp } from '../session';

export interface ImageAdjust {
  brightness: number;
  contrast: number;
  fade: number;
}

export interface UnderlayAdjust {
  fade: number;
  contrast: number;
  monochrome: boolean;
}

/** 언더레이 플래그: 4 = 단색 */
export const UNDERLAY_MONO = 4;

const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

/** 이미지 조정 범위 검사(0~100 정수가 아니면 까닭) */
export function imageValueProblem(v: number): string | null {
  return Number.isFinite(v) && Number.isInteger(v) && v >= 0 && v <= 100 ? null : '값은 0에서 100 사이의 정수여야 합니다.';
}

/** PDF 흐리기 범위 검사(0~80) */
export function underlayFadeProblem(v: number): string | null {
  return Number.isFinite(v) && Number.isInteger(v) && v >= 0 && v <= 80 ? null : '값은 0에서 80 사이의 정수여야 합니다.';
}

/** 이미지 조정값(파일 값이 비었으면 기본값) */
export function imageAdjustOf(e: ImageEntity): ImageAdjust {
  const n = (v: number, d: number) => (Number.isFinite(v) ? clampInt(v, 0, 100) : d);
  return { brightness: n(e.brightness, 50), contrast: n(e.contrast, 50), fade: n(e.fade, 0) };
}

/** 이미지에 조정값을 적용한 사본(바뀐 것이 없으면 null) */
export function adjustImage(e: ImageEntity, patch: Partial<ImageAdjust>): ImageEntity | null {
  const cur = imageAdjustOf(e);
  const next: ImageAdjust = {
    brightness: patch.brightness === undefined ? cur.brightness : clampInt(patch.brightness, 0, 100),
    contrast: patch.contrast === undefined ? cur.contrast : clampInt(patch.contrast, 0, 100),
    fade: patch.fade === undefined ? cur.fade : clampInt(patch.fade, 0, 100),
  };
  if (next.brightness === e.brightness && next.contrast === e.contrast && next.fade === e.fade) return null;
  return { ...e, ...next };
}

/** 언더레이 조정값 */
export function underlayAdjustOf(e: UnderlayEntity): UnderlayAdjust {
  return {
    fade: Number.isFinite(e.fade) ? clampInt(e.fade, 0, 80) : 25,
    contrast: Number.isFinite(e.contrast) ? clampInt(e.contrast, 0, 100) : 20,
    monochrome: (e.flags & UNDERLAY_MONO) !== 0,
  };
}

/** 언더레이에 조정값을 적용한 사본(바뀐 것이 없으면 null) */
export function adjustUnderlay(e: UnderlayEntity, patch: Partial<UnderlayAdjust>): UnderlayEntity | null {
  const cur = underlayAdjustOf(e);
  const fade = patch.fade === undefined ? cur.fade : clampInt(patch.fade, 0, 80);
  const contrast = patch.contrast === undefined ? cur.contrast : clampInt(patch.contrast, 0, 100);
  const mono = patch.monochrome === undefined ? cur.monochrome : patch.monochrome;
  const flags = mono ? e.flags | UNDERLAY_MONO : e.flags & ~UNDERLAY_MONO;
  if (fade === e.fade && contrast === e.contrast && flags === e.flags) return null;
  return { ...e, fade, contrast, flags };
}

/** 이미지 품질(1 높음, 0 초안). 변수 객체가 없으면 1 */
export function imageQuality(doc: CadDocument): 0 | 1 {
  const v = frameVarObject(doc, 'image')?.raw?.find((t) => t.code === 71)?.value;
  return Number(v) === 0 ? 0 : 1;
}

/** 그룹 71을 바꾼 원시 태그(없으면 넣는다) */
function withQuality(raw: RawTag[] | undefined, q: 0 | 1): RawTag[] {
  if (!raw?.length) return frameVarTags('image', 1).map((t) => (t.code === 71 ? { code: 71, value: q } : t));
  if (raw.some((t) => t.code === 71)) return raw.map((t) => (t.code === 71 ? { code: 71, value: q } : t));
  const i = raw.findIndex((t) => t.code === 70);
  const out = [...raw];
  out.splice(i >= 0 ? i + 1 : out.length, 0, { code: 71, value: q });
  return out;
}

/** IMAGEQUALITY 바꾸기 작업(변수 객체가 없으면 만들어 이름 있는 객체 사전에 넣는다). 사전도 없으면 null */
export function imageQualityOps(doc: CadDocument, q: 0 | 1, newHandle: () => string): EditOp[] | null {
  const cur = frameVarObject(doc, 'image');
  if (cur) {
    const after: GenericObject = { ...cur, raw: withQuality(cur.raw, q) };
    delete after.dwgRaw;
    return JSON.stringify(after.raw) === JSON.stringify(cur.raw) ? [] : [{ kind: 'object', key: cur.handle, before: cur, after }];
  }
  const root = rootDictionary(doc);
  if (!root) return null;
  const h = newHandle();
  const o: GenericObject = { type: FRAME_TYPE.image, handle: h, owner: root.handle, reactors: [root.handle], raw: withQuality(undefined, q) };
  const entries = new Map(root.entries);
  entries.set(FRAME_DICT.image, h);
  return [
    { kind: 'object', key: h, before: null, after: o },
    { kind: 'object', key: root.handle, before: root, after: { ...root, entries } },
  ];
}
