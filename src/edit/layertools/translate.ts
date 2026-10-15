/**
 * 도면층 변환기(LAYTRANS): 이 도면의 도면층(변환 시작)을 변환 대상 도면층(다른 도면·표준 파일에서 로드했거나 새로 만든 정의)으로 바꾼다.
 *
 * - 모든 매핑은 지금의 도면층 기준으로 한 번에 적용한다(A→B, B→C가 이어지지 않는다).
 * - 대상 도면층이 이 도면에 없으면 대상 정의의 특성으로 만들고, 있으면 그 특성(색상·선종류·선가중치·투명도·플롯)을 대상 정의 값으로 바꾼다.
 * - 객체(블록 참조의 속성 포함)를 대상 도면층으로 옮긴다. 설정에 따라 색상·선종류·투명도를 ByLayer로 강제하고 블록 정의 안 객체도 옮긴다.
 * - 현재 도면층과 배치 뷰포트의 동결 도면층 목록도 따라간다.
 * - "원본 도면층 삭제"가 켜져 있으면 객체가 남지 않은 원본 도면층을 지운다(0·Defpoints·대상 도면층은 지우지 않는다).
 * - 매핑 저장·불러오기(AutoCAD 형식): 매핑을 저장한 도면(DWS·DWG)의 변환 대상 도면층마다 확장 자료 `ACLAYTRANS` —
 *   1000마다 그 도면층으로 바꾸는 원본 도면층 이름(여럿이면 여러 개). AutoCAD가 저장한 실물(공개 연습 자료의 매핑 DWS)과
 *   Autodesk 개발자 블로그(표준 파일의 도면층 변환 매핑)로 확인했다. 매핑은 그 파일에 들고, 변환하는 도면에는 남지 않는다.
 */
import type { CadDocument, Entity, Layer } from '../../core/model';
import { BYLAYER, TRANSPARENCY_BYLAYER, tableKey } from '../../core/model';
import { createNewDocument } from '../../core/newdoc';
import type { EditOp } from '../session';
import { applyOps, isLayoutBlock } from '../session';
import { maxHandle } from '../util/audit';
import { DefinitionCopier } from './clone';

export interface LayerMapping {
  /** 이 도면의 도면층 이름(변환 시작) */
  from: string;
  /** 변환 대상 정의(이름과 특성) */
  to: Layer;
}

export interface TranslateSettings {
  /** 객체 색상을 BYLAYER로 강제 */
  forceColor: boolean;
  /** 객체 선종류를 BYLAYER로 강제 */
  forceLinetype: boolean;
  /** 객체 투명도를 BYLAYER로 강제 */
  forceTransparency: boolean;
  /** 블록 정의 안의 객체도 변환 */
  blocks: boolean;
  /** 변환한 원본 도면층 삭제(객체가 남지 않았을 때) */
  purge: boolean;
}

export const DEFAULT_TRANSLATE_SETTINGS: TranslateSettings = { forceColor: true, forceLinetype: true, forceTransparency: false, blocks: true, purge: true };

export interface TranslateResult {
  ops: EditOp[];
  /** 옮긴 객체 수(속성 제외) */
  moved: number;
  /** 원본 도면층별 옮긴 객체 수(대문자 이름) */
  counts: Map<string, number>;
  created: string[];
  updated: string[];
  removed: string[];
  /** 객체가 남아(블록 안 등) 지우지 못한 원본 도면층 */
  kept: string[];
}

/** 이름이 같은 도면층끼리 매핑(대소문자 무시). 변환 대상 목록에 없는 이름은 뺀다 */
export function sameNameMappings(from: readonly string[], targets: readonly Layer[]): LayerMapping[] {
  const byKey = new Map(targets.map((t) => [tableKey(t.name), t]));
  const out: LayerMapping[] = [];
  for (const f of from) {
    const t = byKey.get(tableKey(f));
    if (t) out.push({ from: f, to: t });
  }
  return out;
}

/** 변환할 수 없는 원본 도면층이면 까닭(0과 Defpoints는 다른 도면층으로 옮길 수 있지만 지우지 않는다) */
export function cannotTranslate(name: string): string | null {
  if (name.includes('|')) return '외부 참조 종속 도면층은 변환할 수 없습니다.';
  return null;
}

const sameLayerProps = (a: Layer, b: Layer) =>
  a.color.aci === b.color.aci &&
  a.color.rgb === b.color.rgb &&
  tableKey(a.linetype) === tableKey(b.linetype) &&
  a.lineweight === b.lineweight &&
  a.transparency === b.transparency &&
  a.plot === b.plot &&
  (a.description ?? '') === (b.description ?? '');

/**
 * 변환 작업. resolveLinetype은 대상 정의의 선종류를 이 도면에서 쓸 이름으로 바꾼다
 * (호출한 쪽이 원본 파일에서 선종류를 복사한 뒤 그 이름을 준다. 없으면 이 도면에 있을 때만 쓰고 아니면 Continuous).
 */
export function translateLayersOps(
  doc: CadDocument,
  mappings: readonly LayerMapping[],
  settings: TranslateSettings,
  newHandle: () => string,
  resolveLinetype: (name: string) => string = (n) => (doc.linetypes.has(tableKey(n)) ? doc.linetypes.get(tableKey(n))!.name : 'Continuous'),
): TranslateResult {
  const res: TranslateResult = { ops: [], moved: 0, counts: new Map(), created: [], updated: [], removed: [], kept: [] };
  const map = new Map<string, string>();
  const targets = new Map<string, Layer>();
  for (const m of mappings) {
    if (cannotTranslate(m.from)) continue;
    const fk = tableKey(m.from);
    if (!doc.layers.has(fk)) continue;
    map.set(fk, m.to.name);
    targets.set(tableKey(m.to.name), m.to);
  }
  if (!map.size) return res;
  // 1. 대상 도면층 만들기·특성 맞추기
  const tableOps: EditOp[] = [];
  for (const [tk, to] of targets) {
    const have = doc.layers.get(tk);
    const linetype = resolveLinetype(to.linetype || 'Continuous');
    if (have) {
      const after: Layer = { ...structuredClone(have), color: { ...to.color }, linetype, lineweight: to.lineweight, transparency: to.transparency, plot: to.plot };
      if (to.description !== undefined) after.description = to.description;
      if (!sameLayerProps(have, after)) {
        tableOps.push({ kind: 'layer', key: tk, before: have, after });
        res.updated.push(have.name);
      }
    } else {
      const after: Layer = { ...structuredClone(to), handle: newHandle(), flags: to.flags & ~(16 | 32 | 64), linetype };
      delete after.xdict;
      delete after.xdata;
      delete after.plotStyle;
      tableOps.push({ kind: 'layer', key: tk, before: null, after });
      res.created.push(after.name);
    }
  }
  // 2. 객체 옮기기
  const entityOps: EditOp[] = [];
  const touch = (e: Entity): Entity | null => {
    let out: Entity | null = null;
    const get = () => (out ??= structuredClone(e) as Entity);
    const move = (x: Entity) => {
      const to = map.get(tableKey(x.layer));
      if (to === undefined) return false;
      x.layer = to;
      if (settings.forceColor) x.color = { aci: BYLAYER };
      if (settings.forceLinetype) x.linetype = 'ByLayer';
      if (settings.forceTransparency) x.transparency = TRANSPARENCY_BYLAYER;
      return true;
    };
    const fk = tableKey(e.layer);
    if (map.has(fk)) {
      move(get());
      res.moved++;
      res.counts.set(fk, (res.counts.get(fk) ?? 0) + 1);
    }
    if (e.type === 'INSERT' && e.attribs.some((a) => map.has(tableKey(a.layer)))) {
      const c = get() as typeof e;
      for (const a of c.attribs) move(a);
    }
    if (e.type === 'VIEWPORT' && e.frozenLayers.some((n) => map.has(tableKey(n)))) {
      const c = get() as typeof e;
      const seen = new Set<string>();
      c.frozenLayers = c.frozenLayers
        .map((n) => map.get(tableKey(n)) ?? n)
        .filter((n) => {
          const k = tableKey(n);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
    }
    return out;
  };
  const after = new Map<string, Entity[]>();
  for (const [bk, b] of doc.blocks) {
    if (b.flags & 4) continue;
    const translate = settings.blocks || isLayoutBlock(bk);
    const list: Entity[] = [];
    for (const e of b.entities) {
      const c = translate ? touch(e) : null;
      if (c) entityOps.push({ kind: 'modify', block: bk, before: e, after: c });
      list.push(c ?? e);
    }
    after.set(bk, list);
  }
  // 3. 현재 도면층
  const headerOps: EditOp[] = [];
  const cl = doc.header.get('$CLAYER');
  if (typeof cl === 'string' && map.has(tableKey(cl))) headerOps.push({ kind: 'header', name: '$CLAYER', before: cl, after: map.get(tableKey(cl))! });
  // 4. 원본 도면층 지우기(객체가 남지 않은 것)
  const removeOps: EditOp[] = [];
  if (settings.purge) {
    const used = new Set<string>();
    for (const list of after.values())
      for (const e of list) {
        used.add(tableKey(e.layer));
        if (e.type === 'INSERT') for (const a of e.attribs) used.add(tableKey(a.layer));
      }
    for (const fk of map.keys()) {
      if (targets.has(fk) || fk === '0' || fk === 'DEFPOINTS') continue;
      const before = doc.layers.get(fk)!;
      if (used.has(fk)) {
        res.kept.push(before.name);
        continue;
      }
      removeOps.push({ kind: 'layer', key: fk, before, after: null });
      res.removed.push(before.name);
    }
  }
  res.ops = [...tableOps, ...entityOps, ...headerOps, ...removeOps];
  return res;
}

/** 변환 로그(이 앱의 문장 형식) */
export function translateLog(drawing: string, mappings: readonly LayerMapping[], settings: TranslateSettings, r: TranslateResult, when = new Date()): string {
  const yn = (b: boolean) => (b ? '예' : '아니오');
  const lines = [
    `도면층 변환 로그 — ${drawing}`,
    `날짜: ${when.toISOString()}`,
    '',
    '[설정]',
    `객체 색상을 BYLAYER로 강제: ${yn(settings.forceColor)}`,
    `객체 선종류를 BYLAYER로 강제: ${yn(settings.forceLinetype)}`,
    `객체 투명도를 BYLAYER로 강제: ${yn(settings.forceTransparency)}`,
    `블록의 객체 변환: ${yn(settings.blocks)}`,
    `변환한 원본 도면층 삭제: ${yn(settings.purge)}`,
    '',
    '[매핑]',
    ...mappings.map((m) => `${m.from} → ${m.to.name}: 객체 ${r.counts.get(tableKey(m.from)) ?? 0}개`),
    '',
    `옮긴 객체: ${r.moved}개`,
  ];
  if (r.created.length) lines.push(`만든 도면층: ${r.created.join(', ')}`);
  if (r.updated.length) lines.push(`특성을 바꾼 도면층: ${r.updated.join(', ')}`);
  if (r.removed.length) lines.push(`삭제한 도면층: ${r.removed.join(', ')}`);
  if (r.kept.length) lines.push(`객체가 남아 지우지 않은 도면층: ${r.kept.join(', ')}`);
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// 매핑 저장·불러오기(AutoCAD ACLAYTRANS)
// ---------------------------------------------------------------------------

/** 매핑을 적는 확장 자료 응용 이름 */
export const LAYTRANS_APP = 'ACLAYTRANS';

/** 도면(매핑을 저장한 DWS·DWG)의 매핑: 변환 대상 도면층 이름 → 원본 도면층 이름들(파일에 적힌 순서) */
export function readLayTransMappings(doc: CadDocument): { target: string; sources: string[] }[] {
  const out: { target: string; sources: string[] }[] = [];
  for (const l of doc.layers.values()) {
    const x = l.xdata?.find((d) => d.app.toUpperCase() === LAYTRANS_APP);
    if (!x) continue;
    const sources = x.items.filter((i) => i.code === 1000 && typeof i.value === 'string' && i.value).map((i) => String(i.value));
    if (sources.length) out.push({ target: l.name, sources });
  }
  return out;
}

/** 저장할 매핑 하나: 변환 대상 정의, 그 정의(와 선종류)를 읽은 도면, 이 대상으로 바꾸는 원본 도면층 이름들 */
export interface LayTransSaveItem {
  layer: Layer;
  source: CadDocument | null;
  from: readonly string[];
}

/**
 * 매핑을 담은 새 도면(AutoCAD가 LAYTRANS 저장(S)으로 만드는 DWS와 같은 꼴): 변환 대상 도면층(선종류 포함)마다
 * ACLAYTRANS 확장 자료에 원본 도면층 이름을 적는다. base는 새로 만든 정의의 선종류를 찾을 도면이자 단위의 기준이다.
 */
export function layTransMappingDocument(items: readonly LayTransSaveItem[], base: CadDocument): CadDocument {
  const metric = Number(base.header.get('$MEASUREMENT') ?? 1) !== 0;
  const doc = createNewDocument(metric ? 'metric' : 'imperial');
  let next = maxHandle(doc) + 1n;
  const nh = () => (next++).toString(16).toUpperCase();
  const copiers = new Map<CadDocument, DefinitionCopier>();
  const copier = (src: CadDocument) => {
    let c = copiers.get(src);
    if (!c) {
      c = new DefinitionCopier(src, doc, nh);
      copiers.set(src, c);
    }
    return c;
  };
  const layerOps: EditOp[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const key = tableKey(it.layer.name);
    if (seen.has(key)) continue;
    seen.add(key);
    const sources = [...new Set(it.from.filter((n) => !!n))];
    const lt = it.layer.linetype ? (copier(it.source ?? base).linetype(it.layer.linetype) ?? 'Continuous') : 'Continuous';
    const xdata = (it.layer.xdata ?? []).filter((x) => x.app.toUpperCase() !== LAYTRANS_APP).map((x) => structuredClone(x));
    xdata.push({ app: LAYTRANS_APP, items: sources.map((n) => ({ code: 1000, value: n })) });
    const have = doc.layers.get(key);
    const after: Layer = { ...structuredClone(it.layer), handle: have?.handle ?? nh(), flags: it.layer.flags & ~(16 | 32 | 64), linetype: lt, xdata };
    delete after.xdict;
    delete after.plotStyle;
    layerOps.push({ kind: 'layer', key, before: have ?? null, after });
  }
  applyOps(doc, [...[...copiers.values()].flatMap((c) => c.finish()), ...layerOps]);
  doc.header.set('$HANDSEED', next.toString(16).toUpperCase());
  return doc;
}
