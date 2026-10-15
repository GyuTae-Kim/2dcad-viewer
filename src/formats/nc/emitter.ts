/**
 * G-code·Heidenhain 해석기가 함께 쓰는 이동 쌓기: 위치·공구·이송 상태, 이동 더하기(시간·길이 통계),
 * 공구 목록, 범위 계산, NcProgram 만들기.
 */
import type { Box3 } from '../../viewer3d/types';
import {
  FLAG_COMP_LEFT,
  FLAG_COMP_RIGHT,
  FLAG_COOLANT,
  FLAG_INVERSE_TIME,
  FLAG_MACHINE,
  FLAG_PER_REV,
  FLAG_TOOL_LENGTH,
  MOVE_ARC,
  MOVE_RAPID,
  MoveBuilder,
  NcWarnings,
  arcExtend,
  arcLength,
  boxOf,
  emptyBox,
  extendBox,
  toolInfoFromComment,
  type NcDialect,
  type NcProgram,
  type NcTool,
} from './model';
import type { NcSource } from './text';

export class NcEmitter {
  protected src: NcSource;
  protected w = new NcWarnings();
  protected mb: MoveBuilder;

  /** 지금 위치(표시 좌표) */
  protected pos = new Float64Array(3);
  /** 알려진 축 비트(1 x, 2 y, 4 z) — 첫 이동 전 모르는 축은 끝점과 같게 둔다 */
  protected known = 0;
  protected tool = -1;
  protected feed = 0;
  protected speed = 0;
  protected spindleDir = 0;
  protected feedMode = 94;
  protected comp = 0;
  protected tlc = false;
  protected coolant = false;
  protected wcs = 0;
  protected displayInch = false;
  protected rapidFeed = 10000;
  protected tol = 0.002;

  protected tools = new Map<number, NcTool>();
  protected toolInfo = new Map<number, { diameter?: number; name?: string }>();
  protected lastComment: { text: string; line: number } | null = null;
  protected toolChanges = 0;
  protected rapidLen = 0;
  protected feedLen = 0;
  protected rapidTime = 0;
  protected feedTime = 0;
  protected dwellTime = 0;
  protected name = '';
  private warnedNoFeed = false;

  constructor(src: NcSource, start?: readonly number[]) {
    this.src = src;
    if (start) {
      this.pos[0] = start[0]!;
      this.pos[1] = start[1]!;
      this.pos[2] = start[2]!;
      this.known = 7;
    }
    this.mb = new MoveBuilder(this.pos, 1024);
  }

  protected flags(): number {
    let f = 0;
    if (this.comp === 1) f |= FLAG_COMP_LEFT;
    else if (this.comp === 2) f |= FLAG_COMP_RIGHT;
    if (this.tlc) f |= FLAG_TOOL_LENGTH;
    if (this.feedMode === 93) f |= FLAG_INVERSE_TIME;
    else if (this.feedMode === 95) f |= FLAG_PER_REV;
    if (this.coolant) f |= FLAG_COOLANT;
    return f;
  }

  protected toolAcc(): NcTool {
    let t = this.tools.get(this.tool);
    if (!t) {
      t = { number: this.tool, firstLine: -1, moveCount: 0, feedLength: 0, rapidLength: 0, time: 0 };
      this.tools.set(this.tool, t);
    }
    return t;
  }

  /** 이동 하나(직선·급속·드릴, 호면 arcIdx·arcLen). 길이 0이면 넣지 않는다 */
  protected emit(kind: number, x: number, y: number, z: number, line: number, extraFlags = 0, arcIdx = -1, arcLen = -1): boolean {
    const p = this.pos;
    if (this.known !== 7 && this.mb.count === 0) {
      if (!(this.known & 1)) p[0] = x;
      if (!(this.known & 2)) p[1] = y;
      if (!(this.known & 4)) p[2] = z;
      this.mb.setLast(p[0]!, p[1]!, p[2]!);
    }
    const len = arcLen >= 0 ? arcLen : Math.hypot(x - p[0]!, y - p[1]!, z - p[2]!);
    p[0] = x;
    p[1] = y;
    p[2] = z;
    if (len < 1e-12) return false;
    const wcs = extraFlags & FLAG_MACHINE ? 255 : this.wcs;
    const sp = this.spindleDir === 4 ? -this.speed : this.spindleDir === 3 ? this.speed : 0;
    const i = this.mb.push(kind, x, y, z, line, this.tool, this.feed, sp, this.flags() | extraFlags, wcs, arcIdx);
    let t = 0;
    const acc = this.toolAcc();
    if (acc.firstLine < 0) acc.firstLine = line;
    acc.moveCount++;
    if (kind === MOVE_RAPID) {
      t = (len / this.rapidFeed) * 60;
      this.rapidLen += len;
      this.rapidTime += t;
      acc.rapidLength += len;
    } else {
      const f = this.feed;
      if (this.feedMode === 93) t = f > 0 ? 60 / f : 0;
      else if (this.feedMode === 95) t = f > 0 && this.speed > 0 ? (len / (f * this.speed)) * 60 : 0;
      else t = f > 0 ? (len / f) * 60 : 0;
      if (!(f > 0) && !this.warnedNoFeed) {
        this.warnedNoFeed = true;
        this.w.add('이송 속도(F) 없이 절삭 이동 — 시간 계산에서 뺌', line);
      }
      this.feedLen += len;
      this.feedTime += t;
      acc.feedLength += len;
    }
    acc.time += t;
    this.mb.time[i] = t;
    return true;
  }

  /** 호 이동: 중심 c(xyz, 직선 축 값은 시작점), 부호 있는 중심각 */
  protected emitArc(plane: number, c: readonly number[], sweep: number, x: number, y: number, z: number, line: number, extraFlags = 0): void {
    const s = [this.pos[0]!, this.pos[1]!, this.pos[2]!];
    const e = [x, y, z];
    const idx = this.mb.pushArc(c[0]!, c[1]!, c[2]!, plane, sweep);
    const len = arcLength(s, e, c, plane, sweep);
    if (!this.emit(MOVE_ARC, x, y, z, line, extraFlags, idx, len)) this.mb.arcCount--;
  }

  protected dwell(sec: number): void {
    if (!(sec > 0)) return;
    this.dwellTime += sec;
    if (this.mb.count > 0) this.mb.time[this.mb.count - 1] = this.mb.time[this.mb.count - 1]! + sec;
    this.toolAcc().time += sec;
  }

  protected addToolInfo(n: number, text: string): void {
    const info = toolInfoFromComment(text, this.displayInch ? 'inch' : 'mm');
    this.setToolInfo(n, info);
  }

  protected setToolInfo(n: number, info: { diameter?: number; name?: string }): void {
    const cur = this.toolInfo.get(n) ?? {};
    if (cur.diameter === undefined && info.diameter !== undefined) cur.diameter = info.diameter;
    if (cur.name === undefined && info.name !== undefined) cur.name = info.name;
    this.toolInfo.set(n, cur);
  }

  protected changeTool(t: number, line: number): void {
    if (t === this.tool) return;
    this.tool = t;
    this.toolChanges++;
    const acc = this.toolAcc();
    if (acc.firstLine < 0) acc.firstLine = line;
    const lc = this.lastComment;
    if (!this.toolInfo.get(t)?.name && lc && line - lc.line <= 2 && line >= lc.line) this.addToolInfo(t, lc.text);
  }

  /** 모델로 마무리 */
  protected build(o: { name: string; format: NcProgram['format']; dialect: NcDialect; blocks: number; stock?: Box3 }): NcProgram {
    const { moves, arcs, holes } = this.mb.finish();
    const all = emptyBox();
    const cut = emptyBox();
    const pts = moves.points;
    const s = [0, 0, 0];
    const e = [0, 0, 0];
    const c = [0, 0, 0];
    for (let i = 0; i < moves.count; i++) {
      const k = i * 3;
      s[0] = pts[k]!;
      s[1] = pts[k + 1]!;
      s[2] = pts[k + 2]!;
      e[0] = pts[k + 3]!;
      e[1] = pts[k + 4]!;
      e[2] = pts[k + 5]!;
      const kind = moves.kind[i]!;
      if (kind === MOVE_ARC) {
        const ai = moves.arc[i]!;
        c[0] = arcs.center[ai * 3]!;
        c[1] = arcs.center[ai * 3 + 1]!;
        c[2] = arcs.center[ai * 3 + 2]!;
        arcExtend(s, e, c, arcs.plane[ai]!, arcs.sweep[ai]!, all);
        arcExtend(s, e, c, arcs.plane[ai]!, arcs.sweep[ai]!, cut);
      } else {
        extendBox(all, s[0], s[1], s[2]);
        extendBox(all, e[0], e[1], e[2]);
        if (kind !== MOVE_RAPID) {
          extendBox(cut, s[0], s[1], s[2]);
          extendBox(cut, e[0], e[1], e[2]);
        }
      }
    }
    const tools: NcTool[] = [];
    for (const t of this.tools.values()) {
      if (t.number < 0 && t.moveCount === 0) continue;
      const info = this.toolInfo.get(t.number);
      if (info?.diameter !== undefined) t.diameter = info.diameter;
      if (info?.name !== undefined) t.name = info.name;
      tools.push(t);
    }
    // 주석·공구 정의에만 있고 쓰이지 않은 공구도 목록에(이동 0)
    for (const [n, info] of this.toolInfo)
      if (!this.tools.has(n)) tools.push({ number: n, ...info, firstLine: -1, moveCount: 0, feedLength: 0, rapidLength: 0, time: 0 });
    tools.sort((a, b) => (a.firstLine < 0 ? 1e15 : a.firstLine) - (b.firstLine < 0 ? 1e15 : b.firstLine) || a.number - b.number);
    const prog: NcProgram = {
      name: o.name,
      format: o.format,
      dialect: o.dialect,
      units: this.displayInch ? 'inch' : 'mm',
      source: this.src,
      moves,
      arcs,
      holes,
      tools,
      stats: {
        moveCount: moves.count,
        rapidLength: this.rapidLen,
        feedLength: this.feedLen,
        arcCount: arcs.count,
        holeCount: holes.count,
        toolChanges: this.toolChanges,
        time: this.rapidTime + this.feedTime + this.dwellTime,
        rapidTime: this.rapidTime,
        feedTime: this.feedTime,
        dwellTime: this.dwellTime,
        blocks: o.blocks,
        rapidFeed: this.rapidFeed,
      },
      warnings: this.w.list(),
    };
    const b = boxOf(all);
    if (b) prog.bounds = b;
    const fb = boxOf(cut);
    if (fb) prog.feedBounds = fb;
    if (o.stock) prog.stock = o.stock;
    return prog;
  }
}
