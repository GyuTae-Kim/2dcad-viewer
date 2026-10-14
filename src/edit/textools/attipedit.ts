/**
 * ATTIPEDIT(속성 바로 편집): 블록 참조에서 누른 자리의 속성 하나를 찾고 그 값만 바꾼다.
 * 보이는 속성(숨김 아님, 상수 아님) 중 글자 틀 안에 누른 점이 있는 것, 없으면 틀까지 가장 가까운 것(허용 거리 안).
 * 여러 줄 속성은 여러 줄 문자 값(줄바꿈 = \P)을 바꾼다.
 */
import type { AttribEntity, CadDocument, InsertEntity, Vec2 } from '../../core/model';
import { textCorners } from './textalign';

/** 속성 글자 틀(WCS 평면도 네 모서리) */
export function attributeCorners(a: AttribEntity, doc: CadDocument): Vec2[] {
  if (a.mtext) return textCorners({ ...a.mtext, layer: a.layer }, doc);
  return textCorners(a, doc);
}

function inside(poly: Vec2[], p: Vec2): boolean {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(c) < 1e-15) continue;
    const sg = Math.sign(c);
    if (s === 0) s = sg;
    else if (sg !== s) return false;
  }
  return true;
}

function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** 고칠 수 있는 속성(보이고 상수가 아닌 것) */
export function editableAttributes(ins: InsertEntity): AttribEntity[] {
  return ins.attribs.filter((a) => !(a.attFlags & 2) && !(a.attFlags & 1) && !a.invisible);
}

/** 누른 점의 속성. tol = 틀 밖에서 허용하는 거리(도면 단위) */
export function attributeAt(ins: InsertEntity, p: Vec2, doc: CadDocument, tol: number): AttribEntity | null {
  let best: AttribEntity | null = null;
  let bestD = Infinity;
  for (const a of editableAttributes(ins)) {
    const poly = attributeCorners(a, doc);
    if (poly.length < 3) continue;
    if (inside(poly, p)) return a;
    let d = Infinity;
    for (let i = 0; i < poly.length; i++) d = Math.min(d, segDist(p, poly[i]!, poly[(i + 1) % poly.length]!));
    if (d < bestD) {
      bestD = d;
      best = a;
    }
  }
  return bestD <= tol ? best : null;
}

/** 속성 값(여러 줄이면 줄바꿈 \n) */
export function attributeValue(a: AttribEntity): string {
  return a.mtext ? a.mtext.text.replace(/\\P/g, '\n') : a.text;
}

/** 속성 하나의 값을 바꾼 블록 참조(바뀌지 않으면 null) */
export function withAttributeValue(ins: InsertEntity, handle: string, value: string): InsertEntity | null {
  const i = ins.attribs.findIndex((a) => a.handle === handle);
  if (i < 0) return null;
  const a = ins.attribs[i]!;
  const next: AttribEntity = { ...a };
  if (a.mtext) {
    const t = value.replace(/\r?\n/g, '\\P');
    if (t === a.mtext.text) return null;
    next.mtext = { ...a.mtext, text: t };
    next.text = value.replace(/\r?\n/g, ' ');
  } else {
    const t = value.replace(/\r?\n/g, ' ');
    if (t === a.text) return null;
    next.text = t;
  }
  const attribs = [...ins.attribs];
  attribs[i] = next;
  return { ...ins, attribs };
}
