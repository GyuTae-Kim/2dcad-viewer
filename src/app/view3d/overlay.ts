/**
 * 선분 강조 덧그림: 뷰어는 묶음(LineSet) 단위로만 강조하므로, NC 이동 하나(줄 하나)를 강조할 때는
 * 뷰어 위에 겹친 2D 캔버스에 그 선분을 화면 좌표로 투영해 굵게 그린다(가려짐은 따지지 않는다 — 늘 보이게).
 * 카메라가 바뀔 때마다(Viewer3d.onCameraChange, 크기 변화 포함) 다시 그린다.
 */
import { computeFrame, projectToScreen, type CameraState } from '../../viewer3d/camera';

export class SegmentOverlay {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private segs: Float32Array | null = null;
  private color = '#ffb44c';
  private halo = 'rgba(0,0,0,0.55)';

  constructor(host: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'v3d-hl';
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
    host.append(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  setColors(color: string, halo: string): void {
    this.color = color;
    this.halo = halo;
  }

  /** 강조할 선분 쌍 xyz,xyz…(null이면 지움) */
  set(segs: Float32Array | null): void {
    this.segs = segs && segs.length >= 6 ? segs : null;
  }

  get empty(): boolean {
    return !this.segs;
  }

  draw(cam: CameraState | null): void {
    const c = this.canvas;
    const w = c.clientWidth, h = c.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    const s = this.segs;
    if (!s || !cam || w <= 0 || h <= 0) return;
    // x·y 투영은 앞뒤 자르기 면과 상관없으므로 대상점 둘레 구로 틀을 만든다
    const f = computeFrame(cam, w, h, { center: cam.target, radius: Math.max(cam.distance, 1e-9) });
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const path = new Path2D();
    let last: [number, number] | null = null;
    const n = Math.floor(s.length / 6);
    for (let i = 0; i < n; i++) {
      const o = i * 6;
      const a = projectToScreen(f, [s[o]!, s[o + 1]!, s[o + 2]!]);
      const b = projectToScreen(f, [s[o + 3]!, s[o + 4]!, s[o + 5]!]);
      if (!a || !b) continue;
      if (!last || Math.abs(last[0] - a[0]) > 0.01 || Math.abs(last[1] - a[1]) > 0.01) path.moveTo(a[0], a[1]);
      path.lineTo(b[0], b[1]);
      last = [b[0], b[1]];
    }
    g.strokeStyle = this.halo;
    g.lineWidth = 6;
    g.stroke(path);
    g.strokeStyle = this.color;
    g.lineWidth = 3;
    g.stroke(path);
    if (last) {
      g.fillStyle = this.color;
      g.beginPath();
      g.arc(last[0], last[1], 4, 0, Math.PI * 2);
      g.fill();
    }
  }

  dispose(): void {
    this.canvas.remove();
  }
}
