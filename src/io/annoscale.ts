/**
 * 주석 축척 레코드의 파일 쪽 정리(DXF·DWG 공용).
 *
 * - 클래스 판: 컨텍스트 데이터의 `AcDbObjectContextData` 70은 저장 버전에 맞춘다(AC1024 이상 4, 그 전 3).
 * - 주석 치수의 DIMSCALE: 이 앱은 작업 중인 주석 치수에 보이는 축척의 배율을 DSTYLE DIMSCALE(40) 재지정으로 둔다
 *   (그 크기로 다시 그리기 위해). AutoCAD의 주석 치수는 치수 스타일이 주석이면 40 재지정이 없고, 아니면 40 = 0이다
 *   (기능 명세 annotation-scale.md 6.1). 쓸 때 그 값으로 바꾸고, 읽을 때 기본 레코드 축척의 배율을 넣는다.
 * 주석 치수 = AcadAnnotative {1, 1} 표지가 있고 확장 사전 → AcDbContextDataManager → ACDB_ANNOTATIONSCALES에
 * 치수 레코드가 있는 치수.
 */
import type { CadDocument, DictionaryObject, DimensionEntity, Entity, GenericObject, RawTag, ScaleObject, XData } from '../core/model';
import { tableKey } from '../core/model';
import { CTX_TYPES, DIM_CTX, ctxClassVersion } from './dwg/ctxcodec';

export { CTX_TYPES };

const up = (h: string | number | undefined): string => (h === undefined ? '' : String(h).trim().toUpperCase());

/**
 * 레코드 원시 태그를 이 버전 파일에 맞춘 것(같으면 그 배열): 클래스 판(70), 다중 지시선 레코드의 R2010+ 태그
 * (지시선 271, 끝의 272·273, 지시선 선의 재지정 170~93 — MULTILEADER의 같은 자료처럼 R2007 이하에는 없다).
 */
export function ctxRawForVersion(raw: readonly RawTag[], ver: number, type = ''): readonly RawTag[] {
  const want = ctxClassVersion(ver);
  const i = raw.findIndex((t) => t.code === 100 && String(t.value).trim() === 'AcDbObjectContextData');
  const t = i >= 0 ? raw[i + 1] : undefined;
  let out: readonly RawTag[] = raw;
  if (t && t.code === 70 && Number(t.value) !== want) {
    const c = raw.slice();
    c[i + 1] = { code: 70, value: want };
    out = c;
  }
  if (type === 'ACDB_MLEADEROBJECTCONTEXTDATA_CLASS' && ver < 1024) {
    const kept: RawTag[] = [];
    let inLine = false;
    let afterIndex = false;
    for (const x of out) {
      if (x.code === 304 && String(x.value).trim() === 'LEADER_LINE{') inLine = true;
      else if (x.code === 305) {
        inLine = false;
        afterIndex = false;
      }
      if (inLine && x.code === 91) afterIndex = true;
      else if (inLine && afterIndex && [170, 92, 340, 171, 40, 341, 93].includes(x.code)) continue;
      if (!inLine && (x.code === 271 || x.code === 272 || x.code === 273)) continue;
      kept.push(x);
    }
    out = kept;
  }
  return out;
}

/** AcadAnnotative 표지(1 주석, 0 아님, undefined 없음) */
function annotative(xdata: readonly XData[] | undefined): boolean | undefined {
  const x = xdata?.find((d) => d.app.toUpperCase() === 'ACADANNOTATIVE');
  if (!x) return undefined;
  const ints = x.items.filter((i) => i.code === 1070).map((i) => Number(i.value));
  return ints.length >= 2 ? ints[1] === 1 : undefined;
}

function dictOf(doc: CadDocument, h: string | undefined): DictionaryObject | null {
  if (!h) return null;
  const o = doc.objects.get(up(h));
  return o && (o.type === 'DICTIONARY' || o.type === 'ACDBDICTIONARYWDFLT') ? (o as DictionaryObject) : null;
}

function entry(d: DictionaryObject | null, key: string): string | undefined {
  if (!d) return undefined;
  const k = key.toUpperCase();
  for (const [n, h] of d.entries) if (n.toUpperCase() === k) return h;
  return undefined;
}

/** 객체의 컨텍스트 레코드(축척 사전 순서) */
export function ctxRecordsOf(doc: CadDocument, e: { xdict?: string }): GenericObject[] {
  const sc = dictOf(doc, entry(dictOf(doc, entry(dictOf(doc, e.xdict), 'AcDbContextDataManager')), 'ACDB_ANNOTATIONSCALES'));
  if (!sc) return [];
  const out: GenericObject[] = [];
  for (const h of sc.entries.values()) {
    const o = doc.objects.get(up(h));
    if (o && CTX_TYPES.has(o.type)) out.push(o as GenericObject);
  }
  return out;
}

/** AutoCAD 레코드를 가진 주석 치수인지 */
export function isAnnoDimension(doc: CadDocument, e: Entity): boolean {
  if (e.type !== 'DIMENSION' || !e.xdict || annotative(e.xdata) === false) return false;
  return ctxRecordsOf(doc, e).some((o) => !!DIM_CTX[o.type]);
}

function dimStyleAnnotative(doc: CadDocument, name: string): boolean {
  return annotative(doc.dimStyles.get(tableKey(name))?.xdata) === true;
}

/** 쓸 재지정: 주석 치수면 DIMSCALE(40)을 AutoCAD 값으로(스타일이 주석이면 없음, 아니면 0) */
export function annoDimWriteOverrides(doc: CadDocument, e: DimensionEntity): Record<number, string | number> | undefined {
  if (!isAnnoDimension(doc, e)) return e.overrides;
  const ov = { ...(e.overrides ?? {}) };
  if (dimStyleAnnotative(doc, e.dimStyle)) delete ov[40];
  else ov[40] = 0;
  return ov;
}

/**
 * 확장 자료의 ACAD DSTYLE에서 40만 AutoCAD 값으로 바꾼 것(DWG 쓰기: 확장 자료를 그대로 쓰므로).
 * 주석 치수가 아니면 그대로.
 */
export function annoDimWriteXData(doc: CadDocument, e: DimensionEntity): XData[] | undefined {
  if (!isAnnoDimension(doc, e)) return e.xdata;
  const removeOnly = dimStyleAnnotative(doc, e.dimStyle);
  const list = (e.xdata ?? []).map((x) => ({ app: x.app, items: [...x.items] }));
  let acad = list.find((x) => x.app.toUpperCase() === 'ACAD');
  const groupStart = acad ? acad.items.findIndex((it) => it.code === 1000 && String(it.value).toUpperCase() === 'DSTYLE') : -1;
  if (acad && groupStart >= 0) {
    // DSTYLE { (1070 코드, 값)… }
    let i = groupStart + 2;
    let found = false;
    while (i < acad.items.length && !(acad.items[i]!.code === 1002 && String(acad.items[i]!.value).trim() === '}')) {
      const k = acad.items[i]!;
      if (k.code === 1070 && Number(k.value) === 40) {
        found = true;
        if (removeOnly) acad.items.splice(i, 2);
        else {
          acad.items[i + 1] = { code: 1040, value: 0 };
          i += 2;
        }
        continue;
      }
      i += 2;
    }
    if (!found && !removeOnly) acad.items.splice(groupStart + 2, 0, { code: 1070, value: 40 }, { code: 1040, value: 0 });
    // 빈 묶음은 뺀다
    if (acad.items[groupStart + 1]?.code === 1002 && acad.items[groupStart + 2]?.code === 1002 && String(acad.items[groupStart + 2]!.value).trim() === '}') acad.items.splice(groupStart, 3);
  } else if (!removeOnly) {
    if (!acad) {
      acad = { app: 'ACAD', items: [] };
      list.push(acad);
    }
    acad.items.push({ code: 1000, value: 'DSTYLE' }, { code: 1002, value: '{' }, { code: 1070, value: 40 }, { code: 1040, value: 0 }, { code: 1002, value: '}' });
  }
  const out = list.filter((x) => x.items.length);
  return out.length ? out : undefined;
}

/** 기본 레코드(290 = 1, 없으면 첫 레코드)가 가리키는 축척의 배율(도면 단위 ÷ 용지 단위) */
function defaultFactor(doc: CadDocument, recs: readonly GenericObject[]): number | null {
  let pick: GenericObject | undefined;
  for (const r of recs) {
    const raw = r.raw ?? [];
    const i = raw.findIndex((t) => t.code === 100 && String(t.value).trim() === 'AcDbObjectContextData');
    const def = i >= 0 && raw[i + 2]?.code === 290 && Number(raw[i + 2]!.value) === 1;
    if (def) {
      pick = r;
      break;
    }
    pick ??= r;
  }
  const h = pick?.raw?.find((t) => t.code === 340)?.value;
  const s = h === undefined ? undefined : (doc.objects.get(up(h)) as ScaleObject | undefined);
  if (!s || s.type !== 'SCALE' || !(s.paperUnits > 0) || !(s.drawingUnits > 0)) return null;
  return s.drawingUnits / s.paperUnits;
}

/**
 * 읽은 뒤: AutoCAD 레코드를 가진 주석 치수에 보이는 축척의 배율을 DIMSCALE 재지정으로 넣는다(재지정이 없거나 0일 때만).
 * 이 앱이 치수를 다시 그릴 때 그 크기가 되게 한다. 쓸 때는 annoDimWriteOverrides가 되돌린다.
 */
export function restoreAnnoDimScales(doc: CadDocument): number {
  let n = 0;
  for (const b of doc.blocks.values()) {
    for (const e of b.entities) {
      if (e.type !== 'DIMENSION' || !e.xdict) continue;
      const cur = e.overrides?.[40];
      if (cur !== undefined && Number(cur) !== 0) continue;
      if (annotative(e.xdata) === false) continue;
      const recs = ctxRecordsOf(doc, e).filter((o) => !!DIM_CTX[o.type]);
      if (!recs.length) continue;
      const f = defaultFactor(doc, recs);
      if (f === null) continue;
      e.overrides = { ...(e.overrides ?? {}), 40: f };
      n++;
    }
  }
  return n;
}
