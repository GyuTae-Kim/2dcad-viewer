/**
 * 주석 작성: MLEADER(다중 지시선)
 * 프롬프트는 AutoCAD 2026 한국어판을 따른다.
 */
import type { CadDocument, MLeaderEntity, MLeaderStyleObject, Vec3 } from '../core/model';
import { entityDefaults, tableKey } from '../core/model';
import type { App } from './app';
import { addEntities, currentProps, textDialog } from './draw';
import type { Pt } from './view';
import { form } from './ui/dom';

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

const options = new WeakMap<CadDocument, LeaderOptions>();

const v3 = (p: Pt): Vec3 => ({ x: p.x, y: p.y, z: 0 });

/** 화살촉·연결선 위치와 문자로 다중 지시선을 만든다 */
export function makeMLeader(app: App, arrow: Pt, landing: Pt, text: string, height: number, opt: LeaderOptions): MLeaderEntity {
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
  const lay = app.text.layoutMText({ text, height, width: 0, attachment: right ? 1 : 3, lineSpacingStyle: 1, lineSpacingFactor: 1, style: textStyle });
  // 문자 첫 줄 가운데가 연결선 높이에 오게(맨 위 줄 가운데 부착)
  const loc: Vec3 = { x: end.x + dv.x * gap, y: end.y + height / 2, z: 0 };
  const props = currentProps(app);
  return {
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
    contentType: 2,
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
          lines: [{ vertices: [v3(arrow)], index: 0 }],
          index: 0,
          attachmentDirection: 0,
        },
      ],
      text: {
        text,
        location: loc,
        direction: { x: 1, y: 0, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
        rotation: 0,
        width: 0,
        height: Math.max(height, lay.maxY - lay.minY),
        lineSpacingFactor: 1,
        lineSpacingStyle: 1,
        color: style?.textColor ?? { aci: 0 },
        attachment: right ? 1 : 3,
        flowDirection: 1,
        styleHandle: textStyle?.handle,
        backgroundFill: false,
        backgroundScale: 1.5,
      },
      basePoint: { x: end.x, y: end.y, z: 0 },
      baseDirection: { x: 1, y: 0, z: 0 },
      baseVertical: { x: 0, y: 1, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
    },
  };
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
      let opt = options.get(doc) ?? { lineType: style?.leaderLineType ?? 1, landing: style?.landing ?? true, doglegLength: style?.doglegLength ?? (metric ? 8 : 0.36) };
      let landingFirst = false;
      let arrow: Pt | null = null;
      let landing: Pt | null = null;
      for (;;) {
        const r = await ctx.getPoint(
          landingFirst ? '지시선 연결선 위치 지정 또는 [지시선 화살촉 먼저(H)/내용 먼저(C)/옵션(O)] <옵션>:' : '지시선 화살촉 위치 지정 또는 [지시선 연결선 먼저(L)/내용 먼저(C)/옵션(O)] <옵션>:',
          {
            keywords: [landingFirst ? { key: 'H', label: '지시선 화살촉 먼저' } : { key: 'L', label: '지시선 연결선 먼저' }, { key: 'C', label: '내용 먼저' }, { key: 'O', label: '옵션' }],
          },
        );
        if ('point' in r) {
          if (landingFirst) landing = r.point;
          else arrow = r.point;
          break;
        }
        if ('keyword' in r && (r.keyword === 'L' || r.keyword === 'C')) {
          landingFirst = true;
          continue;
        }
        if ('keyword' in r && r.keyword === 'H') {
          landingFirst = false;
          continue;
        }
        // 옵션
        const v = await form(
          '다중 지시선 옵션',
          [
            {
              key: 'lineType',
              label: '지시선 유형',
              type: 'select',
              value: String(opt.lineType),
              options: [
                { value: '1', label: '직선' },
                { value: '2', label: '스플라인' },
                { value: '0', label: '없음' },
              ],
            },
            { key: 'landing', label: '연결선 사용', type: 'check', value: opt.landing },
            { key: 'dogleg', label: '연결선 거리', type: 'number', value: opt.doglegLength },
          ],
          { ok: '확인' },
        );
        if (v) {
          opt = { lineType: Number(v.lineType), landing: !!v.landing, doglegLength: Math.max(0, Number(v.dogleg) || 0) };
          options.set(doc, opt);
        }
      }
      const first = (arrow ?? landing)!;
      const r2 = await ctx.getPoint(landingFirst ? '지시선 화살촉 위치 지정:' : '지시선 연결선 위치 지정:', { base: first });
      if (!('point' in r2)) return;
      if (landingFirst) arrow = r2.point;
      else landing = r2.point;
      const metricH = metric ? 4 : 0.18;
      const height = (style?.textHeight && style.textHeight > 0 ? style.textHeight : Number(doc.header.get('$TEXTSIZE')) || metricH) * (style?.scale && style.scale > 0 ? style.scale : 1);
      const t = await textDialog('다중 지시선 문자', '', height);
      if (!t || !t.text.trim()) return;
      const text = t.text.replace(/\r?\n/g, '\\P');
      const e = makeMLeader(app, arrow!, landing!, text, t.height > 0 ? t.height : height, opt);
      addEntities(app, ctx, [e], 'MLEADER');
      if (!doc.textStyles.has(tableKey('Standard')) && !e.textStyleHandle) ctx.print('참고: 문자 스타일 Standard가 없어 기본 글꼴로 그립니다.');
    },
  });
}
