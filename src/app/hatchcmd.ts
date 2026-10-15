/**
 * 해치 작성: HATCH(BHATCH, H), GRADIENT(그라데이션 채우기)
 * 내부 점 선택·객체 선택으로 경계를 모으고, 무늬·축척·각도·섬·연관 설정(그라데이션은 종류·색·각도·가운데)대로 HATCH를 만든다.
 * 경계 찾기와 무늬는 src/edit/hatch. 프롬프트는 AutoCAD 2026 한국어판을 따른다.
 */
import type { CadColor, CadDocument, Entity, HatchEntity, HatchGradient, HatchPath } from '../core/model';
import { tableKey } from '../core/model';
import { formatLength } from '../core/units';
import type { EditOp } from '../edit/session';
import { PATTERNS, boundaryFromEntities, createHatch, detectBoundary, estimatePatternLines, findPattern, reactorLinks } from '../edit/hatch';
import type { IslandStyle } from '../edit/hatch';
import { HATCH_LINE_LIMIT } from '../render/hatch';
import type { App, CommandContext } from './app';
import type { DocState } from './docstate';
import { currentProps } from './draw';
import { form } from './ui/dom';
import type { OverlayGeom } from './view';

export interface HatchSettings {
  pattern: string;
  scale: number;
  angle: number;
  double: boolean;
  userSpacing: number;
  islands: IslandStyle;
  associative: boolean;
  gap: number;
}

const settings = new WeakMap<DocState, HatchSettings>();

function hnum(doc: CadDocument, k: string, d: number): number {
  const v = doc.header.get(k);
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

/** 문서별 해치 설정(HATCH·-HATCH가 함께 쓴다) */
export function settingsOf(st: DocState): HatchSettings {
  let s = settings.get(st);
  if (!s) {
    const d = st.doc;
    const name = d.header.get('$HPNAME');
    s = {
      pattern: typeof name === 'string' && name && (findPattern(name) || name === '_USER') ? name : 'ANSI31',
      scale: hnum(d, '$HPSCALE', 1) || 1,
      angle: hnum(d, '$HPANG', 0),
      double: hnum(d, '$HPDOUBLE', 0) === 1,
      userSpacing: hnum(d, '$HPSPACE', 1) || 1,
      islands: 'normal',
      associative: hnum(d, '$HPASSOC', 1) !== 0,
      gap: hnum(d, '$HPGAPTOL', 0),
    };
    settings.set(st, s);
  }
  return s;
}

/** 지금 공간에서 보이는 경계 후보 */
export function candidates(st: DocState): Entity[] {
  const block = st.doc.blocks.get(st.space);
  if (!block) return [];
  return block.entities.filter((e) => {
    const L = st.doc.layers.get(tableKey(e.layer));
    return !e.invisible && !(L && (L.off || L.frozen));
  });
}

async function editSettings(st: DocState, s: HatchSettings): Promise<boolean> {
  const v = await form(
    '해치 설정',
    [
      {
        key: 'pattern',
        label: '무늬',
        type: 'select',
        value: s.pattern.toUpperCase(),
        options: [{ value: '_USER', label: '사용자 정의(평행선)' }, ...PATTERNS.map((p) => ({ value: p.name, label: `${p.name} — ${p.description}` }))],
      },
      { key: 'scale', label: '축척', type: 'number', value: s.scale },
      { key: 'angle', label: '각도(도)', type: 'number', value: +((s.angle * 180) / Math.PI).toFixed(6) },
      { key: 'userSpacing', label: '간격(사용자 정의)', type: 'number', value: s.userSpacing },
      { key: 'double', label: '이중(사용자 정의, 90° 교차)', type: 'check', value: s.double },
      {
        key: 'islands',
        label: '섬 검출',
        type: 'select',
        value: s.islands,
        options: [
          { value: 'normal', label: '일반(홀짝)' },
          { value: 'outer', label: '외부(가장 바깥)' },
          { value: 'ignore', label: '무시' },
        ],
      },
      { key: 'associative', label: '연관(경계를 고치면 해치도 따라감)', type: 'check', value: s.associative },
      { key: 'gap', label: '틈 허용', type: 'number', value: s.gap },
    ],
    { ok: '확인', validate: (x) => (Number(x.scale) > 0 && Number(x.userSpacing) > 0 && Number(x.gap) >= 0 ? null : '축척·간격은 0보다 커야 합니다.') },
  );
  if (!v) return false;
  s.pattern = String(v.pattern);
  s.scale = Number(v.scale);
  s.angle = (Number(v.angle) * Math.PI) / 180;
  s.userSpacing = Number(v.userSpacing);
  s.double = !!v.double;
  s.islands = v.islands as IslandStyle;
  s.associative = !!v.associative;
  s.gap = Number(v.gap);
  void st;
  return true;
}

// ---------------------------------------------------------------------------
// 그라데이션(GRADIENT)
// ---------------------------------------------------------------------------

const GRADIENTS = [
  ['LINEAR', '선형'],
  ['CYLINDER', '원통'],
  ['INVCYLINDER', '반전 원통'],
  ['SPHERICAL', '구형'],
  ['INVSPHERICAL', '반전 구형'],
  ['HEMISPHERICAL', '반구형'],
  ['INVHEMISPHERICAL', '반전 반구형'],
  ['CURVED', '곡선'],
  ['INVCURVED', '반전 곡선'],
] as const;

/** 마지막 그라데이션 설정(AutoCAD 기본: 선형, 파랑 → 노랑, 가운데, 0°) */
const gradientSettings: HatchGradient = { enabled: true, name: 'LINEAR', color1: { aci: 5 }, color2: { aci: 2 }, singleColor: false, tint: 1, angle: 0, shift: 0 };

/** "번호" 또는 "r,g,b" 색 입력 */
function parseColor(t: string): CadColor | null {
  const s = t.trim();
  const m = /^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/.exec(s);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map(Number) as [number, number, number];
    if (r > 255 || g > 255 || b > 255) return null;
    return { aci: 7, rgb: (r << 16) | (g << 8) | b };
  }
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 && n <= 255 ? { aci: n } : null;
}

const colorText = (c: CadColor): string => (c.rgb !== undefined ? `${(c.rgb >> 16) & 255},${(c.rgb >> 8) & 255},${c.rgb & 255}` : String(c.aci));

async function editGradient(g: HatchGradient): Promise<boolean> {
  const v = await form(
    '그라데이션 설정',
    [
      { key: 'name', label: '종류', type: 'select', value: g.name, options: GRADIENTS.map(([value, label]) => ({ value, label })) },
      { key: 'color1', label: '색 1(번호 또는 r,g,b)', type: 'text', value: colorText(g.color1) },
      { key: 'single', label: '한 가지 색', type: 'check', value: g.singleColor },
      { key: 'color2', label: '색 2(두 가지 색일 때)', type: 'text', value: colorText(g.color2) },
      { key: 'tint', label: '색조(한 가지 색, 0 어둡게 ~ 1 밝게)', type: 'number', value: g.tint },
      { key: 'angle', label: '각도(도)', type: 'number', value: +((g.angle * 180) / Math.PI).toFixed(6) },
      { key: 'centered', label: '가운데', type: 'check', value: g.shift === 0 },
    ],
    {
      ok: '확인',
      validate: (x) => {
        if (!parseColor(String(x.color1)) || (!x.single && !parseColor(String(x.color2)))) return '색은 1~255 번호나 r,g,b로 입력하십시오.';
        if (!(Number(x.tint) >= 0 && Number(x.tint) <= 1)) return '색조는 0에서 1 사이여야 합니다.';
        return null;
      },
    },
  );
  if (!v) return false;
  g.name = String(v.name);
  g.color1 = parseColor(String(v.color1))!;
  g.singleColor = !!v.single;
  if (!v.single) g.color2 = parseColor(String(v.color2))!;
  g.tint = Number(v.tint);
  g.angle = (Number(v.angle) * Math.PI) / 180;
  // 가운데를 끄면 AutoCAD처럼 0.25만큼 옮긴다
  g.shift = v.centered ? 0 : 0.25;
  return true;
}

export function registerHatchCommands(app: App): void {
  app.register({ name: 'HATCH', aliases: ['H', 'BHATCH', 'BH'], title: '해치', run: (ctx) => runHatch(app, ctx, false) });
  app.register({ name: 'GRADIENT', aliases: ['GD'], title: '그라데이션', run: (ctx) => runHatch(app, ctx, true) });
}

async function runHatch(app: App, ctx: CommandContext, gradient: boolean): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  const s = settingsOf(st);
  const g = gradientSettings;
  const picks: { paths: HatchPath[]; seed?: { x: number; y: number }; bridged: boolean }[] = [];
  const preview = (): OverlayGeom[] => {
    const pk = app.picker();
    const paths = picks.flatMap((p) => p.paths);
    if (!pk || !paths.length) return [];
    try {
      return [pk.geometryOf([createHatch(doc, paths, { pattern: 'SOLID', associative: false })])];
    } catch {
      return [];
    }
  };
  const status = () =>
    ctx.print(
      gradient
        ? `현재 설정: 그라데이션 = ${GRADIENTS.find(([n]) => n === g.name)?.[1] ?? g.name}, 색 = ${colorText(g.color1)}${g.singleColor ? ` (색조 ${g.tint})` : ` → ${colorText(g.color2)}`}, 각도 = ${((g.angle * 180) / Math.PI).toFixed(0)}, 가운데 = ${g.shift === 0 ? '예' : '아니오'}, 연관 = ${s.associative ? '예' : '아니오'}`
        : `현재 설정: 무늬 = ${s.pattern === '_USER' ? '사용자 정의' : s.pattern}, 축척 = ${s.pattern === '_USER' ? formatLength(s.userSpacing, st.units) : s.scale}, 각도 = ${((s.angle * 180) / Math.PI).toFixed(0)}, 섬 = ${s.islands === 'normal' ? '일반' : s.islands === 'outer' ? '외부' : '무시'}, 연관 = ${s.associative ? '예' : '아니오'}`,
    );
  status();
  for (;;) {
    const r = await ctx.getPoint('내부 점 선택 또는 [객체 선택(S)/명령 취소(U)/설정(T)]:', {
      keywords: [
        { key: 'S', label: '객체 선택' },
        { key: 'U', label: '명령 취소' },
        { key: 'T', label: '설정' },
      ],
      ghost: () => preview(),
    });
    if ('enter' in r) break;
    if ('point' in r) {
      ctx.print('모든 것 선택 중... 경계 분석 중...');
      const res = detectBoundary(doc, candidates(st), r.point, { islands: s.islands, gapTolerance: s.gap });
      if (!res || !res.paths.length) {
        ctx.print('유효한 해치 경계를 찾을 수 없습니다. 닫힌 영역 안을 선택하거나 틈 허용을 늘리십시오.', 'err');
        continue;
      }
      picks.push({ paths: res.paths, seed: r.point, bridged: res.bridged });
      if (res.bridged) ctx.print('틈을 이어 경계를 만들었습니다. 이 해치는 연관 해치로 만들지 않습니다.');
      continue;
    }
    if (!('keyword' in r)) return;
    if (r.keyword === 'U') {
      if (picks.pop()) ctx.print('마지막 경계를 뺐습니다.');
      else ctx.print('명령 취소할 것이 없습니다.');
      continue;
    }
    if (r.keyword === 'T') {
      if (await (gradient ? editGradient(g) : editSettings(st, s))) status();
      continue;
    }
    if (r.keyword === 'S') {
      const hs = await ctx.getSelection('객체 선택:', { noPickfirst: true });
      const ents = hs.map((h) => doc.entityIndex.get(h)).filter((e): e is Entity => !!e);
      const paths = boundaryFromEntities(doc, ents);
      if (!paths.length) ctx.print('닫힌 객체(원, 닫힌 폴리선, 타원, 닫힌 스플라인)를 선택하십시오.', 'err');
      else picks.push({ paths, bridged: false });
    }
  }
  const paths = picks.flatMap((p) => p.paths);
  if (!paths.length) return;
  const bridged = picks.some((p) => p.bridged);
  const user = s.pattern === '_USER';
  const props = currentProps(app);
  const hatch: HatchEntity = createHatch(doc, paths, {
    pattern: gradient ? 'SOLID' : user ? '_USER' : s.pattern,
    scale: s.scale,
    angle: s.angle,
    double: user && s.double,
    userSpacing: user ? s.userSpacing : undefined,
    style: s.islands === 'normal' ? 0 : s.islands === 'outer' ? 1 : 2,
    associative: s.associative && !bridged,
    layer: props.layer,
    seedPoints: picks.map((p) => p.seed).filter((p): p is { x: number; y: number } => !!p),
  });
  Object.assign(hatch, { color: props.color, linetype: props.linetype, lineweight: props.lineweight, transparency: props.transparency });
  if (gradient) hatch.gradient = { ...g, color1: { ...g.color1 }, color2: { ...g.color2 } };
  if (!gradient && estimatePatternLines(hatch) > HATCH_LINE_LIMIT) {
    ctx.print('해치 무늬 축척이 너무 작거나 영역이 너무 큽니다. 축척을 키우십시오.', 'err');
    return;
  }
  const block = doc.blocks.get(st.space)!;
  hatch.handle = st.session.newHandle();
  hatch.owner = block.recordHandle;
  hatch.paperSpace = /^\*PAPER_SPACE/i.test(st.space) ? true : undefined;
  // 경계 뒤로(HPDRAWORDER 기본): 경계 객체 중 가장 앞 자리에 넣는다
  const sources = new Set(paths.flatMap((p) => p.sources ?? []));
  let index = block.entities.length;
  block.entities.forEach((e, i) => {
    if (sources.has(e.handle) && i < index) index = i;
  });
  const ops: EditOp[] = [{ kind: 'add', block: st.space, entity: hatch, index }];
  for (const l of reactorLinks(doc, hatch)) {
    const owner = st.session.ownerOf(l.before.handle);
    if (owner) ops.push({ kind: 'modify', block: owner, before: l.before, after: l.after });
  }
  st.session.commit({ label: gradient ? 'GRADIENT' : 'HATCH', ops, group: ctx.group, rebuildNow: true });
  ctx.print(`${gradient ? '그라데이션' : '해치'}를 만들었습니다(경계 ${paths.length}개${hatch.associative ? ', 연관' : ''}).`);
}
