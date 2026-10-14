/** 타일 뷰포트 배치 계산(화면 비율 좌표 0~1, 왼쪽 아래 원점). 화면과 떨어진 순수 함수 */

export type R = { x0: number; y0: number; x1: number; y1: number };

export type Split = 'SI' | '2H' | '2V' | '3H' | '3V' | '3A' | '3B' | '3L' | '3R' | '4';

/** 사각형 r을 나눈다(첫째가 새 활성). 3의 위·아래·왼쪽·오른쪽은 큰 칸이 그쪽 */
export function splitRect(r: R, k: Split): R[] {
  const { x0, y0, x1, y1 } = r;
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const tx = (a: number) => x0 + (x1 - x0) * a;
  const ty = (a: number) => y0 + (y1 - y0) * a;
  switch (k) {
    case 'SI':
      return [r];
    case '2V':
      return [
        { x0, y0, x1: mx, y1 },
        { x0: mx, y0, x1, y1 },
      ];
    case '2H':
      return [
        { x0, y0: my, x1, y1 },
        { x0, y0, x1, y1: my },
      ];
    case '3V':
      return [0, 1, 2].map((i) => ({ x0: tx(i / 3), y0, x1: tx((i + 1) / 3), y1 }));
    case '3H':
      return [2, 1, 0].map((i) => ({ x0, y0: ty(i / 3), x1, y1: ty((i + 1) / 3) }));
    case '3R':
      return [
        { x0: mx, y0, x1, y1 },
        { x0, y0: my, x1: mx, y1 },
        { x0, y0, x1: mx, y1: my },
      ];
    case '3L':
      return [
        { x0, y0, x1: mx, y1 },
        { x0: mx, y0: my, x1, y1 },
        { x0: mx, y0, x1, y1: my },
      ];
    case '3A':
      return [
        { x0, y0: my, x1, y1 },
        { x0, y0, x1: mx, y1: my },
        { x0: mx, y0, x1, y1: my },
      ];
    case '3B':
      return [
        { x0, y0, x1, y1: my },
        { x0, y0: my, x1: mx, y1 },
        { x0: mx, y0: my, x1, y1 },
      ];
    case '4':
      return [
        { x0, y0: my, x1: mx, y1 },
        { x0: mx, y0: my, x1, y1 },
        { x0, y0, x1: mx, y1: my },
        { x0: mx, y0, x1, y1: my },
      ];
  }
}


/** 두 사각형이 한 변을 온전히 맞대면 합친 사각형 */
export function joinRects(a: R, b: R): R | null {
  const eq = (p: number, q: number) => Math.abs(p - q) < 1e-6;
  if (eq(a.y0, b.y0) && eq(a.y1, b.y1) && (eq(a.x1, b.x0) || eq(b.x1, a.x0))) return { x0: Math.min(a.x0, b.x0), y0: a.y0, x1: Math.max(a.x1, b.x1), y1: a.y1 };
  if (eq(a.x0, b.x0) && eq(a.x1, b.x1) && (eq(a.y1, b.y0) || eq(b.y1, a.y0))) return { x0: a.x0, y0: Math.min(a.y0, b.y0), x1: a.x1, y1: Math.max(a.y1, b.y1) };
  return null;
}
