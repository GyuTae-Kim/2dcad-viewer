/**
 * 도면층 상태 레코드: AutoCAD 표본의 ACAD_LAYERSTATES XRECORD 해석, 같은 태그로 다시 쓰기,
 * 새 상태 저장 → DXF·DWG 왕복, 이름 바꾸기·지우기·명령 취소.
 */
import { describe, expect, it } from 'vitest';
import type { RawTag, XRecordObject } from '../../src/core/model';
import { tableKey } from '../../src/core/model';
import {
  LSF_FROZEN,
  LSF_LOCKED,
  LSF_NEWVP,
  LSF_OFF,
  LSF_PLOT,
  LSM_ALL,
  LSM_CURVP,
  LSM_HIDDEN,
  opacityOf,
  parseStateTags,
  stateRecordTags,
  transparencyValue,
  trueColorOf,
  trueColorValue,
} from '../../src/edit/layerstate/record';
import { LayerStateWriter, captureLayerState, findLayerState, layerStatesDict, layerTableXdict, listLayerStates, namerFor, resolverFor } from '../../src/edit/layerstate/store';
import { applyOps } from '../../src/edit/session';
import { addLayer, addLinetype, commit, duplicateHandles, fixture, newDoc, readFixture, roundTrip } from './helpers';

const norm = (tags: readonly RawTag[]) =>
  tags.map((t) => {
    const v = typeof t.value === 'string' ? t.value.trim() : t.value;
    return `${t.code}=${typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : typeof v === 'string' ? v.toUpperCase() : v}`;
  });

const SAMPLES = ['samples-dxf/sample_AC1032_ascii.dxf', 'samples-dxf/sample_AC1015_ascii.dxf', 'samples/sample_AC1032.dwg', 'samples/sample_AC1015.dwg', 'samples/sample_AC1018.dwg', 'samples/sample_AC1014.dwg']
  .map((r) => [r, fixture(r)] as const)
  .filter((x): x is readonly [string, string] => !!x[1]);

describe('값 변환', () => {
  it('트루컬러(92)와 투명도(440)', () => {
    expect(trueColorOf(-1023622777)).toBe(0xfcc187);
    expect(trueColorValue(0xfcc187)).toBe(-1023622777);
    expect(trueColorOf(7)).toBeNull();
    expect(opacityOf(33554508)).toBe(76);
    expect(opacityOf(0)).toBe(255);
    expect(transparencyValue(76)).toBe(33554508);
    expect(transparencyValue(255)).toBe(0);
  });
});

describe('AutoCAD 표본의 도면층 상태', () => {
  it.skipIf(!SAMPLES.length).each(SAMPLES)('%s: 명명된 뷰의 숨은 상태를 읽는다', (_rel, p) => {
    const doc = readFixture(p);
    expect(layerTableXdict(doc)).not.toBeNull();
    expect(listLayerStates(doc)).toEqual([]);
    const all = listLayerStates(doc, { hidden: true });
    expect(all.length).toBe(1);
    const s = all[0]!;
    expect(s.key.toUpperCase()).toBe('ACAD_VIEWS_VIEW_CUSTOM');
    expect(s.hidden).toBe(true);
    expect(s.state.mask).toBe(LSM_HIDDEN | LSM_CURVP);
    expect(s.state.paperSpace).toBe(false);
    expect(s.state.currentLayer).toBe('0');
    const m = new Map(s.state.layers.map((l) => [l.name.toUpperCase(), l]));
    const by = { get: (n: string) => m.get(n.toUpperCase()) };
    // 도면층 표와 같은 값(표본의 도면층 이름이 특성을 말한다)
    expect(by.get('Layer_Off')!.flags).toBe(LSF_PLOT | LSF_OFF);
    expect(by.get('Layer_Freeze')!.flags).toBe(LSF_PLOT | LSF_FROZEN);
    expect(by.get('Layer_Lock')!.flags).toBe(LSF_PLOT | LSF_LOCKED);
    expect(by.get('Layer_NoPlot')!.flags).toBe(0);
    expect(by.get('Layer_vp_freeze')!.flags).toBe(LSF_PLOT | LSF_NEWVP);
    expect(by.get('Layer_color_80')!.color.aci).toBe(80);
    expect(by.get('Layer_Lt_dash')!.linetype.toUpperCase()).toBe('ACAD_ISO02W100');
    expect(by.get('Layer_lw_035')!.lineweight).toBe(35);
    expect(by.get('Layer_true_color')!.color).toEqual({ aci: 150, rgb: 1151726 });
    expect(by.get('Layer_color_book')!.color).toEqual({ aci: 31, rgb: 16564615, name: 'DIC COLOR GUIDE(R)$DIC 7' });
    expect(by.get('0')!.plotStyle).toBe('Color_7');
    if (s.state.layers.some((l) => l.name === 'Layer_transp_70')) expect(by.get('Layer_transp_70')!.transparency).toBe(76);
    // 도면층 표의 값과 견준다
    for (const l of s.state.layers) {
      const L = doc.layers.get(tableKey(l.name))!;
      expect(L, l.name).toBeTruthy();
      expect(!!(l.flags & LSF_OFF)).toBe(L.off);
      expect(!!(l.flags & LSF_FROZEN)).toBe(L.frozen);
      expect(!!(l.flags & LSF_LOCKED)).toBe(L.locked);
      expect(Math.abs(l.color.aci)).toBe(Math.abs(L.color.aci));
    }
  });

  it.skipIf(!SAMPLES.length).each(SAMPLES)('%s: 바꾸지 않은 상태를 같은 태그로 다시 쓴다', (_rel, p) => {
    const doc = readFixture(p);
    const s = listLayerStates(doc, { hidden: true })[0]!;
    const x = doc.objects.get(s.handle) as XRecordObject;
    const again = stateRecordTags(s.state, namerFor(doc));
    expect(norm(again)).toEqual(norm(x.data));
  });

  it.skipIf(!fixture('all-samples/Mechanical - Metric.dwg'))('R2008 꼴(투명도 없음, 지워진 도면층의 빈 핸들)도 읽고 같은 꼴로 쓴다', () => {
    const doc = readFixture(fixture('all-samples/Mechanical - Metric.dwg')!);
    const s = listLayerStates(doc)[0]!;
    expect(s.key).toBe('MODEL TAB VISUAL FIDELITY');
    expect(s.state.mask).toBe(1023);
    const names = s.state.layers.map((l) => l.name);
    expect(names).toContain('0');
    expect(names).toContain('ATT-2');
    // 지워진 도면층은 이름이 없고 핸들을 지닌다
    expect(s.state.layers.filter((l) => !l.name).length).toBeGreaterThan(0);
    const tags = stateRecordTags(s.state, namerFor(doc));
    const back = parseStateTags(s.key, tags, resolverFor(doc));
    expect(back.layers.map((l) => l.name)).toEqual(names);
  });
});

describe('새 상태 저장과 왕복', () => {
  function sampleDoc() {
    const t = newDoc();
    addLinetype(t, 'DASHED');
    addLayer(t, 'WALL', { color: { aci: 1 }, linetype: 'DASHED', lineweight: 35 });
    addLayer(t, 'GLASS', { color: { aci: 150, rgb: 0x1192ee }, transparency: 76, plot: false });
    addLayer(t, '한글층', { off: true, locked: true, flags: 2 });
    addLayer(t, 'FROZEN', { frozen: true, flags: 1 });
    return t;
  }

  it('LAYER 표 확장 사전과 상태 사전을 만들고, 명령 취소로 없앤다', () => {
    const t = sampleDoc();
    expect(layerTableXdict(t.doc)).toBeNull();
    const w = new LayerStateWriter(t.doc, t.nh);
    w.put(captureLayerState(t.doc, { name: '평면도', description: '설명 글' }));
    commit(t, w.finish());
    expect(layerTableXdict(t.doc)).not.toBeNull();
    expect(layerStatesDict(t.doc)!.entries.has('평면도')).toBe(true);
    const s = findLayerState(t.doc, '평면도')!.state;
    expect(s.mask).toBe(LSM_ALL);
    expect(s.description).toBe('설명 글');
    expect(s.layers.length).toBe(t.doc.layers.size);
    expect(duplicateHandles(t.doc)).toEqual([]);
    t.session.undo();
    expect(layerTableXdict(t.doc)).toBeNull();
    expect(listLayerStates(t.doc)).toEqual([]);
    t.session.redo();
    expect(findLayerState(t.doc, '평면도')).not.toBeNull();
  });

  for (const [fmt, ver] of [
    ['dxf', 'AC1032'],
    ['dxf', 'AC1015'],
    ['dwg', 'AC1032'],
    ['dwg', 'AC1018'],
    ['dwg', 'AC1015'],
  ] as const) {
    it(`${fmt.toUpperCase()} ${ver}로 저장해도 상태가 그대로다`, () => {
      const t = sampleDoc();
      const w = new LayerStateWriter(t.doc, t.nh);
      w.put(captureLayerState(t.doc, { name: '평면도', description: '설명', paperSpace: true, mask: LSM_ALL & ~32 }));
      w.put(captureLayerState(t.doc, { name: 'B', mask: 1 | 2 }));
      commit(t, w.finish());
      const before = listLayerStates(t.doc).map((x) => x.state);
      const back = roundTrip(t.doc, fmt, ver);
      const after = listLayerStates(back).map((x) => x.state);
      const strip = (list: typeof before) => list.map((s) => ({ ...s, layers: s.layers.map(({ handle: _h, ...l }) => l).sort((a, b) => a.name.localeCompare(b.name)) }));
      expect(strip(after)).toEqual(strip(before));
      const g = after.find((s) => s.name === '평면도')!.layers.find((l) => l.name === 'GLASS')!;
      expect(g.color.rgb).toBe(0x1192ee);
      expect(g.transparency).toBe(76);
      expect(g.flags & LSF_PLOT).toBe(0);
      expect(after.find((s) => s.name === '평면도')!.layers.find((l) => l.name === 'WALL')!.linetype).toBe('DASHED');
      expect(after.find((s) => s.name === '평면도')!.paperSpace).toBe(true);
    });
  }

  it('워커 문서(구조적 복제로 받은 작업을 따로 적용)에서도 같은 상태로 저장된다', () => {
    const t = sampleDoc();
    const worker = structuredClone(t.doc);
    const w = new LayerStateWriter(t.doc, t.nh);
    w.put(captureLayerState(t.doc, { name: '평면도' }));
    const ops = w.finish();
    commit(t, ops);
    applyOps(worker, structuredClone(ops));
    expect(worker.tableHeads!.get('LAYER')!.xdict).toBe(t.doc.tableHeads!.get('LAYER')!.xdict);
    const back = roundTrip(worker, 'dwg', 'AC1032');
    expect(listLayerStates(back).map((s) => s.key)).toEqual(['평면도']);
  });

  it('이름 바꾸기·업데이트·지우기', () => {
    const t = sampleDoc();
    const w = new LayerStateWriter(t.doc, t.nh);
    w.put(captureLayerState(t.doc, { name: 'A' }));
    commit(t, w.finish());
    const h = findLayerState(t.doc, 'A')!.handle;
    // 이름 바꾸기: 같은 레코드
    const w2 = new LayerStateWriter(t.doc, t.nh);
    expect(w2.rename('a', 'B')).toBe(true);
    commit(t, w2.finish());
    expect(findLayerState(t.doc, 'A')).toBeNull();
    expect(findLayerState(t.doc, 'B')!.handle).toBe(h);
    // 업데이트: 같은 핸들, 새 값
    addLayer(t, 'NEW');
    const w3 = new LayerStateWriter(t.doc, t.nh);
    w3.put({ ...captureLayerState(t.doc, { name: 'B' }) });
    commit(t, w3.finish());
    expect(findLayerState(t.doc, 'B')!.handle).toBe(h);
    expect(findLayerState(t.doc, 'B')!.state.layers.some((l) => l.name === 'NEW')).toBe(true);
    // 지우기
    const w4 = new LayerStateWriter(t.doc, t.nh);
    expect(w4.remove('b')).toBe(true);
    commit(t, w4.finish());
    expect(listLayerStates(t.doc)).toEqual([]);
    expect(t.doc.objects.has(h)).toBe(false);
  });

  it('도면층 이름을 바꿔도 상태가 따라간다(핸들로 가리킨다)', () => {
    const t = sampleDoc();
    const w = new LayerStateWriter(t.doc, t.nh);
    w.put(captureLayerState(t.doc, { name: 'A' }));
    commit(t, w.finish());
    const L = t.doc.layers.get('WALL')!;
    commit(t, [
      { kind: 'layer', key: 'WALL', before: L, after: null },
      { kind: 'layer', key: 'WALL2', before: null, after: { ...L, name: 'WALL2' } },
    ]);
    const s = findLayerState(t.doc, 'A')!.state;
    expect(s.layers.some((l) => l.name === 'WALL2')).toBe(true);
    expect(s.layers.some((l) => l.name === 'WALL')).toBe(false);
  });

  it.skipIf(!fixture('samples/sample_AC1032.dwg'))('AutoCAD DWG 표본에 상태를 더해 DWG(R2018·R2000)·DXF로 저장해도 원래 상태와 새 상태가 그대로다', () => {
    const doc = readFixture(fixture('samples/sample_AC1032.dwg')!);
    let n = 0x9000;
    const nh = () => (n++).toString(16).toUpperCase();
    const w = new LayerStateWriter(doc, nh);
    w.put(captureLayerState(doc, { name: '새 상태', description: '설명', mask: 1 | 2 | 32 }));
    for (const op of w.finish()) if (op.kind === 'object') (op.after ? doc.objects.set(op.key, op.after) : doc.objects.delete(op.key));
    const want = listLayerStates(doc, { hidden: true }).map((x) => [x.key, norm(stateRecordTags(x.state, namerFor(doc)).filter((t) => t.code !== 330 && t.code !== 331))]);
    for (const [fmt, ver] of [
      ['dwg', 'AC1032'],
      ['dwg', 'AC1015'],
      ['dxf', 'AC1032'],
    ] as const) {
      const back = roundTrip(doc, fmt, ver);
      const got = listLayerStates(back, { hidden: true }).map((x) => [x.key, norm(stateRecordTags(x.state, namerFor(back)).filter((t) => t.code !== 330 && t.code !== 331))]);
      expect(got, `${fmt} ${ver}`).toEqual(want);
      const names = (b: typeof doc) => listLayerStates(b, { hidden: true }).map((x) => x.state.layers.map((l) => l.name).sort());
      expect(names(back)).toEqual(names(doc));
    }
  });

  it.skipIf(!fixture('all-samples/Mechanical - Metric.dwg'))('표본 상태를 지우면 그 확장 사전(주석 축척 레코드)도 지운다', () => {
    const doc = readFixture(fixture('all-samples/Mechanical - Metric.dwg')!);
    const s = listLayerStates(doc)[0]!;
    const x = doc.objects.get(s.handle) as XRecordObject;
    expect(x.xdict).toBeTruthy();
    const nh = (() => {
      let n = 0x7000;
      return () => (n++).toString(16).toUpperCase();
    })();
    const w = new LayerStateWriter(doc, nh);
    w.remove(s.key);
    const ops = w.finish();
    const removed = ops.flatMap((o) => (o.kind === 'object' && !o.after ? [o.key] : []));
    expect(removed).toContain(s.handle);
    expect(removed).toContain(x.xdict!.toUpperCase());
  });
});
