/**
 * 그리기에서 쓰는 주석 축척 선택: 공간마다 어느 축척의 표현을 그릴지, ANNOALLVISIBLE.
 * - 모형 공간: CANNOSCALE, 모형 탭의 ANNOALLVISIBLE
 * - 배치(종이) 공간: 1:1(종이 공간의 주석 객체는 1:1 표현 하나), 그 배치의 ANNOALLVISIBLE
 * - 배치 뷰포트를 통해 보는 모형: 그 뷰포트의 주석 축척(ASDK_XREC_ANNOTATION_SCALE_INFO, 없으면 뷰포트 축척과
 *   같은 리스트의 축척, 그것도 없으면 CANNOSCALE), 그 배치의 ANNOALLVISIBLE
 * - 블록 편집기 등 다른 블록: 고르지 않는다(객체 데이터 그대로)
 */
import type { BlockDef, CadDocument, Entity, ViewportEntity, XRecordObject } from '../../core/model';
import { tableKey } from '../../core/model';
import { type AnnoScale, dictOf, entryOf, sameRatio, scaleFromObject, unitScale, upper } from './scales';
import { ScaleIndex, annoState, representation } from './represent';
import { allVisible, cannoscaleName, currentScale } from './vars';

export interface AnnoDisplayOptions {
  /** 주석 축척 이름. undefined = 공간에 맞게, null = 고르지 않는다 */
  annoScale?: string | null;
  /** ANNOALLVISIBLE. undefined = 그 탭의 값 */
  annoAllVisible?: boolean;
}

/** 한 장면을 만드는 동안의 주석 표현 선택기 */
export class AnnoDisplay {
  readonly idx: ScaleIndex;
  /** 주석 객체 수(상태를 읽을 수 있는 것) */
  annotative = 0;
  /** 다른 표현으로 그리거나 숨긴 객체 수 */
  changed = 0;
  readonly blocks = new Map<string, BlockDef>();

  constructor(
    readonly doc: CadDocument,
    /** 그릴 축척(대문자 이름) */
    readonly scale: string,
    readonly allVisible: boolean,
  ) {
    this.idx = new ScaleIndex(doc);
  }

  /** 이 객체를 그릴 모양(같으면 그 객체, 숨기면 null) */
  view(e: Entity): Entity | null {
    if (!e.xdict && !e.xdata && e.type !== 'INSERT') return e;
    const st = annoState(this.doc, e, this.idx);
    if (!st || st.foreign) return e;
    this.annotative++;
    if (!st.byScale.has(this.scale)) {
      if (this.allVisible) return e;
      this.changed++;
      return null;
    }
    const v = representation(this.doc, e, st, this.scale, this.idx);
    if (v.entity !== e) this.changed++;
    if (v.blocks) for (const b of v.blocks) this.blocks.set(tableKey(b.name), b);
    return v.entity;
  }
}

/** 공간(블록 이름)에 맞는 선택기. 고르지 않으면 null */
export function annoDisplayFor(doc: CadDocument, space: string, opt: AnnoDisplayOptions = {}): AnnoDisplay | null {
  if (opt.annoScale === null) return null;
  const key = tableKey(space);
  const model = key === '*MODEL_SPACE';
  const paper = /^\*PAPER_SPACE/.test(key);
  if (!model && !paper && opt.annoScale === undefined) return null;
  let name = opt.annoScale;
  if (name === undefined) {
    const idx = new ScaleIndex(doc);
    name = model ? (currentScale(doc, idx.list)?.name ?? cannoscaleName(doc)) : (unitScale(idx.list)?.name ?? '1:1');
  }
  const vis = opt.annoAllVisible ?? allVisible(doc, model ? '*MODEL_SPACE' : key);
  return new AnnoDisplay(doc, name.toUpperCase(), vis);
}

/** 뷰포트에 저장된 주석 축척(ASDK_XREC_ANNOTATION_SCALE_INFO의 340). 없거나 읽을 수 없으면 null */
export function storedViewportScale(doc: CadDocument, vp: ViewportEntity): AnnoScale | null {
  const d = dictOf(doc, vp.xdict);
  const h = entryOf(d, 'ASDK_XREC_ANNOTATION_SCALE_INFO');
  const x = h ? doc.objects.get(h) : undefined;
  if (!x || x.type !== 'XRECORD') return null;
  const t = (x as XRecordObject).data.find((r) => r.code === 340);
  return t ? scaleFromObject(doc.objects.get(upper(String(t.value)))) : null;
}

/** 뷰포트의 주석 축척: 저장된 것, 없으면 뷰포트 축척과 같은 리스트의 축척, 없으면 CANNOSCALE */
export function viewportAnnoScale(doc: CadDocument, vp: ViewportEntity, list?: readonly AnnoScale[]): AnnoScale | undefined {
  const stored = storedViewportScale(doc, vp);
  if (stored) return stored;
  const l = list ?? new ScaleIndex(doc).list;
  const k = vp.viewHeight > 0 ? vp.height / vp.viewHeight : 0;
  if (k > 0 && Number.isFinite(k)) {
    const m = l.find((s) => sameRatio(s, { paper: k, drawing: 1 }));
    if (m) return m;
  }
  return currentScale(doc, l);
}

/** 뷰포트 축척(종이 ÷ 모형)이 이 주석 축척과 같은지 */
export function viewportSynced(vp: ViewportEntity, s: AnnoScale): boolean {
  const k = vp.viewHeight > 0 ? vp.height / vp.viewHeight : 0;
  return k > 0 && Math.abs(k * s.drawing - s.paper) <= 1e-6 * Math.max(k * s.drawing, s.paper);
}
