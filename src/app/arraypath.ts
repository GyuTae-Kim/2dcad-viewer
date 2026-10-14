/**
 * 경로 배열 ARRAYPATH(비연관): `객체 선택:` → `경로 곡선 선택:` → `그립을 선택하여 배열을 편집하거나 [...] <종료>:`.
 * 옵션: 연관(AS — 예를 골라도 분해된 객체로 만든다고 안내), 방법(M 등분할·길이 분할), 기준점(B, 키 점 K), 접선 방향(T, 일반 N),
 * 항목(I — 사이 거리·개수·전체 경로 채우기), 행(R — 수·간격·전체), 레벨(L — Z 방향 간격), 항목 정렬(A), Z 방향(Z), 종료(X).
 * 경로: 선·폴리선(2D·3D)·호·원·타원·스플라인·나선. 열린 경로는 고른 점에 가까운 끝에서 시작한다.
 * 프롬프트는 AutoCAD 2026 한국어판을 따른다. 자리 계산은 src/edit/arraypath.
 */
import type { Entity } from '../core/model';
import { formatLength } from '../core/units';
import { copyEntity, transformEntity, type EditResult } from '../edit/geom';
import { entityPath } from '../edit/geom/path';
import { type Path, pathLength, pathStart } from '../edit/geom/curve';
import { calculate } from '../edit/util/calc';
import { MAX_ARRAY_ITEMS, type PathArraySpec, type PathMethod, defaultPathSpacing, isIdentity, maxPathItems, orientPath, pathArrayItems } from '../edit/arraypath';
import type { App, CommandContext, Keyword } from './app';
import { unlockedOnly } from './layers';
import { Ghost, commitResults } from './modify';
import type { OverlayGeom, Pt } from './view';

/** 이 모듈의 프롬프트에 쓰는 옵션 */
export const ARRAYPATH_KEYWORDS: Keyword[] = [
  { key: 'AS', label: '연관' },
  { key: 'M', label: '방법' },
  { key: 'B', label: '기준점' },
  { key: 'T', label: '접선 방향' },
  { key: 'I', label: '항목' },
  { key: 'R', label: '행' },
  { key: 'L', label: '레벨' },
  { key: 'A', label: '항목 정렬' },
  { key: 'Z', label: 'Z 방향' },
  { key: 'X', label: '종료' },
];

const KW_E: Keyword = { key: 'E', label: '표현식' };

/** 숫자·표현식 입력. Enter는 def, 점은 base(없으면 두 번째 점)까지 거리. 다른 키워드는 그대로 돌려준다 */
async function askValue(
  ctx: CommandContext,
  prompt: string,
  def: number,
  opt: { keywords?: Keyword[]; base?: Pt | null; check?: (v: number) => string | null; integer?: boolean } = {},
): Promise<number | { keyword: string }> {
  const keywords = [...(opt.keywords ?? []), KW_E];
  for (;;) {
    const r = await ctx.getPoint(prompt, { preferNumber: true, keywords, base: opt.base ?? null });
    let v: number | null = null;
    if ('enter' in r) v = def;
    else if ('keyword' in r && r.keyword !== 'E') return { keyword: r.keyword };
    else if ('keyword' in r) {
      const e = await ctx.getPoint('표현식 입력:', { allowText: true });
      if (!('text' in e)) continue;
      v = evalNumber(ctx, e.text);
    } else if ('text' in r) v = evalNumber(ctx, r.text);
    else if ('point' in r) {
      let from = opt.base ?? null;
      if (!from) {
        const r2 = await ctx.getPoint('두 번째 점 지정:', { base: r.point });
        if (!('point' in r2)) continue;
        from = r2.point;
      }
      v = Math.hypot(r.point.x - from.x, r.point.y - from.y);
    }
    if (v === null) continue;
    if (opt.integer) v = Math.round(v);
    const bad = opt.check?.(v) ?? null;
    if (bad) {
      ctx.print(bad, 'err');
      continue;
    }
    return v;
  }
}

/** 숫자 또는 CAL 식 */
function evalNumber(ctx: CommandContext, text: string): number | null {
  const t = text.trim();
  const n = Number(t);
  if (t && Number.isFinite(n)) return n;
  try {
    const v = calculate(t);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    ctx.print('식의 결과가 숫자가 아닙니다.', 'err');
  } catch (e) {
    ctx.print(`잘못된 식입니다: ${e instanceof Error ? e.message : String(e)}`, 'err');
  }
  return null;
}

async function yesNo(ctx: CommandContext, prompt: string, def: boolean): Promise<boolean> {
  const r = await ctx.getPoint(`${prompt} [예(Y)/아니오(N)] <${def ? '예' : '아니오'}>:`, {
    keywords: [
      { key: 'Y', label: '예' },
      { key: 'N', label: '아니오' },
    ],
  });
  if ('keyword' in r) return r.keyword === 'Y';
  return def;
}

/** 경로 곡선 객체(선·폴리선·호·원·타원·스플라인·나선)의 평면 경로 */
export function arrayPathOf(e: Entity | undefined): Path | null {
  if (!e) return null;
  if (!['LINE', 'LWPOLYLINE', 'POLYLINE', 'ARC', 'CIRCLE', 'ELLIPSE', 'SPLINE'].includes(e.type)) return null;
  if (e.type === 'POLYLINE' && e.kind !== '2d' && e.kind !== '3d') return null;
  const p = entityPath(e);
  if (!p || !p.pieces.length || !(pathLength(p) > 0)) return null;
  return p;
}

export function registerArrayPathCommand(app: App): void {
  app.register({
    name: 'ARRAYPATH',
    title: '경로 배열',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const hs = unlockedOnly(app, await ctx.getSelection()).filter((h) => doc.entityIndex.has(h));
      if (!hs.length) return;
      ctx.print('유형 = 경로  연관 = 아니오');
      let path: Path | null = null;
      while (!path) {
        const r = await ctx.getEntity('경로 곡선 선택:');
        if (!('handle' in r)) return;
        const e = doc.entityIndex.get(r.handle);
        const p = arrayPathOf(e);
        if (!p) {
          ctx.print('선택한 객체는 경로로 사용할 수 없습니다. 선, 폴리선, 호, 원, 타원, 스플라인, 나선을 선택하십시오.', 'err');
          continue;
        }
        path = orientPath(p, r.point);
      }
      app.clearSelection();
      const P0 = path;
      const L = pathLength(P0);
      const pk = app.picker();
      let ext: [number, number, number, number] | null = null;
      for (const h of hs) {
        const b = pk?.box(h);
        if (!b) continue;
        ext = ext ? [Math.min(ext[0], b.minX), Math.min(ext[1], b.minY), Math.max(ext[2], b.maxX), Math.max(ext[3], b.maxY)] : [b.minX, b.minY, b.maxX, b.maxY];
      }
      const w = ext ? ext[2] - ext[0] : 0;
      const hgt = ext ? ext[3] - ext[1] : 0;
      let spacing = defaultPathSpacing(w, hgt, L);
      const spec: PathArraySpec = {
        method: 'measure',
        count: maxPathItems(L, P0.closed, spacing),
        spacing,
        rows: 1,
        rowSpacing: +(1.5 * Math.max(w, hgt, 1e-6)).toPrecision(6),
        align: true,
        base: pathStart(P0),
      };
      let levels = 1;
      let levelSpacing = +(1.5 * Math.max(w, hgt, 1e-6)).toPrecision(6);
      let zDir = true;
      const fmt = (v: number) => formatLength(v, st.units);
      const ghost = new Ghost(app, hs);
      const preview = (): OverlayGeom[] => {
        const out: OverlayGeom[] = [];
        const items = pathArrayItems(P0, spec);
        let n = 0;
        for (const it of items) {
          if (isIdentity(it.matrix)) continue;
          if (++n > 600) break;
          out.push(...ghost.at(it.matrix));
        }
        return out;
      };
      for (;;) {
        const g = preview();
        app.view.overlay.ghost = g;
        app.view.requestOverlay();
        const r = await ctx.getPoint('그립을 선택하여 배열을 편집하거나 [연관(AS)/방법(M)/기준점(B)/접선 방향(T)/항목(I)/행(R)/레벨(L)/항목 정렬(A)/Z 방향(Z)/종료(X)] <종료>:', {
          keywords: ARRAYPATH_KEYWORDS,
          ghost: () => g,
        });
        if ('enter' in r || ('keyword' in r && r.keyword === 'X')) break;
        // 경로 배열은 그립이 없다(점은 무시)
        if (!('keyword' in r)) continue;
        const k = r.keyword;
        if (k === 'AS') {
          const yes = await yesNo(ctx, '연관 배열 작성', false);
          if (yes) ctx.print('이 웹 버전은 연관 배열을 만들지 않습니다. 배열 항목은 분해된(따로 떨어진) 객체로 만듭니다.');
        } else if (k === 'M') {
          const m = await ctx.getPoint(`경로 방법 입력 [등분할(D)/길이 분할(M)] <${spec.method === 'divide' ? '등분할' : '길이 분할'}>:`, {
            keywords: [
              { key: 'D', label: '등분할' },
              { key: 'M', label: '길이 분할' },
            ],
          });
          if ('keyword' in m) {
            const next: PathMethod = m.keyword === 'D' ? 'divide' : 'measure';
            if (next === 'measure' && spec.method !== 'measure') spec.count = Math.min(spec.count, maxPathItems(L, P0.closed, spec.spacing));
            spec.method = next;
          }
        } else if (k === 'B') {
          const b = await ctx.getPoint('기준점 지정 또는 [키 점(K)] <경로 곡선의 끝>:', { keywords: [{ key: 'K', label: '키 점' }] });
          if ('point' in b) spec.base = b.point;
          else if ('enter' in b) spec.base = pathStart(P0);
          else if ('keyword' in b) {
            const kp = await ctx.getPoint('원본 객체의 키 점 지정:');
            if ('point' in kp) {
              if (!kp.snap || !hs.includes(kp.snap.handle ?? '')) ctx.print('원본 객체의 키 점이 아닙니다.', 'err');
              else spec.base = kp.point;
            }
          }
        } else if (k === 'T') {
          const a = await ctx.getPoint('접선 벡터의 첫 번째 점 지정 또는 [일반(N)]:', { keywords: [{ key: 'N', label: '일반' }] });
          if ('keyword' in a) spec.tangent = undefined;
          else if ('point' in a) {
            const p1 = a.point;
            const b = await ctx.getPoint('접선 벡터의 두 번째 점 지정:', { base: p1 });
            if ('point' in b && Math.hypot(b.point.x - p1.x, b.point.y - p1.y) > 1e-12) spec.tangent = Math.atan2(b.point.y - p1.y, b.point.x - p1.x);
          }
        } else if (k === 'I') {
          if (spec.method === 'measure') {
            const d = await askValue(ctx, `경로를 따라 항목 사이의 거리 지정 또는 [표현식(E)] <${fmt(spec.spacing)}>:`, spec.spacing, {
              check: (v) => (v > 0 && L / v < MAX_ARRAY_ITEMS ? null : '0보다 큰 거리를 입력하십시오(항목이 너무 많아지지 않게).'),
            });
            if (typeof d !== 'number') continue;
            spacing = d;
            spec.spacing = d;
            const max = maxPathItems(L, P0.closed, d);
            ctx.print(`최대 항목 수 = ${max}`);
            const n = await askValue(ctx, `항목 수 지정 또는 [전체 경로 채우기(F)/표현식(E)] <${max}>:`, max, {
              keywords: [{ key: 'F', label: '전체 경로 채우기' }],
              integer: true,
              check: (v) => (v >= 1 && v <= max ? null : `1에서 ${max} 사이의 정수를 입력하십시오.`),
            });
            spec.count = typeof n === 'number' ? n : max;
          } else {
            const n = await askValue(ctx, `경로를 따라 항목 수 지정 또는 [표현식(E)] <${spec.count}>:`, spec.count, {
              integer: true,
              check: (v) => (v >= 2 && v <= MAX_ARRAY_ITEMS ? null : `2에서 ${MAX_ARRAY_ITEMS} 사이의 정수를 입력하십시오.`),
            });
            if (typeof n === 'number') spec.count = n;
          }
        } else if (k === 'R') {
          const n = await askValue(ctx, `행 수 입력 또는 [표현식(E)] <${spec.rows}>:`, spec.rows, {
            integer: true,
            check: (v) => (v >= 1 && v * spec.count <= MAX_ARRAY_ITEMS ? null : '1 이상의 정수를 입력하십시오(항목이 너무 많아지지 않게).'),
          });
          if (typeof n !== 'number') continue;
          spec.rows = n;
          const d = await askValue(ctx, `행 사이의 거리 지정 또는 [전체(T)/표현식(E)] <${fmt(spec.rowSpacing)}>:`, spec.rowSpacing, { keywords: [{ key: 'T', label: '전체' }] });
          if (typeof d === 'number') spec.rowSpacing = d;
          else if (d.keyword === 'T') {
            const tot = await askValue(ctx, `시작 행과 끝 행 사이의 전체 거리 지정 또는 [표현식(E)] <${fmt(spec.rowSpacing * Math.max(1, spec.rows - 1))}>:`, spec.rowSpacing * Math.max(1, spec.rows - 1));
            if (typeof tot === 'number') spec.rowSpacing = spec.rows > 1 ? tot / (spec.rows - 1) : tot;
          }
        } else if (k === 'L') {
          const n = await askValue(ctx, `레벨 수 입력 또는 [표현식(E)] <${levels}>:`, levels, {
            integer: true,
            check: (v) => (v >= 1 && v * spec.count * spec.rows <= MAX_ARRAY_ITEMS ? null : '1 이상의 정수를 입력하십시오(항목이 너무 많아지지 않게).'),
          });
          if (typeof n !== 'number') continue;
          levels = n;
          const d = await askValue(ctx, `레벨 사이의 거리 지정 또는 [전체(T)/표현식(E)] <${fmt(levelSpacing)}>:`, levelSpacing, { keywords: [{ key: 'T', label: '전체' }] });
          if (typeof d === 'number') levelSpacing = d;
          else if (d.keyword === 'T') {
            const tot = await askValue(ctx, `시작 레벨과 끝 레벨 사이의 전체 거리 지정 또는 [표현식(E)] <${fmt(levelSpacing * Math.max(1, levels - 1))}>:`, levelSpacing * Math.max(1, levels - 1));
            if (typeof tot === 'number') levelSpacing = levels > 1 ? tot / (levels - 1) : tot;
          }
          if (levels > 1) ctx.print('레벨은 Z 방향으로 쌓이므로 평면도에서는 같은 자리에 겹쳐 보입니다.');
        } else if (k === 'A') {
          spec.align = await yesNo(ctx, '경로를 따라 배열된 항목을 정렬하시겠습니까?', spec.align);
        } else if (k === 'Z') {
          // 평면 경로에서는 결과가 같다(값만 지닌다)
          zDir = await yesNo(ctx, '항목의 Z 방향을 유지하시겠습니까?', zDir);
        }
      }
      const items = pathArrayItems(P0, spec);
      const n = items.length * Math.max(1, levels);
      if (n > MAX_ARRAY_ITEMS) {
        ctx.print(`배열 항목이 너무 많습니다(최대 ${MAX_ARRAY_ITEMS}개).`, 'err');
        return;
      }
      if (n < 2) {
        ctx.print('항목이 하나뿐이라 배열을 만들지 않았습니다.');
        return;
      }
      const mirrorText = Number(doc.header.get('$MIRRTEXT') ?? 0) === 1;
      const mirrorHatch = Number(doc.header.get('$MIRRHATCH') ?? 0) === 1;
      const results: EditResult[] = [];
      // 복사가 먼저(행렬은 원래 자리 기준), 원본 자리의 항목이 움직이면 원본을 옮긴다
      const moveOriginal: EditResult[] = [];
      for (let lv = 0; lv < Math.max(1, levels); lv++) {
        const dz = lv * levelSpacing;
        for (const it of items) {
          const first = it.index === 0 && it.row === 0 && lv === 0;
          for (const h of hs) {
            const e = doc.entityIndex.get(h);
            if (!e) continue;
            if (first) {
              if (!isIdentity(it.matrix)) moveOriginal.push(transformEntity(e, it.matrix, doc, { mirrorText, mirrorHatch }));
            } else results.push(copyEntity(e, it.matrix, doc, { mirrorText, mirrorHatch, dz: dz || undefined }));
          }
        }
      }
      results.push(...moveOriginal);
      st.selection.clear();
      const res = commitResults(app, ctx, results, 'ARRAYPATH');
      app.refreshSelectionOverlay();
      ctx.print(`항목 ${n}개(새 객체 ${res.added.length}개)를 만들었습니다.${spec.align ? '' : ' 항목은 돌리지 않았습니다.'}`);
    },
  });
}
