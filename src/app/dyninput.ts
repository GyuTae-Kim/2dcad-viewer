/**
 * 동적 입력(F12): 커서 옆 입력 칸 두 개와 상대 좌표 기본.
 * - 포인터 입력: 첫 점(기준점이 없을 때)은 X·Y 칸(절대 좌표), 두 번째 점부터(기준점이 있을 때)는 거리·각도 칸(기준점에서 상대 극좌표).
 * - 입력한 글은 명령행 입력란에 들어가고 지금 칸에 보인다. Tab은 지금 칸의 값을 잠그고 다음 칸으로 옮긴다(잠긴 칸에 자물쇠).
 *   잠긴 값은 커서가 움직여도 그대로이고, 고무줄·미리보기도 그 값에 묶인다(constrain). Enter는 두 칸을 합쳐 점을 만든다(resolve).
 * - 쉼표·<가 든 글은 칸 대신 좌표 입력이다. 두 번째 점부터는 @ 없이 상대 좌표로 읽는다(dynRelative): `10,5` = `@10,5`, `#10,5`는 절대.
 * 이 모듈은 화면과 앱을 모른다(app.ts가 상태를 들고 view.ts가 칸을 그린다).
 */
import { parseAngle, parseLength } from '../core/units';
import { type Ucs, dirToUcs, toUcs, toWcs } from './ucs';
import type { Pt } from './view';

/** 커서 옆에 그릴 칸 하나 */
export interface DynFieldView {
  text: string;
  locked: boolean;
  active: boolean;
}

/**
 * 동적 입력이 켜져 있고 기준점이 있으면(두 번째 점부터) 좌표 글을 상대 좌표로 바꾼다.
 * `10,5`·`10<45` → `@10,5`·`@10<45`. `#`(절대)·`@`(상대)·`*`(WCS 절대)로 시작하거나 좌표가 아닌 글은 그대로.
 */
export function dynRelative(text: string): string {
  const t = text.trim();
  if (!t || /^[#@*]/.test(t)) return text;
  if (/^[^,<]+(,[^,<]+){1,2}$/.test(t) || /^[^,<]+<[^,<]+$/.test(t)) return `@${t}`;
  return text;
}

/** 각도를 0~360°로 */
function deg(r: number): number {
  let d = (r * 180) / Math.PI;
  d = ((d % 360) + 360) % 360;
  return Math.abs(d - 360) < 1e-9 ? 0 : d;
}

export class DynInput {
  /** 잠긴 값(칸 번호 → 입력한 글). 극좌표면 [거리, 각도], 아니면 [X, Y] */
  locks: [string | null, string | null] = [null, null];
  /** 지금 칸(0·1) */
  focus = 0;
  /** 이 상태가 속한 점 요청(요청이 바뀌면 지운다) */
  private owner: object | null = null;

  /** 점 요청이 바뀌었으면 칸을 비운다 */
  sync(owner: object | null): void {
    if (owner === this.owner) return;
    this.owner = owner;
    this.locks = [null, null];
    this.focus = 0;
  }

  get locked(): boolean {
    return this.locks[0] !== null || this.locks[1] !== null;
  }

  /** 칸 값 읽기(거리·X·Y는 길이, 각도는 도면 각도 단위) */
  private value(i: number, text: string, polar: boolean, aunits: number): number | null {
    if (polar && i === 1) return parseAngle(text, aunits);
    return parseLength(text);
  }

  /**
   * Tab: 입력 중인 글이 지금 칸의 값이면 잠그고 다음 칸으로 옮긴다(글이 비었으면 칸만 옮긴다).
   * 좌표 글(쉼표·<)이거나 값으로 읽지 못하면 false(입력을 그대로 둔다).
   */
  tab(text: string, polar: boolean, aunits = 0): boolean {
    const t = text.trim();
    if (t) {
      if (/[,<]/.test(t) || this.value(this.focus, t, polar, aunits) === null) return false;
      this.locks[this.focus] = t;
    }
    this.focus = 1 - this.focus;
    return true;
  }

  /** 칸 값(입력 중인 글이 지금 칸 값이면 그것, 아니면 잠긴 값) */
  private parts(text: string, polar: boolean, aunits: number): [number | null, number | null] {
    const t = text.trim();
    const typed = t && !/[,<]/.test(t) ? this.value(this.focus, t, polar, aunits) : null;
    const v: [number | null, number | null] = [null, null];
    for (const i of [0, 1]) {
      if (i === this.focus && typed !== null) v[i] = typed;
      else if (this.locks[i] !== null) v[i] = this.value(i, this.locks[i]!, polar, aunits);
    }
    return v;
  }

  /** 잠긴 값으로 커서 점을 묶는다: 극좌표면 거리·각도, 아니면 UCS X·Y */
  constrain(base: Pt | null, p: Pt, u: Ucs, aunits = 0): Pt {
    if (!this.locked) return p;
    const [a, b] = this.parts('', !!base, aunits);
    if (base) {
      const d = dirToUcs(u, { x: p.x - base.x, y: p.y - base.y });
      const dist = a ?? Math.hypot(d.x, d.y);
      const ang = b ?? Math.atan2(d.y, d.x);
      const w = { x: Math.cos(ang + u.angle) * dist, y: Math.sin(ang + u.angle) * dist };
      return { x: base.x + w.x, y: base.y + w.y };
    }
    const q = toUcs(u, p);
    return toWcs(u, { x: a ?? q.x, y: b ?? q.y });
  }

  /**
   * Enter: 입력 중인 글(지금 칸 값)과 잠긴 값으로 점을 만든다.
   * 칸 입력이 아니면(잠긴 값이 없고 글이 숫자 하나뿐이거나 좌표 글이면) null — 직접 거리·좌표 해석에 맡긴다.
   * 극좌표에서 거리만 있으면 커서 방향(직접 거리), 각도만 있으면 커서까지 거리.
   */
  resolve(text: string, base: Pt | null, cursor: Pt | null, u: Ucs, aunits = 0): Pt | null {
    if (!this.locked) return null;
    const t = text.trim();
    if (t && /[,<]/.test(t)) return null;
    const [a, b] = this.parts(t, !!base, aunits);
    if (t && this.value(this.focus, t, !!base, aunits) === null) return null;
    if (base) {
      const d = cursor ? dirToUcs(u, { x: cursor.x - base.x, y: cursor.y - base.y }) : { x: 1, y: 0 };
      const dist = a ?? Math.hypot(d.x, d.y);
      const ang = b ?? Math.atan2(d.y, d.x);
      return { x: base.x + Math.cos(ang + u.angle) * dist, y: base.y + Math.sin(ang + u.angle) * dist };
    }
    const q = cursor ? toUcs(u, cursor) : { x: 0, y: 0 };
    return toWcs(u, { x: a ?? q.x, y: b ?? q.y });
  }

  /** 커서 옆 칸 두 개: 지금 칸에는 입력 중인 글(없으면 커서 값), 잠긴 칸에는 잠긴 값 */
  fields(base: Pt | null, p: Pt, text: string, u: Ucs, fmtLen: (v: number) => string): DynFieldView[] {
    const t = text.trim();
    // 좌표 글(10,5)을 치는 중이면 칸 하나에 글 그대로
    if (t && /[,<]/.test(t)) return [{ text: t, locked: false, active: true }];
    let cur: [string, string];
    if (base) {
      const d = dirToUcs(u, { x: p.x - base.x, y: p.y - base.y });
      const a = deg(Math.atan2(d.y, d.x));
      cur = [fmtLen(Math.hypot(d.x, d.y)), `${Math.abs(a - Math.round(a)) < 1e-6 ? Math.round(a) : a.toFixed(1)}°`];
    } else {
      const q = toUcs(u, p);
      cur = [fmtLen(q.x), fmtLen(q.y)];
    }
    return [0, 1].map((i) => {
      const active = i === this.focus;
      if (active && t) return { text: t, locked: false, active };
      const lk = this.locks[i];
      return { text: lk ?? cur[i]!, locked: lk !== null, active };
    });
  }
}
