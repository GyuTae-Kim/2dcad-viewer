/** 1단계 명령: 보기·조회·도면층·파일 */
import { tableKey } from '../core/model';
import { formatAngle, formatLength, unitAbbr } from '../core/units';
import { ccwSweep } from '../geom/curves';
import type { App, CommandContext, PointResult } from './app';
import { CancelError } from './app';
import { type LayerPatch, patchLayers } from './layers';
import { entityLength, entityProperties, hatchArea, polyArea, ringArea, ringPerimeter, typeName } from './inquiry';
import type { Pt } from './view';
import { h } from './ui/dom';

function pointOf(r: PointResult): Pt | null {
  return 'point' in r ? r.point : null;
}

async function needPoint(ctx: CommandContext, prompt: string, base?: Pt | null): Promise<Pt> {
  for (;;) {
    const r = await ctx.getPoint(prompt, { base });
    if ('enter' in r) throw new CancelError();
    const p = pointOf(r);
    if (p) return p;
  }
}

const L = (app: App, v: number) => formatLength(v, app.active!.units);
const area = (app: App, v: number) => {
  const u = app.active!.units;
  return formatLength(v, { lunits: u.lunits === 3 || u.lunits === 4 ? 2 : u.lunits, luprec: u.luprec });
};
const unitSuffix = (app: App) => {
  const a = unitAbbr(app.active!.units.insunits);
  return a ? ` ${a}` : '';
};

export function registerCommands(app: App): void {
  // ------------------------------------------------------------- 화면
  app.register({
    name: 'ZOOM',
    aliases: ['Z'],
    title: '확대/축소',
    transparent: true,
    async run(ctx, arg) {
      const kws = [
        { key: 'A', label: '전체' },
        { key: 'E', label: '범위' },
        { key: 'P', label: '이전' },
        { key: 'W', label: '윈도우' },
        { key: 'O', label: '객체' },
        { key: 'S', label: '축척' },
      ];
      let r: PointResult = arg ? { keyword: arg.toUpperCase() } : await ctx.getPoint('윈도우 구석 지정, 축척 비율(nX 또는 nXP) 입력, 또는 [전체(A)/범위(E)/이전(P)/윈도우(W)/객체(O)/축척(S)] <실시간>:', { keywords: kws, allowText: true });
      if ('text' in r) {
        const m = /^([\d.]+)\s*(x|xp)?$/i.exec(r.text);
        if (m) {
          app.view.zoomCenter(parseFloat(m[1]!));
          return;
        }
        r = { keyword: r.text.toUpperCase() };
      }
      if ('enter' in r) {
        ctx.print('휠을 굴리거나 가운데 버튼으로 끌어 확대·이동하십시오.');
        return;
      }
      if ('point' in r) {
        const a = r.point;
        const b = await needPoint(ctx, '반대 구석 지정:', a);
        app.view.zoomRect(a.x, a.y, b.x, b.y);
        return;
      }
      const k = (r as { keyword: string }).keyword;
      if (k === 'A' || k === 'E') app.view.zoomExtents();
      else if (k === 'P') {
        if (!app.view.zoomPrevious()) ctx.print('이전 화면이 없습니다.');
      } else if (k === 'W') {
        const a = await needPoint(ctx, '첫 번째 구석 지정:');
        const b = await needPoint(ctx, '반대 구석 지정:', a);
        app.view.zoomRect(a.x, a.y, b.x, b.y);
      } else if (k === 'O') {
        const hs = await app.selectedOrPick(ctx);
        zoomToHandles(app, hs);
      } else if (k === 'S') {
        const t = await ctx.getPoint('축척 비율 입력(nX):', { allowText: true });
        if ('text' in t) {
          const f = parseFloat(t.text);
          if (f > 0) app.view.zoomCenter(f);
        }
      }
    },
  });
  app.register({ name: 'ZOOMEXTENTS', aliases: ['ZE'], title: '범위 줌', transparent: true, run: () => app.view.zoomExtents() });
  app.register({ name: 'ZOOMPREVIOUS', aliases: ['ZP'], title: '이전 화면', transparent: true, run: () => void app.view.zoomPrevious() });
  app.register({ name: 'ZOOMIN', title: '확대', transparent: true, run: () => app.view.zoomCenter(2) });
  app.register({ name: 'ZOOMOUT', title: '축소', transparent: true, run: () => app.view.zoomCenter(0.5) });
  app.register({
    name: 'PAN',
    aliases: ['P'],
    title: '초점이동',
    transparent: true,
    async run(ctx) {
      ctx.print('가운데 버튼으로 끌거나, 두 점을 찍어 이동합니다.');
      const a = await needPoint(ctx, '기준점 지정:');
      const b = await needPoint(ctx, '두 번째 점 지정:', a);
      const c = app.view.camera();
      app.view.zoomRect(c.cx - (b.x - a.x) - app.view.width / 2 / c.scale, c.cy - (b.y - a.y) - app.view.height / 2 / c.scale, c.cx - (b.x - a.x) + app.view.width / 2 / c.scale, c.cy - (b.y - a.y) + app.view.height / 2 / c.scale, true, 0);
    },
  });
  app.register({
    name: 'REGEN',
    aliases: ['RE', 'REGENALL', 'REA'],
    title: '재생성',
    run: () => {
      app.active?.touchLayers();
      app.view.requestRender();
    },
  });

  // ------------------------------------------------------------- 조회
  app.register({
    name: 'DIST',
    aliases: ['DI'],
    title: '거리',
    async run(ctx) {
      const a = await needPoint(ctx, '첫 번째 점 지정:');
      const b = await needPoint(ctx, '두 번째 점 지정:', a);
      reportDistance(app, ctx, a, b);
    },
  });
  app.register({
    name: 'MEASUREGEOM',
    aliases: ['MEA'],
    title: '측정',
    async run(ctx, arg) {
      const kws = [
        { key: 'D', label: '거리' },
        { key: 'R', label: '반지름' },
        { key: 'A', label: '각도' },
        { key: 'AR', label: '면적' },
        { key: 'X', label: '종료' },
      ];
      let mode = (arg ?? 'D').toUpperCase();
      for (;;) {
        if (mode === 'X') return;
        if (mode === 'D') {
          const r = await ctx.getPoint('첫 번째 점 지정 또는 [거리(D)/반지름(R)/각도(A)/면적(AR)/종료(X)] <거리>:', { keywords: kws });
          if ('keyword' in r) {
            mode = r.keyword;
            continue;
          }
          if ('enter' in r) return;
          const a = pointOf(r)!;
          const b = await needPoint(ctx, '두 번째 점 지정:', a);
          reportDistance(app, ctx, a, b);
          continue;
        }
        if (mode === 'R') {
          const r = await ctx.getEntity('호 또는 원 선택 [거리(D)/각도(A)/면적(AR)/종료(X)]:', kws);
          if ('keyword' in r) {
            mode = r.keyword;
            continue;
          }
          if ('enter' in r) return;
          const e = app.entity(r.handle);
          const rad = e?.type === 'CIRCLE' || e?.type === 'ARC' ? e.radius : null;
          if (rad === null) ctx.print('호나 원이 아닙니다.', 'err');
          else ctx.print(`반지름 = ${L(app, rad)}${unitSuffix(app)}\n지름 = ${L(app, rad * 2)}${unitSuffix(app)}`, 'res');
          continue;
        }
        if (mode === 'A') {
          await measureAngle(app, ctx);
          mode = 'D';
          continue;
        }
        if (mode === 'AR') {
          await measureArea(app, ctx);
          mode = 'D';
          continue;
        }
        mode = 'D';
      }
    },
  });
  app.register({
    name: 'AREA',
    aliases: ['AA'],
    title: '면적',
    run: (ctx) => measureArea(app, ctx),
  });
  app.register({
    name: 'MEASUREANGLE',
    aliases: ['ANG'],
    title: '각도 측정',
    run: (ctx) => measureAngle(app, ctx),
  });
  app.register({
    name: 'MEASURERADIUS',
    title: '반지름 측정',
    run: (ctx) => app.run('MEASUREGEOM', 'R').then(() => void ctx),
  });
  app.register({
    name: 'ID',
    title: '점 좌표',
    async run(ctx) {
      const p = await needPoint(ctx, '점 지정:');
      ctx.print(`X = ${L(app, p.x)}     Y = ${L(app, p.y)}     Z = ${L(app, 0)}`, 'res');
      app.view.overlay.marks = [{ p, text: `${L(app, p.x)}, ${L(app, p.y)}` }];
      app.view.requestOverlay();
    },
  });
  app.register({
    name: 'LIST',
    aliases: ['LI', 'LS'],
    title: '리스트',
    async run(ctx) {
      const hs = await app.selectedOrPick(ctx);
      const st = app.active!;
      let total = 0;
      let n = 0;
      for (const hd of hs.slice(0, 200)) {
        const e = app.entity(hd);
        if (!e) continue;
        ctx.print(`${typeName(e)}  도면층: "${e.layer}"  공간: ${st.isModel ? '모형 공간' : '도면 공간'}  핸들 = ${e.handle}`, 'res');
        for (const g of entityProperties(st.doc, e, st.units).slice(1))
          for (const row of g.rows) ctx.print(`    ${row.k}: ${row.v}`);
        const len = entityLength(e);
        if (len !== null) {
          total += len;
          n++;
        }
      }
      if (hs.length > 200) ctx.print(`… ${hs.length - 200}개는 생략`);
      if (n > 1) ctx.print(`길이 합계(${n}개) = ${L(app, total)}${unitSuffix(app)}`, 'res');
    },
  });
  app.register({
    name: 'PROPERTIES',
    aliases: ['PR', 'PROPS', 'CH', 'MO', 'DDMODIFY'],
    title: '특성',
    run: () => app.ui.openPalette('props'),
  });
  app.register({
    name: 'SELECTALL',
    aliases: ['AI_SELALL'],
    title: '모두 선택',
    run: () => {
      const st = app.active!;
      const scene = st.scenes.get(st.space);
      if (!scene) return;
      const visible = scene.entities.filter((b) => {
        const e = st.doc.entityIndex.get(b.handle);
        const l = e ? st.layers.get(tableKey(e.layer)) : undefined;
        return !l || (l.on && !l.frozen);
      });
      app.setSelection(visible.map((b) => b.handle));
      app.cmd.print(`${visible.length}개를 선택했습니다.`);
    },
  });
  app.register({
    name: 'FIND',
    title: '문자 찾기',
    run: () => app.ui.openPalette('find'),
  });
  app.register({
    name: 'DIMLIST',
    aliases: ['DIMLST'],
    title: '치수 목록',
    run: () => app.ui.openPalette('dims'),
  });
  // ------------------------------------------------------------- 도면층
  app.register({ name: 'LAYER', aliases: ['LA', 'DDLMODES'], title: '도면층 특성', run: () => app.ui.openPalette('layers') });
  app.register({
    name: 'LAYOFF',
    title: '도면층 끄기',
    async run(ctx) {
      for (;;) {
        const r = await ctx.getEntity('끌 도면층의 객체 선택:');
        if (!('handle' in r)) return;
        const e = app.entity(r.handle)!;
        setLayer(app, e.layer, { on: false });
        ctx.print(`도면층 "${e.layer}"을(를) 껐습니다.`);
      }
    },
  });
  app.register({
    name: 'LAYFRZ',
    title: '도면층 동결',
    async run(ctx) {
      for (;;) {
        const r = await ctx.getEntity('동결할 도면층의 객체 선택:');
        if (!('handle' in r)) return;
        const e = app.entity(r.handle)!;
        setLayer(app, e.layer, { frozen: true });
        ctx.print(`도면층 "${e.layer}"을(를) 동결했습니다.`);
      }
    },
  });
  app.register({
    name: 'LAYON',
    title: '모든 도면층 켜기',
    run: (ctx) => {
      patchLayers(app, 'LAYON', [...app.active!.doc.layers.values()].map((l) => [l.name, { off: false }]));
      ctx.print('모든 도면층을 켰습니다.');
    },
  });
  app.register({
    name: 'LAYTHW',
    title: '모든 도면층 동결 해제',
    run: (ctx) => {
      patchLayers(app, 'LAYTHW', [...app.active!.doc.layers.values()].map((l) => [l.name, { frozen: false }]));
      ctx.print('모든 도면층의 동결을 풀었습니다.');
    },
  });
  app.register({
    name: 'LAYISO',
    title: '도면층 격리',
    async run(ctx) {
      const hs = await app.selectedOrPick(ctx, '격리할 도면층의 객체 선택:');
      const keep = new Set(hs.map((x) => tableKey(app.entity(x)?.layer ?? '')));
      const st = app.active!;
      isoSaved.set(st.docId, new Map([...st.doc.layers].map(([k, l]) => [k, !l.off])));
      patchLayers(app, 'LAYISO', [...st.doc.layers].map(([k, l]) => [l.name, { off: !keep.has(k) }]));
      app.clearSelection();
      ctx.print(`도면층 ${keep.size}개만 남기고 껐습니다. LAYUNISO로 되돌립니다.`);
    },
  });
  app.register({
    name: 'LAYUNISO',
    title: '도면층 격리 해제',
    run: (ctx) => {
      const st = app.active!;
      const saved = isoSaved.get(st.docId);
      if (!saved) {
        ctx.print('격리한 도면층이 없습니다.');
        return;
      }
      patchLayers(app, 'LAYUNISO', [...saved].filter(([k]) => st.doc.layers.has(k)).map(([k, on]) => [st.doc.layers.get(k)!.name, { off: !on }]));
      isoSaved.delete(st.docId);
      ctx.print('도면층 격리를 풀었습니다.');
    },
  });

  // ------------------------------------------------------------- 표시
  app.register({
    name: 'LWDISPLAY',
    aliases: ['LWEIGHT', 'LW'],
    title: '선가중치 표시',
    transparent: true,
    noDoc: true,
    run: (ctx) => {
      app.view.lwDisplay = !app.view.lwDisplay;
      for (const d of app.docs) d.touchLayers();
      app.view.requestRender();
      app.ui.refreshStatus();
      ctx.print(`선가중치 표시 ${app.view.lwDisplay ? '켜기' : '끄기'}`);
    },
  });
  app.register({
    name: 'BACKGROUND',
    aliases: ['BG'],
    title: '배경색 전환',
    transparent: true,
    noDoc: true,
    run: () => {
      app.view.modelBg = app.view.modelBg === 0xffffff ? 0x212830 : 0xffffff;
      for (const d of app.docs) d.touchLayers();
      app.view.requestRender();
      app.ui.refreshStatus();
    },
  });
  app.register({ name: 'ORTHO', title: '직교 켜기/끄기', transparent: true, noDoc: true, run: () => app.toggleOrtho() });
  app.register({
    name: 'MODEL',
    aliases: ['TILEMODE'],
    title: '모형 탭',
    run: () => app.setSpace('*Model_Space'),
  });
}

const isoSaved = new Map<number, Map<string, boolean>>();

export function changedLayers(app: App): void {
  app.active?.touchLayers();
  app.view.requestRender();
  app.ui.refreshPalette();
}

export function setLayer(app: App, name: string, change: { on?: boolean; frozen?: boolean; locked?: boolean }): void {
  const patch: LayerPatch = {};
  if (change.on !== undefined) patch.off = !change.on;
  if (change.frozen !== undefined) patch.frozen = change.frozen;
  if (change.locked !== undefined) patch.locked = change.locked;
  patchLayers(app, 'LAYER', [[name, patch]]);
}

export function zoomToHandles(app: App, hs: string[]): void {
  const pk = app.picker();
  if (!pk || !hs.length) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const hd of hs) {
    const b = pk.box(hd);
    if (!b) continue;
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  if (!(minX <= maxX)) return;
  const pad = Math.max(maxX - minX, maxY - minY, 1e-6) * 0.15;
  app.view.zoomRect(minX - pad, minY - pad, maxX + pad, maxY + pad);
}

function reportDistance(app: App, ctx: CommandContext, a: Pt, b: Pt): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  let ang = Math.atan2(dy, dx);
  if (ang < 0) ang += Math.PI * 2;
  const u = app.active!.units;
  ctx.print(`거리 = ${L(app, d)}${unitSuffix(app)},  XY 평면에서의 각도 = ${formatAngle(ang, u)},  XY 평면으로부터의 각도 = 0`, 'res');
  ctx.print(`X 증분 = ${L(app, dx)},  Y 증분 = ${L(app, dy)},  Z 증분 = ${L(app, 0)}`, 'res');
  app.view.overlay.marks = [
    { p: a },
    { p: b, text: `${L(app, d)}${unitSuffix(app)}` },
  ];
  app.view.overlay.rubber = [{ pts: [a.x, a.y, b.x, b.y] }];
  persistMarks(app);
}

/** 명령이 끝나도 결과 표시를 잠시 남긴다 */
function persistMarks(app: App): void {
  const o = app.view.overlay;
  const marks = o.marks;
  const rub = o.rubber;
  setTimeout(() => {
    if (!app.busyCommand) {
      o.marks = marks;
      o.rubber = rub;
      app.view.requestOverlay();
      setTimeout(() => {
        if (o.marks === marks && !app.busyCommand) {
          o.marks = [];
          o.rubber = [];
          app.view.requestOverlay();
        }
      }, 6000);
    }
  });
}

async function measureAngle(app: App, ctx: CommandContext): Promise<void> {
  const r = await ctx.getEntity('호, 원, 선을 선택하거나 <정점 지정>:');
  const u = app.active!.units;
  if ('handle' in r) {
    const e = app.entity(r.handle)!;
    if (e.type === 'ARC') {
      ctx.print(`각도 = ${formatAngle(ccwSweep(e.startAngle, e.endAngle), u)}`, 'res');
      return;
    }
    if (e.type === 'LINE') {
      const r2 = await ctx.getEntity('두 번째 선 선택:');
      if (!('handle' in r2)) return;
      const f = app.entity(r2.handle)!;
      if (f.type !== 'LINE') {
        ctx.print('선이 아닙니다.', 'err');
        return;
      }
      const a1 = Math.atan2(e.end.y - e.start.y, e.end.x - e.start.x);
      const a2 = Math.atan2(f.end.y - f.start.y, f.end.x - f.start.x);
      let d = Math.abs(a2 - a1) % Math.PI;
      if (d > Math.PI / 2) d = Math.PI - d;
      ctx.print(`각도 = ${formatAngle(d, u)}  (보각 ${formatAngle(Math.PI - d, u)})`, 'res');
      return;
    }
    if (e.type === 'CIRCLE') {
      const c = e.center;
      const p1 = r.point;
      const p2 = await needPoint(ctx, '각도의 두 번째 끝점 지정:', c);
      const a = Math.abs(Math.atan2(p2.y - c.y, p2.x - c.x) - Math.atan2(p1.y - c.y, p1.x - c.x));
      ctx.print(`각도 = ${formatAngle(a > Math.PI ? Math.PI * 2 - a : a, u)}`, 'res');
      return;
    }
    ctx.print('호, 원, 선을 선택하십시오.', 'err');
    return;
  }
  if ('keyword' in r) return;
  const v = await needPoint(ctx, '각도 정점 지정:');
  const p1 = await needPoint(ctx, '각도의 첫 번째 끝점 지정:', v);
  const p2 = await needPoint(ctx, '각도의 두 번째 끝점 지정:', v);
  let a = Math.abs(Math.atan2(p2.y - v.y, p2.x - v.x) - Math.atan2(p1.y - v.y, p1.x - v.x));
  if (a > Math.PI) a = Math.PI * 2 - a;
  ctx.print(`각도 = ${formatAngle(a, u)}`, 'res');
}

async function measureArea(app: App, ctx: CommandContext): Promise<void> {
  const r = await ctx.getPoint('첫 번째 구석점 지정 또는 [객체(O)] <객체(O)>:', { keywords: [{ key: 'O', label: '객체' }] });
  if ('keyword' in r || 'enter' in r) {
    const er = await ctx.getEntity('객체 선택:');
    if (!('handle' in er)) return;
    const e = app.entity(er.handle)!;
    let a: number | null = null;
    let per: number | null = null;
    if (e.type === 'CIRCLE') {
      a = Math.PI * e.radius * e.radius;
      per = Math.PI * 2 * e.radius;
    } else if (e.type === 'LWPOLYLINE') {
      a = Math.abs(polyArea(e.vertices));
      per = entityLength(e);
    } else if (e.type === 'POLYLINE' && e.kind === '2d') {
      const vs = e.vertices.filter((v) => !(v.flags & 16)).map((v) => ({ x: v.location.x, y: v.location.y, bulge: v.bulge }));
      a = Math.abs(polyArea(vs));
      per = entityLength(e);
    } else if (e.type === 'HATCH' || e.type === 'MPOLYGON') a = hatchArea(e);
    else if (e.type === 'ELLIPSE') {
      const ma = Math.hypot(e.majorAxis.x, e.majorAxis.y);
      a = Math.PI * ma * ma * e.ratio;
    } else if (e.type === 'SPLINE') per = entityLength(e);
    if (a === null && per === null) {
      ctx.print('면적을 잴 수 없는 객체입니다.', 'err');
      return;
    }
    ctx.print(`면적 = ${a !== null ? area(app, a) : '-'},  둘레 = ${per !== null ? L(app, per) : '-'}`, 'res');
    return;
  }
  const pts: number[] = [];
  let p: Pt | null = pointOf(r);
  while (p) {
    pts.push(p.x, p.y);
    const base = p;
    const r2 = await ctx.getPoint(pts.length >= 6 ? '다음 점 지정 <합계>:' : '다음 점 지정:', {
      base,
      rubber: (q) => [{ pts: [...pts, q.x, q.y], closed: true, fill: true }],
    });
    p = pointOf(r2);
  }
  if (pts.length < 6) {
    ctx.print('점이 3개 이상 필요합니다.', 'err');
    return;
  }
  const a = Math.abs(ringArea(pts));
  ctx.print(`면적 = ${area(app, a)},  둘레 = ${L(app, ringPerimeter(pts))}`, 'res');
  app.view.overlay.rubber = [{ pts, closed: true, fill: true }];
  app.view.overlay.marks = [{ p: { x: pts[0]!, y: pts[1]! }, text: `면적 ${area(app, a)}` }];
  persistMarks(app);
}

export { h };
