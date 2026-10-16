/**
 * 주석 작성: MLEADER(다중 지시선)
 * 프롬프트는 AutoCAD 2026 한국어판을 따른다. 순서(화살촉 먼저·연결선 먼저·내용 먼저)와 옵션(지시선 유형·연결선·내용 유형·
 * 최대 점 수·첫 번째·두 번째 각도)은 도면마다 세션 동안 유지한다. 여러 줄 문자 내용은 제자리 문자 편집기로 받는다.
 */
import type { CadDocument, MLeaderEntity, MLeaderStyleObject, Vec3 } from '../core/model';
import { entityDefaults, tableKey } from '../core/model';
import { boundsOf } from '../edit/geom/query';
import type { App, CommandContext, Keyword } from './app';
import { addEntities, currentProps, textDialog } from './draw';
import type { Pt } from './view';

/** 지금 다중 지시선 스타일($CMLEADERSTYLE, 없으면 Standard) */
export function currentMLeaderStyle(doc: CadDocument): MLeaderStyleObject | null {
  const styles = [...doc.objects.values()].filter((o): o is MLeaderStyleObject => o.type === 'MLEADERSTYLE');
  const cur = doc.header.get('$CMLEADERSTYLE');
  if (typeof cur === 'string') {
    const byHandle = styles.find((s) => s.handle === cur.toUpperCase());
    if (byHandle) return byHandle;
    const byName = styles.find((s) => s.name.toUpperCase() === cur.toUpperCase());
    if (byName) return byName;
  }
  return styles.find((s) => s.name.toUpperCase() === 'STANDARD') ?? styles[0] ?? null;
}

interface LeaderOptions {
  /** 0 없음, 1 직선, 2 스플라인 */
  lineType: number;
  landing: boolean;
  doglegLength: number;
}

/** MLEADER 옵션(세션 동안, 도면마다) */
export interface MLeaderSession extends LeaderOptions {
  /** 내용 유형: M 여러 줄 문자, B 블록, N 없음 */
  content: 'M' | 'B' | 'N';
  block: string;
  /** 지시선의 최대 점 수(화살촉 포함, 0 = 제한 없음) */
  maxPoints: number;
  /** 첫 번째·두 번째 세그먼트 각도 구속(라디안, 0 = 없음) */
  firstAngle: number;
  secondAngle: number;
  /** 순서: H 화살촉 먼저, L 연결선 먼저, C 내용 먼저 */
  order: 'H' | 'L' | 'C';
}

const sessions = new WeakMap<CadDocument, MLeaderSession>();

export function mleaderSession(doc: CadDocument): MLeaderSession {
  let s = sessions.get(doc);
  if (!s) {
    const style = currentMLeaderStyle(doc);
    const metric = Number(doc.header.get('$MEASUREMENT') ?? 1) === 1;
    const blk = style?.blockHandle ? [...doc.blocks.values()].find((b) => b.recordHandle === style.blockHandle)?.name : undefined;
    s = {
      lineType: style?.leaderLineType ?? 1,
      landing: style?.landing ?? true,
      doglegLength: style?.doglegLength ?? (metric ? 8 : 0.36),
      content: style?.contentType === 1 ? 'B' : style?.contentType === 0 ? 'N' : 'M',
      block: blk ?? '',
      maxPoints: 2,
      firstAngle: 0,
      secondAngle: 0,
      order: 'H',
    };
    sessions.set(doc, s);
  }
  return s;
}

const v3 = (p: Pt): Vec3 => ({ x: p.x, y: p.y, z: 0 });

/** 각도 구속: from → to 방향을 step의 배수로(거리는 그대로) */
export function constrainAngle(from: Pt, to: Pt, step: number): Pt {
  if (!(step > 0)) return to;
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  const a = Math.round(Math.atan2(to.y - from.y, to.x - from.x) / step) * step;
  return { x: from.x + d * Math.cos(a), y: from.y + d * Math.sin(a) };
}

export interface MLeaderContent {
  /** 여러 줄 문자(없으면 내용 없음 또는 블록) */
  text?: string;
  /** 블록 내용: 블록 이름 */
  block?: string;
  /** 문자 폭(0 = 줄바꿈 없음) */
  width?: number;
  /** 화살촉과 연결 점 사이의 꼭짓점(최대 점 수가 2보다 클 때) */
  vertices?: Pt[];
}

/** 화살촉·연결선 위치와 문자로 다중 지시선을 만든다 */
export function makeMLeader(app: App, arrow: Pt, landing: Pt, text: string, height: number, opt: LeaderOptions, content: MLeaderContent = { text }): MLeaderEntity {
  const st = app.active!;
  const doc = st.doc;
  const style = currentMLeaderStyle(doc);
  const scale = style?.scale && style.scale > 0 ? style.scale : 1;
  const metric = Number(doc.header.get('$MEASUREMENT') ?? 1) === 1;
  const arrowSize = (style?.arrowSize ?? (metric ? 4 : 0.18)) * scale;
  const gap = (style?.landingGap ?? (metric ? 2 : 0.09)) * scale;
  const right = landing.x >= arrow.x;
  const dv: Vec3 = { x: right ? 1 : -1, y: 0, z: 0 };
  const dl = opt.landing ? opt.doglegLength * scale : 0;
  const end = { x: landing.x + dv.x * dl, y: landing.y };
  const textStyle = (style?.textStyleHandle && [...doc.textStyles.values()].find((t) => t.handle === style.textStyleHandle)) || doc.textStyles.get('STANDARD');
  const hasText = content.text !== undefined && !content.block;
  let lay = { minY: 0, maxY: height };
  if (hasText) {
    try {
      lay = app.text.layoutMText({ text: content.text!, height, width: content.width ?? 0, attachment: right ? 1 : 3, lineSpacingStyle: 1, lineSpacingFactor: 1, style: textStyle });
    } catch {
      /* 글꼴이 없으면 한 줄 높이 */
    }
  }
  // 문자 첫 줄 가운데가 연결선 높이에 오게(맨 위 줄 가운데 부착)
  const loc: Vec3 = { x: end.x + dv.x * gap, y: end.y + height / 2, z: 0 };
  const props = currentProps(app);
  const e: MLeaderEntity = {
    ...entityDefaults(),
    ...props,
    type: 'MULTILEADER',
    handle: '',
    styleHandle: style?.handle,
    leaderLineType: opt.lineType,
    leaderLineColor: style?.leaderLineColor ?? { aci: 0 },
    leaderLineWeight: style?.leaderLineWeight ?? -2,
    landing: opt.landing,
    dogleg: opt.landing,
    doglegLength: dl,
    arrowHeadHandle: style?.arrowHeadHandle,
    arrowSize,
    contentType: hasText ? 2 : content.block ? 1 : 0,
    textStyleHandle: textStyle?.handle,
    textColor: style?.textColor ?? { aci: 0 },
    textFrame: false,
    blockColor: { aci: 0 },
    blockScale: { x: 1, y: 1, z: 1 },
    blockRotation: 0,
    blockConnection: 0,
    scale,
    context: {
      scale,
      contentBase: { x: end.x, y: end.y, z: 0 },
      textHeight: height,
      arrowSize,
      landingGap: gap,
      leaders: [
        {
          lastLeaderPoint: v3(landing),
          doglegVector: dv,
          doglegLength: dl,
          hasLastPoint: true,
          hasDogleg: opt.landing,
          lines: [{ vertices: [v3(arrow), ...(content.vertices ?? []).map(v3)], index: 0 }],
          index: 0,
          attachmentDirection: 0,
        },
      ],
      basePoint: { x: end.x, y: end.y, z: 0 },
      baseDirection: { x: 1, y: 0, z: 0 },
      baseVertical: { x: 0, y: 1, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
    },
  };
  if (hasText) {
    e.context.text = {
      text: content.text!,
      location: loc,
      direction: { x: 1, y: 0, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
      rotation: 0,
      width: content.width ?? 0,
      height: Math.max(height, lay.maxY - lay.minY),
      lineSpacingFactor: 1,
      lineSpacingStyle: 1,
      color: style?.textColor ?? { aci: 0 },
      attachment: right ? 1 : 3,
      flowDirection: 1,
      styleHandle: textStyle?.handle,
      backgroundFill: false,
      backgroundScale: 1.5,
    };
  } else if (content.block) {
    // 블록 범위의 가운데 옆이 연결선 끝에 오게(블록 연결 "범위 중심")
    const blk = doc.blocks.get(tableKey(content.block));
    const b = blk ? boundsOf(blk.entities, doc) : null;
    const bp = blk?.basePoint ?? { x: 0, y: 0, z: 0 };
    const sideX = b ? (right ? b.minX : b.maxX) - bp.x : 0;
    const midY = b ? (b.minY + b.maxY) / 2 - bp.y : 0;
    e.blockHandle = blk?.recordHandle;
    e.context.block = { blockHandle: blk?.recordHandle, location: { x: end.x - sideX, y: end.y - midY, z: 0 }, normal: { x: 0, y: 0, z: 1 }, scale: { x: 1, y: 1, z: 1 }, rotation: 0, color: { aci: 0 } };
  }
  return e;
}

const ORDER_KW: Record<'H' | 'L' | 'C', Keyword> = {
  H: { key: 'H', label: '지시선 화살촉 먼저' },
  L: { key: 'L', label: '지시선 연결선 먼저' },
  C: { key: 'C', label: '내용 먼저' },
};

/** 옵션 묻기(옵션 종료까지) */
async function askOptions(ctx: CommandContext, doc: CadDocument, s: MLeaderSession): Promise<void> {
  for (;;) {
    const r = await ctx.getPoint('옵션 입력 [지시선 유형(L)/지시선 연결선(A)/내용 유형(C)/최대 점 수(M)/첫 번째 각도(F)/두 번째 각도(S)/옵션 종료(X)] <옵션 종료>:', {
      keywords: [
        { key: 'L', label: '지시선 유형' },
        { key: 'A', label: '지시선 연결선' },
        { key: 'C', label: '내용 유형' },
        { key: 'M', label: '최대 점 수' },
        { key: 'F', label: '첫 번째 각도' },
        { key: 'S', label: '두 번째 각도' },
        { key: 'X', label: '옵션 종료' },
      ],
    });
    if (!('keyword' in r) || r.keyword === 'X') return;
    switch (r.keyword) {
      case 'L': {
        const cur = s.lineType === 2 ? '스플라인' : s.lineType === 0 ? '없음' : '직선';
        const k = await ctx.getPoint(`지시선 유형 선택 [직선(S)/스플라인(P)/없음(N)] <${cur}>:`, {
          keywords: [
            { key: 'S', label: '직선' },
            { key: 'P', label: '스플라인' },
            { key: 'N', label: '없음' },
          ],
        });
        if ('keyword' in k) s.lineType = k.keyword === 'P' ? 2 : k.keyword === 'N' ? 0 : 1;
        break;
      }
      case 'A': {
        const k = await ctx.getPoint(`지시선 연결선 사용 [예(Y)/아니오(N)] <${s.landing ? '예' : '아니오'}>:`, {
          keywords: [
            { key: 'Y', label: '예' },
            { key: 'N', label: '아니오' },
          ],
        });
        if ('keyword' in k) s.landing = k.keyword === 'Y';
        if (s.landing) {
          for (;;) {
            const d = await ctx.getPoint(`고정 연결선 거리 지정 <${+s.doglegLength.toFixed(4)}>:`, { preferNumber: true });
            if ('text' in d && Number(d.text) >= 0) s.doglegLength = Number(d.text);
            else if ('text' in d) {
              ctx.print('0 이상의 값을 입력하십시오.', 'err');
              continue;
            }
            break;
          }
        }
        break;
      }
      case 'C': {
        const cur = s.content === 'B' ? '블록' : s.content === 'N' ? '없음' : '여러 줄 문자';
        const k = await ctx.getPoint(`내용 유형 선택 [블록(B)/여러 줄 문자(M)/없음(N)] <${cur}>:`, {
          keywords: [
            { key: 'B', label: '블록' },
            { key: 'M', label: '여러 줄 문자' },
            { key: 'N', label: '없음' },
          ],
        });
        if (!('keyword' in k)) break;
        if (k.keyword !== 'B') {
          s.content = k.keyword as 'M' | 'N';
          break;
        }
        for (;;) {
          const b = await ctx.getPoint(`블록 이름 입력${s.block ? ` <${s.block}>` : ''}:`, { allowText: true });
          if ('enter' in b && s.block) {
            s.content = 'B';
            break;
          }
          if (!('text' in b)) break;
          const name = b.text.trim();
          const blk = doc.blocks.get(tableKey(name));
          if (!blk || blk.name.startsWith('*')) {
            ctx.print(`블록 ${name}을(를) 찾을 수 없습니다.`, 'err');
            continue;
          }
          s.block = blk.name;
          s.content = 'B';
          break;
        }
        break;
      }
      case 'M': {
        for (;;) {
          const k = await ctx.getPoint(`지시선의 최대 점 수 입력 또는 [없음(N)] <${s.maxPoints || '없음'}>:`, { keywords: [{ key: 'N', label: '없음' }], preferNumber: true });
          if ('keyword' in k) s.maxPoints = 0;
          else if ('text' in k) {
            const n = Math.round(Number(k.text));
            if (!(n >= 2)) {
              ctx.print('2 이상의 정수를 입력하십시오.', 'err');
              continue;
            }
            s.maxPoints = n;
          }
          break;
        }
        break;
      }
      case 'F':
      case 'S': {
        const first = r.keyword === 'F';
        const cur = first ? s.firstAngle : s.secondAngle;
        for (;;) {
          const k = await ctx.getPoint(`${first ? '첫 번째' : '두 번째'} 각도 구속 입력 <${+((cur * 180) / Math.PI).toFixed(4)}>:`, { preferNumber: true });
          if ('text' in k) {
            const deg = Number(k.text);
            if (!Number.isFinite(deg) || deg < 0 || deg >= 360) {
              ctx.print('0에서 360 사이의 각도를 입력하십시오(0 = 구속 없음).', 'err');
              continue;
            }
            const v = (deg * Math.PI) / 180;
            if (first) s.firstAngle = v;
            else s.secondAngle = v;
          }
          break;
        }
        break;
      }
    }
  }
}

export function registerAnnotateCommands(app: App): void {
  app.register({
    name: 'MLEADER',
    aliases: ['MLD'],
    title: '다중 지시선',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const style = currentMLeaderStyle(doc);
      const metric = Number(doc.header.get('$MEASUREMENT') ?? 1) === 1;
      const s = mleaderSession(doc);
      const height = (style?.textHeight && style.textHeight > 0 ? style.textHeight : Number(doc.header.get('$TEXTSIZE')) || (metric ? 4 : 0.18)) * (style?.scale && style.scale > 0 ? style.scale : 1);
      const textStyleName = (style?.textStyleHandle && [...doc.textStyles.values()].find((t) => t.handle === style.textStyleHandle)?.name) || String(doc.header.get('$TEXTSTYLE') ?? 'Standard');
      let first: Pt | null = null;
      // 내용 먼저: 문자 상자의 두 구석(또는 블록 삽입점)
      let box: { a: Pt; b: Pt } | null = null;
      for (;;) {
        const others = (['H', 'L', 'C'] as const).filter((k) => k !== s.order).map((k) => ORDER_KW[k]);
        const prompt =
          s.order === 'C'
            ? s.content === 'B'
              ? `블록의 삽입점 지정 또는 [${others.map((k) => `${k.label}(${k.key})`).join('/')}/옵션(O)] <옵션>:`
              : `문자의 첫 번째 구석 지정 또는 [${others.map((k) => `${k.label}(${k.key})`).join('/')}/옵션(O)] <옵션>:`
            : `${s.order === 'L' ? '지시선 연결선 위치 지정' : '지시선 화살촉 위치 지정'} 또는 [${others.map((k) => `${k.label}(${k.key})`).join('/')}/옵션(O)] <옵션>:`;
        const r = await ctx.getPoint(prompt, { keywords: [...others, { key: 'O', label: '옵션' }] });
        if ('point' in r) {
          first = r.point;
          break;
        }
        if ('keyword' in r && (r.keyword === 'H' || r.keyword === 'L' || r.keyword === 'C')) {
          s.order = r.keyword;
          continue;
        }
        if ('keyword' in r || 'enter' in r) {
          await askOptions(ctx, doc, s);
          continue;
        }
        return;
      }
      const askPoint = async (prompt: string, base: Pt | null, step = 0): Promise<Pt | null> => {
        const r = await ctx.getPoint(prompt, { base, rubber: base ? (q) => [{ pts: [base.x, base.y, ...((p) => [p.x, p.y])(constrainAngle(base, q, step))] }] : undefined });
        if (!('point' in r)) return null;
        return base ? constrainAngle(base, r.point, step) : r.point;
      };
      let arrow: Pt | null = null;
      let landing: Pt | null = null;
      const mids: Pt[] = [];
      if (s.order === 'C') {
        if (s.content === 'M') {
          const b = await ctx.getPoint('반대 구석 지정:', { base: first, rubber: (q) => [{ pts: [first!.x, first!.y, q.x, first!.y, q.x, q.y, first!.x, q.y], closed: true, dashed: true }] });
          if (!('point' in b)) return;
          box = { a: first, b: b.point };
        } else box = { a: first, b: first };
      } else if (s.order === 'L') {
        landing = first;
        arrow = await askPoint('지시선 화살촉 위치 지정:', landing, s.firstAngle);
        if (!arrow) return;
      } else {
        arrow = first;
        // 화살촉 다음 점들: 마지막이 연결선 위치(최대 점 수까지, 제한 없으면 Enter까지)
        const pts: Pt[] = [arrow];
        for (;;) {
          const n = pts.length;
          const last = s.maxPoints === n + 1;
          const step = n === 1 ? s.firstAngle : n === 2 ? s.secondAngle : 0;
          const r = await ctx.getPoint(last ? '지시선 연결선 위치 지정:' : '다음 점 지정:', {
            base: pts[n - 1]!,
            rubber: (q) => [{ pts: [...pts, constrainAngle(pts[n - 1]!, q, step)].flatMap((p) => [p.x, p.y]) }],
          });
          if ('point' in r) {
            pts.push(constrainAngle(pts[n - 1]!, r.point, step));
            if (last || s.maxPoints === 2) break;
            continue;
          }
          if ('enter' in r && n >= 2) break;
          if (n < 2) return;
          break;
        }
        landing = pts[pts.length - 1]!;
        mids.push(...pts.slice(1, -1));
      }
      // 내용
      let text: string | undefined;
      let width = 0;
      let h = height;
      if (s.content === 'M') {
        let at: Pt;
        let att: number;
        if (box) {
          at = { x: Math.min(box.a.x, box.b.x), y: Math.max(box.a.y, box.b.y) };
          att = 1;
          width = Math.abs(box.b.x - box.a.x);
        } else {
          const right = landing!.x >= arrow!.x;
          const scale = style?.scale && style.scale > 0 ? style.scale : 1;
          const gap = (style?.landingGap ?? (metric ? 2 : 0.09)) * scale;
          const dl = s.landing ? s.doglegLength * scale : 0;
          at = { x: landing!.x + (right ? 1 : -1) * (dl + gap), y: landing!.y + height / 2 };
          att = right ? 1 : 3;
        }
        const t = await textDialog('다중 지시선 문자', '', height, { app, ctx, at, attachment: att, width, style: textStyleName });
        if (!t || !t.plain.trim()) return;
        text = t.text;
        width = t.width;
        if (t.height > 0) h = t.height;
      }
      if (box) {
        // 내용 먼저: 이제 화살촉. 연결선은 상자의 가까운 옆
        const a = await askPoint('지시선 화살촉 위치 지정:', null);
        if (!a) return;
        arrow = a;
        const left = Math.min(box.a.x, box.b.x);
        const rightX = Math.max(box.a.x, box.b.x);
        const top = Math.max(box.a.y, box.b.y);
        const scale = style?.scale && style.scale > 0 ? style.scale : 1;
        const gap = (style?.landingGap ?? (metric ? 2 : 0.09)) * scale;
        const dl = s.landing ? s.doglegLength * scale : 0;
        const toRight = arrow.x <= (left + rightX) / 2;
        if (s.content === 'M') landing = toRight ? { x: left - gap - dl, y: top - h / 2 } : { x: rightX + gap + dl, y: top - h / 2 };
        else landing = toRight ? { x: left - dl, y: top } : { x: rightX + dl, y: top };
        if (toRight && landing.x < arrow.x) landing = { ...landing, x: arrow.x };
        if (!toRight && landing.x > arrow.x) landing = { ...landing, x: arrow.x };
      }
      const e = makeMLeader(app, arrow!, landing!, text ?? '', h, s, { text, block: s.content === 'B' ? s.block || undefined : undefined, width, vertices: mids });
      if (s.content === 'B' && !s.block) ctx.print('블록 이름이 없어 내용 없이 만듭니다. 옵션(O) › 내용 유형(C)에서 블록을 정하십시오.');
      addEntities(app, ctx, [e], 'MLEADER');
      if (!doc.textStyles.has(tableKey('Standard')) && !e.textStyleHandle) ctx.print('참고: 문자 스타일 Standard가 없어 기본 글꼴로 그립니다.');
    },
  });
}
