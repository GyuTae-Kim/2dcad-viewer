/**
 * 지시선 명령: QLEADER(LE), MLEADEREDIT(MLE), MLEADERALIGN(MLA), MLEADERCOLLECT(MLC), MLEADERSTYLE(MLS).
 * 프롬프트는 AutoCAD 2026 한국어판을 따른다. 계산은 src/edit/annot(mleader·qleader·mlstyle).
 */
import type { BlockDef, DictionaryObject, Entity, InsertEntity, LeaderEntity, MLeaderEntity, MLeaderStyleObject, MTextEntity, ToleranceEntity, Vec3 } from '../core/model';
import { entityDefaults, tableKey } from '../core/model';
import { builtinArrowBlock, dimVars } from '../edit/dim';
import { addLeaderLine, alignMleaders, type AlignMode, collectLayout, landingOf, leaderPolyline, lineCount, removeLeaderLine, translateContent } from '../edit/annot/mleader';
import { buildLeader, type QLeaderSettings, defaultQLeaderSettings } from '../edit/annot/qleader';
import { copyStyle, styleInUse, updateStyle, type StyleValues } from '../edit/annot/mlstyle';
import { applyOverrides } from '../edit/annot/override';
import { toleranceLayout, buildToleranceText } from '../edit/annot/tolerance';
import { boundsOf } from '../edit/geom/query';
import type { EditOp } from '../edit/session';
import type { App, CommandContext } from './app';
import { currentMLeaderStyle } from './annotate';
import { commitChanged } from './annot2-common';
import { toleranceDialog } from './annot2-misc';
import { currentProps, textDialog } from './draw';
import { unlockedOnly } from './layers';
import { commitResults } from './modify';
import { dialog, form, h } from './ui/dom';
import type { Pt } from './view';

const v3 = (p: Pt, z = 0): Vec3 => ({ x: p.x, y: p.y, z });

/** QLEADER 설정(세션 동안, 도면마다) */
const qsettings = new WeakMap<object, QLeaderSettings>();

const ARROWS: { value: string; label: string }[] = [
  { value: '', label: '닫고 채움' },
  { value: '_ClosedBlank', label: '닫고 비움' },
  { value: '_Closed', label: '닫음' },
  { value: '_Dot', label: '점' },
  { value: '_ArchTick', label: '건축 눈금' },
  { value: '_Oblique', label: '기울기' },
  { value: '_Open', label: '열기' },
  { value: '_Origin', label: '원점 표시기' },
  { value: '_Origin2', label: '원점 표시기 2' },
  { value: '_Open90', label: '직각' },
  { value: '_Open30', label: '30도 열기' },
  { value: '_DotSmall', label: '작은 점' },
  { value: '_DotBlank', label: '빈 점' },
  { value: '_Small', label: '작은 원' },
  { value: '_BoxBlank', label: '상자' },
  { value: '_BoxFilled', label: '채운 상자' },
  { value: '_DatumBlank', label: '데이텀 삼각형' },
  { value: '_DatumFilled', label: '채운 데이텀 삼각형' },
  { value: '_Integral', label: '적분' },
  { value: '_None', label: '없음' },
];

async function qleaderSettingsDialog(s: QLeaderSettings): Promise<QLeaderSettings> {
  const v = await form(
    '지시선 설정',
    [
      {
        key: 'annotation',
        label: '주석 유형',
        type: 'select',
        value: s.annotation,
        options: [
          { value: 'M', label: '여러 줄 문자' },
          { value: 'T', label: '공차' },
          { value: 'B', label: '블록 참조' },
          { value: 'N', label: '없음' },
        ],
      },
      { key: 'promptWidth', label: '폭에 대한 프롬프트', type: 'check', value: s.promptWidth },
      {
        key: 'spline',
        label: '지시선',
        type: 'select',
        value: s.spline ? '1' : '0',
        options: [
          { value: '0', label: '직선' },
          { value: '1', label: '스플라인' },
        ],
      },
      { key: 'arrow', label: '화살촉', type: 'select', value: s.arrow, options: ARROWS },
      { key: 'maxPoints', label: '점의 수(0 = 제한 없음)', type: 'number', value: s.maxPoints },
    ],
    { ok: '확인', validate: (x) => (Number(x.maxPoints) === 0 || Number(x.maxPoints) >= 2 ? null : '점의 수는 0(제한 없음) 또는 2 이상이어야 합니다.') },
  );
  if (!v) return s;
  return { annotation: String(v.annotation) as QLeaderSettings['annotation'], promptWidth: !!v.promptWidth, spline: v.spline === '1', arrow: String(v.arrow), maxPoints: Math.max(0, Math.round(Number(v.maxPoints))) };
}

/** 화살촉 블록 핸들(없으면 만들 블록 정의도) */
function arrowRecord(app: App, name: string): { handle: string; def?: BlockDef } | null {
  if (!name) return null;
  const st = app.active!;
  const rec = st.doc.blockRecords.get(tableKey(name));
  if (rec) return { handle: rec.handle };
  const ents = builtinArrowBlock(name);
  if (!ents.length) return null;
  const def: BlockDef = { name, handle: '', recordHandle: st.session.newHandle(), basePoint: { x: 0, y: 0, z: 0 }, flags: 0, entities: ents };
  return { handle: def.recordHandle, def };
}

/** 다중 지시선 내용의 폭(문자 배치 또는 블록 범위) */
function contentWidth(app: App, e: MLeaderEntity): number {
  const st = app.active!;
  const t = e.context.text;
  if (t && e.contentType === 2) {
    try {
      const style = t.styleHandle ? [...st.doc.textStyles.values()].find((s) => s.handle === t.styleHandle) : undefined;
      const l = app.text.layoutMText({ text: t.text, height: e.context.textHeight, width: t.width, attachment: t.attachment || 1, lineSpacingStyle: t.lineSpacingStyle, lineSpacingFactor: t.lineSpacingFactor, style });
      if (Number.isFinite(l.maxX - l.minX)) return l.maxX - l.minX;
    } catch {
      /* 아래 대략 */
    }
    return t.text.length * e.context.textHeight * 0.7;
  }
  const b = e.context.block;
  if (b) {
    const blk = [...st.doc.blocks.values()].find((x) => x.recordHandle === (b.blockHandle ?? e.blockHandle));
    const bb = blk ? boundsOf(blk.entities, st.doc) : null;
    if (bb) return (bb.maxX - bb.minX) * (b.scale.x || 1);
  }
  return 0;
}

function mleaderOf(app: App, h: string): MLeaderEntity | null {
  const e = app.active!.doc.entityIndex.get(h);
  return e?.type === 'MULTILEADER' ? e : null;
}

export function registerAnnot2Leader(app: App): void {
  // ------------------------------------------------------------- QLEADER
  app.register({
    name: 'QLEADER',
    aliases: ['LE'],
    title: '빠른 지시선',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      let s = qsettings.get(doc) ?? defaultQLeaderSettings();
      let first: Pt | null = null;
      while (!first) {
        const r = await ctx.getPoint('첫 번째 지시선 점 지정 또는 [설정(S)] <설정>:', { keywords: [{ key: 'S', label: '설정' }] });
        if ('point' in r) first = r.point;
        else if ('enter' in r || 'keyword' in r) {
          s = await qleaderSettingsDialog(s);
          qsettings.set(doc, s);
        } else return;
      }
      const pts: Pt[] = [first];
      while (s.maxPoints === 0 || pts.length < s.maxPoints) {
        const r = await ctx.getPoint('다음 점 지정:', { base: pts[pts.length - 1]! });
        if (!('point' in r)) break;
        pts.push(r.point);
      }
      if (pts.length < 2) return;
      const last = pts[pts.length - 1]!;
      const right = last.x >= pts[pts.length - 2]!.x;
      const dimStyle = String(doc.header.get('$DIMSTYLE') ?? 'Standard') || 'Standard';
      const dv = dimVars(doc, { dimStyle });
      let annotation: Entity | null = null;
      if (s.annotation === 'M') {
        let width = 0;
        if (s.promptWidth) {
          const w = await ctx.getPoint('문자 폭 지정 <0>:', { base: last, preferNumber: true });
          if ('text' in w) width = Math.max(0, Number(w.text) || 0);
          else if ('point' in w) width = Math.hypot(w.point.x - last.x, w.point.y - last.y);
        }
        let text = '';
        const r = await ctx.getPoint('주석 문자의 첫 번째 행 입력 <여러 줄 문자>:', { allowText: true });
        if ('text' in r) {
          const lines = [r.text];
          for (;;) {
            const n = await ctx.getPoint('주석 문자의 다음 행 입력:', { allowText: true });
            if (!('text' in n)) break;
            lines.push(n.text);
          }
          text = lines.join('\\P');
        } else if ('enter' in r) {
          const t = await textDialog('지시선 주석', '', dv.txt, { app, ctx, at: { x: last.x + (right ? 1 : -1) * dv.gap, y: last.y + dv.txt / 2 }, attachment: right ? 1 : 3, width, style: dv.txsty });
          if (!t || !t.plain.trim()) return;
          text = t.text;
          if (t.width !== width) width = t.width;
        } else return;
        const m: MTextEntity = {
          ...entityDefaults(),
          ...currentProps(app),
          type: 'MTEXT',
          insert: { x: last.x + (right ? 1 : -1) * dv.gap, y: last.y + dv.txt / 2, z: 0 },
          height: dv.txt,
          width,
          attachment: right ? 1 : 3,
          drawingDirection: 1,
          text,
          style: dv.txsty,
          rotation: 0,
          lineSpacingStyle: 1,
          lineSpacingFactor: 1,
          backgroundFlags: 0,
          backgroundScale: 1.5,
        };
        annotation = m;
      } else if (s.annotation === 'T') {
        const spec = await toleranceDialog();
        const text = spec ? buildToleranceText(spec) : '';
        if (text) {
          const lay = toleranceLayout(text, dv.txt, dv.gap);
          const t: ToleranceEntity = { ...entityDefaults(), ...currentProps(app), type: 'TOLERANCE', handle: '', dimStyle, insert: v3({ x: right ? last.x : last.x - lay.width, y: last.y }), text, direction: { x: 1, y: 0, z: 0 } };
          annotation = t;
        }
      } else if (s.annotation === 'B') {
        for (;;) {
          const r = await ctx.getPoint('블록 이름 입력 또는 [?]:', { allowText: true });
          if (!('text' in r)) break;
          if (r.text.trim() === '?') {
            const names = [...doc.blocks.values()].filter((b) => !b.name.startsWith('*') && !(b.flags & 1)).map((b) => b.name);
            ctx.print(names.length ? names.join(', ') : '블록이 없습니다.');
            continue;
          }
          const b = doc.blocks.get(tableKey(r.text.trim()));
          if (!b || b.name.startsWith('*')) {
            ctx.print(`블록 ${r.text.trim()}을(를) 찾을 수 없습니다.`, 'err');
            continue;
          }
          const ins: InsertEntity = {
            ...entityDefaults(),
            ...currentProps(app),
            type: 'INSERT',
            block: b.name,
            insert: v3(last),
            scale: { x: 1, y: 1, z: 1 },
            rotation: 0,
            columnCount: 1,
            rowCount: 1,
            columnSpacing: 0,
            rowSpacing: 0,
            attribs: [],
          };
          annotation = ins;
          break;
        }
      }
      const props = currentProps(app);
      const geom = buildLeader(pts, { hook: annotation?.type === 'MTEXT', hookLength: dv.asz });
      const leader: LeaderEntity = {
        ...entityDefaults(),
        ...props,
        type: 'LEADER',
        dimStyle,
        vertices: geom.vertices.map((q) => v3(q)),
        arrowHead: s.arrow !== '_None',
        pathType: s.spline ? 1 : 0,
        creation: annotation?.type === 'MTEXT' ? 0 : annotation?.type === 'TOLERANCE' ? 1 : annotation?.type === 'INSERT' ? 2 : 3,
        hooklineDirection: geom.hookDirection,
        hookline: geom.hooked,
        textHeight: annotation?.type === 'MTEXT' ? dv.txt : 0,
        textWidth: annotation?.type === 'MTEXT' ? (annotation as MTextEntity).width : 0,
        horizontalDirection: { x: 1, y: 0, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
      };
      const blocks: BlockDef[] = [];
      if (s.arrow && s.arrow !== '_None') {
        const ar = arrowRecord(app, s.arrow);
        if (ar) {
          if (ar.def) blocks.push(ar.def);
          Object.assign(leader, applyOverrides(leader, { 341: ar.handle }));
        }
      }
      // 핸들을 먼저 붙여 서로 가리키게 한다(지시선 340 ↔ 주석 반응자)
      const space = doc.blocks.get(st.space);
      leader.handle = st.session.newHandle();
      if (annotation) {
        annotation.handle = st.session.newHandle();
        annotation.reactors = [leader.handle];
        leader.annotation = annotation.handle;
        if (annotation.type === 'MTEXT') leader.annotationOffset = { x: annotation.insert.x - last.x, y: annotation.insert.y - last.y, z: 0 };
      }
      const ops: EditOp[] = [];
      for (const b of blocks) {
        const key = tableKey(b.name);
        ops.push({ kind: 'blockRecord', key, before: null, after: { name: b.name, handle: b.recordHandle, flags: 0, insertUnits: 0, explodable: true, scalable: true } });
        for (const x of b.entities) {
          x.handle = st.session.newHandle();
          x.owner = b.recordHandle;
        }
        ops.push({ kind: 'blockDef', key, before: null, after: { ...b, handle: st.session.newHandle(), endHandle: st.session.newHandle() } });
      }
      for (const e of [leader, ...(annotation ? [annotation] : [])]) {
        if (space?.recordHandle) e.owner = space.recordHandle;
        e.paperSpace = /^\*PAPER_SPACE/i.test(st.space) ? true : undefined;
        ops.push({ kind: 'add', block: st.space, entity: e });
      }
      st.session.commit({ label: 'QLEADER', ops, group: ctx.group });
    },
  });

  // ------------------------------------------------------------- MLEADEREDIT
  app.register({
    name: 'MLEADEREDIT',
    aliases: ['MLE'],
    title: '다중 지시선 편집',
    async run(ctx) {
      let cur: MLeaderEntity | null = null;
      while (!cur) {
        const r = await ctx.getEntity('다중 지시선 선택:');
        if (!('handle' in r)) return;
        cur = mleaderOf(app, r.handle);
        if (!cur) ctx.print('다중 지시선이 아닙니다.', 'err');
      }
      app.clearSelection();
      const k = await ctx.getPoint('옵션 지정 [지시선 추가(A)/지시선 제거(R)] <지시선 추가>:', {
        keywords: [
          { key: 'A', label: '지시선 추가' },
          { key: 'R', label: '지시선 제거' },
        ],
      });
      const remove = 'keyword' in k && k.keyword === 'R';
      let firstPoint: Pt | null = 'point' in k ? k.point : null;
      const k0 = cur;
      for (;;) {
        const e: MLeaderEntity = cur;
        if (!remove) {
          const w = contentWidth(app, e);
          let p: Pt | null = firstPoint;
          firstPoint = null;
          if (!p) {
            const r = await ctx.getPoint('지시선 화살촉 위치 지정:', {
              rubber: (q) => {
                const t = addLeaderLine(e, q, w);
                const ld = t.context.leaders.find((l) => l.lines.some((x) => x.index === Math.max(...t.context.leaders.flatMap((y) => y.lines.map((z) => z.index)))));
                const pts = ld ? leaderPolyline(ld, ld.lines.length - 1) : [];
                const out = [{ pts: pts.flatMap((v) => [v.x, v.y]) }];
                if (ld?.lastLeaderPoint && ld.doglegVector && ld.hasDogleg && ld.doglegLength > 0 && ld.lines.length === 1)
                  out.push({ pts: [ld.lastLeaderPoint.x, ld.lastLeaderPoint.y, ld.lastLeaderPoint.x + ld.doglegVector.x * ld.doglegLength, ld.lastLeaderPoint.y + ld.doglegVector.y * ld.doglegLength] });
                return out;
              },
            });
            if (!('point' in r)) return;
            p = r.point;
          }
          cur = addLeaderLine(e, p, w);
          commitChanged(app, ctx, [cur], 'MLEADEREDIT');
        } else {
          if (lineCount(e) <= 1) {
            // 처음부터 하나뿐일 때만 알린다(지우다가 하나 남으면 조용히 끝낸다)
            if (e === k0) ctx.print('지시선이 하나뿐이라 제거할 수 없습니다.');
            return;
          }
          const r = await ctx.getPoint('제거할 지시선 지정:');
          if (!('point' in r)) return;
          const c = removeLeaderLine(e, r.point);
          if (!c) {
            ctx.print('제거할 지시선을 찾을 수 없습니다.', 'err');
            continue;
          }
          cur = c;
          commitChanged(app, ctx, [cur], 'MLEADEREDIT');
        }
      }
    },
  });

  // ------------------------------------------------------------- MLEADERALIGN
  let alignSpacing = 0;
  app.register({
    name: 'MLEADERALIGN',
    aliases: ['MLA'],
    title: '다중 지시선 정렬',
    async run(ctx) {
      const st = app.active!;
      const sel = unlockedOnly(app, await ctx.getSelection('다중 지시선 선택:'))
        .map((h) => mleaderOf(app, h))
        .filter((e): e is MLeaderEntity => !!e);
      app.clearSelection();
      if (sel.length < 2) {
        ctx.print('다중 지시선을 둘 이상 선택하십시오.', 'err');
        return;
      }
      let mode: AlignMode = alignSpacing > 0 ? { kind: 'spacing', spacing: alignSpacing } : { kind: 'current' };
      let base: MLeaderEntity | null = null;
      while (!base) {
        const r = await ctx.getEntity('정렬할 다중 지시선 선택 또는 [옵션(O)]:', [{ key: 'O', label: '옵션' }]);
        if ('keyword' in r) {
          const k = await ctx.getPoint('옵션 입력 [분산(D)/지시선 세그먼트를 평행으로 지정(P)/간격두기 지정(S)/현재 간격두기 사용(U)] <현재 간격두기 사용>:', {
            keywords: [
              { key: 'D', label: '분산' },
              { key: 'P', label: '지시선 세그먼트를 평행으로 지정' },
              { key: 'S', label: '간격두기 지정' },
              { key: 'U', label: '현재 간격두기 사용' },
            ],
          });
          const kk = 'keyword' in k ? k.keyword : 'U';
          if (kk === 'D') mode = { kind: 'distribute', from: { x: 0, y: 0 }, to: { x: 0, y: 0 } };
          else if (kk === 'P') mode = { kind: 'parallel' };
          else if (kk === 'S') {
            const v = await ctx.getPoint(`간격두기 지정 <${alignSpacing}>:`, { preferNumber: true });
            if ('text' in v && Number(v.text) >= 0) alignSpacing = Number(v.text);
            mode = { kind: 'spacing', spacing: alignSpacing };
          } else mode = { kind: 'current' };
          continue;
        }
        if (!('handle' in r)) return;
        base = mleaderOf(app, r.handle);
        if (!base) ctx.print('다중 지시선이 아닙니다.', 'err');
      }
      const b = base;
      const others = sel.filter((e) => e.handle !== b.handle);
      let out: MLeaderEntity[];
      if (mode.kind === 'distribute') {
        const p1 = await ctx.getPoint('첫 번째 점 지정:');
        if (!('point' in p1)) return;
        const p2 = await ctx.getPoint('두 번째 점 지정:', { base: p1.point });
        if (!('point' in p2)) return;
        out = alignMleaders(b, [b, ...others], { x: p2.point.x - p1.point.x, y: p2.point.y - p1.point.y }, { kind: 'distribute', from: p1.point, to: p2.point });
      } else if (mode.kind === 'parallel') out = alignMleaders(b, others, { x: 1, y: 0 }, mode);
      else {
        const land = landingOf(b);
        const r = await ctx.getPoint('방향 지정:', { base: land });
        if (!('point' in r)) return;
        const d = { x: r.point.x - land.x, y: r.point.y - land.y };
        if (Math.hypot(d.x, d.y) < 1e-12) return;
        out = alignMleaders(b, others, d, mode);
      }
      commitChanged(app, ctx, out, 'MLEADERALIGN');
      void st;
    },
  });

  // ------------------------------------------------------------- MLEADERCOLLECT
  app.register({
    name: 'MLEADERCOLLECT',
    aliases: ['MLC'],
    title: '다중 지시선 수집',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const all = unlockedOnly(app, await ctx.getSelection('다중 지시선 선택:'))
        .map((h) => mleaderOf(app, h))
        .filter((e): e is MLeaderEntity => !!e);
      app.clearSelection();
      const sel = all.filter((e) => e.contentType === 1 && !!e.context.block && !!(e.context.block.blockHandle ?? e.blockHandle));
      if (all.length && sel.length < all.length) ctx.print(`블록 내용이 아닌 다중 지시선 ${all.length - sel.length}개는 뺐습니다.`);
      if (sel.length < 2) {
        ctx.print('블록 내용이 있는 다중 지시선을 둘 이상 선택하십시오.', 'err');
        return;
      }
      let layoutMode: Parameters<typeof collectLayout>[1] = { kind: 'H' };
      let at: Pt | null = null;
      while (!at) {
        const r = await ctx.getPoint('다중 지시선 배치 지정 또는 [수직(V)/수평(H)/줄바꿈(W)] <수평>:', {
          keywords: [
            { key: 'V', label: '수직' },
            { key: 'H', label: '수평' },
            { key: 'W', label: '줄바꿈' },
          ],
        });
        if ('point' in r) at = r.point;
        else if ('keyword' in r) {
          if (r.keyword === 'V') layoutMode = { kind: 'V' };
          else if (r.keyword === 'H') layoutMode = { kind: 'H' };
          else {
            const w = await ctx.getPoint('줄바꿈 폭 지정 또는 [번호(N)]:', { keywords: [{ key: 'N', label: '번호' }], preferNumber: true });
            if ('keyword' in w) {
              const n = await ctx.getPoint('행당 다중 지시선 수 지정 <3>:', { preferNumber: true });
              layoutMode = { kind: 'W', count: 'text' in n ? Math.max(1, Math.round(Number(n.text)) || 3) : 3 };
            } else if ('text' in w) layoutMode = { kind: 'W', width: Math.max(0, Number(w.text) || 0) };
          }
        } else return;
      }
      // 블록마다 범위와 삽입
      const items = sel.map((e) => {
        const bd = e.context.block!;
        const rh = bd.blockHandle ?? e.blockHandle;
        const blk = [...doc.blocks.values()].find((x) => x.recordHandle === rh);
        const bb = blk ? boundsOf(blk.entities, doc) : null;
        const sx = bd.scale.x || 1;
        const sy = bd.scale.y || 1;
        const box = bb ? { minX: (bb.minX - blk!.basePoint.x) * sx, minY: (bb.minY - blk!.basePoint.y) * sy, w: (bb.maxX - bb.minX) * sx, h: (bb.maxY - bb.minY) * sy } : { minX: 0, minY: 0, w: 1, h: 1 };
        return { e, blk, bd, box };
      });
      if (items.some((i) => !i.blk)) {
        ctx.print('블록 정의를 찾을 수 없는 다중 지시선이 있습니다.', 'err');
        return;
      }
      const gap = Math.max(...items.map((i) => Math.max(i.box.w, i.box.h))) * 0.1;
      const pos = collectLayout(
        items.map((i) => ({ w: i.box.w, h: i.box.h })),
        layoutMode,
        gap,
      );
      // 새 블록(MLEADER_COLLECT_n): 블록 참조들
      let n = 1;
      while (doc.blocks.has(tableKey(`MLEADER_COLLECT_${n}`))) n++;
      const name = `MLEADER_COLLECT_${n}`;
      const recordHandle = st.session.newHandle();
      const inserts: InsertEntity[] = items.map((it, i) => ({
        ...entityDefaults(),
        layer: '0',
        color: { aci: 0 },
        type: 'INSERT',
        block: it.blk!.name,
        insert: { x: pos[i]!.x - it.box.minX, y: pos[i]!.y - it.box.minY, z: 0 },
        scale: { ...it.bd.scale },
        rotation: it.bd.rotation,
        columnCount: 1,
        rowCount: 1,
        columnSpacing: 0,
        rowSpacing: 0,
        attribs: [],
      }));
      const def: BlockDef = { name, handle: '', recordHandle, basePoint: { x: 0, y: 0, z: 0 }, flags: 0, entities: inserts };
      // 첫 다중 지시선이 모은 내용을 지닌다
      const first = items[0]!;
      const moved = translateContent(first.e, { x: at.x - first.bd.location.x, y: at.y - first.bd.location.y });
      const blk = moved.context.block!;
      blk.blockHandle = recordHandle;
      blk.scale = { x: 1, y: 1, z: 1 };
      blk.rotation = 0;
      delete blk.matrix;
      moved.blockHandle = recordHandle;
      moved.blockScale = { x: 1, y: 1, z: 1 };
      moved.blockRotation = 0;
      moved.blockAttributes = undefined;
      commitResults(app, ctx, [{ replace: [moved], remove: items.slice(1).map((i) => i.e.handle), blocks: [def] }], 'MLEADERCOLLECT', { quiet: true });
    },
  });

  // ------------------------------------------------------------- MLEADERSTYLE
  app.register({
    name: 'MLEADERSTYLE',
    aliases: ['MLS'],
    title: '다중 지시선 스타일',
    run: (ctx) => mleaderStyleManager(app, ctx),
  });
}

// ---------------------------------------------------------------------------
// MLEADERSTYLE 관리자
// ---------------------------------------------------------------------------

function mleaderDict(app: App): DictionaryObject | null {
  const doc = app.active!.doc;
  const root = doc.rootDictionary ? doc.objects.get(doc.rootDictionary) : undefined;
  if (root?.type !== 'DICTIONARY' && root?.type !== 'ACDBDICTIONARYWDFLT') return null;
  const h = (root as DictionaryObject).entries.get('ACAD_MLEADERSTYLE');
  const d = h ? doc.objects.get(h) : undefined;
  return d && (d.type === 'DICTIONARY' || d.type === 'ACDBDICTIONARYWDFLT') ? (d as DictionaryObject) : null;
}

function styles(app: App): MLeaderStyleObject[] {
  return [...app.active!.doc.objects.values()].filter((o): o is MLeaderStyleObject => o.type === 'MLEADERSTYLE').sort((a, b) => a.name.localeCompare(b.name));
}

async function editStyleDialog(app: App, s: MLeaderStyleObject, title: string): Promise<StyleValues | null> {
  const doc = app.active!.doc;
  const tstyles = [...doc.textStyles.values()];
  const gapRaw = Number(s.raw?.find((t) => t.code === 143)?.value);
  const v = await form(
    title,
    [
      {
        key: 'leaderLineType',
        label: '지시선 유형',
        type: 'select',
        value: String(s.leaderLineType),
        options: [
          { value: '1', label: '직선' },
          { value: '2', label: '스플라인' },
          { value: '0', label: '없음' },
        ],
      },
      { key: 'arrowSize', label: '화살촉 크기', type: 'number', value: s.arrowSize },
      { key: 'breakGap', label: '끊기 크기', type: 'number', value: Number.isFinite(gapRaw) ? gapRaw : 3.75 },
      { key: 'landing', label: '연결선 자동 포함', type: 'check', value: s.landing },
      { key: 'doglegLength', label: '연결선 거리', type: 'number', value: s.doglegLength },
      {
        key: 'contentType',
        label: '다중 지시선 유형(내용)',
        type: 'select',
        value: String(s.contentType),
        options: [
          { value: '2', label: '여러 줄 문자' },
          { value: '1', label: '블록' },
          { value: '0', label: '없음' },
        ],
      },
      { key: 'textStyle', label: '문자 스타일', type: 'select', value: tstyles.find((t) => t.handle === s.textStyleHandle)?.handle ?? tstyles[0]?.handle ?? '', options: tstyles.map((t) => ({ value: t.handle, label: t.name })) },
      { key: 'textHeight', label: '문자 높이', type: 'number', value: s.textHeight },
      { key: 'landingGap', label: '연결선 간격', type: 'number', value: s.landingGap },
      { key: 'scale', label: '축척', type: 'number', value: s.scale },
    ],
    {
      ok: '확인',
      validate: (x) => {
        for (const k of ['arrowSize', 'doglegLength', 'textHeight', 'landingGap', 'breakGap'] as const) if (Number(x[k]) < 0) return '크기는 0 이상이어야 합니다.';
        return Number(x.scale) > 0 ? null : '축척은 0보다 커야 합니다.';
      },
    },
  );
  if (!v) return null;
  return {
    leaderLineType: Number(v.leaderLineType),
    arrowSize: Number(v.arrowSize),
    breakGap: Number(v.breakGap),
    landing: !!v.landing,
    doglegLength: Number(v.doglegLength),
    contentType: Number(v.contentType),
    textStyleHandle: String(v.textStyle) || undefined,
    textHeight: Number(v.textHeight),
    landingGap: Number(v.landingGap),
    scale: Number(v.scale),
  };
}

function mleaderStyleManager(app: App, ctx: CommandContext): Promise<void> {
  return new Promise((resolve) => {
    const st = app.active!;
    const doc = st.doc;
    const list = h('select', { size: 8, 'aria-label': '스타일', style: 'width:100%;min-width:240px' });
    const info = h('div', { style: 'margin-top:8px;color:var(--text-dim);min-height:2.6em' });
    const status = h('div', { role: 'status', style: 'margin-top:6px;min-height:1.3em' });
    const current = () => currentMLeaderStyle(doc);
    const fill = (pick?: string) => {
      const cur = current();
      list.innerHTML = '';
      for (const s of styles(app)) list.append(h('option', { value: s.handle }, `${s.name}${cur?.handle === s.handle ? '  (현재)' : ''}`));
      list.value = pick ?? cur?.handle ?? list.options[0]?.value ?? '';
      describe();
    };
    const selected = (): MLeaderStyleObject | null => {
      const o = doc.objects.get(list.value);
      return o?.type === 'MLEADERSTYLE' ? (o as MLeaderStyleObject) : null;
    };
    const describe = () => {
      const s = selected();
      info.textContent = s ? `내용: ${s.contentType === 2 ? '여러 줄 문자' : s.contentType === 1 ? '블록' : '없음'}, 문자 높이 ${s.textHeight}, 화살촉 크기 ${s.arrowSize}, 연결선 ${s.landing ? s.doglegLength : '없음'}, 축척 ${s.scale}` : '';
    };
    list.addEventListener('change', describe);
    const say = (t: string): void => {
      status.textContent = t;
    };
    const setCurrent = () => {
      const s = selected();
      if (!s) return;
      st.session.commit({ label: 'MLEADERSTYLE', ops: [{ kind: 'header', name: '$CMLEADERSTYLE', before: doc.header.get('$CMLEADERSTYLE'), after: s.name }], group: ctx.group });
      say(`현재 다중 지시선 스타일: ${s.name}`);
      fill(s.handle);
    };
    const create = async () => {
      const dict = mleaderDict(app);
      if (!dict) {
        say('이 도면에는 다중 지시선 스타일 사전이 없어 새 스타일을 만들 수 없습니다.');
        return;
      }
      const all = styles(app);
      const v = await form('새 다중 지시선 스타일 작성', [
        { key: 'name', label: '새 스타일 이름', type: 'text', value: `${selected()?.name ?? 'Standard'}의 복사본` },
        { key: 'base', label: '시작', type: 'select', value: selected()?.handle ?? all[0]?.handle ?? '', options: all.map((s) => ({ value: s.handle, label: s.name })) },
      ], {
        ok: '계속',
        validate: (x) => {
          const nm = String(x.name).trim();
          if (!nm) return '이름을 입력하십시오.';
          if (/[<>/\\":;?*|,=`]/.test(nm)) return '이름에 쓸 수 없는 문자가 있습니다.';
          if ([...dict.entries.keys()].some((k) => k.toUpperCase() === nm.toUpperCase())) return '같은 이름의 스타일이 있습니다.';
          return null;
        },
      });
      if (!v) return;
      const bo = doc.objects.get(String(v.base));
      if (bo?.type !== 'MLEADERSTYLE') return;
      const base = bo as MLeaderStyleObject;
      const nm = String(v.name).trim();
      const vals = await editStyleDialog(app, base, `다중 지시선 스타일 수정: ${nm}`);
      if (!vals) return;
      const ns = updateStyle(copyStyle(base, nm, st.session.newHandle(), dict.handle), vals);
      const nd: DictionaryObject = { ...dict, entries: new Map([...dict.entries, [nm, ns.handle]]) };
      st.session.commit({
        label: 'MLEADERSTYLE',
        ops: [
          { kind: 'object', key: ns.handle, before: null, after: ns },
          { kind: 'object', key: dict.handle, before: dict, after: nd },
        ],
        group: ctx.group,
      });
      say(`스타일 ${nm}을(를) 만들었습니다.`);
      fill(ns.handle);
    };
    const modify = async () => {
      const s = selected();
      if (!s) return;
      const vals = await editStyleDialog(app, s, `다중 지시선 스타일 수정: ${s.name}`);
      if (!vals) return;
      const ns = updateStyle(s, vals);
      st.session.commit({ label: 'MLEADERSTYLE', ops: [{ kind: 'object', key: s.handle, before: s, after: ns }], group: ctx.group });
      say(`스타일 ${s.name}을(를) 고쳤습니다. 이미 있는 다중 지시선은 그대로입니다.`);
      fill(s.handle);
    };
    const remove = (): void => {
      const s = selected();
      if (!s) return;
      const why = s.name.toUpperCase() === 'STANDARD' ? 'Standard 스타일은 삭제할 수 없습니다.' : current()?.handle === s.handle ? '현재 스타일은 삭제할 수 없습니다.' : styleInUse(doc, s.handle) ? '사용 중인 스타일은 삭제할 수 없습니다.' : '';
      if (why) {
        say(why);
        return;
      }
      const dict = mleaderDict(app);
      const ops: EditOp[] = [{ kind: 'object', key: s.handle, before: s, after: null }];
      if (dict) {
        const entries = new Map([...dict.entries].filter(([, hh]) => hh !== s.handle));
        ops.push({ kind: 'object', key: dict.handle, before: dict, after: { ...dict, entries } });
      }
      st.session.commit({ label: 'MLEADERSTYLE', ops, group: ctx.group });
      say(`스타일 ${s.name}을(를) 삭제했습니다.`);
      fill();
    };
    const btn = (label: string, run: () => void | Promise<void>) => h('button', { class: 'btn', style: 'display:block;width:100%;margin-bottom:6px', onclick: () => void run() }, label);
    const body = h(
      'div',
      { style: 'display:flex;gap:12px;align-items:flex-start' },
      h('div', { style: 'flex:1' }, h('div', { style: 'margin-bottom:4px' }, '스타일:'), list, info, status),
      h('div', { style: 'width:130px' }, btn('현재로 설정', setCurrent), btn('새로 만들기...', create), btn('수정...', modify), btn('삭제', remove)),
    );
    const back = dialog('다중 지시선 스타일 관리자', body, [{ label: '닫기', primary: true }]);
    fill();
    new MutationObserver((_, obs) => {
      if (!document.body.contains(back)) {
        obs.disconnect();
        resolve();
      }
    }).observe(document.body, { childList: true });
  });
}
