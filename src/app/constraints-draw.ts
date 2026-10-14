/**
 * 구속 표시 그리기: constraintGlyphs(월드 좌표 도형)를 오버레이 캔버스에 그린다.
 * CadView.renderOverlay에서 선택·그립 다음에 drawConstraintOverlay(app, g, W, dark)를 부르면 된다.
 */
import { type ConstraintGlyphs, constraintGlyphs } from '../edit/constraint/glyphs';
import { hasConstraints } from '../edit/constraint/store';
import type { App } from './app';
import type { Pt } from './view';

type W = (x: number, y: number) => Pt;

/** 도형을 캔버스에 그린다(W: 월드 → 화면 CSS 픽셀) */
export function paintConstraintGlyphs(g: CanvasRenderingContext2D, gl: ConstraintGlyphs, W: W, dark: boolean): void {
  g.save();
  // 구속 막대
  for (const b of gl.bars) {
    const a = W(b.x0, b.y1);
    const c = W(b.x1, b.y0);
    g.fillStyle = dark ? 'rgba(38,44,54,0.92)' : 'rgba(245,247,250,0.94)';
    g.strokeStyle = dark ? 'rgba(150,170,200,0.9)' : 'rgba(90,110,140,0.9)';
    g.lineWidth = 1;
    g.fillRect(a.x, a.y, c.x - a.x, c.y - a.y);
    g.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(c.x - a.x), Math.round(c.y - a.y));
  }
  const strokeSegs = (s: number[], color: string, width: number) => {
    if (!s.length) return;
    g.strokeStyle = color;
    g.lineWidth = width;
    g.beginPath();
    for (let i = 0; i + 3 < s.length; i += 4) {
      const p = W(s[i]!, s[i + 1]!);
      const q = W(s[i + 2]!, s[i + 3]!);
      g.moveTo(p.x, p.y);
      g.lineTo(q.x, q.y);
    }
    g.stroke();
  };
  strokeSegs(gl.icons, dark ? '#a9d4ff' : '#1d5fae', 1.3);
  // 일치 표식
  g.fillStyle = dark ? '#5aa9ff' : '#1d5fae';
  for (const c of gl.coincident) {
    const q = W(c.p.x, c.p.y);
    g.fillRect(Math.round(q.x) - 3, Math.round(q.y) - 3, 6, 6);
  }
  // 동적 치수 구속
  const dimColor = dark ? 'rgba(130,205,255,0.95)' : 'rgba(20,90,170,0.95)';
  strokeSegs(gl.dims, dimColor, 1);
  if (gl.arrows.length) {
    g.fillStyle = dimColor;
    g.beginPath();
    const t = gl.arrows;
    for (let i = 0; i + 5 < t.length; i += 6) {
      const p0 = W(t[i]!, t[i + 1]!);
      const p1 = W(t[i + 2]!, t[i + 3]!);
      const p2 = W(t[i + 4]!, t[i + 5]!);
      g.moveTo(p0.x, p0.y);
      g.lineTo(p1.x, p1.y);
      g.lineTo(p2.x, p2.y);
      g.closePath();
    }
    g.fill();
  }
  // 글과 자물쇠(글 폭을 재서 자물쇠를 글 앞에 놓는다)
  const lockColor = dark ? '#ffd166' : '#a86a00';
  for (const t of gl.texts) {
    const q = W(t.x, t.y);
    const size = Math.max(10, Math.min(16, Math.abs(W(t.x, t.y + t.size).y - q.y) * 1.05));
    g.font = `${size}px var(--font, sans-serif)`;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    const w = g.measureText(t.text).width;
    const lockW = t.lock ? size * 1.05 : 0;
    const total = lockW + w;
    const x0 = t.align === 'left' ? q.x : t.align === 'right' ? q.x - total : q.x - total / 2;
    g.fillStyle = dark ? 'rgba(33,40,48,0.85)' : 'rgba(255,255,255,0.88)';
    g.fillRect(x0 - 2, q.y - size / 2 - 1, total + 4, size + 2);
    if (t.lock) {
      const s = size * 0.8;
      const lx = x0 + 1;
      const ly = q.y + s * 0.45;
      g.strokeStyle = lockColor;
      g.lineWidth = 1.1;
      g.beginPath();
      g.rect(lx, ly - s * 0.5, s * 0.75, s * 0.5);
      g.moveTo(lx + s * 0.16, ly - s * 0.5);
      g.lineTo(lx + s * 0.16, ly - s * 0.68);
      g.arc(lx + s * 0.375, ly - s * 0.68, s * 0.215, Math.PI, 0);
      g.lineTo(lx + s * 0.59, ly - s * 0.5);
      g.stroke();
    }
    g.fillStyle = t.reference ? (dark ? '#c8c8c8' : '#555') : dimColor;
    g.fillText(t.text, x0 + lockW, q.y);
  }
  g.restore();
}

/**
 * 지금 도면·공간의 구속 표시를 그린다. 구속이 없으면 아무것도 하지 않는다.
 * MSPACE(배치의 뷰포트 안)에서는 그리지 않는다(모형 좌표 변환은 뷰포트마다 다르다).
 */
export function drawConstraintOverlay(app: App, g: CanvasRenderingContext2D, W: W, dark: boolean): void {
  const st = app.active;
  if (!st || st.msVp || !hasConstraints(st.doc)) return;
  const gl = constraintGlyphs(st.doc, st.space, app.view.pixelSize(), { units: st.units });
  paintConstraintGlyphs(g, gl, W, dark);
}
