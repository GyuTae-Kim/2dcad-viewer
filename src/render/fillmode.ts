/**
 * 채우기 모드(FILLMODE·FILL)와 빠른 문자(QTEXTMODE·QTEXT)의 그리기 규칙(DOM 없음).
 * 장면 빌더가 화면·PDF·SVG·플롯 모두에 같은 규칙을 쓴다(모두 같은 표시 목록에서 나온다).
 *
 * - FILLMODE 0: 해치(솔리드·그라데이션·패턴)는 경계 윤곽만, 2D 솔리드·트레이스는 테두리, 폭 있는 폴리선·도넛은
 *   폭의 양쪽 가장자리와 세그먼트 끝 선, 채운 화살촉은 바깥 윤곽, 다중선 채우기는 그리지 않음, 윤곽 글꼴(트루타입)
 *   문자는 글자 윤곽선만.
 * - QTEXTMODE 1: 문자·여러 줄 문자·속성(치수 문자 포함)을 줄마다 테두리 사각형으로.
 */

/**
 * 삼각형 목록 [x0, y0, x1, y1, x2, y2, …]의 바깥 윤곽: 한 번만 쓰인 변(두 삼각형이 함께 쓰는 변은 안쪽).
 * 결과는 선분 [x0, y0, x1, y1, …].
 */
export function boundaryEdges(tris: ArrayLike<number>): number[] {
  const key = (x: number, y: number) => `${Math.round(x * 1e9)},${Math.round(y * 1e9)}`;
  const count = new Map<string, { n: number; seg: [number, number, number, number] }>();
  for (let i = 0; i + 5 < tris.length; i += 6) {
    const p = [tris[i]!, tris[i + 1]!, tris[i + 2]!, tris[i + 3]!, tris[i + 4]!, tris[i + 5]!];
    for (let k = 0; k < 3; k++) {
      const ax = p[k * 2]!;
      const ay = p[k * 2 + 1]!;
      const bx = p[((k + 1) % 3) * 2]!;
      const by = p[((k + 1) % 3) * 2 + 1]!;
      const ka = key(ax, ay);
      const kb = key(bx, by);
      if (ka === kb) continue;
      const k2 = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const c = count.get(k2);
      if (c) c.n++;
      else count.set(k2, { n: 1, seg: [ax, ay, bx, by] });
    }
  }
  const out: number[] = [];
  for (const c of count.values()) if (c.n === 1) out.push(...c.seg);
  return out;
}

/** 닫힌 고리 [x, y, …]의 끝에 되풀이된 첫 점을 뺀다(닫힌 꺾은선으로 그릴 때) */
export function openRing(pts: readonly number[]): number[] {
  const n = pts.length;
  if (n >= 6 && Math.abs(pts[0]! - pts[n - 2]!) < 1e-12 && Math.abs(pts[1]! - pts[n - 1]!) < 1e-12) return pts.slice(0, n - 2);
  return [...pts];
}

/** 닫힌 윤곽선들([x, y, …]) → 선분 [x0, y0, x1, y1, …] */
export function contourSegments(contours: readonly ArrayLike<number>[]): Float32Array {
  let n = 0;
  for (const c of contours) n += c.length >= 4 ? (c.length >> 1) * 4 : 0;
  const out = new Float32Array(n);
  let o = 0;
  for (const c of contours) {
    const m = c.length >> 1;
    if (m < 2) continue;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      out[o++] = c[i * 2]!;
      out[o++] = c[i * 2 + 1]!;
      out[o++] = c[j * 2]!;
      out[o++] = c[j * 2 + 1]!;
    }
  }
  return o === out.length ? out : out.slice(0, o);
}

export interface TextBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * QTEXT 줄 상자: 글자 상자(문자 배치 좌표)를 기준선이 가까운 것끼리 묶어 줄마다 하나의 상자로.
 * base는 글자의 기준선 높이, tol은 같은 줄로 볼 기준선 차이.
 */
export function textLineBoxes(glyphs: readonly (TextBox & { base: number })[], tol: number): TextBox[] {
  const sorted = [...glyphs].filter((g) => Number.isFinite(g.minX) && g.maxX >= g.minX && g.maxY >= g.minY).sort((a, b) => b.base - a.base);
  const out: (TextBox & { base: number })[] = [];
  for (const g of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.base - g.base) <= tol) {
      last.minX = Math.min(last.minX, g.minX);
      last.minY = Math.min(last.minY, g.minY);
      last.maxX = Math.max(last.maxX, g.maxX);
      last.maxY = Math.max(last.maxY, g.maxY);
    } else out.push({ ...g });
  }
  return out.map(({ minX, minY, maxX, maxY }) => ({ minX, minY, maxX, maxY }));
}

/** 폭 있는 띠의 윤곽(왼쪽·오른쪽 가장자리 꺾은선과 양 끝 선): 꺾은선 목록 */
export function stripOutline(left: readonly number[], right: readonly number[]): number[][] {
  const n = Math.min(left.length, right.length) >> 1;
  if (n < 2) return [];
  const L = left.slice(0, n * 2);
  const R = right.slice(0, n * 2);
  return [L, R, [L[0]!, L[1]!, R[0]!, R[1]!], [L[n * 2 - 2]!, L[n * 2 - 1]!, R[n * 2 - 2]!, R[n * 2 - 1]!]];
}
