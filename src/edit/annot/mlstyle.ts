/**
 * 다중 지시선 스타일(MLEADERSTYLE) 고치기·복사.
 * 파일에서 읽은 스타일은 원본 태그(raw)를 지니고 DXF 쓰기는 그 태그를 그대로 쓰므로, 모델 값과 함께 원본 태그의 같은 코드도 고친다.
 * 원본 태그에 없는 코드를 바꿔야 하면 원본 태그를 버린다(쓰기가 모델 값으로 새로 쓴다).
 */
import type { CadDocument, MLeaderStyleObject, RawTag } from '../../core/model';

export interface StyleValues {
  leaderLineType: number;
  arrowSize: number;
  /** 끊기 크기(143) */
  breakGap: number;
  landing: boolean;
  doglegLength: number;
  contentType: number;
  textStyleHandle?: string;
  textHeight: number;
  landingGap: number;
  scale: number;
}

/** 원본 태그의 code 첫 값 바꾸기(없으면 false) */
function patch(raw: RawTag[], code: number, value: string | number): boolean {
  const t = raw.find((x) => x.code === code);
  if (!t) return false;
  t.value = value;
  return true;
}

export function updateStyle(s: MLeaderStyleObject, v: StyleValues): MLeaderStyleObject {
  const c = structuredClone(s);
  c.leaderLineType = v.leaderLineType;
  c.arrowSize = v.arrowSize;
  c.landing = v.landing;
  c.doglegLength = v.doglegLength;
  c.contentType = v.contentType;
  c.textStyleHandle = v.textStyleHandle;
  c.textHeight = v.textHeight;
  c.landingGap = v.landingGap;
  c.scale = v.scale;
  if (c.raw?.length) {
    const ok = [
      patch(c.raw, 173, v.leaderLineType),
      patch(c.raw, 44, v.arrowSize),
      patch(c.raw, 290, v.landing ? 1 : 0),
      patch(c.raw, 43, v.doglegLength),
      patch(c.raw, 170, v.contentType),
      v.textStyleHandle ? patch(c.raw, 342, v.textStyleHandle) : true,
      patch(c.raw, 45, v.textHeight),
      patch(c.raw, 42, v.landingGap),
      patch(c.raw, 142, v.scale),
      patch(c.raw, 143, v.breakGap),
      patch(c.raw, 3, c.name),
    ].every(Boolean);
    if (!ok) delete c.raw;
  }
  return c;
}

/** 스타일 복사(새 이름·핸들·소유 사전) */
export function copyStyle(s: MLeaderStyleObject, name: string, handle: string, owner: string): MLeaderStyleObject {
  const c = structuredClone(s);
  c.name = name;
  c.handle = handle;
  c.owner = owner;
  c.reactors = [owner];
  delete c.xdict;
  delete c.dwgRaw;
  if (c.raw) {
    if (!patch(c.raw, 3, name)) delete c.raw;
  }
  return c;
}

/** 그 스타일을 쓰는 다중 지시선이 있는지 */
export function styleInUse(doc: CadDocument, handle: string): boolean {
  const h = handle.toUpperCase();
  for (const b of doc.blocks.values()) for (const e of b.entities) if (e.type === 'MULTILEADER' && e.styleHandle?.toUpperCase() === h) return true;
  return false;
}
