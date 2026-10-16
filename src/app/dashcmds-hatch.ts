/**
 * 명령행 해치·경계: -HATCH, -BOUNDARY.
 * -HATCH: `내부 점 지정 또는 [특성(P)/객체 선택(S)/그리기 경계(W)/경계 제거(B)/고급(A)/그리기 순서(DR)/원점(O)/주석(AN)/해치 색상(CO)/도면층(LA)/투명도(T)]:`
 *   를 Enter까지 되풀이하고 해치를 만든다. 무늬·축척·각도·섬·연관·틈 허용은 HATCH와 같은 문서 설정을 쓴다.
 *   그리기 경계(W)는 직선 경계만(호는 안내), 주석(AN)·배경색은 이 웹 버전에 없어 묻기만 하고 안내한다.
 * -BOUNDARY: `내부 점 지정 또는 [고급 옵션(A)]:` → 폴리선 경계. 영역(REGION)은 만들 수 없어 안내한다.
 */
import type { CadColor, Entity, HatchEntity, HatchGradient, HatchPath } from '../core/model';
import { entityDefaults, tableKey } from '../core/model';
import type { EditOp } from '../edit/session';
import { PATTERNS, boundaryFromEntities, createHatch, detectBoundary, estimatePatternLines, findPattern, reactorLinks } from '../edit/hatch';
import type { IslandStyle } from '../edit/hatch';
import { boundaryObjects } from '../edit/geom/bpoly';
import { matchNameList } from '../edit/layercmd';
import { HATCH_LINE_LIMIT } from '../render/hatch';
import type { App, CommandContext, Keyword } from './app';
import { askAngleDeg, askOption, askReal, askWord, askYN, fmt4, matchKeyword } from './dashcmds-ask';
import { askColor, colorName } from './dashcmds-insert';
import { addEntities, currentProps } from './draw';
import { candidates, settingsOf } from './hatchcmd';
import { memOf, previewOf, visibleEntities } from './modify2-util';
import type { OverlayGeom, Pt } from './view';
import { lwPoints, packBulge } from '../core/lwpoly';

/** -HATCH 그라데이션 이름 ↔ 해치 객체의 그라데이션 이름 */
export const GRADIENT_NAMES: [string, string][] = [
  ['GR_LINEAR', 'LINEAR'],
  ['GR_CYLIN', 'CYLINDER'],
  ['GR_INVCYL', 'INVCYLINDER'],
  ['GR_SPHER', 'SPHERICAL'],
  ['GR_INVSPH', 'INVSPHERICAL'],
  ['GR_HEMISP', 'HEMISPHERICAL'],
  ['GR_INVHEMSP', 'INVHEMISPHERICAL'],
  ['GR_CURVED', 'CURVED'],
  ['GR_INVCUR', 'INVCURVED'],
];

/** 무늬 이름 입력 해석: "ANSI31", "ANSI31,O"(섬 스타일 붙임), "_USER" … 모르면 null */
export function parsePatternSpec(text: string): { name: string; style: IslandStyle | null } | null {
  const [n0, st0] = text.trim().split(',');
  const n = (n0 ?? '').trim().replace(/^\*/, '');
  if (!n) return null;
  const style = !st0 ? null : /^N/i.test(st0.trim()) ? 'normal' : /^O/i.test(st0.trim()) ? 'outer' : /^I/i.test(st0.trim()) ? 'ignore' : undefined;
  if (style === undefined) return null;
  const up = n.toUpperCase();
  if (up === 'SOLID') return { name: 'SOLID', style };
  if (up === '_USER' || up === 'U') return { name: '_USER', style };
  const def = findPattern(n);
  return def ? { name: def.name, style } : null;
}

const MAIN_KW: Keyword[] = [
  { key: 'P', label: '특성' },
  { key: 'S', label: '객체 선택' },
  { key: 'W', label: '그리기 경계' },
  { key: 'B', label: '경계 제거' },
  { key: 'A', label: '고급' },
  { key: 'DR', label: '그리기 순서' },
  { key: 'O', label: '원점' },
  { key: 'AN', label: '주석' },
  { key: 'CO', label: '해치 색상' },
  { key: 'LA', label: '도면층' },
  { key: 'T', label: '투명도' },
];

type DrawOrder = 'N' | 'B' | 'F' | 'E' | 'R';

interface Pick {
  paths: HatchPath[];
  seed?: Pt;
  bridged: boolean;
}

/** 직선 경계 그리기(W): 닫힌 점 목록들. 취소하면 null */
async function drawLoops(ctx: CommandContext): Promise<Pt[][]> {
  const loops: Pt[][] = [];
  for (;;) {
    const first = await ctx.getPoint(loops.length ? '새 경계의 시작점 지정 또는 <해치 적용>:' : '시작점 지정:');
    if (!('point' in first)) {
      if (loops.length) return loops;
      continue;
    }
    const pts: Pt[] = [first.point];
    for (;;) {
      const last = pts[pts.length - 1]!;
      const r = await ctx.getPoint(pts.length >= 3 ? '다음 점 지정 또는 [호(A)/닫기(C)/길이(L)/명령 취소(U)]:' : '다음 점 지정 또는 [호(A)/길이(L)/명령 취소(U)]:', {
        base: last,
        keywords: [
          { key: 'A', label: '호' },
          ...(pts.length >= 3 ? [{ key: 'C', label: '닫기' }] : []),
          { key: 'L', label: '길이' },
          { key: 'U', label: '명령 취소' },
        ],
        rubber: (p) => [{ pts: [...pts.flatMap((q) => [q.x, q.y]), p.x, p.y] }],
      });
      if ('point' in r) {
        pts.push(r.point);
        continue;
      }
      if ('keyword' in r) {
        if (r.keyword === 'C') break;
        if (r.keyword === 'U') {
          if (pts.length > 1) pts.pop();
          continue;
        }
        if (r.keyword === 'A') {
          ctx.print('그리기 경계의 호는 이 웹 버전에서 쓸 수 없습니다. 직선 점을 지정하십시오.');
          continue;
        }
        if (r.keyword === 'L') {
          const prev = pts.length > 1 ? pts[pts.length - 2]! : null;
          const len = await askReal(ctx, '선의 길이 지정:', null, (v) => (v > 0 ? null : '값은 0보다 커야 합니다.'));
          const a = prev ? Math.atan2(last.y - prev.y, last.x - prev.x) : 0;
          pts.push({ x: last.x + len * Math.cos(a), y: last.y + len * Math.sin(a) });
          continue;
        }
      }
      // Enter: 닫는다
      if (pts.length >= 3) break;
      ctx.print('경계는 점이 셋 이상이어야 합니다.', 'err');
    }
    loops.push(pts);
  }
}

/** 점 목록 → 폴리선 해치 경로 */
function loopPath(pts: Pt[], outer: boolean): HatchPath {
  return { flags: outer ? 3 : 2, polyline: { closed: true, verts: packBulge(pts) } };
}

export function registerDashHatchCommands(app: App): void {
  // ------------------------------------------------------------- -HATCH
  app.register({
    name: '-HATCH',
    aliases: ['-H', '-BHATCH', '-BH'],
    title: '해치(명령행)',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const s = settingsOf(st);
      const m = memOf(st);
      let gradient: HatchGradient | null = null;
      let color: CadColor | null = null;
      let layer: string | null = null;
      let transparency: number | null = null;
      let order: DrawOrder = (m.hpDrawOrder as DrawOrder | undefined) ?? 'E';
      let retain = false;
      let separate = false;
      let candidateSet: string[] | null = null;
      let origin: Pt | null = (m.hpOrigin as Pt | undefined) ?? null;
      let originCorner: string | null = null;
      const picks: Pick[] = [];
      const cands = (): Entity[] => (candidateSet ? candidateSet.map((h) => doc.entityIndex.get(h)).filter((e): e is Entity => !!e) : candidates(st));
      const preview = (): OverlayGeom[] => {
        const paths = picks.flatMap((p) => p.paths);
        if (!paths.length) return [];
        try {
          return previewOf(app, [createHatch(doc, paths, { pattern: 'SOLID', associative: false })]);
        } catch {
          return [];
        }
      };
      const patternText = () => (gradient ? (GRADIENT_NAMES.find(([, n]) => n === gradient!.name)?.[0] ?? gradient.name) : s.pattern === '_USER' ? '_USER' : s.pattern);
      let drawn: Pt[][] | null = null;
      main: for (;;) {
        const r = await ctx.getPoint('내부 점 지정 또는 [특성(P)/객체 선택(S)/그리기 경계(W)/경계 제거(B)/고급(A)/그리기 순서(DR)/원점(O)/주석(AN)/해치 색상(CO)/도면층(LA)/투명도(T)]:', {
          keywords: MAIN_KW,
          ghost: () => preview(),
        });
        if ('enter' in r) break;
        if ('point' in r) {
          ctx.print('모든 것 선택 중... 경계 분석 중...');
          const res = detectBoundary(doc, cands(), r.point, { islands: s.islands, gapTolerance: s.gap });
          if (!res || !res.paths.length) {
            ctx.print('유효한 해치 경계를 찾을 수 없습니다. 닫힌 영역 안을 선택하거나 틈 허용(고급 옵션 G)을 늘리십시오.', 'err');
            continue;
          }
          picks.push({ paths: res.paths, seed: r.point, bridged: res.bridged });
          continue;
        }
        if (!('keyword' in r)) continue;
        switch (r.keyword) {
          case 'P': {
            const def = patternText();
            for (;;) {
              const t = await askWord(ctx, `패턴 이름 입력 또는 [?/솔리드(S)/사용자 정의(U)/그라데이션(G)] <${def}>:`, [
                { key: '?', label: '?' },
                { key: 'S', label: '솔리드' },
                { key: 'U', label: '사용자 정의' },
                { key: 'G', label: '그라데이션' },
              ]);
              if (t === null) break;
              if (t === '?') {
                const pat = (await askWord(ctx, '나열할 패턴 입력 <*>:')) ?? '*';
                const names = matchNameList(
                  PATTERNS.map((p) => p.name),
                  pat,
                ).names;
                for (const n of names) ctx.print(`${n.padEnd(12)} - ${PATTERNS.find((p) => p.name === n)?.description ?? ''}`);
                continue;
              }
              if (t === 'S') {
                s.pattern = 'SOLID';
                gradient = null;
                break;
              }
              if (t === 'U') {
                gradient = null;
                s.pattern = '_USER';
                s.angle = await askAngleDeg(ctx, `선 각도 지정 <${+((s.angle * 180) / Math.PI).toFixed(4)}>:`, null, s.angle);
                s.userSpacing = await askReal(ctx, `선 간격 지정 <${fmt4(s.userSpacing)}>:`, s.userSpacing, (v) => (v > 0 ? null : '값은 0보다 커야 합니다.'));
                s.double = await askYN(ctx, '해치 영역을 이중 해치하시겠습니까?', s.double);
                break;
              }
              if (t === 'G') {
                gradient = await askGradient(ctx, gradient);
                break;
              }
              const spec = parsePatternSpec(t);
              if (!spec) {
                ctx.print(`패턴 "${t}"을(를) 찾을 수 없습니다. ?로 목록을 보십시오.`, 'err');
                continue;
              }
              gradient = null;
              s.pattern = spec.name;
              if (spec.style) s.islands = spec.style;
              if (spec.name !== 'SOLID' && spec.name !== '_USER') {
                s.scale = await askReal(ctx, `패턴 축척 지정 <${fmt4(s.scale)}>:`, s.scale, (v) => (v > 0 ? null : '값은 0보다 커야 합니다.'));
                s.angle = await askAngleDeg(ctx, `패턴 각도 지정 <${+((s.angle * 180) / Math.PI).toFixed(4)}>:`, null, s.angle);
              }
              break;
            }
            continue;
          }
          case 'S': {
            const hs = await ctx.getSelection('객체 선택:', { noPickfirst: true });
            app.clearSelection();
            const ents = hs.map((h) => doc.entityIndex.get(h)).filter((e): e is Entity => !!e);
            const paths = boundaryFromEntities(doc, ents);
            if (!paths.length) ctx.print('닫힌 객체(원, 닫힌 폴리선, 타원, 닫힌 스플라인)를 선택하십시오.', 'err');
            else picks.push({ paths, bridged: false });
            continue;
          }
          case 'W': {
            const keep = await askYN(ctx, '폴리선 경계를 유지하시겠습니까?', false);
            drawn = await drawLoops(ctx);
            if (keep) retain = true;
            // 그린 경계는 바로 해치를 적용한다(AutoCAD와 같다)
            picks.push({ paths: drawn.map((l, i) => loopPath(l, i === 0)), bridged: false });
            break main;
          }
          case 'B': {
            if (!picks.length) {
              ctx.print('제거할 경계가 없습니다.');
              continue;
            }
            const hs = new Set(await ctx.getSelection('제거할 경계 선택:', { noPickfirst: true }));
            app.clearSelection();
            let n = 0;
            for (const p of picks) {
              const keep = p.paths.filter((q) => !(q.sources ?? []).some((h) => hs.has(h)));
              n += p.paths.length - keep.length;
              p.paths = keep;
            }
            ctx.print(`경계 ${n}개를 제거했습니다.`);
            continue;
          }
          case 'A': {
            for (;;) {
              const k = await askOption(
                ctx,
                '옵션 입력 [경계 세트(B)/유지(R)/섬 검출(I)/스타일(S)/연관(A)/틈 허용 공차(G)/개별 해치 작성(H)] <종료>:',
                [
                  { key: 'B', label: '경계 세트' },
                  { key: 'R', label: '유지' },
                  { key: 'I', label: '섬 검출' },
                  { key: 'S', label: '스타일' },
                  { key: 'A', label: '연관' },
                  { key: 'G', label: '틈 허용 공차' },
                  { key: 'H', label: '개별 해치 작성' },
                  { key: 'X', label: '종료' },
                ],
                'X',
              );
              if (k === 'X' || k === null) break;
              if (k === 'B') {
                const b = await askOption(
                  ctx,
                  '경계 세트 지정 [새로 만들기(N)/모두(E)] <모두>:',
                  [
                    { key: 'N', label: '새로 만들기' },
                    { key: 'E', label: '모두' },
                  ],
                  'E',
                );
                if (b === 'N') {
                  candidateSet = await ctx.getSelection('객체 선택:', { noPickfirst: true });
                  app.clearSelection();
                } else candidateSet = null;
              } else if (k === 'R') retain = await askYN(ctx, '경계를 유지하시겠습니까?', retain);
              else if (k === 'I') {
                const on = await askYN(ctx, '섬 검출 여부', s.islands !== 'ignore');
                s.islands = on ? (s.islands === 'ignore' ? 'normal' : s.islands) : 'ignore';
              } else if (k === 'S') {
                const v = await askOption(
                  ctx,
                  `해치 스타일 입력 [섬 무시(I)/외부(O)/일반(N)] <${s.islands === 'ignore' ? '섬 무시' : s.islands === 'outer' ? '외부' : '일반'}>:`,
                  [
                    { key: 'I', label: '섬 무시' },
                    { key: 'O', label: '외부' },
                    { key: 'N', label: '일반' },
                  ],
                  s.islands === 'ignore' ? 'I' : s.islands === 'outer' ? 'O' : 'N',
                );
                s.islands = v === 'I' ? 'ignore' : v === 'O' ? 'outer' : 'normal';
              } else if (k === 'A') s.associative = await askYN(ctx, '연관 여부', s.associative);
              else if (k === 'G') s.gap = await askReal(ctx, `틈 허용 공차 지정 <${+s.gap.toFixed(4)}>:`, s.gap, (v) => (v >= 0 && v <= 5000 ? null : '0에서 5000 사이의 값이 필요합니다.'));
              else if (k === 'H') separate = await askYN(ctx, '개별 해치 작성 여부', separate);
            }
            continue;
          }
          case 'DR': {
            const names: Record<DrawOrder, string> = { N: '지정 안 함', B: '맨 뒤로', F: '맨 앞으로', E: '경계 뒤', R: '경계 앞' };
            order = (await askOption(
              ctx,
              `그리기 순서 옵션 입력 [지정 안 함(N)/맨 뒤로(B)/맨 앞으로(F)/경계 뒤(E)/경계 앞(R)] <${names[order]}>:`,
              (Object.keys(names) as DrawOrder[]).map((k) => ({ key: k, label: names[k] })),
              order,
            )) as DrawOrder;
            m.hpDrawOrder = order;
            continue;
          }
          case 'O': {
            const k = await askOption(
              ctx,
              '원점 옵션 입력 [현재 원점 사용(U)/새 원점 설정(S)/경계 범위를 기본값으로(D)] <현재 원점 사용>:',
              [
                { key: 'U', label: '현재 원점 사용' },
                { key: 'S', label: '새 원점 설정' },
                { key: 'D', label: '경계 범위를 기본값으로' },
              ],
              'U',
            );
            if (k === 'S') {
              const p = await ctx.getPoint('원점 지정:');
              if ('point' in p) {
                origin = p.point;
                originCorner = null;
                if (await askYN(ctx, '이 원점을 기본 원점으로 저장하시겠습니까?', false)) m.hpOrigin = origin;
              }
            } else if (k === 'D') {
              originCorner = await askOption(
                ctx,
                '새 원점 선택 [왼쪽 아래(L)/오른쪽 아래(R)/왼쪽 위(T)/오른쪽 위(U)/중심(C)] <왼쪽 아래>:',
                [
                  { key: 'L', label: '왼쪽 아래' },
                  { key: 'R', label: '오른쪽 아래' },
                  { key: 'T', label: '왼쪽 위' },
                  { key: 'U', label: '오른쪽 위' },
                  { key: 'C', label: '중심' },
                ],
                'L',
              );
              if (await askYN(ctx, '이 원점을 기본 원점으로 저장하시겠습니까?', false)) ctx.print('참고: 경계 범위 원점은 이번 해치에만 씁니다.');
            } else {
              origin = (m.hpOrigin as Pt | undefined) ?? null;
              originCorner = null;
            }
            continue;
          }
          case 'AN': {
            if (await askYN(ctx, '주석 해치 작성', false)) ctx.print('주석 해치는 이 명령행 버전에서 만들 수 없습니다. 보통 해치로 만듭니다(주석 축척은 특성 팔레트에서 켜십시오).');
            continue;
          }
          case 'CO': {
            for (;;) {
              const t = await askWord(ctx, `해치 색상 입력 또는 [트루 컬러(T)/색상표(CO)] <${color ? colorName(color) : '현재 사용'}>:`, [
                { key: 'T', label: '트루 컬러' },
                { key: 'CO', label: '색상표' },
                { key: '.', label: '.' },
              ]);
              if (t === null) break;
              if (t === '.') {
                color = null;
                break;
              }
              const c = await askColorFrom(ctx, t);
              if (c) {
                color = c;
                break;
              }
            }
            const bg = await askWord(ctx, '해치 배경색 입력 또는 [트루 컬러(T)/색상표(CO)/.] <없음>:', [
              { key: 'T', label: '트루 컬러' },
              { key: 'CO', label: '색상표' },
            ]);
            if (bg !== null && bg !== '.' && bg.toUpperCase() !== 'NONE' && bg !== '없음') {
              if (matchKeyword(bg, [{ key: 'T', label: '트루 컬러' }])) await askWord(ctx, '빨강, 초록, 파랑:');
              ctx.print('해치 배경색은 이 웹 버전에서 쓸 수 없습니다. 배경 없이 만듭니다.');
            }
            continue;
          }
          case 'LA': {
            const t = await askWord(ctx, `해치 작성에 사용할 도면층 입력 또는 [현재 사용(.)] <${layer ?? '현재 사용'}>:`, [{ key: '.', label: '현재 사용' }]);
            if (t === null) continue;
            if (t === '.') {
              layer = null;
              continue;
            }
            const l = doc.layers.get(tableKey(t));
            if (!l) {
              ctx.print(`도면층 "${t}"을(를) 찾을 수 없습니다.`, 'err');
              continue;
            }
            layer = l.name;
            continue;
          }
          case 'T': {
            const t = await askWord(ctx, `해치 투명도 값 입력 또는 [ByLayer(L)/ByBlock(B)/현재 사용(.)] <${transparency === null ? '현재 사용' : transparency}>:`, [
              { key: 'L', label: 'ByLayer' },
              { key: 'B', label: 'ByBlock' },
              { key: '.', label: '현재 사용' },
            ]);
            if (t === null) continue;
            if (t === '.') transparency = null;
            else if (t === 'L' || /^bylayer$/i.test(t)) transparency = -1;
            else if (t === 'B' || /^byblock$/i.test(t)) transparency = -2;
            else {
              const v = Number(t);
              if (!Number.isInteger(v) || v < 0 || v > 90) {
                ctx.print('0에서 90 사이의 정수가 필요합니다.', 'err');
                continue;
              }
              transparency = v;
            }
            continue;
          }
        }
      }
      const all = picks.filter((p) => p.paths.length);
      if (!all.length) return;
      const props = currentProps(app);
      const groups = separate ? all.map((p) => [p]) : [all];
      const block = doc.blocks.get(st.space)!;
      const ops: EditOp[] = [];
      let made = 0;
      for (const g of groups) {
        const paths = g.flatMap((p) => p.paths);
        const bridged = g.some((p) => p.bridged);
        const box = pathsBox(paths);
        let org = origin ?? undefined;
        if (originCorner && box) {
          const c = originCorner;
          org = { x: c === 'R' || c === 'U' ? box.maxX : c === 'C' ? (box.minX + box.maxX) / 2 : box.minX, y: c === 'T' || c === 'U' ? box.maxY : c === 'C' ? (box.minY + box.maxY) / 2 : box.minY };
        }
        const user = s.pattern === '_USER';
        let hatch: HatchEntity;
        try {
          hatch = createHatch(doc, paths, {
            pattern: gradient ? 'SOLID' : s.pattern,
            scale: s.scale,
            angle: s.angle,
            double: user && s.double,
            userSpacing: user ? s.userSpacing : undefined,
            style: s.islands === 'normal' ? 0 : s.islands === 'outer' ? 1 : 2,
            associative: s.associative && !bridged && !drawn,
            layer: layer ?? props.layer,
            seedPoints: g.map((p) => p.seed).filter((p): p is Pt => !!p),
            origin: org,
            gradient: gradient ?? undefined,
          });
        } catch (e) {
          ctx.print(e instanceof Error ? e.message : String(e), 'err');
          return;
        }
        Object.assign(hatch, {
          color: color ?? props.color,
          linetype: props.linetype,
          lineweight: props.lineweight,
          transparency: transparency ?? props.transparency,
        });
        if (!gradient && estimatePatternLines(hatch) > HATCH_LINE_LIMIT) {
          ctx.print('해치 무늬 축척이 너무 작거나 영역이 너무 큽니다. 축척을 키우십시오.', 'err');
          return;
        }
        hatch.handle = st.session.newHandle();
        hatch.owner = block.recordHandle;
        hatch.paperSpace = /^\*PAPER_SPACE/i.test(st.space) ? true : undefined;
        // 그리기 순서: 경계 뒤(기본)·경계 앞·맨 뒤·맨 앞
        const sources = new Set(paths.flatMap((p) => p.sources ?? []));
        let index = block.entities.length;
        if (order === 'B') index = 0;
        else if ((order === 'E' || order === 'R') && sources.size) {
          const idx = block.entities.map((e, i) => (sources.has(e.handle) ? i : -1)).filter((i) => i >= 0);
          if (idx.length) index = order === 'E' ? Math.min(...idx) : Math.max(...idx) + 1;
        }
        ops.push({ kind: 'add', block: st.space, entity: hatch, index: Math.min(index + made, block.entities.length + made) });
        for (const l of reactorLinks(doc, hatch)) {
          const owner = st.session.ownerOf(l.before.handle);
          if (owner) ops.push({ kind: 'modify', block: owner, before: l.before, after: l.after });
        }
        made++;
      }
      st.session.commit({ label: 'HATCH', ops, group: ctx.group, rebuildNow: true });
      if (retain) {
        const objs = boundaryObjects(
          all.flatMap((p) => p.paths),
          { ...props, handle: '' },
        );
        if (objs.length) addEntities(app, ctx, objs, 'HATCH');
      }
      app.lastCreated = ops.filter((o) => o.kind === 'add').map((o) => (o as { entity: Entity }).entity.handle);
      ctx.print(`해치 ${made}개를 만들었습니다.`);
    },
  });

  // ------------------------------------------------------------- -BOUNDARY
  app.register({
    name: '-BOUNDARY',
    aliases: ['-BO', '-BPOLY'],
    title: '경계(명령행)',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const m = memOf(st);
      let islands = m.boIslands !== false;
      let set: string[] | null = null;
      const paths: HatchPath[] = [];
      const props = { ...currentProps(app), handle: '' };
      const preview = (): OverlayGeom[] => previewOf(app, boundaryObjects(paths, props));
      for (;;) {
        const r = await ctx.getPoint('내부 점 지정 또는 [고급 옵션(A)]:', { keywords: [{ key: 'A', label: '고급 옵션' }], ghost: () => preview() });
        if ('enter' in r) break;
        if ('keyword' in r) {
          const k = await askOption(
            ctx,
            '옵션 입력 [경계 세트(B)/섬 검출(I)/객체 유형(O)]:',
            [
              { key: 'B', label: '경계 세트' },
              { key: 'I', label: '섬 검출' },
              { key: 'O', label: '객체 유형' },
            ],
            null,
          );
          if (k === 'B') {
            const b = await askOption(
              ctx,
              '경계 세트 지정 [새로 만들기(N)/모두(E)] <모두>:',
              [
                { key: 'N', label: '새로 만들기' },
                { key: 'E', label: '모두' },
              ],
              'E',
            );
            if (b === 'N') {
              set = await ctx.getSelection('객체 선택:', { noPickfirst: true });
              app.clearSelection();
            } else set = null;
          } else if (k === 'I') {
            islands = await askYN(ctx, '섬 검출 여부', islands);
            m.boIslands = islands;
          } else if (k === 'O') {
            const t = await askOption(
              ctx,
              '경계 객체 유형 입력 [영역(R)/폴리선(P)] <폴리선>:',
              [
                { key: 'R', label: '영역' },
                { key: 'P', label: '폴리선' },
              ],
              'P',
            );
            if (t === 'R') ctx.print('영역(REGION)은 이 웹 버전에서 만들 수 없습니다. 폴리선으로 만듭니다.');
          }
          continue;
        }
        if (!('point' in r)) continue;
        ctx.print('모든 것 선택 중... 경계 분석 중...');
        const list = set ? set.map((h) => doc.entityIndex.get(h)).filter((e): e is Entity => !!e) : visibleEntities(st);
        const res = detectBoundary(doc, list, r.point, { islands: islands ? 'normal' : 'ignore' });
        if (!res || !res.paths.length) {
          ctx.print('유효한 경계를 찾을 수 없습니다. 닫힌 영역 안을 선택하십시오.', 'err');
          continue;
        }
        paths.push(...res.paths);
      }
      if (!paths.length) return;
      const objs = boundaryObjects(paths, props);
      if (!objs.length) return;
      app.lastCreated = addEntities(app, ctx, objs, 'BOUNDARY');
      const nPl = objs.filter((o) => o.type !== 'SPLINE').length;
      const nSp = objs.length - nPl;
      ctx.print(nSp ? `BOUNDARY이(가) 폴리선 ${nPl}개, 스플라인 ${nSp}개를 작성함` : `BOUNDARY이(가) 폴리선 ${nPl}개를 작성함`);
    },
  });
}

/** 해치 경로들의 범위(정점·모서리 끝점) */
function pathsBox(paths: readonly HatchPath[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const objs = boundaryObjects(paths, entityDefaults());
  let b: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  for (const o of objs)
    if (o.type === 'LWPOLYLINE')
      for (const v of lwPoints(o)) {
        if (!b) b = { minX: v.x, minY: v.y, maxX: v.x, maxY: v.y };
        else b = { minX: Math.min(b.minX, v.x), minY: Math.min(b.minY, v.y), maxX: Math.max(b.maxX, v.x), maxY: Math.max(b.maxY, v.y) };
      }
  return b;
}

/** 이미 받은 글로 색 해석(T면 r,g,b를 더 묻는다) */
async function askColorFrom(ctx: CommandContext, t: string): Promise<CadColor | null> {
  const k = matchKeyword(t, [
    { key: 'T', label: '트루 컬러' },
    { key: 'CO', label: '색상표' },
  ]);
  return askColor(ctx, '해치 색상 입력 또는 [트루 컬러(T)/색상표(CO)] <현재 사용>:', k ?? t);
}

/** 그라데이션(G): 이름 → 색 1 → 색 2(.이면 한 가지 색) → 각도 → 가운데 */
async function askGradient(ctx: CommandContext, cur: HatchGradient | null): Promise<HatchGradient> {
  const g: HatchGradient = cur ? structuredClone(cur) : { enabled: true, name: 'LINEAR', color1: { aci: 5 }, color2: { aci: 2 }, singleColor: false, tint: 1, angle: 0, shift: 0 };
  const curName = GRADIENT_NAMES.find(([, n]) => n === g.name)?.[0] ?? 'GR_LINEAR';
  for (;;) {
    const t = await askWord(ctx, `그라데이션 패턴 이름 입력 또는 [?] <${curName}>:`, [{ key: '?', label: '?' }]);
    if (t === null) break;
    if (t === '?') {
      for (const [n] of GRADIENT_NAMES) ctx.print(n);
      continue;
    }
    const hit = GRADIENT_NAMES.find(([n, m]) => n === t.toUpperCase() || m === t.toUpperCase());
    if (!hit) {
      ctx.print(`그라데이션 패턴 "${t}"을(를) 찾을 수 없습니다.`, 'err');
      continue;
    }
    g.name = hit[1];
    break;
  }
  const c1 = await askColor(ctx, `첫 번째 그라데이션 색상 지정 또는 [트루 컬러(T)/색상표(CO)] <${colorName(g.color1)}>:`);
  if (c1) g.color1 = c1;
  const t2 = await askWord(ctx, `두 번째 그라데이션 색상 지정 또는 [트루 컬러(T)/색상표(CO)/.] <${g.singleColor ? '.' : colorName(g.color2)}>:`, [
    { key: 'T', label: '트루 컬러' },
    { key: 'CO', label: '색상표' },
    { key: '.', label: '.' },
  ]);
  if (t2 === '.') {
    g.singleColor = true;
    g.tint = await askReal(ctx, `색조 값 입력(0 어둡게 ~ 1 밝게) <${g.tint}>:`, g.tint, (v) => (v >= 0 && v <= 1 ? null : '0에서 1 사이의 값이 필요합니다.'));
  } else if (t2 !== null) {
    const c2 = await askColorFrom(ctx, t2);
    if (c2) {
      g.color2 = c2;
      g.singleColor = false;
    }
  }
  g.angle = await askAngleDeg(ctx, `그라데이션 각도 지정 <${+((g.angle * 180) / Math.PI).toFixed(4)}>:`, null, g.angle);
  g.shift = (await askYN(ctx, '가운데 맞춤', g.shift === 0)) ? 0 : 0.25;
  return g;
}
