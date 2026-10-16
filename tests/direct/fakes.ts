/**
 * 직접 조작 시험용 가짜: tests/polish/fakes.ts의 명령행에 이번에 더한 메서드(clearInput 등)를 붙이고,
 * 진짜 Picker 대신 선·원·호·경량 폴리선의 형상으로 고르는 작은 Picker를 둔다(App.picker를 바꿔 끼운다).
 * 이 모듈은 app.ts를 가져오지 않는다(vi.mock으로 바꿔 끼우는 동안 순환을 만들지 않는다).
 */
import type { CadDocument, Entity } from '../../src/core/model';
import { MODEL_SPACE } from '../../src/core/model';
import { lwVertices } from '../../src/core/lwpoly';
import { fenceHits, polygonHits } from '../../src/edit/geom/selpoly';
import { FakeCommandLine } from '../polish/fakes';

type Pt = { x: number; y: number };
type Geom = { segs: number[]; tris?: number[] };

/** 명령행: 동적 입력·바로 가기 메뉴가 쓰는 메서드까지 */
export class DirectCommandLine extends FakeCommandLine {
  submitted: string[] = [];
  suggesting = false;
  intercept: ((ev: KeyboardEvent) => boolean) | null = null;
  onContext: ((ev: MouseEvent) => void) | null = null;
  clearInput(): void {
    this.input.value = '';
    this.onChange?.('');
  }
  insertText(t: string): void {
    this.input.value += t;
  }
  historyText(): string {
    return this.lines.map((l) => l.text).join('\n');
  }
  selectedText(): string {
    return '';
  }
  submitCurrent(): void {
    const v = this.input.value.trim();
    this.input.value = '';
    this.submitted.push(v);
    (this.host as { submit(t: string): void }).submit(v);
  }
  escape(): void {
    this.input.value = '';
    this.host.cancel();
  }
  /** 사람이 명령행에 치고 Enter(동적 입력의 상대 좌표 기본이 쓰인다) */
  type(t: string): void {
    this.input.value = t;
    this.onChange?.(t);
    this.submitCurrent();
  }
}

/** 객체 형상(도면 좌표 선분) */
export function geometryOf(e: Entity): Geom {
  const segs: number[] = [];
  const arc = (cx: number, cy: number, r: number, a0: number, sweep: number) => {
    const n = 64;
    for (let i = 0; i < n; i++) {
      const t0 = a0 + (sweep * i) / n;
      const t1 = a0 + (sweep * (i + 1)) / n;
      segs.push(cx + r * Math.cos(t0), cy + r * Math.sin(t0), cx + r * Math.cos(t1), cy + r * Math.sin(t1));
    }
  };
  switch (e.type) {
    case 'LINE':
      segs.push(e.start.x, e.start.y, e.end.x, e.end.y);
      break;
    case 'CIRCLE':
      arc(e.center.x, e.center.y, e.radius, 0, Math.PI * 2);
      break;
    case 'ARC': {
      let sw = e.endAngle - e.startAngle;
      while (sw <= 0) sw += Math.PI * 2;
      arc(e.center.x, e.center.y, e.radius, e.startAngle, sw);
      break;
    }
    case 'LWPOLYLINE': {
      const vs = lwVertices(e);
      const n = e.closed ? vs.length : vs.length - 1;
      for (let i = 0; i < n; i++) {
        const a = vs[i]!;
        const b = vs[(i + 1) % vs.length]!;
        segs.push(a.x, a.y, b.x, b.y);
      }
      break;
    }
    default:
      break;
  }
  return { segs };
}

function distSeg(px: number, py: number, s: number[], i: number): number {
  const x0 = s[i]!;
  const y0 = s[i + 1]!;
  const dx = s[i + 2]! - x0;
  const dy = s[i + 3]! - y0;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / l2)) : 0;
  return Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
}

/** App.picker 대신 쓰는 작은 Picker(모형 공간 객체 전부, 편집하면 다시 읽는다) */
export class FakePicker {
  constructor(private readonly doc: CadDocument) {}
  private get ents(): Entity[] {
    return this.doc.blocks.get(MODEL_SPACE)!.entities.filter((e) => this.doc.entityIndex.has(e.handle));
  }
  private boxOf(e: Entity) {
    const s = this.geometry(e.handle).segs;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i + 1 < s.length; i += 2) {
      minX = Math.min(minX, s[i]!);
      maxX = Math.max(maxX, s[i]!);
      minY = Math.min(minY, s[i + 1]!);
      maxY = Math.max(maxY, s[i + 1]!);
    }
    return { handle: e.handle, minX, minY, maxX, maxY };
  }
  get boxes() {
    return this.ents.map((e) => this.boxOf(e));
  }
  entity(h: string): Entity | undefined {
    return this.doc.entityIndex.get(h);
  }
  geometry(h: string): Geom {
    const e = this.doc.entityIndex.get(h);
    return e ? geometryOf(e) : { segs: [] };
  }
  geometryOf(list: Entity[]): Geom {
    return { segs: list.flatMap((e) => geometryOf(e).segs) };
  }
  distance(h: string, x: number, y: number): number {
    const s = this.geometry(h).segs;
    let d = Infinity;
    for (let i = 0; i + 3 < s.length; i += 4) d = Math.min(d, distSeg(x, y, s, i));
    return d;
  }
  candidates(x: number, y: number, tol: number) {
    return this.boxes.filter((b) => b.minX - tol <= x && b.maxX + tol >= x && b.minY - tol <= y && b.maxY + tol >= y);
  }
  pick(x: number, y: number, tol: number): string | null {
    let best: string | null = null;
    let bd = Infinity;
    for (const b of this.candidates(x, y, tol)) {
      const d = this.distance(b.handle, x, y);
      if (d <= tol && d < bd) {
        bd = d;
        best = b.handle;
      }
    }
    return best;
  }
  pickAll(x: number, y: number, tol: number): string[] {
    return this.candidates(x, y, tol)
      .filter((b) => this.distance(b.handle, x, y) <= tol)
      .map((b) => b.handle);
  }
  segmentsNear(x: number, y: number, tol: number): number[] {
    const out: number[] = [];
    for (const b of this.candidates(x, y, tol)) {
      const s = this.geometry(b.handle).segs;
      for (let i = 0; i + 3 < s.length; i += 4) if (distSeg(x, y, s, i) <= tol) out.push(s[i]!, s[i + 1]!, s[i + 2]!, s[i + 3]!);
    }
    return out;
  }
  overlapping(r: [number, number, number, number]): string[] {
    return this.boxes.filter((b) => !(b.maxX < r[0] || b.minX > r[2] || b.maxY < r[1] || b.minY > r[3])).map((b) => b.handle);
  }
  select(r: [number, number, number, number], crossing: boolean): string[] {
    return this.boxes
      .filter((b) => {
        if (b.maxX < r[0] || b.minX > r[2] || b.maxY < r[1] || b.minY > r[3]) return false;
        const inside = b.minX >= r[0] && b.maxX <= r[2] && b.minY >= r[1] && b.maxY <= r[3];
        return inside || crossing;
      })
      .map((b) => b.handle);
  }
  selectPolygon(poly: Pt[], crossing: boolean): string[] {
    return polygonHits(this.boxes, (h) => this.geometry(h), poly, crossing);
  }
  selectFence(pts: Pt[]): string[] {
    return fenceHits(this.boxes, (h) => this.geometry(h), pts);
  }
  invalidate(): void {}
}
