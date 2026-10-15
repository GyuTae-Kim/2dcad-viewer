/**
 * 이름 있는 페이지 설정(ACAD_PLOTSETTINGS 사전의 PLOTSETTINGS 객체) 읽기·가져오기(화면 없음). PSETUPIN·-PSETUPIN이 쓴다.
 */
import { rootDictionary } from '../../core/framevars';
import type { CadDocument, CadObject, DictionaryObject, PlotSettings, PlotSettingsObject } from '../../core/model';
import type { EditOp } from '../session';

export interface NamedPageSetup {
  name: string;
  plot: PlotSettings;
  /** 모형용(플래그 1024)인가 */
  model: boolean;
}

/** 도면의 이름 있는 페이지 설정 사전과 항목 */
export function namedPageSetups(doc: CadDocument): { dict: DictionaryObject | null; items: NamedPageSetup[] } {
  const root = rootDictionary(doc);
  const h = root?.entries.get('ACAD_PLOTSETTINGS');
  const d = h ? doc.objects.get(h) : undefined;
  if (!d || (d.type !== 'DICTIONARY' && d.type !== 'ACDBDICTIONARYWDFLT')) return { dict: null, items: [] };
  const dict = d as DictionaryObject;
  const items: NamedPageSetup[] = [];
  for (const [name, oh] of dict.entries) {
    const o = doc.objects.get(oh);
    if (o?.type === 'PLOTSETTINGS') {
      const plot = (o as PlotSettingsObject).plot;
      items.push({ name, plot, model: (plot.flags & 1024) !== 0 });
    }
  }
  return { dict, items };
}

/** 이름 규칙(AutoCAD의 기호 이름과 같다) */
export function validSetupName(name: string): boolean {
  return !!name.trim() && !/[<>/\\":;?*|,=`]/.test(name) && name.length <= 255;
}

/**
 * 가져오기 작업: 같은 이름(대소문자 무시)이 있으면 overwrite에 든 것만 바꾸고, 없으면 새로 만든다.
 * 사전이 없으면 루트 사전에 ACAD_PLOTSETTINGS를 만든다. 루트 사전이 없으면 null
 */
export function importPageSetupOps(host: CadDocument, setups: readonly NamedPageSetup[], overwrite: ReadonlySet<string>, newHandle: () => string): { ops: EditOp[]; added: string[]; replaced: string[] } | null {
  const root = rootDictionary(host);
  if (!root) return null;
  const ops: EditOp[] = [];
  let { dict } = namedPageSetups(host);
  const before = dict;
  if (!dict) {
    dict = { type: 'DICTIONARY', handle: newHandle(), owner: root.handle, reactors: [root.handle], entries: new Map(), hardOwner: false, cloning: 1 };
    const rootAfter: DictionaryObject = { ...root, entries: new Map(root.entries) };
    rootAfter.entries.set('ACAD_PLOTSETTINGS', dict.handle);
    ops.push({ kind: 'object', key: root.handle, before: root, after: rootAfter as CadObject });
  }
  const entries = new Map(dict.entries);
  const added: string[] = [];
  const replaced: string[] = [];
  for (const s of setups) {
    const existing = [...entries.keys()].find((k) => k.toUpperCase() === s.name.toUpperCase());
    if (existing !== undefined) {
      if (!overwrite.has(s.name.toUpperCase())) continue;
      const h = entries.get(existing)!;
      const old = host.objects.get(h);
      if (old?.type !== 'PLOTSETTINGS') continue;
      const after: PlotSettingsObject = { ...(old as PlotSettingsObject), plot: { ...structuredClone(s.plot), pageSetupName: existing } };
      ops.push({ kind: 'object', key: h, before: old, after });
      replaced.push(existing);
      continue;
    }
    const h = newHandle();
    const obj: PlotSettingsObject = { type: 'PLOTSETTINGS', handle: h, owner: dict.handle, reactors: [dict.handle], plot: { ...structuredClone(s.plot), pageSetupName: s.name } };
    ops.push({ kind: 'object', key: h, before: null, after: obj });
    entries.set(s.name, h);
    added.push(s.name);
  }
  if (added.length) ops.push({ kind: 'object', key: dict.handle, before: before, after: { ...dict, entries } as CadObject });
  else if (!before) return { ops: [], added, replaced };
  return { ops, added, replaced };
}
