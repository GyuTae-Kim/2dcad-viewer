/**
 * 개발 확인 페이지(dev/viewer3d.html) 스크립트. 배포 빌드에는 들어가지 않는다(vite 입력은 index.html뿐).
 * 주소 인자: ?segs=선분 수&sseg=구 경도 칸 수&theme=light
 * 자동 확인용으로 window.v3dDev(viewer, scene, bench)를 둔다.
 */
import { buildBvh } from './bvh';
import { VIEW_LABELS, type ViewName } from './camera';
import type { RenderMode } from './renderer';
import { syntheticScene } from './synth';
import type { Scene3d } from './types';
import { Viewer3d } from './viewer';

const q = new URLSearchParams(location.search);
const segs = Math.max(1, Number(q.get('segs') ?? 300_000) | 0);
const sseg = Math.max(4, Number(q.get('sseg') ?? 128) | 0);
let theme: 'dark' | 'light' = q.get('theme') === 'light' ? 'light' : 'dark';
document.body.dataset.theme = theme;

const bar = document.getElementById('bar')!;
const view = document.getElementById('view')!;
const status = document.getElementById('status')!;

const viewer = new Viewer3d(view, { theme });
let scene: Scene3d = syntheticScene({ segments: segs, sphereSeg: sseg });
viewer.setScene(scene);

let info = '';
let pickInfo = '';
const showStatus = (): void => {
  const s = viewer.stats;
  status.textContent = `선분 ${segs.toLocaleString()} · 그리기 ${s.drawCalls}회 · 삼각형 ${Math.round(s.triangles).toLocaleString()} · CPU ${s.frameMs.toFixed(1)} ms · ${s.width}×${s.height}@${s.dpr}  ${info}  ${pickInfo}`;
};
viewer.onCameraChange(() => showStatus());

const button = (label: string, fn: () => void, title?: string): HTMLButtonElement => {
  const b = document.createElement('button');
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener('click', fn);
  bar.append(b);
  return b;
};
const sep = (): void => {
  const s = document.createElement('span');
  s.className = 'sep';
  bar.append(s);
};

for (const v of ['top', 'front', 'right', 'back', 'left', 'bottom', 'seIso', 'swIso', 'neIso', 'nwIso'] as ViewName[]) button(VIEW_LABELS[v], () => viewer.setView(v));
button('전체', () => viewer.fit());
sep();
const projBtn = button('원근', () => {
  const p = viewer.getProjection() === 'perspective' ? 'orthographic' : 'perspective';
  viewer.setProjection(p);
  projBtn.textContent = p === 'perspective' ? '원근' : '평행';
});
const modes: [RenderMode, string][] = [
  ['shaded', '음영'],
  ['shadedEdges', '음영+윤곽'],
  ['wireframe', '와이어'],
  ['xray', 'X-ray'],
];
const modeBtns = modes.map(([m, l]) =>
  button(l, () => {
    viewer.setRenderMode(m);
    modeBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(modes[i]![0] === m)));
  }),
);
modeBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(modes[i]![0] === viewer.getRenderMode())));
sep();
const measureBtn = button('측정', () => {
  viewer.setMeasureMode(!viewer.measureMode);
  measureBtn.setAttribute('aria-pressed', String(viewer.measureMode));
});
button('테마', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  document.body.dataset.theme = theme;
  viewer.setTheme(theme);
});
let gridOn = true;
button('격자', () => viewer.setGridVisible((gridOn = !gridOn)));
button('PNG', () => {
  void viewer.toBlob('image/png').then((b) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = '3d-view.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
});
sep();
// 묶음 켜고 끄기
for (const g of viewer.groups()) {
  const l = document.createElement('label');
  const c = document.createElement('input');
  c.type = 'checkbox';
  c.checked = g.visible;
  c.addEventListener('change', () => viewer.setGroupVisible(g.name, c.checked));
  l.append(c, ` ${g.name}`);
  bar.append(l);
}
sep();
// 공구 경로 재생
const play = document.createElement('input');
play.type = 'range';
play.id = 'play';
play.min = '0';
play.max = String(segs);
play.value = String(segs);
play.title = '공구 경로 재생(앞에서 몇 선분까지)';
bar.append(play);
const setPlay = (n: number): void => {
  const line = scene.lines[0]!;
  if (n >= segs) {
    viewer.setLineDrawRange(line.id, null);
    viewer.setMarker(null);
    return;
  }
  viewer.setLineDrawRange(line.id, n, { ghost: 0.12 });
  const o = Math.max(0, n - 1) * 6 + 3;
  const P = line.positions;
  viewer.setMarker([P[o]!, P[o + 1]!, P[o + 2]!], 'ball');
};
play.addEventListener('input', () => setPlay(Number(play.value)));

viewer.onPick((p) => {
  viewer.highlight(p ? [p.id] : null);
  pickInfo = p ? `고름: ${p.kind} "${p.id}" #${p.index} (${p.point.map((v) => v.toFixed(2)).join(', ')})` : '';
  showStatus();
});
viewer.onMeasure((m) => {
  info = m ? `측정: ${m.distance.toFixed(3)} mm (ΔX ${m.dx.toFixed(3)} ΔY ${m.dy.toFixed(3)} ΔZ ${m.dz.toFixed(3)})` : '';
  showStatus();
});

/** 큰 자료 측정: 선분 segs개 + 구(sseg) 장면을 올리고 프레임·BVH·고르기 시간을 잰다 */
async function bench(o: { segs?: number; sseg?: number; frames?: number; width?: number } = {}): Promise<Record<string, number | string>> {
  const res: Record<string, number | string> = {};
  const nf = o.frames ?? 12;
  let t = performance.now();
  const sc = syntheticScene({ segments: o.segs ?? 3_000_000, sphereSeg: o.sseg ?? 1000 });
  res.genMs = performance.now() - t;
  if (o.width) sc.lines[0]!.width = o.width;
  res.segments = sc.lines[0]!.positions.length / 6;
  res.triangles = sc.meshes.reduce((a, m) => a + (m.indices ? m.indices.length / 3 : m.positions.length / 9), 0);
  const gl = viewer.canvas.getContext('webgl2')!;
  res.renderer = String(gl.getParameter(gl.RENDERER));
  const px = new Uint8Array(4);
  const sync = (): void => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  t = performance.now();
  viewer.setScene(sc);
  scene = sc;
  res.setSceneMs = performance.now() - t;
  t = performance.now();
  viewer.renderNow();
  sync();
  res.firstFrameMs = performance.now() - t;
  // 고르기(BVH가 아직 없으면 여기서 만든다)
  const w = viewer.canvas.clientWidth, h = viewer.canvas.clientHeight;
  t = performance.now();
  const p0 = viewer.pick(w * 0.45, h * 0.45);
  res.firstPickMs = performance.now() - t;
  res.firstPick = p0 ? `${p0.kind}:${p0.id}#${p0.index}` : '없음';
  t = performance.now();
  let hits = 0;
  for (let i = 0; i < 20; i++) if (viewer.pick(w * (0.3 + i * 0.02), h * (0.35 + i * 0.015))) hits++;
  res.pickMs = (performance.now() - t) / 20;
  res.pickHits = hits;
  // 가만히 있는 프레임(굵은 선 그대로)
  const times: number[] = [];
  for (let i = 0; i < nf; i++) {
    viewer.orbitBy(0.02, 0);
    t = performance.now();
    viewer.renderNow();
    sync();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  res.idleFrameMedianMs = times[times.length >> 1]!;
  // 끄는 프레임(포인터 사건으로 진짜 경로를 탄다)
  const r = viewer.canvas.getBoundingClientRect();
  const ev = (type: string, x: number, y: number, buttons: number): void => {
    viewer.canvas.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, button: 0, buttons, pointerId: 7, pointerType: 'mouse', bubbles: true }));
  };
  const drag: number[] = [];
  ev('pointerdown', w / 2, h / 2, 1);
  for (let i = 1; i <= nf; i++) {
    ev('pointermove', w / 2 + i * 6, h / 2 + i * 2, 1);
    t = performance.now();
    viewer.renderNow();
    sync();
    drag.push(performance.now() - t);
  }
  ev('pointerup', w / 2 + nf * 6, h / 2 + nf * 2, 0);
  drag.sort((a, b) => a - b);
  res.dragFrameMedianMs = drag[drag.length >> 1]!;
  res.dragCpuMs = viewer.stats.frameMs;
  // BVH 만들기 시간(따로)
  t = performance.now();
  buildBvh('segment', sc.lines[0]!.positions);
  res.bvhSegmentsMs = performance.now() - t;
  const sph = sc.meshes[1]!;
  t = performance.now();
  buildBvh('triangle', sph.positions, sph.indices);
  res.bvhTrianglesMs = performance.now() - t;
  viewer.renderNow();
  return res;
}

(window as unknown as { v3dDev: unknown }).v3dDev = {
  viewer,
  get scene() {
    return scene;
  },
  bench,
  setPlay,
  ready: true,
};
showStatus();
