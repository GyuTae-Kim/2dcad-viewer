/**
 * 치수·표 명령(AutoCAD 2026 한국어판 프롬프트):
 * - DIMCENTER(DCE): 고른 원·호에 DIMCEN 설정대로 중심 표식·중심선을 LINE 객체로 그린다(CENTERMARK와 달리 연관 없음).
 * - DIMHORIZONTAL·DIMVERTICAL: 수평·수직으로 고정한 선형 치수(DIMLINEAR의 H·V 옵션 바로가기).
 * - TABLEEXPORT: 표를 CSV(쉼표 구분, UTF-8)로 내려받는다.
 * - MATCHCELL: 원본 셀의 특성(정렬)을 대상 셀들에 옮긴다.
 */
import type { CircleEntity, DimensionEntity, Entity, LineEntity, Vec3 } from '../core/model';
import { entityDefaults } from '../core/model';
import { dimVars } from '../edit/dim/vars';
import { createLinearDimension } from '../edit/dim';
import { OSNAP, type PointRef } from '../edit/dim/assoc';
import { dimCenterSegments } from '../edit/editcmds2/dimcenter';
import { csvFileText, effectiveAlign, matchCellAlign } from '../edit/editcmds2/table';
import { isEditableTable, tableFromEntity } from '../edit/table/entity';
import { cellName } from '../edit/table/model';
import type { App, CommandContext, Keyword } from './app';
import { objectRef, pointRef } from './dimassoc';
import { type DimOpts, addDimension, originsFromEntity, preview, textOption } from './dimcmds';
import { addEntities, currentProps } from './draw';
import { baseName, download } from './export';
import { commitTable, lockedLayer, pickCell } from './tablecmds';
import { currentUcs } from './ucs';
import type { Pt } from './view';

const v3 = (p: Pt): Vec3 => ({ x: p.x, y: p.y, z: 0 });

/** 지금 DIMCEN(머리말의 현재 값, 없으면 현재 치수 스타일) × DIMSCALE */
export function currentDimCen(app: App): number {
  const doc = app.active!.doc;
  const hc = doc.header.get('$DIMCEN');
  const hs = doc.header.get('$DIMSCALE');
  const style = String(doc.header.get('$DIMSTYLE') ?? 'Standard') || 'Standard';
  const v = dimVars(doc, { dimStyle: style });
  const cen = typeof hc === 'number' ? hc : v.cen / (v.scale || 1);
  const scale = typeof hs === 'number' && hs > 0 ? hs : v.scale || 1;
  return cen * scale;
}

export function registerEditCmds2Dim(app: App): void {
  // ------------------------------------------------------------- DIMCENTER
  app.register({
    name: 'DIMCENTER',
    aliases: ['DCE'],
    title: '중심 표식(DIMCEN)',
    async run(ctx) {
      const st = app.active!;
      for (;;) {
        const r = await ctx.getEntity('호 또는 원 선택:');
        if (!('handle' in r)) return;
        const e = st.doc.entityIndex.get(r.handle);
        if (e?.type !== 'CIRCLE' && e?.type !== 'ARC') {
          ctx.print('호 또는 원을 선택하십시오.', 'err');
          continue;
        }
        const c = e as CircleEntity;
        const cen = currentDimCen(app);
        if (!cen) {
          ctx.print('DIMCEN이 0이어서 중심 표식을 그리지 않습니다.');
          return;
        }
        const segs = dimCenterSegments({ x: c.center.x, y: c.center.y }, c.radius, cen, currentUcs(st).angle);
        const props = currentProps(app);
        const z = c.center.z || 0;
        const lines: Entity[] = segs.map(([a, b]) => ({ ...entityDefaults(), ...props, type: 'LINE', handle: '', start: { x: a.x, y: a.y, z }, end: { x: b.x, y: b.y, z } }) as LineEntity);
        app.lastCreated = addEntities(app, ctx, lines, 'DIMCENTER');
        return;
      }
    },
  });

  // ------------------------------------------------------------- DIMHORIZONTAL·DIMVERTICAL
  const fixedLinear = (rotation: number, label: string) => async (ctx: CommandContext) => {
    const st = app.active!;
    const doc = st.doc;
    let p1: Pt;
    let p2: Pt;
    let refs: (PointRef | null)[] = [];
    const r1 = await ctx.getPoint('첫 번째 치수보조선 원점 지정 또는 <객체 선택>:');
    if ('enter' in r1) {
      const pick = await ctx.getEntity('치수기입할 객체 선택:');
      if (!('handle' in pick)) return;
      const picked = doc.entityIndex.get(pick.handle);
      const o = originsFromEntity(picked, pick.point);
      if (!o) {
        ctx.print('선, 호, 폴리선 세그먼트를 선택하십시오.', 'err');
        return;
      }
      [p1, p2] = o;
      refs = [objectRef(app, picked, OSNAP.END, p1), objectRef(app, picked, OSNAP.END, p2)];
    } else if ('point' in r1) {
      p1 = r1.point;
      const ref1 = pointRef(app, r1);
      const r2 = await ctx.getPoint('두 번째 치수보조선 원점 지정:', { base: p1 });
      if (!('point' in r2)) return;
      p2 = r2.point;
      refs = [ref1, pointRef(app, r2)];
    } else return;
    const o: DimOpts = {};
    const kws: Keyword[] = [
      { key: 'M', label: '여러 줄 문자' },
      { key: 'T', label: '문자' },
    ];
    for (;;) {
      const make = (p: Pt): DimensionEntity => createLinearDimension(doc, v3(p1), v3(p2), v3(p), { text: o.text, rotation });
      const r = await ctx.getPoint('치수선의 위치 지정 또는 [여러 줄 문자(M)/문자(T)]:', { keywords: kws, ghost: preview(app, make) });
      if ('point' in r) {
        addDimension(app, ctx, make(r.point), label, refs);
        return;
      }
      if (!('keyword' in r)) return;
      await textOption(ctx, r.keyword, o);
    }
  };
  app.register({ name: 'DIMHORIZONTAL', title: '수평 선형 치수', run: fixedLinear(0, 'DIMHORIZONTAL') });
  app.register({ name: 'DIMVERTICAL', title: '수직 선형 치수', run: fixedLinear(Math.PI / 2, 'DIMVERTICAL') });

  // ------------------------------------------------------------- TABLEEXPORT
  app.register({
    name: 'TABLEEXPORT',
    title: '테이블 내보내기',
    async run(ctx) {
      const st = app.active!;
      for (;;) {
        const r = await ctx.getEntity('표 선택:');
        if (!('handle' in r)) return;
        const e = st.doc.entityIndex.get(r.handle);
        const t = isEditableTable(e) ? tableFromEntity(e, st.doc) : null;
        if (!t) {
          ctx.print('표가 아닙니다.', 'err');
          continue;
        }
        const name = `${baseName(st.name.replace(/^.*[\\/]/, '')) || 'table'}.csv`;
        download(new Blob([csvFileText(t.data)], { type: 'text/csv;charset=utf-8' }), name);
        ctx.print(`표(${t.data.rows}행 × ${t.data.cols}열)를 ${name}(으)로 내보냈습니다.`);
        return;
      }
    },
  });

  // ------------------------------------------------------------- MATCHCELL
  app.register({
    name: 'MATCHCELL',
    title: '셀 일치',
    async run(ctx) {
      const src = await pickCell(app, ctx, '원본 셀 선택:');
      if (!src || 'keyword' in src) return;
      const align = effectiveAlign(src.data, src.style, src.cell!.r, src.cell!.c);
      let n = 0;
      for (;;) {
        const dst = await pickCell(app, ctx, '대상 셀 선택:');
        if (!dst || 'keyword' in dst) break;
        if (lockedLayer(app, dst.entity)) continue;
        const next = matchCellAlign(dst.data, dst.style, dst.cell!, align);
        if (!next) continue;
        commitTable(app, dst, next, 'MATCHCELL', ctx.group);
        n++;
      }
      if (n) ctx.print(`셀 ${n}개에 ${cellName(src.cell!.r, src.cell!.c)} 셀의 특성을 적용했습니다.`);
    },
  });
}
