/**
 * 표 그림 블록(*T)의 내용: 격자선(LINE), 셀 채우기(SOLID), 셀 문자(MTEXT).
 * 좌표는 표 좌표(삽입점 원점)다. 블록 기준점은 (0, 0)이고 객체는 도면층 0·ByBlock이라 표의 특성을 따른다.
 */
import type { CadColor, Entity, MTextEntity, Vec3 } from '../../core/model';
import { entityDefaults } from '../../core/model';
import type { TableStyle } from './style';
import { type TableData, cellIndex, cellRect, colOffset, mergeAt, rowOffset } from './model';

const BYBLOCK_LW = -2;

function base(color: CadColor): Omit<Entity, 'type'> {
  return { ...entityDefaults(), layer: '0', linetype: 'ByBlock', lineweight: BYBLOCK_LW, color } as Omit<Entity, 'type'>;
}

const P = (x: number, y: number): Vec3 => ({ x, y, z: 0 });

/** 행 경계 i(0 = 표 시작)의 Y */
function rowY(t: TableData, i: number, flow: 0 | 1): number {
  const d = rowOffset(t, i);
  return flow === 1 ? d : -d;
}

/** 두 행 사이 경계(r-1과 r 사이)가 열 c에서 병합 안에 있는지 */
function insideMergeH(t: TableData, r: number, c: number): boolean {
  const m = mergeAt(t, r, c);
  return !!m && m.row < r && m.row + m.rows > r;
}

function insideMergeV(t: TableData, r: number, c: number): boolean {
  const m = mergeAt(t, r, c);
  return !!m && m.col < c && m.col + m.cols > c;
}

export interface TableGeometryOptions {
  /** 셀 문자를 그리지 않는다(미리보기) */
  noText?: boolean;
}

export function tableBlockEntities(t: TableData, style: TableStyle, opt: TableGeometryOptions = {}): Entity[] {
  const flow = style.flow;
  const out: Entity[] = [];
  // 채우기(격자·문자 아래)
  for (let r = 0; r < t.rows; r++)
    for (let c = 0; c < t.cols; c++) {
      const m = mergeAt(t, r, c);
      if (m && (m.row !== r || m.col !== c)) continue;
      const fill = style.cells[t.rowKinds[r] ?? 'data'].fill;
      if (!fill) continue;
      const q = cellRect(t, r, c, flow);
      out.push({ ...base(fill), type: 'SOLID', points: [P(q.x0, q.y0), P(q.x1, q.y0), P(q.x0, q.y1), P(q.x1, q.y1)], invisibleEdges: 0 } as Entity);
    }
  // 가로선: 경계마다 병합 안을 지나지 않는 구간을 이어 그린다
  const borderOf = (r: number) => style.cells[t.rowKinds[Math.min(t.rows - 1, Math.max(0, r))] ?? 'data'].borderColor;
  for (let i = 0; i <= t.rows; i++) {
    const y = rowY(t, i, flow);
    let start = -1;
    for (let c = 0; c <= t.cols; c++) {
      const on = c < t.cols && (i === 0 || i === t.rows || !insideMergeH(t, i, c));
      if (on && start < 0) start = c;
      if (!on && start >= 0) {
        out.push({ ...base(borderOf(i === t.rows ? i - 1 : i)), type: 'LINE', start: P(colOffset(t, start), y), end: P(colOffset(t, c), y) } as Entity);
        start = -1;
      }
    }
  }
  // 세로선
  for (let j = 0; j <= t.cols; j++) {
    const x = colOffset(t, j);
    let start = -1;
    for (let r = 0; r <= t.rows; r++) {
      const on = r < t.rows && (j === 0 || j === t.cols || !insideMergeV(t, r, j));
      if (on && start < 0) start = r;
      if (!on && start >= 0) {
        out.push({ ...base(borderOf(start)), type: 'LINE', start: P(x, rowY(t, start, flow)), end: P(x, rowY(t, r, flow)) } as Entity);
        start = -1;
      }
    }
  }
  if (opt.noText) return out;
  // 문자
  for (let r = 0; r < t.rows; r++)
    for (let c = 0; c < t.cols; c++) {
      const m = mergeAt(t, r, c);
      if (m && (m.row !== r || m.col !== c)) continue;
      const cell = t.cells[cellIndex(t, r, c)]!;
      if (!cell.text) continue;
      const cs = style.cells[t.rowKinds[r] ?? 'data'];
      const align = cell.align ?? cs.align;
      const q = cellRect(t, r, c, flow);
      const col = (align - 1) % 3;
      const row = Math.floor((align - 1) / 3);
      const x = col === 0 ? q.x0 + style.hMargin : col === 1 ? (q.x0 + q.x1) / 2 : q.x1 - style.hMargin;
      const y = row === 0 ? q.y1 - style.vMargin : row === 1 ? (q.y0 + q.y1) / 2 : q.y0 + style.vMargin;
      const mt: MTextEntity = {
        ...(base(cs.color) as Omit<MTextEntity, 'type'>),
        type: 'MTEXT',
        handle: '',
        insert: P(x, y),
        height: cs.height,
        width: Math.max(0, q.x1 - q.x0 - 2 * style.hMargin),
        attachment: align,
        drawingDirection: 1,
        text: cell.text,
        style: cs.textStyle || 'Standard',
        rotation: 0,
        lineSpacingStyle: 1,
        lineSpacingFactor: 1,
        backgroundFlags: 0,
        backgroundScale: 1.5,
      } as MTextEntity;
      out.push(mt);
    }
  return out;
}

/** 미리보기용 격자 선분(표 좌표, [x0, y0, x1, y1] …) */
export function tableGridSegments(t: TableData, style: TableStyle): number[][] {
  return tableBlockEntities(t, style, { noText: true })
    .filter((e) => e.type === 'LINE')
    .map((e) => {
      const l = e as Extract<Entity, { type: 'LINE' }>;
      return [l.start.x, l.start.y, l.end.x, l.end.y];
    });
}
