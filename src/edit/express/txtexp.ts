/**
 * TXTEXP(Express Tools 문자 분해) 계산(UI 없음).
 * 한 줄 문자·여러 줄 문자·속성 정의·원호 정렬 문자를 화면과 같은 글꼴의 글자 모양으로 나눈다:
 * - 단선 글꼴(SHX 대신 쓰는 글꼴): 획마다 열린 폴리선
 * - 윤곽 글꼴(트루타입 대신 쓰는 글꼴): 윤곽마다 닫힌 폴리선
 * - 밑줄·윗줄·취소선: 선
 * 결과는 문자의 도면층·색·선종류·선가중치·투명도를 잇고, WCS 평면도에 문자 고도로 놓인다.
 */
import type { ArcTextEntity, AttribEntity, CadDocument, Entity, LineEntity, LwPolylineEntity, MTextEntity } from '../../core/model';
import { tableKey } from '../../core/model';
import type { TextEngine, TextLayout } from '../../text/layout';
import { arcTextParts } from '../../text/arctext';
import { type Affine, affApply, affMul, cross3, norm3 } from '../geom/math';
import { isPlanarExt, planProj, planZ } from '../geom/ocs';
import { inherit } from '../geom/path';
import { isTextLike } from '../geom/textjust';
import { mtextDir } from '../geom/xtext';

/** TXTEXP를 받는 객체 */
export function isExplodableText(e: Entity): boolean {
  if (e.type === 'TEXT' || e.type === 'MTEXT' || e.type === 'ATTDEF' || e.type === 'ARCALIGNEDTEXT') return isPlanarExt(e.extrusion);
  return false;
}

type Engine = Pick<TextEngine, 'layoutText' | 'layoutMText'>;

function textLayout(e: Entity, doc: CadDocument, engine: Engine): { lay: TextLayout; world: Affine; z: number } | null {
  if (isTextLike(e)) {
    const style = doc.textStyles.get(tableKey(e.style));
    const att = e.type === 'ATTDEF' ? (e as AttribEntity) : null;
    const text = att ? att.text || att.tag : e.text;
    if (att?.mtext) return textLayout({ ...att.mtext, layer: e.layer } as MTextEntity, doc, engine);
    const lay = engine.layoutText({
      text,
      insert: e.insert,
      alignPoint: e.alignPoint,
      height: e.height,
      rotation: e.rotation,
      widthFactor: e.widthFactor,
      oblique: e.oblique,
      generation: e.generation,
      halign: e.halign,
      valign: e.valign,
      style,
    });
    return { lay, world: planProj(e.extrusion, e.insert.z), z: planZ(e.extrusion, e.insert.z) };
  }
  if (e.type === 'MTEXT') {
    const lay = engine.layoutMText({
      text: e.text,
      height: e.height,
      width: e.width,
      attachment: e.attachment,
      lineSpacingStyle: e.lineSpacingStyle,
      lineSpacingFactor: e.lineSpacingFactor,
      style: doc.textStyles.get(tableKey(e.style)),
      columns: e.columns && e.columns.count > 1 ? e.columns : undefined,
      rectHeight: e.rectHeight,
    });
    const n = norm3(e.extrusion ?? { x: 0, y: 0, z: 1 });
    const ux = mtextDir(e);
    const uy = norm3(cross3(n, ux));
    return { lay, world: [ux.x, ux.y, uy.x, uy.y, e.insert.x, e.insert.y], z: e.insert.z };
  }
  return null;
}

/** 점 목록에서 같은 점이 이어진 것을 뺀다 */
function dedupe(pts: number[], closed: boolean, tol: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = pts[i]!;
    const y = pts[i + 1]!;
    const n = out.length;
    if (n >= 2 && Math.abs(out[n - 2]! - x) <= tol && Math.abs(out[n - 1]! - y) <= tol) continue;
    out.push(x, y);
  }
  if (closed && out.length >= 4) {
    const n = out.length;
    if (Math.abs(out[0]! - out[n - 2]!) <= tol && Math.abs(out[1]! - out[n - 1]!) <= tol) out.splice(n - 2, 2);
  }
  return out;
}

/** 문자 하나를 글자 모양 객체로(핸들 ''). 나눌 수 없거나 그릴 글자가 없으면 빈 배열 */
export function explodeTextGeometry(e: Entity, doc: CadDocument, engine: Engine): Entity[] {
  if (!isExplodableText(e)) return [];
  if (e.type === 'ARCALIGNEDTEXT') return arcTextParts(e as ArcTextEntity).flatMap((p) => explodeTextGeometry(p, doc, engine));
  const r = textLayout(e, doc, engine);
  if (!r) return [];
  const { lay, world, z } = r;
  const props = inherit(e);
  delete props.thickness;
  const scale = Math.sqrt(Math.abs(world[0] * world[3] - world[1] * world[2])) || 1;
  const out: Entity[] = [];
  const poly = (flat: ArrayLike<number>, m: Affine, closed: boolean) => {
    const pts: number[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const p = affApply(m, { x: flat[i]!, y: flat[i + 1]! });
      pts.push(p.x, p.y);
    }
    const tol = 1e-9 * Math.max(1, scale * (lay.maxY - lay.minY || 1));
    const q = dedupe(pts, closed, tol);
    if (q.length < 4) return;
    if (closed && q.length < 6) closed = false;
    const lw: LwPolylineEntity = {
      ...props,
      handle: '',
      type: 'LWPOLYLINE',
      verts: [],
      widths: undefined,
      closed,
      plinegen: false,
      constantWidth: 0,
      elevation: z,
    };
    for (let i = 0; i + 1 < q.length; i += 2) lw.verts.push(q[i]!, q[i + 1]!, 0);
    out.push(lw);
  };
  for (const g of lay.glyphs) {
    const m = affMul(world, g.m);
    if (g.geom.strokes) for (const s of g.geom.strokes) poly(s, m, false);
    else if (g.geom.contours) for (const c of g.geom.contours) poly(c, m, true);
  }
  for (const l of lay.lines) {
    const a = affApply(world, { x: l.x0, y: l.y0 });
    const b = affApply(world, { x: l.x1, y: l.y1 });
    if (Math.hypot(b.x - a.x, b.y - a.y) <= 1e-12) continue;
    const ln: LineEntity = { ...props, handle: '', type: 'LINE', start: { x: a.x, y: a.y, z }, end: { x: b.x, y: b.y, z } };
    out.push(ln);
  }
  return out;
}
