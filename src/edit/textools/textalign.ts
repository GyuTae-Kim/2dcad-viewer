/**
 * TEXTALIGN(문자 정렬): 문자(TEXT·ATTDEF·MTEXT)를 정렬 기준 문자(또는 두 점)가 정하는 선에 맞춰 줄 세운다.
 * 문자는 옮기기만 한다(회전·자리맞추기는 그대로).
 *
 * 맞추는 점: 정렬 기준 문자의 자리맞추기(왼쪽·가운데·오른쪽·위·중간·아래)와 같은 자리를 각 문자에서 잰다.
 * 선: 기준 점(정렬 기준 문자의 그 점 또는 첫 점)에서 두 번째 점 방향.
 * 간격 모드:
 * - 현재 수직(V): 각 문자의 지금 Y를 두고 수평으로 선까지 옮긴다(선이 수평에 가까우면 선에 수직으로 내린다).
 * - 현재 수평(H): 지금 X를 두고 수직으로 옮긴다(선이 수직에 가까우면 수직으로 내린다).
 * - 분산(D): 두 점 사이에 같은 간격으로(지금 선 방향 순서대로).
 * - 간격 설정(S): 기준에서 선 방향으로, 문자 범위 사이 간격을 그 값으로.
 */
import type { CadDocument, Entity, Vec2 } from '../../core/model';
import { type TextLike, isTextLike, scaleBasePoint, textFrame } from '../geom/textjust';
import { mtextDir, mtextLocalBox } from '../geom/xtext';

export type SpacingMode = 'D' | 'S' | 'V' | 'H';

export const SPACING_LABEL: Record<SpacingMode, string> = { D: '분산', S: '간격 설정', V: '현재 수직', H: '현재 수평' };

/** 문자·여러 줄 문자인지(정렬할 수 있는 객체) */
export function isAlignable(e: Entity): boolean {
  return e.type === 'TEXT' || e.type === 'ATTDEF' || e.type === 'MTEXT';
}

/** 자리맞추기 키(textjust의 TEXT_JUST·MTEXT_ATTACH 키) */
export function justKeyOf(e: Entity): string {
  if (e.type === 'MTEXT') return ['TL', 'TC', 'TR', 'ML', 'MC', 'MR', 'BL', 'BC', 'BR'][Math.min(8, Math.max(0, e.attachment - 1))]!;
  if (isTextLike(e)) {
    const ha = e.halign;
    const va = e.valign;
    if (ha === 3 || ha === 5) return 'L';
    if (ha === 4) return 'M';
    const col = ha === 1 ? 'C' : ha === 2 ? 'R' : 'L';
    if (va === 0) return col;
    return (va === 3 ? 'T' : va === 2 ? 'M' : 'B') + col;
  }
  return 'L';
}

/** 맞추는 점(WCS 평면도) */
export function anchorOf(e: Entity, key: string, doc: CadDocument): Vec2 | null {
  return scaleBasePoint(e, key, doc);
}

/** 문자 범위의 네 모서리(WCS 평면도) */
export function textCorners(e: Entity, doc: CadDocument): Vec2[] {
  if (isTextLike(e)) {
    const f = textFrame(e as TextLike, doc);
    const c = Math.cos(f.rot);
    const s = Math.sin(f.rot);
    const W = f.W * f.h * f.wf;
    const lo = -f.desc * f.h;
    const hi = f.h;
    return [
      [0, lo],
      [W, lo],
      [W, hi],
      [0, hi],
    ].map(([x, y]) => ({ x: f.o.x + c * x! - s * y!, y: f.o.y + s * x! + c * y! }));
  }
  if (e.type === 'MTEXT') {
    const b = mtextLocalBox(e, doc);
    const d = mtextDir(e);
    const a = Math.atan2(d.y, d.x);
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [
      [b.minX, b.minY],
      [b.maxX, b.minY],
      [b.maxX, b.maxY],
      [b.minX, b.maxY],
    ].map(([x, y]) => ({ x: e.insert.x + c * x! - s * y!, y: e.insert.y + s * x! + c * y! }));
  }
  return [];
}

export interface AlignPlan {
  handle: string;
  dx: number;
  dy: number;
}

export interface AlignRequest {
  /** 정렬할 문자(기준 문자는 넣지 않는다) */
  texts: Entity[];
  /** 기준 문자(없으면 점 두 개) */
  reference?: Entity | null;
  /** 맞추는 점의 자리맞추기 키 */
  key: string;
  /** 선의 시작(기준 문자의 맞추는 점 또는 첫 점)과 두 번째 점 */
  from: Vec2;
  to: Vec2;
  mode: SpacingMode;
  /** 간격 설정(S)의 간격 */
  spacing?: number;
}

/** 옮길 거리(바뀌지 않는 문자는 빼고). 선 방향을 정할 수 없으면 빈 배열 */
export function planTextAlign(req: AlignRequest, doc: CadDocument): AlignPlan[] {
  const dx = req.to.x - req.from.x;
  const dy = req.to.y - req.from.y;
  const L = Math.hypot(dx, dy);
  if (!(L > 1e-12)) return [];
  const d = { x: dx / L, y: dy / L };
  const items = req.texts
    .map((e) => ({ e, p: anchorOf(e, req.key, doc) }))
    .filter((x): x is { e: Entity; p: Vec2 } => !!x.p);
  const proj = (p: Vec2) => (p.x - req.from.x) * d.x + (p.y - req.from.y) * d.y;
  const out: AlignPlan[] = [];
  const push = (e: Entity, p: Vec2, q: Vec2) => {
    const mx = q.x - p.x;
    const my = q.y - p.y;
    if (Math.hypot(mx, my) > 1e-12) out.push({ handle: e.handle, dx: mx, dy: my });
  };
  const onLine = (t: number): Vec2 => ({ x: req.from.x + d.x * t, y: req.from.y + d.y * t });
  switch (req.mode) {
    case 'D': {
      const sorted = [...items].sort((a, b) => proj(a.p) - proj(b.p));
      const n = sorted.length;
      sorted.forEach((it, i) => push(it.e, it.p, onLine(n === 1 ? 0 : (L * i) / (n - 1))));
      break;
    }
    case 'S': {
      const gap = req.spacing ?? 0;
      const ext = (e: Entity, anchorT: number) => {
        const ts = textCorners(e, doc).map(proj);
        return ts.length ? { lo: Math.min(...ts) - anchorT, hi: Math.max(...ts) - anchorT } : { lo: 0, hi: 0 };
      };
      let prevHi = 0;
      if (req.reference) {
        const rp = anchorOf(req.reference, req.key, doc) ?? req.from;
        prevHi = ext(req.reference, proj(rp)).hi + proj(rp);
      }
      const sorted = [...items].sort((a, b) => proj(a.p) - proj(b.p));
      sorted.forEach((it, i) => {
        const x = ext(it.e, proj(it.p));
        // 기준 문자가 없으면 첫 문자는 첫 점에
        const t = !req.reference && i === 0 ? 0 : prevHi + gap - x.lo;
        push(it.e, it.p, onLine(t));
        prevHi = t + x.hi;
      });
      break;
    }
    case 'H':
    case 'V': {
      // V: Y를 두고 수평 이동, H: X를 두고 수직 이동. 선이 그 방향과 나란하면 선에 수직으로 내린다
      const keepY = req.mode === 'V';
      const comp = keepY ? d.y : d.x;
      for (const it of items) {
        let t: number;
        if (Math.abs(comp) < 1e-6) t = proj(it.p);
        else t = keepY ? (it.p.y - req.from.y) / d.y : (it.p.x - req.from.x) / d.x;
        push(it.e, it.p, onLine(t));
      }
      break;
    }
  }
  return out;
}
