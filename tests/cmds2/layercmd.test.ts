import { describe, expect, it } from 'vitest';
import { tableKey } from '../../src/core/model';
import {
  dashLayerPrompt,
  layerColorText,
  lineweightText,
  matchNameList,
  opacityFromPercent,
  parseLayerColor,
  parseLineweight,
  parseTransparency,
  parseTrueColor,
  percentFromOpacity,
  resolveDashLayerOption,
  splitNameList,
} from '../../src/edit/layercmd';
import { registerDashLayerCommand } from '../../src/app/layercmd';
import { line } from '../edit/make';
import { makeHarness } from './harness';

describe('-LAYER 옵션 해석', () => {
  it('주 프롬프트가 AutoCAD 2026 한국어판과 같다', () => {
    expect(dashLayerPrompt()).toBe(
      '옵션 입력 [?/만들기(M)/설정(S)/새로 만들기(N)/이름 바꾸기(R)/켜기(ON)/끄기(OFF)/색상(C)/선종류(L)/선가중치(LW)/투명도(TR)/재료(MAT)/플롯(P)/동결(F)/동결 해제(T)/잠금(LO)/잠금 해제(U)/상태(A)/설명(D)/조정(E)]:',
    );
  });

  it('열쇠·한국어 이름·영어판 이름·겹치지 않는 앞부분', () => {
    expect(resolveDashLayerOption('m')).toBe('M');
    expect(resolveDashLayerOption('lo')).toBe('LO');
    expect(resolveDashLayerOption('동결 해제')).toBe('T');
    expect(resolveDashLayerOption('_FREEZE')).toBe('F');
    expect(resolveDashLayerOption('make')).toBe('M');
    expect(resolveDashLayerOption('LT')).toBe('L');
    expect(resolveDashLayerOption('THA')).toBe('T');
    expect(resolveDashLayerOption('O')).toBeNull(); // ON·OFF 겹침
    expect(resolveDashLayerOption('XYZ')).toBeNull();
  });
});

describe('-LAYER 이름 리스트·와일드카드', () => {
  const all = ['0', 'Walls', 'WALL-2', 'Doors', 'Defpoints', 'A1', 'A2', 'B1', '벽체'];

  it('쉼표 리스트를 나누고 따옴표를 뗀다([] 안의 쉼표는 그대로)', () => {
    expect(splitNameList(' a , "b c" ,, d')).toEqual(['a', 'b c', 'd']);
    expect(splitNameList('[A,B]1,C')).toEqual(['[A,B]1', 'C']);
  });

  it('*, ?, #, [...], ~, 대소문자 무관', () => {
    expect(matchNameList(all, 'wall*').names).toEqual(['Walls', 'WALL-2']);
    expect(matchNameList(all, 'A?').names).toEqual(['A1', 'A2']);
    expect(matchNameList(all, '@#').names).toEqual(['A1', 'A2', 'B1']);
    expect(matchNameList(all, '[AB]1').names).toEqual(['A1', 'B1']);
    expect(matchNameList(all, 'WALL.2').names).toEqual(['WALL-2']);
    expect(matchNameList(all, '~*s').names).toEqual(['0', 'WALL-2', 'A1', 'A2', 'B1', '벽체']);
    expect(matchNameList(all, '벽*,doors').names).toEqual(['Doors', '벽체']);
  });

  it('맞는 이름이 없는 패턴을 알려 준다', () => {
    const m = matchNameList(all, 'A1,없음*,Z');
    expect(m.names).toEqual(['A1']);
    expect(m.unmatched).toEqual(['없음*', 'Z']);
  });
});

describe('-LAYER 값', () => {
  it('색상: 번호·이름·음수(끄기)·트루컬러', () => {
    expect(parseLayerColor('1')).toEqual({ color: { aci: 1 }, off: false });
    expect(parseLayerColor('red')).toEqual({ color: { aci: 1 }, off: false });
    expect(parseLayerColor('파란색')).toEqual({ color: { aci: 5 }, off: false });
    expect(parseLayerColor('-3')).toEqual({ color: { aci: 3 }, off: true });
    expect(parseLayerColor('0')).toBeNull();
    expect(parseLayerColor('256')).toBeNull();
    expect(parseTrueColor('255, 128,0')?.rgb).toBe(0xff8000);
    expect(parseTrueColor('300,0,0')).toBeNull();
    expect(layerColorText({ aci: 1 })).toBe('1 (빨간색)');
    expect(layerColorText({ aci: 30 })).toBe('30');
    expect(layerColorText({ aci: 30, rgb: 0x0a0b0c })).toBe('10,11,12');
  });

  it('선가중치: mm → 가까운 표준 값, 기본값', () => {
    expect(parseLineweight('0.3')).toBe(30);
    expect(parseLineweight('.30mm')).toBe(30);
    expect(parseLineweight('0.33')).toBe(35);
    expect(parseLineweight('2.11')).toBe(211);
    expect(parseLineweight('2.2')).toBeNull();
    expect(parseLineweight('기본값')).toBe(-3);
    expect(parseLineweight('abc')).toBeNull();
    expect(lineweightText(30)).toBe('0.30mm');
    expect(lineweightText(-3)).toBe('기본값');
  });

  it('투명도: 0–90 %와 불투명도', () => {
    expect(parseTransparency('50')).toBe(50);
    expect(parseTransparency('91')).toBeNull();
    expect(opacityFromPercent(0)).toBe(255);
    expect(opacityFromPercent(50)).toBe(128);
    expect(percentFromOpacity(128)).toBe(50);
  });
});

describe('-LAYER 명령(스크립트 흐름)', () => {
  const layer = (h: ReturnType<typeof makeHarness>, n: string) => h.doc.layers.get(tableKey(n));

  it('새로 만들기·만들기·색상·선가중치·동결·잠금·켜기·끄기 — 옵션마다 명령 취소 한 단계', async () => {
    const h = makeHarness();
    registerDashLayerCommand(h.app);
    const undo0 = (h.st.session as unknown as { undoStack: unknown[] }).undoStack.length;
    await h.run('-LAYER', [
      'N',
      'A1,A2,B1',
      'M',
      'WALL',
      'C',
      '1',
      'A*',
      'LW',
      '0.3',
      '',
      'F',
      'B1,WALL',
      'LO',
      'A?',
      'OFF',
      'A1',
      'TR',
      '50',
      'A2',
      'P',
      'N',
      'B1',
      '',
    ]);
    expect(h.printed[0]).toBe('현재 도면층: "0"');
    expect(h.doc.header.get('$CLAYER')).toBe('WALL');
    expect(layer(h, 'A1')?.color).toEqual({ aci: 1 });
    expect(layer(h, 'A2')?.color).toEqual({ aci: 1 });
    expect(layer(h, 'B1')?.color).toEqual({ aci: 7 });
    expect(layer(h, 'WALL')?.lineweight).toBe(30);
    expect(layer(h, 'B1')?.frozen).toBe(true);
    // 현재 도면층은 동결하지 않는다
    expect(layer(h, 'WALL')?.frozen).toBe(false);
    expect(h.printed.some((t) => t.includes('"WALL"을(를) 동결할 수 없습니다'))).toBe(true);
    expect(layer(h, 'A1')?.locked && layer(h, 'A2')?.locked).toBe(true);
    expect(layer(h, 'A1')?.off).toBe(true);
    expect(layer(h, 'A2')?.transparency).toBe(128);
    expect(layer(h, 'B1')?.plot).toBe(false);
    const undo1 = (h.st.session as unknown as { undoStack: unknown[] }).undoStack.length;
    // 옵션 9개(N, M, C, LW, F, LO, OFF, TR, P) = 9단계
    expect(undo1 - undo0).toBe(9);
    // 명령 취소 한 번이면 마지막 옵션(플롯)만 되돌린다
    h.st.session.undo();
    expect(layer(h, 'B1')?.plot).toBe(true);
    expect(layer(h, 'A2')?.transparency).toBe(128);
  });

  it('현재 도면층 끄기는 확인하고, 설정(S)·이름 바꾸기(R)·동결 해제·잠금 해제·켜기·목록', async () => {
    const h = makeHarness();
    registerDashLayerCommand(h.app);
    await h.run('-LAYER', ['N', 'X1,X2', 'OFF', '0', '', 'F', 'X1', 'T', 'X*', 'LO', 'X2', 'U', 'X2', 'S', 'X1', 'R', 'X2', 'Y2', 'ON', '*', '?', '', '']);
    expect(h.prompts).toContain('현재 도면층 "0"을(를) 끄시겠습니까? [예(Y)/아니오(N)] <아니오(N)>:');
    expect(layer(h, '0')?.off).toBe(false);
    expect(layer(h, 'X1')?.frozen).toBe(false);
    expect(layer(h, 'Y2')?.locked).toBe(false);
    expect(layer(h, 'X2')).toBeUndefined();
    expect(h.doc.header.get('$CLAYER')).toBe('X1');
    expect(h.prompts).toContain('나열할 도면층 이름(들) 입력 <*>:');
    expect(h.printed.some((t) => t.startsWith('"Y2"'))).toBe(true);
  });

  it('객체로 도면층 고르기, 선종류, 없는 이름·잘못된 이름·재료·상태 안내', async () => {
    const h = makeHarness((doc) => {
      doc.layers.set('L1', { ...doc.layers.get('0')!, name: 'L1', handle: 'A0' });
      doc.linetypes.set('DASHED', { name: 'DASHED', handle: 'A1', flags: 0, description: '__ __', patternLength: 1, elements: [] } as never);
    });
    registerDashLayerCommand(h.app);
    const e = h.add({ ...line(0, 0, 1, 1), layer: 'L1' });
    await h.run('-LAYER', ['LO', '', { sel: [e.handle] }, 'L', 'NOPE', 'dashed', 'L1', 'N', 'a<b', 'C', '3', 'Q*', 'MAT', '', 'A', 'BOGUS', '']);
    expect(layer(h, 'L1')?.locked).toBe(true);
    expect(layer(h, 'L1')?.linetype).toBe('DASHED');
    expect(h.printed.some((t) => t.includes('선종류 NOPE을(를) 찾을 수 없습니다'))).toBe(true);
    expect(h.printed).toContain('"a<b"은(는) 유효하지 않은 도면층 이름임.');
    expect(h.printed).toContain('일치하는 도면층 이름을 찾지 못함: Q*');
    expect(h.printed.some((t) => t.includes('재료는 3D'))).toBe(true);
    expect(h.printed.some((t) => t.includes('도면층 상태(LAYERSTATE)'))).toBe(true);
    expect(h.printed).toContain('옵션 키워드가 잘못되었습니다.');
  });
});
