/** 객체 특성·측정값(특성 창, LIST, 치수 목록) */
import type { CadColor, CadDocument, DimensionEntity, Entity, HatchEntity } from '../core/model';
import { tableKey } from '../core/model';
import { DIM_VAR_CODES, DIM_VAR_DEFAULTS } from '../core/dimvars';
import { type UnitSettings, formatAngle, formatLength } from '../core/units';
import { bulgeArc, ccwSweep, interpolateFitPoints, nurbsPoints, TAU } from '../geom/curves';
import { hatchLoops } from '../render/hatch';
import { decodePercent } from '../text/mtext';
import { definitionName } from '../edit/dynblock';

export const TYPE_NAMES: Record<string, string> = {
  LINE: '선',
  POINT: '점',
  CIRCLE: '원',
  ARC: '호',
  ELLIPSE: '타원',
  LWPOLYLINE: '폴리선',
  POLYLINE: '폴리선(2D/3D)',
  SPLINE: '스플라인',
  XLINE: '구성선',
  RAY: '광선',
  TEXT: '문자',
  ATTRIB: '속성',
  ATTDEF: '속성 정의',
  MTEXT: '여러 줄 문자',
  INSERT: '블록 참조',
  DIMENSION: '치수',
  LEADER: '지시선',
  MULTILEADER: '다중 지시선',
  HATCH: '해치',
  MPOLYGON: '다각형 해치',
  SOLID: '2D 솔리드',
  TRACE: '트레이스',
  '3DFACE': '3D 면',
  IMAGE: '래스터 이미지',
  WIPEOUT: '가리기',
  VIEWPORT: '뷰포트',
  MLINE: '여러 줄',
  TOLERANCE: '공차',
  SHAPE: '모양',
  ACAD_TABLE: '표',
  MESH: '메시',
  REGION: '영역',
  '3DSOLID': '3D 솔리드',
  BODY: '본체',
  OLE2FRAME: 'OLE 객체',
  OLEFRAME: 'OLE 객체',
  PDFUNDERLAY: 'PDF 언더레이',
  DWFUNDERLAY: 'DWF 언더레이',
  DGNUNDERLAY: 'DGN 언더레이',
  UNKNOWN: '사용자 객체',
};

export function typeName(e: Entity): string {
  if (e.type === 'UNKNOWN') return `${TYPE_NAMES.UNKNOWN} (${e.originalType})`;
  if (e.type === 'SPLINE' && e.helix) return '나선';
  if (e.type === 'DIMENSION') return `치수 (${dimTypeName(e)})`;
  return TYPE_NAMES[e.type] ?? e.type;
}

export function dimTypeName(d: DimensionEntity): string {
  if (d.subtype === 'ARC_DIMENSION') return '호 길이';
  if (d.subtype === 'LARGE_RADIAL_DIMENSION') return '꺾기';
  switch (d.dimType & 7) {
    case 0:
      return Math.abs(Math.sin(d.rotation)) < 1e-9 ? '선형(수평)' : Math.abs(Math.cos(d.rotation)) < 1e-9 ? '선형(수직)' : '선형(회전)';
    case 1:
      return '정렬';
    case 2:
      return '각도';
    case 3:
      return '지름';
    case 4:
      return '반지름';
    case 5:
      return '3점 각도';
    case 6:
      return d.dimType & 64 ? '세로좌표(X)' : '세로좌표(Y)';
    default:
      return '치수';
  }
}

export function colorText(c: CadColor): string {
  if (c.rgb !== undefined && c.aci !== 0 && !(c.aci === 256 && c.rgb === 0)) {
    const r = (c.rgb >> 16) & 255;
    const g = (c.rgb >> 8) & 255;
    const b = c.rgb & 255;
    return `${r},${g},${b}${c.name ? ` (${c.name})` : ''}`;
  }
  if (c.aci === 256) return 'ByLayer';
  if (c.aci === 0) return 'ByBlock';
  const names: Record<number, string> = { 1: '빨간색', 2: '노란색', 3: '초록색', 4: '하늘색', 5: '파란색', 6: '선홍색', 7: '흰색' };
  return names[c.aci] ?? `색상 ${c.aci}`;
}

export function lineweightText(lw: number): string {
  if (lw === -1) return 'ByLayer';
  if (lw === -2) return 'ByBlock';
  if (lw < 0) return '기본값';
  return `${(lw / 100).toFixed(2)} mm`;
}

export function transparencyText(t: number): string {
  if (t === -1) return 'ByLayer';
  if (t === -2) return 'ByBlock';
  return `${Math.round((1 - t / 255) * 100)}`;
}

// ---------------------------------------------------------------------------
// 길이·면적
// ---------------------------------------------------------------------------

export interface Bulged {
  x: number;
  y: number;
  bulge: number;
}

export function polyLength(vs: readonly Bulged[], closed: boolean): number {
  let L = 0;
  const n = vs.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = vs[i]!;
    const b = vs[(i + 1) % n]!;
    const arc = bulgeArc(a.x, a.y, b.x, b.y, a.bulge);
    L += arc ? Math.abs(arc.sweep) * arc.r : Math.hypot(b.x - a.x, b.y - a.y);
  }
  return L;
}

/** 볼록도를 포함한 닫힌 폴리선 면적(부호 있음) */
export function polyArea(vs: readonly Bulged[]): number {
  const n = vs.length;
  let A = 0;
  for (let i = 0; i < n; i++) {
    const a = vs[i]!;
    const b = vs[(i + 1) % n]!;
    A += a.x * b.y - b.x * a.y;
  }
  A /= 2;
  for (let i = 0; i < n; i++) {
    const a = vs[i]!;
    const b = vs[(i + 1) % n]!;
    const arc = bulgeArc(a.x, a.y, b.x, b.y, a.bulge);
    if (!arc) continue;
    const th = Math.abs(arc.sweep);
    const seg = (arc.r * arc.r * (th - Math.sin(th))) / 2;
    A += a.bulge > 0 ? seg : -seg;
  }
  return A;
}

export function ringArea(pts: readonly number[]): number {
  let A = 0;
  for (let i = 0, n = pts.length; i < n; i += 2) {
    const j = (i + 2) % n;
    A += pts[i]! * pts[j + 1]! - pts[j]! * pts[i + 1]!;
  }
  return A / 2;
}

export function ringPerimeter(pts: readonly number[], closed = true): number {
  let L = 0;
  const n = pts.length;
  for (let i = 0; i + 3 < n; i += 2) L += Math.hypot(pts[i + 2]! - pts[i]!, pts[i + 3]! - pts[i + 1]!);
  if (closed && n >= 4) L += Math.hypot(pts[0]! - pts[n - 2]!, pts[1]! - pts[n - 1]!);
  return L;
}

/** 해치 면적: 홀짝 규칙(바깥 고리 − 구멍) */
export function hatchArea(h: HatchEntity): number {
  const loops = hatchLoops(h, 1e-6 + 0.0005 * Math.max(1, Math.abs(h.patternScale)));
  // 깊이 = 다른 고리 안에 든 횟수
  let total = 0;
  for (let i = 0; i < loops.length; i++) {
    const l = loops[i]!;
    const x = (l[0]! + l[2]!) / 2;
    const y = (l[1]! + l[3]!) / 2;
    let depth = 0;
    for (let j = 0; j < loops.length; j++) if (j !== i && inside(x, y, loops[j]!)) depth++;
    const a = Math.abs(ringArea(l));
    total += depth % 2 === 0 ? a : -a;
  }
  return Math.abs(total);
}

function inside(x: number, y: number, c: readonly number[]): boolean {
  let r = false;
  for (let i = 0, n = c.length, j = n - 2; i < n; j = i, i += 2) {
    const xi = c[i]!;
    const yi = c[i + 1]!;
    const xj = c[j]!;
    const yj = c[j + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) r = !r;
  }
  return r;
}

export function ellipsePerimeter(a: number, b: number): number {
  // 라마누잔 근사
  const h = ((a - b) * (a - b)) / ((a + b) * (a + b));
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

function splineLength(e: Extract<Entity, { type: 'SPLINE' }>): number {
  let pts: number[];
  if (e.controlPoints.length >= 2) pts = nurbsPoints(e.degree, e.knots, e.controlPoints, e.weights, 1e-6);
  else if (e.fitPoints.length >= 2) {
    const s = interpolateFitPoints(e.fitPoints, e.startTangent, e.endTangent);
    pts = nurbsPoints(s.degree, s.knots, s.ctrl, undefined, 1e-6);
  } else return 0;
  let L = 0;
  for (let i = 3; i + 2 < pts.length; i += 3) L += Math.hypot(pts[i]! - pts[i - 3]!, pts[i + 1]! - pts[i - 2]!, pts[i + 2]! - pts[i - 1]!);
  return L;
}

// ---------------------------------------------------------------------------
// 치수
// ---------------------------------------------------------------------------

export function dimVars(doc: CadDocument, d: { dimStyle: string; overrides?: Record<number, string | number> }): Record<string, number | string> {
  const out: Record<string, number | string> = { ...DIM_VAR_DEFAULTS };
  for (const [k, v] of doc.header) if (k.startsWith('$DIM')) out[k.slice(1)] = v as number | string;
  const ds = doc.dimStyles.get(tableKey(d.dimStyle));
  if (ds) Object.assign(out, ds.vars);
  if (d.overrides) for (const [code, v] of Object.entries(d.overrides)) {
    const n = DIM_VAR_CODES[Number(code)];
    if (n) out[n] = v;
  }
  return out;
}

/** 치수 측정값(파일 42가 없으면 정의점으로 계산). 각도는 라디안 */
export function dimMeasurement(d: DimensionEntity): number {
  if (Number.isFinite(d.measurement)) return d.measurement;
  const k = d.dimType & 7;
  const p1 = d.defPoint2;
  const p2 = d.defPoint3;
  if (k === 0) {
    const ux = Math.cos(d.rotation);
    const uy = Math.sin(d.rotation);
    return Math.abs((p2.x - p1.x) * ux + (p2.y - p1.y) * uy);
  }
  if (k === 1) return Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (k === 3) return Math.hypot(d.defPoint4.x - d.defPoint.x, d.defPoint4.y - d.defPoint.y);
  if (k === 4) return Math.hypot(d.defPoint4.x - d.defPoint.x, d.defPoint4.y - d.defPoint.y);
  return NaN;
}

function zeroSuppress(s: string, dimzin: number): string {
  let out = s;
  if (dimzin & 8 && out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '');
  if (dimzin & 4) out = out.replace(/^(-?)0\./, '$1.');
  return out;
}

/** 치수 표시 문자(재지정과 측정값을 합친 것, 서식 코드 제외) */
export function dimDisplayText(doc: CadDocument, d: DimensionEntity): { text: string; value: number; formatted: string; isAngle: boolean } {
  const v = dimVars(doc, d);
  const k = d.dimType & 7;
  const isAngle = d.subtype !== 'ARC_DIMENSION' && (k === 2 || k === 5);
  const m = dimMeasurement(d);
  let formatted: string;
  if (isAngle) {
    const prec = Number(v.DIMADEC ?? 0) >= 0 ? Number(v.DIMADEC) : Number(v.DIMDEC ?? 0);
    formatted = formatAngle(m, { aunits: Number(v.DIMAUNIT ?? 0) === 1 ? 1 : Number(v.DIMAUNIT ?? 0), auprec: prec });
    formatted = zeroSuppress(formatted.replace('°', ''), Number(v.DIMAZIN ?? 0)) + (Number(v.DIMAUNIT ?? 0) === 0 ? '°' : '');
  } else {
    const lfac = Number(v.DIMLFAC ?? 1) || 1;
    let val = m * lfac;
    const rnd = Number(v.DIMRND ?? 0);
    if (rnd > 0) val = Math.round(val / rnd) * rnd;
    const lunit = Number(v.DIMLUNIT ?? 2);
    formatted = formatLength(val, { lunits: lunit === 6 ? 2 : lunit, luprec: Number(v.DIMDEC ?? 4) });
    if (lunit === 2 || lunit === 6) formatted = zeroSuppress(formatted, Number(v.DIMZIN ?? 0));
    const dsep = Number(v.DIMDSEP ?? 46);
    if (dsep && dsep !== 46) formatted = formatted.replace('.', String.fromCharCode(dsep));
    const post = String(v.DIMPOST ?? '');
    if (post) formatted = post.includes('<>') ? post.replace('<>', formatted) : formatted + post;
    if (k === 3) formatted = '%%c' + formatted;
    if (k === 4) formatted = 'R' + formatted;
  }
  let text = d.text;
  if (!text) text = formatted;
  else if (text === ' ') text = '';
  else text = text.replace('<>', formatted);
  return { text: plainText(text), value: m, formatted: plainText(formatted), isAngle };
}

/** MTEXT 서식을 지운 글자 */
export function plainText(s: string): string {
  let t = s
    .replace(/\\P/g, '\n')
    .replace(/\\[Xx]/g, '\n')
    .replace(/\\S([^;]*?)[/#^]([^;]*);/g, '$1/$2')
    .replace(/\\[ACFHQTWfcp][^;]*;/g, '')
    .replace(/\\[LlOoKk~]/g, '')
    .replace(/\\([\\{}])/g, '$1')
    .replace(/[{}]/g, '');
  t = String.fromCodePoint(...decodePercent(t).filter((c) => c >= 0));
  return t;
}

// ---------------------------------------------------------------------------
// 특성 목록
// ---------------------------------------------------------------------------

export interface PropRow {
  k: string;
  v: string;
}
export interface PropGroup {
  title: string;
  rows: PropRow[];
}

export function entityProperties(doc: CadDocument, e: Entity, u: UnitSettings): PropGroup[] {
  const L = (v: number) => formatLength(v, u);
  const A = (v: number) => formatAngle(v, u);
  const P = (p: { x: number; y: number; z?: number }) => `${L(p.x)}, ${L(p.y)}${p.z ? `, ${L(p.z)}` : ''}`;
  const area = (v: number) => formatLength(v, { lunits: u.lunits === 3 || u.lunits === 4 ? 2 : u.lunits, luprec: u.luprec });
  const general: PropRow[] = [
    { k: '종류', v: typeName(e) },
    { k: '도면층', v: e.layer },
    { k: '색상', v: colorText(e.color) },
    { k: '선종류', v: e.linetype },
    { k: '선종류 축척', v: String(+e.ltscale.toFixed(4)) },
    { k: '선가중치', v: lineweightText(e.lineweight) },
    { k: '투명도', v: transparencyText(e.transparency) },
    { k: '핸들', v: e.handle },
  ];
  if (e.thickness) general.push({ k: '두께', v: L(e.thickness) });
  if (e.hyperlink) general.push({ k: '하이퍼링크', v: e.hyperlink.url });
  const geo: PropRow[] = [];
  const misc: PropRow[] = [];
  switch (e.type) {
    case 'LINE': {
      const dx = e.end.x - e.start.x;
      const dy = e.end.y - e.start.y;
      geo.push(
        { k: '시작점', v: P(e.start) },
        { k: '끝점', v: P(e.end) },
        { k: '델타 X', v: L(dx) },
        { k: '델타 Y', v: L(dy) },
        { k: '길이', v: L(Math.hypot(dx, dy, e.end.z - e.start.z)) },
        { k: '각도', v: A(Math.atan2(dy, dx) < 0 ? Math.atan2(dy, dx) + TAU : Math.atan2(dy, dx)) },
      );
      break;
    }
    case 'CIRCLE':
      geo.push(
        { k: '중심', v: P(e.center) },
        { k: '반지름', v: L(e.radius) },
        { k: '지름', v: L(e.radius * 2) },
        { k: '둘레', v: L(e.radius * TAU) },
        { k: '면적', v: area(Math.PI * e.radius * e.radius) },
      );
      break;
    case 'ARC': {
      const sw = ccwSweep(e.startAngle, e.endAngle);
      geo.push(
        { k: '중심', v: P(e.center) },
        { k: '반지름', v: L(e.radius) },
        { k: '시작 각도', v: A(e.startAngle) },
        { k: '끝 각도', v: A(e.endAngle) },
        { k: '사이 각도', v: A(sw) },
        { k: '호 길이', v: L(e.radius * sw) },
        { k: '현 길이', v: L(2 * e.radius * Math.sin(sw / 2)) },
        { k: '면적', v: area((e.radius * e.radius * (sw - Math.sin(sw))) / 2) },
      );
      break;
    }
    case 'ELLIPSE': {
      const a = Math.hypot(e.majorAxis.x, e.majorAxis.y, e.majorAxis.z);
      const b = a * e.ratio;
      const full = Math.abs(e.endParam - e.startParam - TAU) < 1e-9 || Math.abs(e.endParam - e.startParam) < 1e-12;
      geo.push({ k: '중심', v: P(e.center) }, { k: '장축 반지름', v: L(a) }, { k: '단축 반지름', v: L(b) }, { k: '반지름 비율', v: e.ratio.toFixed(4) });
      if (full) geo.push({ k: '둘레', v: L(ellipsePerimeter(a, b)) }, { k: '면적', v: area(Math.PI * a * b) });
      else geo.push({ k: '시작 매개변수', v: A(e.startParam) }, { k: '끝 매개변수', v: A(e.endParam) });
      break;
    }
    case 'LWPOLYLINE': {
      geo.push({ k: '정점 수', v: String(e.vertices.length) }, { k: '닫힘', v: e.closed ? '예' : '아니요' }, { k: '길이', v: L(polyLength(e.vertices, e.closed)) });
      if (e.closed) geo.push({ k: '면적', v: area(Math.abs(polyArea(e.vertices))) });
      if (e.constantWidth) geo.push({ k: '전역 폭', v: L(e.constantWidth) });
      if (e.elevation) geo.push({ k: '고도', v: L(e.elevation) });
      const v0 = e.vertices[0];
      if (v0) geo.push({ k: '첫 정점', v: P(v0) });
      break;
    }
    case 'POLYLINE': {
      const vs = e.vertices.filter((v) => !(v.flags & 16) && !(v.faceIndices && !(v.flags & 64)));
      const closed = (e.flags & 1) !== 0;
      geo.push({ k: '종류', v: { '2d': '2D 폴리선', '3d': '3D 폴리선', mesh: '폴리곤 메시', polyface: '폴리페이스 메시' }[e.kind] });
      geo.push({ k: '정점 수', v: String(vs.length) });
      if (e.kind === '2d') {
        const b = vs.map((v) => ({ x: v.location.x, y: v.location.y, bulge: v.bulge }));
        geo.push({ k: '닫힘', v: closed ? '예' : '아니요' }, { k: '길이', v: L(polyLength(b, closed)) });
        if (closed) geo.push({ k: '면적', v: area(Math.abs(polyArea(b))) });
      } else if (e.kind === '3d') {
        let len = 0;
        for (let i = 1; i < vs.length; i++) len += Math.hypot(vs[i]!.location.x - vs[i - 1]!.location.x, vs[i]!.location.y - vs[i - 1]!.location.y, vs[i]!.location.z - vs[i - 1]!.location.z);
        geo.push({ k: '길이', v: L(len) });
      }
      break;
    }
    case 'SPLINE':
      geo.push(
        { k: '차수', v: String(e.degree) },
        { k: '조정점 수', v: String(e.controlPoints.length) },
        { k: '맞춤점 수', v: String(e.fitPoints.length) },
        { k: '닫힘', v: e.flags & 1 ? '예' : '아니요' },
        { k: '길이', v: L(splineLength(e)) },
      );
      break;
    case 'POINT':
      geo.push({ k: '위치', v: P(e.position) });
      break;
    case 'XLINE':
    case 'RAY':
      geo.push({ k: '기준점', v: P(e.base) }, { k: '방향', v: A(Math.atan2(e.direction.y, e.direction.x)) });
      break;
    case 'TEXT':
    case 'ATTRIB':
    case 'ATTDEF': {
      if ('tag' in e) misc.push({ k: '태그', v: e.tag });
      misc.push(
        { k: '내용', v: plainText(e.text) },
        { k: '문자 스타일', v: e.style },
        { k: '높이', v: L(e.height) },
        { k: '회전', v: A(e.rotation) },
        { k: '폭 비율', v: e.widthFactor.toFixed(4) },
        { k: '기울기', v: A(e.oblique) },
        { k: '자리맞추기', v: justify(e.halign, e.valign) },
      );
      geo.push({ k: '위치', v: P(e.insert) });
      break;
    }
    case 'MTEXT': {
      const st = doc.textStyles.get(tableKey(e.style));
      misc.push(
        { k: '내용', v: plainText(e.text) },
        { k: '문자 스타일', v: e.style },
        { k: '문자 높이', v: L(e.height) },
        { k: '폭', v: e.width ? L(e.width) : '줄바꿈 없음' },
        { k: '부착', v: ['', '위 왼쪽', '위 중심', '위 오른쪽', '중간 왼쪽', '중간 중심', '중간 오른쪽', '아래 왼쪽', '아래 중심', '아래 오른쪽'][e.attachment] ?? String(e.attachment) },
        { k: '줄 간격 비율', v: e.lineSpacingFactor.toFixed(2) },
      );
      if (st) misc.push({ k: '글꼴', v: st.fontFamily || st.font || '-' });
      geo.push({ k: '위치', v: P(e.insert) });
      break;
    }
    case 'INSERT': {
      // 동적 블록 표현(*U…)은 정의 이름을 보이고 표현 블록 이름은 따로 둔다
      let dyn: string | null = null;
      if (/^\*U/i.test(e.block)) {
        try {
          dyn = definitionName(doc, e);
        } catch {
          dyn = null;
        }
      }
      misc.push({ k: '이름', v: dyn ?? e.block });
      if (dyn) misc.push({ k: '표현 블록', v: e.block });
      geo.push(
        { k: '위치', v: P(e.insert) },
        { k: '축척 X', v: e.scale.x.toFixed(4) },
        { k: '축척 Y', v: e.scale.y.toFixed(4) },
        { k: '축척 Z', v: e.scale.z.toFixed(4) },
        { k: '회전', v: A(e.rotation) },
      );
      if (e.columnCount > 1 || e.rowCount > 1) geo.push({ k: '열 × 행', v: `${e.columnCount} × ${e.rowCount}` }, { k: '열 간격', v: L(e.columnSpacing) }, { k: '행 간격', v: L(e.rowSpacing) });
      for (const a of e.attribs) misc.push({ k: `속성 ${a.tag}`, v: plainText(a.text) });
      const b = doc.blocks.get(tableKey(e.block));
      if (b?.description) misc.push({ k: '블록 설명', v: b.description });
      break;
    }
    case 'DIMENSION': {
      const t = dimDisplayText(doc, e);
      misc.push(
        { k: '치수 종류', v: dimTypeName(e) },
        { k: '측정값', v: t.isAngle ? formatAngle(t.value, { aunits: 0, auprec: 4 }) : formatLength(t.value, { lunits: 2, luprec: 4 }) },
        { k: '표시 문자', v: t.text },
        { k: '문자 재지정', v: e.text ? plainText(e.text) : '없음' },
        { k: '치수 스타일', v: e.dimStyle },
      );
      geo.push({ k: '문자 위치', v: P(e.textMid) });
      break;
    }
    case 'HATCH':
    case 'MPOLYGON': {
      misc.push({ k: '무늬', v: e.solid ? 'SOLID' : e.patternName || '-' });
      if (!e.solid) misc.push({ k: '축척', v: e.patternScale.toFixed(4) }, { k: '각도', v: A(e.patternAngle) });
      if (e.gradient) misc.push({ k: '그라데이션', v: e.gradient.name });
      misc.push({ k: '연관', v: e.associative ? '예' : '아니요' }, { k: '경계 수', v: String(e.paths.length) });
      geo.push({ k: '면적', v: area(hatchArea(e)) });
      break;
    }
    case 'VIEWPORT': {
      const k = e.viewHeight > 0 ? e.height / e.viewHeight : 0;
      geo.push({ k: '중심', v: P(e.center) }, { k: '폭', v: L(e.width) }, { k: '높이', v: L(e.height) }, { k: '표준 축척', v: k ? scaleText(k) : '-' });
      break;
    }
    case 'MULTILEADER':
      if (e.context.text) misc.push({ k: '내용', v: plainText(e.context.text.text) });
      misc.push({ k: '지시선 수', v: String(e.context.leaders.length) });
      break;
    case 'LEADER':
      geo.push({ k: '정점 수', v: String(e.vertices.length) });
      break;
    case 'ACAD_TABLE':
      misc.push({ k: '행 × 열', v: `${e.rows} × ${e.columns}` });
      geo.push({ k: '위치', v: P(e.insert) });
      break;
    case 'IMAGE':
    case 'WIPEOUT': {
      const w = Math.hypot(e.uVector.x, e.uVector.y) * e.imageSize.x;
      const h = Math.hypot(e.vVector.x, e.vVector.y) * e.imageSize.y;
      geo.push({ k: '위치', v: P(e.insert) }, { k: '폭', v: L(w) }, { k: '높이', v: L(h) });
      if (e.imageDef) {
        const def = doc.objects.get(e.imageDef) as { fileName?: string } | undefined;
        if (def?.fileName) misc.push({ k: '파일', v: def.fileName });
      }
      break;
    }
    default:
      break;
  }
  const groups: PropGroup[] = [{ title: '일반', rows: general }];
  if (geo.length) groups.push({ title: '형상', rows: geo });
  if (misc.length) groups.push({ title: e.type === 'INSERT' ? '기타·속성' : '문자·기타', rows: misc });
  return groups;
}

function justify(h: number, v: number): string {
  if (h === 3) return '정렬';
  if (h === 5) return '맞춤';
  if (h === 4) return '중간';
  const hv = ['왼쪽', '중심', '오른쪽'][h] ?? '왼쪽';
  const vv = ['기준선', '아래', '중간', '맨 위'][v] ?? '기준선';
  if (v === 0) return h === 0 ? '왼쪽' : hv;
  return `${vv} ${hv}`;
}

export function scaleText(k: number): string {
  if (k >= 1) {
    const r = Math.round(k * 1000) / 1000;
    return `${r}:1`;
  }
  const inv = 1 / k;
  const r = Math.abs(inv - Math.round(inv)) < 1e-6 * inv ? Math.round(inv) : Math.round(inv * 1000) / 1000;
  return `1:${r}`;
}

/** 여러 객체 길이 합(LIST·선택 정보) */
export function entityLength(e: Entity): number | null {
  switch (e.type) {
    case 'LINE':
      return Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y, e.end.z - e.start.z);
    case 'CIRCLE':
      return e.radius * TAU;
    case 'ARC':
      return e.radius * ccwSweep(e.startAngle, e.endAngle);
    case 'LWPOLYLINE':
      return polyLength(e.vertices, e.closed);
    case 'POLYLINE':
      if (e.kind !== '2d') return null;
      return polyLength(
        e.vertices.filter((v) => !(v.flags & 16)).map((v) => ({ x: v.location.x, y: v.location.y, bulge: v.bulge })),
        (e.flags & 1) !== 0,
      );
    case 'SPLINE':
      return splineLength(e);
    default:
      return null;
  }
}
