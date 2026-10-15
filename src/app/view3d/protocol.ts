/**
 * 3D 해석 워커(src/worker/view3d.worker.ts)와 화면 사이의 메시지 꼴과 직렬화 도움(순수 함수, DOM 없음).
 *
 * 파일 바이트는 화면 → 워커로 이전(transfer)하고, 결과 장면·NC 자료의 형식 배열은 워커 → 화면으로 이전한다
 * (복사 없이 넘긴다). 한 메시지 안에서 같은 버퍼를 여러 곳이 가리킬 수 있으므로(예: meta.moveLine = moves.line,
 * STEP의 같은 그물을 여러 번 놓기) 이전 목록은 버퍼마다 한 번만 넣는다.
 */
import type { Scene3d } from '../../viewer3d/types';
import { ncLineMoves, ncTimeline, type NcDialect, type NcProgram, type NcStats, type NcTool } from '../../formats/nc/model';
import type { NcSource } from '../../formats/nc/text';
import type { View3dFormat } from './formats';

export type { View3dFormat } from './formats';

/** NC 다시 해석할 때 고르는 것 */
export interface NcOpenOptions {
  /** G-code 방언(기본 'auto') */
  dialect?: NcDialect | 'auto';
  /** G20/G21이 없을 때의 단위(기본 mm) */
  units?: 'mm' | 'inch';
}

export interface View3dOpenRequest {
  id: number;
  type: 'open';
  /** 파일 이름(장면·프로그램 이름) */
  name: string;
  format: View3dFormat;
  /** 파일 바이트(이전된다) */
  bytes: ArrayBuffer;
  nc?: NcOpenOptions;
}

export type View3dRequest = View3dOpenRequest;

export type View3dResponse =
  | { id: number; type: 'progress'; fraction: number; stage: string }
  | { id: number; type: 'done'; result: View3dResult }
  | { id: number; type: 'error'; message: string };

/** 화면 패널이 쓰는 NC 자료(G-code·Heidenhain). 모델 전체가 아니라 패널에 필요한 것만 */
export interface NcPayload {
  kind: 'gcode' | 'heidenhain';
  dialect: NcDialect;
  units: 'mm' | 'inch';
  /** 원본 글(줄 글은 sourceLine(source, i)) */
  source: NcSource;
  moves: {
    count: number;
    kind: Uint8Array;
    /** 점 xyz(길이 3*(count+1)) — 이동 i는 점 i → 점 i+1 */
    points: Float64Array;
    line: Uint32Array;
    tool: Int32Array;
    feed: Float32Array;
  };
  /** 이동마다 끝난 시각(초, 누적) */
  timeline: Float64Array;
  /** 줄 → 이동(CSR) */
  lineMoves: { offsets: Uint32Array; moves: Uint32Array };
  tools: NcTool[];
  stats: NcStats;
}

/** MPR 패널 자료(가공·변수는 scene.meta에 있다) */
export interface MprPayload {
  /** 원본 줄 */
  lines: string[];
}

export interface View3dResult {
  format: View3dFormat;
  scene: Scene3d;
  nc?: NcPayload;
  mpr?: MprPayload;
  /** 해석 시간(ms) */
  ms: number;
}

/** NC 모델 → 패널 자료(워커에서 만든다) */
export function ncPayload(p: NcProgram): NcPayload {
  const m = p.moves;
  return {
    kind: p.format,
    dialect: p.dialect,
    units: p.units,
    source: p.source,
    moves: { count: m.count, kind: m.kind, points: m.points, line: m.line, tool: m.tool, feed: m.feed },
    timeline: ncTimeline(p),
    lineMoves: ncLineMoves(p),
    tools: p.tools,
    stats: p.stats,
  };
}

/**
 * 값 안의 모든 ArrayBuffer(형식 배열의 버퍼 포함)를 한 번씩 모은다 — postMessage 이전 목록.
 * 일반 객체·배열·Map·Set을 따라 들어가고, 같은 객체는 한 번만 본다. SharedArrayBuffer는 넣지 않는다.
 */
export function collectTransfers(value: unknown): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const seen = new Set<object>();
  const stack: unknown[] = [value];
  while (stack.length) {
    const v = stack.pop();
    if (v === null || typeof v !== 'object') continue;
    if (seen.has(v)) continue;
    seen.add(v);
    if (v instanceof ArrayBuffer) {
      if (v.byteLength > 0) out.add(v);
      continue;
    }
    if (ArrayBuffer.isView(v)) {
      const b = v.buffer;
      if (b instanceof ArrayBuffer && b.byteLength > 0) out.add(b);
      continue;
    }
    if (Array.isArray(v)) {
      for (const x of v) if (x !== null && typeof x === 'object') stack.push(x);
      continue;
    }
    if (v instanceof Map) {
      for (const [k, x] of v) {
        stack.push(k);
        stack.push(x);
      }
      continue;
    }
    if (v instanceof Set) {
      for (const x of v) stack.push(x);
      continue;
    }
    for (const x of Object.values(v)) if (x !== null && typeof x === 'object') stack.push(x);
  }
  return [...out];
}

/** 장면에 그릴 것이 있는지(그물·선분·점) */
export function sceneHasGeometry(s: Scene3d): boolean {
  return (
    s.meshes.some((m) => m.positions.length >= 9) ||
    s.lines.some((l) => l.positions.length >= 6) ||
    (s.points ?? []).some((p) => p.positions.length >= 3)
  );
}

/** 오류 값 → 사람이 읽는 글 */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}
