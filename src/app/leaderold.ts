/**
 * 옛 지시선 LEADER(LEAD): `지시선 시작점 지정:` → `다음 점 지정:` → `다음 점 지정 또는 [주석(A)/형식(F)/명령 취소(U)] <주석>:`.
 * 형식(F) `지시선 형식 옵션 입력 [스플라인(S)/직선(ST)/화살표(A)/없음(N)] <종료>:`.
 * 주석: `주석 문자의 첫 번째 행 입력 또는 <옵션>:`(입력한 줄들은 여러 줄 문자) → Enter면
 * `주석 옵션 입력 [공차(T)/복사(C)/블록(B)/없음(N)/여러 줄 문자(M)] <여러 줄 문자>:`.
 * LEADER 객체와 주석의 연결(340 주석 핸들 ↔ 주석의 반응자, 73 주석 종류)과 갈고리선은 QLEADER와 같은 방식이다
 * (src/edit/annot/qleader의 buildLeader). 갈고리선은 여러 줄 문자 주석의 직선 지시선에만 생긴다.
 * 프롬프트는 AutoCAD 2026 한국어판을 따른다.
 */
import type { Entity, InsertEntity, LeaderEntity, MTextEntity, ToleranceEntity, Vec3 } from '../core/model';
import { entityDefaults, tableKey } from '../core/model';
import { dimVars } from '../edit/dim';
import { buildLeader } from '../edit/annot/qleader';
import { buildToleranceText, toleranceLayout } from '../edit/annot/tolerance';
import { copyEntity } from '../edit/geom';
import { affTranslate } from '../edit/geom/math';
import { boundsOf } from '../edit/geom/query';
import type { EditOp } from '../edit/session';
import type { App, CommandContext, Keyword } from './app';
import { toleranceDialog } from './annot2-misc';
import { currentProps, textDialog } from './draw';
import { askText } from './util2-ui';
import { registerLeaderAssoc } from './leaderassoc';
import type { Pt } from './view';

const v3 = (p: Pt, z = 0): Vec3 => ({ x: p.x, y: p.y, z });

export interface LeaderFormat {
  spline: boolean;
  arrow: boolean;
}

/** 지시선 형식 옵션 하나를 적용한다(모르는 열쇠면 그대로) */
export function applyLeaderFormat(f: LeaderFormat, key: string): LeaderFormat {
  switch (key.toUpperCase()) {
    case 'S':
      return { ...f, spline: true };
    case 'ST':
      return { ...f, spline: false };
    case 'A':
      return { ...f, arrow: true };
    case 'N':
      return { ...f, arrow: false };
    default:
      return f;
  }
}

/** 주석 종류(DXF 73): 0 여러 줄 문자, 1 공차, 2 블록 참조, 3 없음 */
export function leaderCreationType(annotation: Entity | null): number {
  if (!annotation) return 3;
  if (annotation.type === 'MTEXT') return 0;
  if (annotation.type === 'TOLERANCE') return 1;
  if (annotation.type === 'INSERT') return 2;
  return 3;
}

/** 주석 객체가 지시선에 이어지는지(TEXT는 LEADER의 주석 종류가 없어 잇지 않는다) */
const linkable = (e: Entity | null): boolean => !!e && (e.type === 'MTEXT' || e.type === 'TOLERANCE' || e.type === 'INSERT');

export function registerLeaderCommand(app: App): void {
  // 주석을 옮기면 지시선 끝이 따라간다(src/app/leaderassoc.ts)
  registerLeaderAssoc(app);
  app.register({
    name: 'LEADER',
    aliases: ['LEAD'],
    title: '지시선',
    async run(ctx) {
      const s0 = await ctx.getPoint('지시선 시작점 지정:');
      if (!('point' in s0)) return;
      const pts: Pt[] = [s0.point];
      let fmt: LeaderFormat = { spline: false, arrow: true };
      const rubber = (p: Pt) => [{ pts: [...pts, p].flatMap((q) => [q.x, q.y]) }];
      const kws: Keyword[] = [
        { key: 'A', label: '주석' },
        { key: 'F', label: '형식' },
        { key: 'U', label: '명령 취소' },
      ];
      for (;;) {
        const last = pts[pts.length - 1]!;
        if (pts.length < 2) {
          const r = await ctx.getPoint('다음 점 지정:', { base: last, rubber });
          if (!('point' in r)) return;
          pts.push(r.point);
          continue;
        }
        const r = await ctx.getPoint('다음 점 지정 또는 [주석(A)/형식(F)/명령 취소(U)] <주석>:', { base: last, rubber, keywords: kws });
        if ('point' in r) {
          pts.push(r.point);
          continue;
        }
        if ('keyword' in r && r.keyword === 'U') {
          pts.pop();
          continue;
        }
        if ('keyword' in r && r.keyword === 'F') {
          const f = await ctx.getPoint('지시선 형식 옵션 입력 [스플라인(S)/직선(ST)/화살표(A)/없음(N)] <종료>:', {
            keywords: [
              { key: 'S', label: '스플라인' },
              { key: 'ST', label: '직선' },
              { key: 'A', label: '화살표' },
              { key: 'N', label: '없음' },
            ],
          });
          if ('keyword' in f) fmt = applyLeaderFormat(fmt, f.keyword);
          continue;
        }
        if ('enter' in r || ('keyword' in r && r.keyword === 'A')) break;
        return;
      }
      const annotation = await askAnnotation(app, ctx, pts);
      if (annotation === undefined) return;
      commitLeader(app, ctx, pts, annotation, fmt);
    },
  });
}

/** 주석 묻기. undefined = 취소, null = 주석 없음 */
async function askAnnotation(app: App, ctx: CommandContext, pts: Pt[]): Promise<Entity | null | undefined> {
  const st = app.active!;
  const doc = st.doc;
  const last = pts[pts.length - 1]!;
  const right = last.x >= pts[pts.length - 2]!.x;
  const dimStyle = String(doc.header.get('$DIMSTYLE') ?? 'Standard') || 'Standard';
  const dv = dimVars(doc, { dimStyle });
  const mtext = (text: string, height: number): MTextEntity => ({
    ...entityDefaults(),
    ...currentProps(app),
    type: 'MTEXT',
    insert: { x: last.x + (right ? 1 : -1) * dv.gap, y: last.y + height / 2, z: 0 },
    height,
    width: 0,
    attachment: right ? 1 : 3,
    drawingDirection: 1,
    text,
    style: dv.txsty,
    rotation: 0,
    lineSpacingStyle: 1,
    lineSpacingFactor: 1,
    backgroundFlags: 0,
    backgroundScale: 1.5,
  });
  const first = await askText(ctx, '주석 문자의 첫 번째 행 입력 또는 <옵션>:', '');
  if (first) {
    const lines = [first];
    for (;;) {
      const n = await askText(ctx, '주석 문자의 다음 행 입력:', '');
      if (!n) break;
      lines.push(n);
    }
    return mtext(lines.join('\\P'), dv.txt);
  }
  const o = await ctx.getPoint('주석 옵션 입력 [공차(T)/복사(C)/블록(B)/없음(N)/여러 줄 문자(M)] <여러 줄 문자>:', {
    keywords: [
      { key: 'T', label: '공차' },
      { key: 'C', label: '복사' },
      { key: 'B', label: '블록' },
      { key: 'N', label: '없음' },
      { key: 'M', label: '여러 줄 문자' },
    ],
  });
  const k = 'keyword' in o ? o.keyword : 'enter' in o ? 'M' : null;
  if (!k) return undefined;
  if (k === 'N') return null;
  if (k === 'M') {
    const t = await textDialog('지시선 주석', '', dv.txt, { app, ctx, at: { x: last.x + (right ? 1 : -1) * dv.gap, y: last.y + dv.txt / 2 }, attachment: right ? 1 : 3, style: dv.txsty });
    if (!t || !t.plain.trim()) return null;
    const m = mtext(t.text, t.height > 0 ? t.height : dv.txt);
    m.width = t.width;
    m.lineSpacingFactor = t.lineSpacingFactor;
    m.lineSpacingStyle = t.lineSpacingStyle;
    return m;
  }
  if (k === 'T') {
    const spec = await toleranceDialog();
    const text = spec ? buildToleranceText(spec) : '';
    if (!text) return null;
    const lay = toleranceLayout(text, dv.txt, dv.gap);
    const t: ToleranceEntity = { ...entityDefaults(), ...currentProps(app), type: 'TOLERANCE', handle: '', dimStyle, insert: v3({ x: right ? last.x : last.x - lay.width, y: last.y }), text, direction: { x: 1, y: 0, z: 0 } };
    return t;
  }
  if (k === 'C') {
    for (;;) {
      const r = await ctx.getEntity('복사할 객체 선택:');
      if (!('handle' in r)) return null;
      const e = doc.entityIndex.get(r.handle);
      if (!e || !['TEXT', 'MTEXT', 'TOLERANCE', 'INSERT'].includes(e.type)) {
        ctx.print('문자, 여러 줄 문자, 공차 또는 블록 참조를 선택하십시오.', 'err');
        continue;
      }
      app.clearSelection();
      let dx = 0;
      let dy = 0;
      if (e.type === 'INSERT') {
        dx = last.x - e.insert.x;
        dy = last.y - e.insert.y;
      } else {
        const b = boundsOf([e], doc);
        if (b) {
          dx = (right ? last.x + dv.gap : last.x - dv.gap) - (right ? b.minX : b.maxX);
          dy = last.y - (b.minY + b.maxY) / 2;
        }
      }
      const c = copyEntity(e, affTranslate(dx, dy), doc).add?.[0];
      if (!c) return null;
      if (e.type === 'TEXT') ctx.print('단일 행 문자는 지시선 주석으로 이어지지 않습니다(복사만 합니다).');
      return c;
    }
  }
  // 블록(B)
  for (;;) {
    const r = await ctx.getPoint('블록 이름 입력 또는 [?]:', { allowText: true });
    if (!('text' in r)) return null;
    const name = r.text.trim();
    if (name === '?') {
      const names = [...doc.blocks.values()].filter((b) => !b.name.startsWith('*') && !(b.flags & 1)).map((b) => b.name);
      ctx.print(names.length ? names.join(', ') : '블록이 없습니다.');
      continue;
    }
    const b = doc.blocks.get(tableKey(name));
    if (!b || b.name.startsWith('*')) {
      ctx.print(`블록 ${name}을(를) 찾을 수 없습니다.`, 'err');
      continue;
    }
    const ip = await ctx.getPoint('삽입점 지정:', { base: last });
    const at = 'point' in ip ? ip.point : last;
    const num = async (prompt: string, def: number): Promise<number> => {
      const v = await ctx.getPoint(prompt, { preferNumber: true, base: at });
      if ('text' in v && Number.isFinite(Number(v.text)) && Number(v.text) !== 0) return Number(v.text);
      return def;
    };
    const sx = await num('X 축척 비율 입력 <1>:', 1);
    const sy = await num('Y 축척 비율 입력 <X 축척 비율 사용>:', sx);
    const ra = await ctx.getPoint('회전 각도 지정 <0>:', { preferNumber: true, base: at });
    const rot = 'text' in ra && Number.isFinite(Number(ra.text)) ? (Number(ra.text) * Math.PI) / 180 : 'point' in ra ? Math.atan2(ra.point.y - at.y, ra.point.x - at.x) : 0;
    const ins: InsertEntity = {
      ...entityDefaults(),
      ...currentProps(app),
      type: 'INSERT',
      block: b.name,
      insert: v3(at),
      scale: { x: sx, y: sy, z: 1 },
      rotation: rot,
      columnCount: 1,
      rowCount: 1,
      columnSpacing: 0,
      rowSpacing: 0,
      attribs: [],
    };
    return ins;
  }
}

/** LEADER 객체와 주석을 한 번에 넣는다(QLEADER와 같은 연결) */
function commitLeader(app: App, ctx: CommandContext, pts: Pt[], annotation: Entity | null, fmt: LeaderFormat): void {
  const st = app.active!;
  const doc = st.doc;
  const dimStyle = String(doc.header.get('$DIMSTYLE') ?? 'Standard') || 'Standard';
  const dv = dimVars(doc, { dimStyle });
  const last = pts[pts.length - 1]!;
  const isText = annotation?.type === 'MTEXT';
  const geom = buildLeader(pts, { hook: isText && !fmt.spline, hookLength: dv.asz });
  const link = linkable(annotation);
  const leader: LeaderEntity = {
    ...entityDefaults(),
    ...currentProps(app),
    type: 'LEADER',
    dimStyle,
    vertices: geom.vertices.map((q) => v3(q)),
    arrowHead: fmt.arrow,
    pathType: fmt.spline ? 1 : 0,
    creation: link ? leaderCreationType(annotation) : 3,
    hooklineDirection: geom.hookDirection,
    hookline: geom.hooked,
    textHeight: isText ? (annotation as MTextEntity).height : 0,
    textWidth: isText ? (annotation as MTextEntity).width : 0,
    horizontalDirection: { x: 1, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
  };
  const space = doc.blocks.get(st.space);
  leader.handle = st.session.newHandle();
  if (annotation) {
    annotation.handle = st.session.newHandle();
    if (annotation.type === 'INSERT')
      for (const a of annotation.attribs) {
        a.handle = st.session.newHandle();
        a.owner = annotation.handle;
      }
    if (link) {
      annotation.reactors = [leader.handle];
      leader.annotation = annotation.handle;
      if (annotation.type === 'MTEXT') leader.annotationOffset = { x: annotation.insert.x - last.x, y: annotation.insert.y - last.y, z: 0 };
    }
  }
  const ops: EditOp[] = [];
  for (const e of [leader, ...(annotation ? [annotation] : [])]) {
    if (space?.recordHandle) e.owner = space.recordHandle;
    e.paperSpace = /^\*PAPER_SPACE/i.test(st.space) ? true : undefined;
    ops.push({ kind: 'add', block: st.space, entity: e });
  }
  st.session.commit({ label: 'LEADER', ops, group: ctx.group });
}
