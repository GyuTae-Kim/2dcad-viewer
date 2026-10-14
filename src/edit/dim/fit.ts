/**
 * 맞춤(DIMATFIT·DIMTIX·DIMSOXD): 치수보조선 사이에 문자와 화살촉을 넣을지 정한다.
 * available = 보조선 사이 길이, textSpace = 문자 폭 + 2·DIMGAP, arrowSpace = 화살촉 두 개 길이.
 */
import type { Out } from './builder';

export interface Fit {
  textInside: boolean;
  arrowsInside: boolean;
  /** DIMSOXD로 화살촉을 그리지 않음 */
  arrowsSuppressed: boolean;
}

export function decideFit(o: Out, available: number, textSpace: number, arrowSpace: number): Fit {
  const v = o.v;
  const eps = 1e-9 * Math.max(1, available);
  const both = available + eps >= textSpace + arrowSpace;
  const textFits = available + eps >= textSpace;
  const arrowsFit = available + eps >= arrowSpace;
  let textInside: boolean;
  let arrowsInside: boolean;
  if (v.tix) {
    textInside = true;
    arrowsInside = both;
  } else if (both) {
    textInside = true;
    arrowsInside = true;
  } else {
    switch (v.atfit) {
      case 0:
        textInside = false;
        arrowsInside = false;
        break;
      case 1:
        textInside = textFits;
        arrowsInside = false;
        break;
      case 2:
        textInside = false;
        arrowsInside = arrowsFit;
        break;
      default:
        if (textFits) {
          textInside = true;
          arrowsInside = false;
        } else {
          textInside = false;
          arrowsInside = arrowsFit;
        }
    }
  }
  const arrowsSuppressed = !arrowsInside && v.soxd && textInside && v.tix;
  return { textInside, arrowsInside, arrowsSuppressed };
}
