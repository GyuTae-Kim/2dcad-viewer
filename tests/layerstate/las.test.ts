/** 도면층 상태 파일(.las): 쓰기 꼴(CR LF·3칸 코드·CP949), 읽기(UTF-8·CP949·\U+), 왕복, 형식 오류, 가져오기 */
import { describe, expect, it } from 'vitest';
import { decoderFor } from '../../src/core/codepage';
import { importLayerStatesOps } from '../../src/edit/layerstate/import';
import { LasFormatError, lasFileName, lasText, parseLas, readLas, writeLas } from '../../src/edit/layerstate/las';
import { LSF_OFF, LSF_PLOT, LSM_ALL, type LayerState } from '../../src/edit/layerstate/record';
import { captureLayerState, findLayerState, listLayerStates } from '../../src/edit/layerstate/store';
import { addLayer, addLinetype, commit, duplicateHandles, fixture, newDoc, readFixture } from './helpers';

function sample(): LayerState {
  return {
    name: '평면도',
    mask: LSM_ALL,
    description: '1층 평면',
    paperSpace: true,
    currentLayer: '벽',
    layers: [
      { name: '벽', flags: LSF_PLOT, color: { aci: 1 }, lineweight: 35, linetype: 'Continuous', plotStyle: 'Color_1', transparency: 255 },
      { name: 'GLASS', flags: LSF_OFF, color: { aci: 150, rgb: 0x1192ee }, lineweight: -3, linetype: 'HIDDEN', plotStyle: 'Color_150', transparency: 76 },
    ],
  };
}

describe('.las 쓰기', () => {
  it('AutoCAD 꼴: CR LF, 그룹 코드 3칸 오른쪽 맞춤, 도면층마다 8·90·62·370·6·2·440(+92)', () => {
    const t = lasText([sample()]);
    expect(t.endsWith('\r\n')).toBe(true);
    const lines = t.split('\r\n');
    expect(lines.slice(0, 6)).toEqual(['  0', 'LAYERSTATEDICTIONARY', '  0', 'LAYERSTATE', '  1', '평면도']);
    expect(lines.slice(6, 16)).toEqual([' 91', '2047', '301', '1층 평면', '290', '1', '302', '벽', '  8', '벽']);
    const gi = lines.indexOf('GLASS');
    // 마지막 도면층: 트루컬러 92가 끝에 오고 파일은 줄 끝으로 끝난다
    expect(lines.slice(gi - 1)).toEqual(['  8', 'GLASS', ' 90', '1', ' 62', '150', '370', '-3', '  6', 'HIDDEN', '  2', 'Color_150', '440', '33554508', ' 92', '-1039035666', '']);
  });

  it('CP949로 쓰고, 그 코드 페이지에 없는 글자는 \\U+XXXX', () => {
    const s = sample();
    s.description = 'ǅ 표시';
    const bytes = writeLas([s]);
    const text = decoderFor('euc-kr').decode(bytes);
    expect(text).toContain('평면도');
    expect(text).toContain('\\U+01C5 표시');
    expect(readLas(bytes)[0]!.description).toBe('ǅ 표시');
  });

  it('왕복: 쓰고 읽으면 같다', () => {
    const back = readLas(writeLas([sample()]));
    expect(back).toEqual([sample()]);
  });

  it('UTF-8 파일과 여러 상태도 읽는다', () => {
    const two = lasText([sample(), { ...sample(), name: 'B', layers: [] }]);
    const st = readLas(new TextEncoder().encode(two));
    expect(st.map((s) => s.name)).toEqual(['평면도', 'B']);
  });

  it('형식이 아니면 오류', () => {
    expect(() => parseLas('hello')).toThrow(LasFormatError);
    expect(() => parseLas('  0\r\nSECTION\r\n')).toThrow('도면층 상태 파일(LAS)의 형식이 올바르지 않습니다.');
  });

  it('파일 이름', () => {
    expect(lasFileName('A/B:C')).toBe('A_B_C.las');
  });
});

describe('가져오기', () => {
  it('.las: 없는 도면층과 표준 선종류를 만들고, 같은 이름은 물어서 덮어쓴다', () => {
    const t = newDoc();
    addLayer(t, '벽', { color: { aci: 3 } });
    const r = importLayerStatesOps(t.doc, t.nh, [sample()]);
    expect(r.imported).toEqual(['평면도']);
    expect(r.createdLayers).toEqual(['GLASS']);
    expect(r.loadedLinetypes).toEqual(['HIDDEN']);
    commit(t, r.ops);
    const G = t.doc.layers.get('GLASS')!;
    expect([G.off, G.color.rgb, G.linetype, G.transparency]).toEqual([true, 0x1192ee, 'HIDDEN', 76]);
    // 기존 도면층 값은 바꾸지 않는다(복원은 따로)
    expect(t.doc.layers.get('벽')!.color.aci).toBe(3);
    const s = findLayerState(t.doc, '평면도')!.state;
    expect(s.layers.map((l) => l.name).sort()).toEqual(['GLASS', '벽']);
    expect(duplicateHandles(t.doc)).toEqual([]);
    // 같은 이름: 덮어쓰지 않으면 건너뛴다
    const again = importLayerStatesOps(t.doc, t.nh, [{ ...sample(), description: '새 설명' }], { overwrite: () => false });
    expect(again.skipped).toEqual(['평면도']);
    const over = importLayerStatesOps(t.doc, t.nh, [{ ...sample(), description: '새 설명' }], { overwrite: () => true });
    commit(t, over.ops);
    expect(findLayerState(t.doc, '평면도')!.state.description).toBe('새 설명');
    expect(listLayerStates(t.doc).length).toBe(1);
  });

  it('찾지 못한 선종류는 Continuous, 올바르지 않은 이름은 뺀다', () => {
    const t = newDoc();
    const s = sample();
    s.layers[0]!.linetype = 'MY_LT';
    s.layers.push({ ...s.layers[0]!, name: 'a<b' });
    const r = importLayerStatesOps(t.doc, t.nh, [s, { ...s, name: 'x|y' }]);
    expect(r.missingLinetypes).toEqual(['MY_LT']);
    expect(r.droppedLayers).toBe(1);
    expect(r.invalid).toEqual(['x|y']);
    commit(t, r.ops);
    expect(t.doc.layers.get('벽')!.linetype).toBe('Continuous');
  });

  it.skipIf(!fixture('all-samples/Mechanical - Metric.dwg'))('다른 도면: 그 도면의 도면층 정의를 가져온다', () => {
    const src = readFixture(fixture('all-samples/Mechanical - Metric.dwg')!);
    const states = listLayerStates(src).map((s) => s.state);
    const t = newDoc();
    addLinetype(t, 'DASHED');
    const r = importLayerStatesOps(t.doc, t.nh, states, { source: src });
    expect(r.imported).toEqual(['MODEL TAB VISUAL FIDELITY']);
    commit(t, r.ops);
    expect(t.doc.layers.has('ATT-2')).toBe(true);
    const s = findLayerState(t.doc, 'MODEL TAB VISUAL FIDELITY')!.state;
    expect(s.mask).toBe(1023);
    expect(s.layers.map((l) => l.name)).toEqual(expect.arrayContaining(['0', 'ATT-2', 'ATT-3']));
    expect(duplicateHandles(t.doc)).toEqual([]);
  });

  it('지금 도면에서 만든 상태를 .las로 내보내고 다른 도면에 가져온다', () => {
    const a = newDoc();
    addLayer(a, 'X', { color: { aci: 4 }, off: true });
    const s = captureLayerState(a.doc, { name: 'S1' });
    const b = newDoc();
    const r = importLayerStatesOps(b.doc, b.nh, readLas(writeLas([s])));
    commit(b, r.ops);
    expect(b.doc.layers.get('X')!.off).toBe(true);
    expect(findLayerState(b.doc, 'S1')!.state.layers.find((l) => l.name === 'X')!.color.aci).toBe(4);
  });
});
