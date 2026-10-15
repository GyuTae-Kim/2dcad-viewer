/**
 * 도면층 상태 가져오기: .las 파일이나 다른 도면(DWG·DXF·DWS·DWT)의 상태를 이 도면에 넣는 작업.
 *
 * AutoCAD처럼 상태가 가리키는데 이 도면에 없는 도면층은 만든다 — 다른 도면에서 가져오면 그 도면의 정의(선종류 포함)로,
 * .las에서 가져오면 상태에 적힌 값으로. 상태가 쓰는 선종류가 이 도면에 없으면 다른 도면에서는 그 정의를 복사하고,
 * .las에서는 이 앱의 표준 선종류 목록에 있으면 그것을 로드한다(없으면 Continuous로 두고 알린다).
 * 모든 작업은 트랜잭션 하나(명령 취소 한 단계)로 넣는다.
 */
import type { CadDocument, Layer } from '../../core/model';
import { tableKey } from '../../core/model';
import { DefinitionCopier } from '../layertools/clone';
import { STANDARD_LINETYPES, makeLinetype } from '../linetypes';
import type { EditOp } from '../session';
import { type LayerState, layerStateNameProblem } from './record';
import { LayerStateWriter, findLayerState, layerFromEntry } from './store';

const BAD_LAYER = /[<>/\\":;?*,=`]/;

export interface ImportResult {
  ops: EditOp[];
  /** 가져온 상태 이름 */
  imported: string[];
  /** 같은 이름이 있어 건너뛴 상태 */
  skipped: string[];
  /** 이름이 올바르지 않아 뺀 상태 */
  invalid: string[];
  /** 새로 만든 도면층 */
  createdLayers: string[];
  /** 로드한 선종류 */
  loadedLinetypes: string[];
  /** 찾지 못해 Continuous로 둔 선종류 */
  missingLinetypes: string[];
  /** 이름이 올바르지 않거나 외부 참조라 상태에서 뺀 도면층 수 */
  droppedLayers: number;
}

export interface ImportOptions {
  /** 이미 있는 상태를 덮어쓸지(이름마다 묻는다). 없으면 덮어쓰지 않는다 */
  overwrite?: (name: string) => boolean;
  /** 상태가 온 도면(.las면 null) */
  source?: CadDocument | null;
}

/** 상태들을 이 도면에 넣는 작업 */
export function importLayerStatesOps(doc: CadDocument, newHandle: () => string, states: readonly LayerState[], o: ImportOptions = {}): ImportResult {
  const res: ImportResult = { ops: [], imported: [], skipped: [], invalid: [], createdLayers: [], loadedLinetypes: [], missingLinetypes: [], droppedLayers: 0 };
  const writer = new LayerStateWriter(doc, newHandle);
  const src = o.source ?? null;
  const cp = src ? new DefinitionCopier(src, doc, newHandle) : null;
  const tableOps: EditOp[] = [];
  const madeLayers = new Map<string, string>();
  const madeLts = new Map<string, string>();
  const metric = Number(doc.header.get('$MEASUREMENT') ?? 1) === 1;
  const missingLt = new Set<string>();

  /** 선종류 이름 → 이 도면의 이름(없으면 만들고, 못 만들면 null) */
  const linetype = (name: string): string | null => {
    const k = tableKey(name || 'Continuous');
    if (k === 'CONTINUOUS' || k === 'BYLAYER' || k === 'BYBLOCK') return 'Continuous';
    const have = doc.linetypes.get(k);
    if (have) return have.name;
    if (madeLts.has(k)) return madeLts.get(k)!;
    if (cp && src?.linetypes.has(k)) {
      if (cp.copy('linetype', name) !== 'missing') {
        const h = cp.recordHandle('linetype', name);
        const n = src.linetypes.get(k)!.name;
        if (h) writer.knowLinetype(n, h);
        madeLts.set(k, n);
        res.loadedLinetypes.push(n);
        return n;
      }
    }
    const def = STANDARD_LINETYPES.find((d) => d.name.toUpperCase() === k);
    if (def) {
      const lt = makeLinetype(def, newHandle(), metric);
      tableOps.push({ kind: 'linetype', key: k, before: null, after: lt });
      writer.knowLinetype(lt.name, lt.handle);
      madeLts.set(k, lt.name);
      res.loadedLinetypes.push(lt.name);
      return lt.name;
    }
    missingLt.add(name);
    return null;
  };

  for (const s0 of states) {
    const name = s0.name.trim();
    if (layerStateNameProblem(name)) {
      res.invalid.push(s0.name);
      continue;
    }
    if (findLayerState(doc, name) && !(o.overwrite?.(name) ?? false)) {
      res.skipped.push(name);
      continue;
    }
    const s: LayerState = structuredClone({ ...s0, name });
    s.layers = [];
    for (const e0 of s0.layers) {
      const e = structuredClone(e0);
      delete e.handle;
      if (!e.name || BAD_LAYER.test(e.name) || /[\u0000-\u001f]/.test(e.name)) {
        res.droppedLayers++;
        continue;
      }
      const k = tableKey(e.name);
      const lt = linetype(e.linetype);
      e.linetype = lt ?? 'Continuous';
      if (!doc.layers.has(k) && !madeLayers.has(k)) {
        if (e.name.includes('|')) {
          // 외부 참조 도면층은 만들지 않는다
          res.droppedLayers++;
          continue;
        }
        if (cp && src?.layers.has(k)) {
          cp.copy('layer', e.name);
          const h = cp.recordHandle('layer', e.name);
          if (h) {
            writer.knowLayer(e.name, h);
            madeLayers.set(k, h);
            res.createdLayers.push(src.layers.get(k)!.name);
          }
        } else {
          const L: Layer = layerFromEntry(e, newHandle(), (n) => (tableKey(n) === 'CONTINUOUS' ? 'Continuous' : (doc.linetypes.get(tableKey(n))?.name ?? madeLts.get(tableKey(n)) ?? null)));
          tableOps.push({ kind: 'layer', key: k, before: null, after: L });
          writer.knowLayer(L.name, L.handle);
          madeLayers.set(k, L.handle);
          res.createdLayers.push(L.name);
        }
      }
      s.layers.push(e);
    }
    writer.put(s);
    res.imported.push(name);
  }
  res.missingLinetypes = [...missingLt];
  // 선종류 → 도면층 → 상태 순서
  res.ops = [...(cp ? cp.finish() : []), ...tableOps, ...writer.finish()];
  return res;
}
