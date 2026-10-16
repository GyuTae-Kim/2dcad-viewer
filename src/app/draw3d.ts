/**
 * 3D 객체 작성(평면도에서 그리는 것): 3DPOLY(3D 폴리선), 3DFACE(3D 면, 보이지 않는 모서리), TRACE(폭 있는 선, TRACEWID).
 * Z는 지금 고도(ELEVATION) — 점 입력은 평면 좌표만 받는다. 프롬프트는 AutoCAD 2026 한국어판을 따른다.
 */
import type { Entity, FaceEntity, PolylineEntity, Vec3 } from '../core/model';
import { formatLength } from '../core/units';
import type { App, CommandContext } from './app';
import { addEntities, currentElevation, currentProps } from './draw';
import type { Pt } from './view';

const P3 = (p: Pt, z: number): Vec3 => ({ x: p.x, y: p.y, z });

/** TRACE 구간들의 네 구석(이음은 두 변의 바깥 선이 만나는 자리로 맞춘다) */
export function tracePoints(pts: readonly Pt[], width: number): [Pt, Pt, Pt, Pt][] {
  const out: [Pt, Pt, Pt, Pt][] = [];
  const h = width / 2;
  const n = pts.length;
  if (n < 2) return out;
  const normal = (a: Pt, b: Pt) => {
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: -(b.y - a.y) / l, y: (b.x - a.x) / l };
  };
  /** 정점 i에서의 왼쪽·오른쪽 구석 */
  const corner = (i: number): [Pt, Pt] => {
    const p = pts[i]!;
    if (i === 0 || i === n - 1) {
      const nn = i === 0 ? normal(pts[0]!, pts[1]!) : normal(pts[n - 2]!, pts[n - 1]!);
      return [
        { x: p.x + nn.x * h, y: p.y + nn.y * h },
        { x: p.x - nn.x * h, y: p.y - nn.y * h },
      ];
    }
    const n1 = normal(pts[i - 1]!, p);
    const n2 = normal(p, pts[i + 1]!);
    const m = { x: n1.x + n2.x, y: n1.y + n2.y };
    const ml = Math.hypot(m.x, m.y);
    const cos = (n1.x * n2.x + n1.y * n2.y + 1) / 2;
    // 거의 되돌아가는 꺾임은 이음을 맞추지 않는다(끝없이 길어지지 않게)
    if (ml < 1e-9 || cos < 0.05) return [
      { x: p.x + n1.x * h, y: p.y + n1.y * h },
      { x: p.x - n1.x * h, y: p.y - n1.y * h },
    ];
    const k = h / Math.sqrt(cos);
    return [
      { x: p.x + (m.x / ml) * k, y: p.y + (m.y / ml) * k },
      { x: p.x - (m.x / ml) * k, y: p.y - (m.y / ml) * k },
    ];
  };
  for (let i = 0; i + 1 < n; i++) {
    const [l0, r0] = corner(i);
    const [l1, r1] = corner(i + 1);
    out.push([l0, r0, l1, r1]);
  }
  return out;
}

export function registerDraw3dCommands(app: App): void {
  const base = () => currentProps(app);

  // ------------------------------------------------------------- 3DPOLY
  app.register({
    name: '3DPOLY',
    title: '3D 폴리선',
    async run(ctx: CommandContext) {
      const z = currentElevation(app);
      const s = await ctx.getPoint('폴리선의 시작점 지정:');
      if (!('point' in s)) return;
      const pts: Pt[] = [s.point];
      let handle: string | null = null;
      let closed = false;
      const entity = (): Entity => {
        const { thickness: _t, ...props } = base();
        void _t;
        return {
          ...props,
          type: 'POLYLINE',
          handle: handle ?? '',
          kind: '3d',
          flags: 8 | (closed ? 1 : 0),
          vertices: pts.map((p) => ({ location: P3(p, z), bulge: 0, startWidth: 0, endWidth: 0, flags: 32 })),
          elevation: 0,
          defaultStartWidth: 0,
          defaultEndWidth: 0,
          mCount: 0,
          nCount: 0,
          mDensity: 0,
          nDensity: 0,
          smoothType: 0,
        } as PolylineEntity;
      };
      const commit = () => {
        const st = app.active!;
        if (!handle) {
          if (pts.length >= 2) handle = addEntities(app, ctx, [entity()], '3DPOLY')[0]!;
          return;
        }
        const before = st.doc.entityIndex.get(handle);
        if (before) st.session.commit({ label: '3DPOLY', ops: [{ kind: 'modify', block: st.space, before, after: { ...entity(), owner: before.owner } as Entity }], group: ctx.group });
      };
      for (;;) {
        const last = pts[pts.length - 1]!;
        const kws = [...(pts.length >= 3 ? [{ key: 'C', label: '닫기' }] : []), { key: 'U', label: '명령 취소' }];
        const r = await ctx.getPoint(pts.length >= 3 ? '선의 끝점 지정 또는 [닫기(C)/명령 취소(U)]:' : '선의 끝점 지정 또는 [명령 취소(U)]:', {
          base: last,
          keywords: kws,
          rubber: (q) => [{ pts: [...pts, q].flatMap((p) => [p.x, p.y]) }],
        });
        if ('enter' in r) return;
        if ('keyword' in r) {
          if (r.keyword === 'C') {
            closed = true;
            commit();
            return;
          }
          if (pts.length > 1) {
            pts.pop();
            if (pts.length >= 2) commit();
            else if (handle) {
              app.active!.session.undoLastStep(ctx.group, 1);
              handle = null;
            }
          }
          continue;
        }
        if (!('point' in r)) continue;
        if (Math.hypot(r.point.x - last.x, r.point.y - last.y) < 1e-12) continue;
        pts.push(r.point);
        commit();
        app.lastPoint = r.point;
      }
    },
  });

  // ------------------------------------------------------------- 3DFACE
  app.register({
    name: '3DFACE',
    aliases: ['3F'],
    title: '3D 면',
    async run(ctx: CommandContext) {
      const z = currentElevation(app);
      const { thickness: _t, ...props } = base();
      void _t;
      /** 점 하나(보이지 않음(I)을 먼저 입력하면 그 점에서 시작하는 모서리를 숨긴다) */
      const ask = async (prompt: string, from: Pt | null, allowEnd: boolean): Promise<{ p: Pt; hidden: boolean } | 'end' | null> => {
        let hidden = false;
        for (;;) {
          const r = await ctx.getPoint(prompt, { base: from, keywords: [{ key: 'I', label: '보이지 않음' }] });
          if ('keyword' in r) {
            hidden = true;
            continue;
          }
          if ('enter' in r) return allowEnd ? 'end' : null;
          if ('point' in r) return { p: r.point, hidden };
        }
      };
      const a = await ask('첫 번째 점 지정 또는 [보이지 않음(I)]:', null, false);
      if (!a || a === 'end') return;
      const b = await ask('두 번째 점 지정 또는 [보이지 않음(I)]:', a.p, false);
      if (!b || b === 'end') return;
      let p1 = a;
      let p2 = b;
      for (;;) {
        const c = await ask('세 번째 점 지정 또는 [보이지 않음(I)] <종료>:', p2.p, true);
        if (!c || c === 'end') return;
        const d = await ask('네 번째 점 지정 또는 [보이지 않음(I)] <세 개의 측면을 가진 면 작성>:', c.p, true);
        const p4 = d && d !== 'end' ? d : { p: c.p, hidden: c.hidden };
        // 모서리 비트: 1 = 1→2, 2 = 2→3, 4 = 3→4, 8 = 4→1(그 모서리를 시작하는 점에서 보이지 않음(I))
        let edges = (p1.hidden ? 1 : 0) | (p2.hidden ? 2 : 0) | (c.hidden ? 4 : 0) | (p4.hidden ? 8 : 0);
        if (p4 === c || !d || d === 'end') edges = (p1.hidden ? 1 : 0) | (p2.hidden ? 2 : 0) | (c.hidden ? 4 : 0);
        const face: FaceEntity = { ...props, type: '3DFACE', handle: '', points: [P3(p1.p, z), P3(p2.p, z), P3(c.p, z), P3(p4.p, z)], invisibleEdges: edges };
        addEntities(app, ctx, [face as Entity], '3DFACE');
        // 다음 면은 세 번째·네 번째 점에서 이어진다(AutoCAD와 같다)
        p1 = { p: c.p, hidden: false };
        p2 = { p: p4.p, hidden: false };
      }
    },
  });

  // ------------------------------------------------------------- TRACE
  app.register({
    name: 'TRACE',
    title: '트레이스',
    async run(ctx: CommandContext) {
      const st = app.active!;
      const z = currentElevation(app);
      const cur = Number(st.doc.header.get('$TRACEWID') ?? 0.05);
      const def = Number.isFinite(cur) && cur >= 0 ? cur : 0.05;
      ctx.print(`현재 트레이스 폭 = ${formatLength(def, st.units)}`);
      let w = def;
      for (;;) {
        const r = await ctx.getPoint(`트레이스 폭 지정 <${formatLength(def, st.units)}>:`, { preferNumber: true });
        if ('enter' in r) break;
        if ('text' in r && Number(r.text) >= 0) {
          w = Number(r.text);
          break;
        }
        if ('point' in r) {
          const q = await ctx.getPoint('두 번째 점 지정:', { base: r.point });
          if ('point' in q) {
            w = Math.hypot(q.point.x - r.point.x, q.point.y - r.point.y);
            break;
          }
        }
        ctx.print('0 이상의 값을 입력하십시오.', 'err');
      }
      if (w !== def) st.session.commit({ label: 'TRACE', ops: [{ kind: 'header', name: '$TRACEWID', before: st.doc.header.get('$TRACEWID'), after: w }], group: ctx.group });
      const s = await ctx.getPoint('시작점 지정:');
      if (!('point' in s)) return;
      const pts: Pt[] = [s.point];
      // 트레이스를 넣기 전 이 묶음의 작업 수(다시 만들 때 그 뒤만 거둔다)
      const ops0 = st.session.opsInGroup(ctx.group);
      const rebuild = () => {
        // 앞 구간의 끝 이음이 바뀌므로 지금까지의 트레이스를 다시 만든다(같은 명령 취소 묶음)
        const n = st.session.opsInGroup(ctx.group) - ops0;
        if (n > 0) st.session.undoLastStep(ctx.group, n);
        const quads = tracePoints(pts, w);
        const list = quads.map((q) => ({ ...currentProps(app), type: 'TRACE', handle: '', points: q.map((p) => P3(p, z)), invisibleEdges: 0 }) as Entity);
        if (list.length) addEntities(app, ctx, list, 'TRACE');
      };
      for (;;) {
        const last = pts[pts.length - 1]!;
        const r = await ctx.getPoint('다음 점 지정:', {
          base: last,
          rubber: (q) => tracePoints([...pts, q], w).map((c) => ({ pts: [c[0].x, c[0].y, c[1].x, c[1].y, c[3].x, c[3].y, c[2].x, c[2].y], closed: true })),
        });
        if (!('point' in r)) return;
        if (Math.hypot(r.point.x - last.x, r.point.y - last.y) < 1e-12) continue;
        pts.push(r.point);
        rebuild();
        app.lastPoint = r.point;
      }
    },
  });
}
