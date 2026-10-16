/**
 * 올가미 선택(누른 채 끌기, AutoCAD의 LASSO 켜짐): 직사각형 대신 끈 자취를 따라 고른다.
 * - 처음 가로로 움직인 방향으로 정한다: 오른쪽 = 윈도우 올가미(완전히 안), 왼쪽 = 걸침 올가미(안이거나 걸침).
 * - 끄는 동안 스페이스바로 걸침 → 윈도우 → 울타리 순환(울타리는 자취와 만나는 객체).
 * - 거의 움직이지 않은 자취(세 점 미만)는 고르지 않는다. 클릭-클릭 창 선택은 그대로 직사각형이다.
 * 좌표는 화면 픽셀로 모으고, 고를 때 도면 좌표로 바꾼다(selectPolygon·selectFence는 Picker).
 */
import type { SelectMethodPicker } from './selmethod';
import type { Pt } from './view';

export type LassoMode = 'crossing' | 'window' | 'fence';

export const LASSO_LABEL: Record<LassoMode, string> = { crossing: '걸침 올가미', window: '윈도우 올가미', fence: '울타리 올가미' };

const NEXT: Record<LassoMode, LassoMode> = { crossing: 'window', window: 'fence', fence: 'crossing' };

export class Lasso {
  /** 자취(화면 좌표) */
  readonly pts: Pt[] = [];
  mode: LassoMode = 'window';
  /** 스페이스바로 바꿨으면 방향으로 다시 정하지 않는다 */
  private chosen = false;

  constructor(start: Pt) {
    this.pts.push({ ...start });
  }

  /** 자취에 점을 더한다(앞 점과 2픽셀 넘게 떨어졌을 때) */
  add(p: Pt): void {
    const last = this.pts[this.pts.length - 1]!;
    if (Math.hypot(p.x - last.x, p.y - last.y) < 2) return;
    this.pts.push({ ...p });
    if (!this.chosen) {
      const dx = p.x - this.pts[0]!.x;
      if (Math.abs(dx) >= 3) {
        this.mode = dx < 0 ? 'crossing' : 'window';
        this.chosen = true;
      }
    }
  }

  /** 스페이스바: 걸침 → 윈도우 → 울타리 → 걸침 */
  cycle(): LassoMode {
    this.mode = NEXT[this.mode];
    this.chosen = true;
    return this.mode;
  }

  get label(): string {
    return LASSO_LABEL[this.mode];
  }

  /** 고를 만큼 그렸는지 */
  get usable(): boolean {
    return this.mode === 'fence' ? this.pts.length >= 2 : this.pts.length >= 3;
  }

  /** 고른 핸들(화면 → 도면 변환을 받아). 쓸 수 없는 자취면 빈 배열 */
  select(pick: SelectMethodPicker, toWorld: (p: Pt) => Pt): string[] {
    if (!this.usable) return [];
    const w = simplify(this.pts, 1.5).map(toWorld);
    if (this.mode === 'fence') return pick.selectFence(w);
    return pick.selectPolygon(w, this.mode === 'crossing');
  }
}

/** 이웃 점과 거의 일직선인 점을 뺀다(자취가 길어도 다각형 판정이 가볍게) */
export function simplify(pts: readonly Pt[], tol: number): Pt[] {
  if (pts.length <= 3) return [...pts];
  const out: Pt[] = [pts[0]!];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1]!;
    const b = pts[i]!;
    const c = pts[i + 1]!;
    const l = Math.hypot(c.x - a.x, c.y - a.y);
    const d = l < 1e-9 ? Math.hypot(b.x - a.x, b.y - a.y) : Math.abs((c.x - a.x) * (a.y - b.y) - (a.x - b.x) * (c.y - a.y)) / l;
    if (d > tol) out.push(b);
  }
  out.push(pts[pts.length - 1]!);
  return out;
}
