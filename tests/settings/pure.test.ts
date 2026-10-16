/**
 * 설정 연결의 순수 계산(src/app/settings.ts): 기본값에서는 예전 고정 크기·동작과 같고, 값에 따라 바뀐다.
 * 그립 크기·고르기 거리(GRIPSIZE), 십자선(CURSORSIZE), 표식기(AutoSnap 표식기 크기), 휠(ZOOMFACTOR),
 * AUTOSNAP 비트, SELECTIONPREVIEW·PICKAUTO·PICKADD·SHORTCUTMENU, 시간에 민감한 오른쪽 클릭의 누른 시간 재기.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  RightClickTimer,
  SETTING_VARS,
  autoWindow,
  contextAction,
  crosshairArm,
  gripHalf,
  gripPickRadius,
  gripsOn,
  pickMode,
  previewOn,
  readSettings,
  showSnapMarker,
  showSnapTip,
  showTrackTip,
  snapMarkerRadius,
  timedRightClick,
  usePickfirst,
  wheelZoom,
} from '../../src/app/settings';
import { BROWSER_VARS, setBrowserSysvar } from '../../src/app/sysvars';
import { optionValue } from '../../src/app/options';
import { prefSet } from '../../src/app/mgr-ui';

afterEach(() => {
  for (const v of BROWSER_VARS) prefSet(`opencad.sysvar.${v.name}`, null);
  prefSet('opencad.options.autosnapMarker', null);
});

describe('설정 읽기', () => {
  it('기본값은 sysvars.ts의 이 브라우저 변수 기본값과 같다', () => {
    for (const [k, name] of Object.entries(SETTING_VARS)) {
      const v = BROWSER_VARS.find((b) => b.name === name);
      if (v) expect(DEFAULT_SETTINGS[k as keyof typeof DEFAULT_SETTINGS], name).toBe(v.def);
    }
    expect(DEFAULT_SETTINGS.markerSize).toBe(5);
    expect(readSettings(optionValue)).toEqual(DEFAULT_SETTINGS);
  });

  it('optionValue로 바뀐 변수·표식기 크기를 읽고, 읽지 못하면 기본값', () => {
    expect(setBrowserSysvar('GRIPSIZE', 12)).toBeNull();
    expect(setBrowserSysvar('ZOOMFACTOR', 90)).toBeNull();
    prefSet('opencad.options.autosnapMarker', '9');
    const s = readSettings(optionValue);
    expect(s.gripSize).toBe(12);
    expect(s.zoomFactor).toBe(90);
    expect(s.markerSize).toBe(9);
    const odd = readSettings((n) => {
      if (n === 'APERTURE') throw new Error('x');
      return n === 'PICKADD' ? NaN : 0;
    });
    expect(odd.aperture).toBe(10);
    expect(odd.pickadd).toBe(2);
    expect(odd.grips).toBe(0);
  });
});

describe('화면 크기 계산', () => {
  it('그립: GRIPSIZE 5에서 예전 8픽셀 상자·6픽셀 고르기(터치 12), 크기에 비례, 1이어도 보인다', () => {
    expect(gripHalf(5)).toBe(4);
    expect(gripPickRadius(5)).toBe(6);
    expect(gripPickRadius(5, true)).toBe(12);
    expect(gripHalf(10)).toBe(8);
    expect(gripPickRadius(10)).toBe(10);
    expect(gripHalf(1)).toBe(1);
    expect(gripsOn(0)).toBe(false);
    expect(gripsOn(2)).toBe(true);
  });

  it('십자선: CURSORSIZE 5에서 예전 길이(긴 변의 5% + 20), 100이면 어디서든 화면 끝까지', () => {
    expect(crosshairArm(5, 1000, 600)).toBe(1000 * 0.05 + 20);
    expect(crosshairArm(5, 1000, 600)).toBeLessThan(crosshairArm(50, 1000, 600));
    // 화면 구석에 있어도 반대편 끝까지 닿는다
    expect(crosshairArm(100, 1000, 600)).toBeGreaterThanOrEqual(1000);
  });

  it('AutoSnap 표식기: 크기 5에서 예전 반지름 6', () => {
    expect(snapMarkerRadius(5)).toBe(6);
    expect(snapMarkerRadius(20)).toBe(21);
    expect(snapMarkerRadius(1)).toBe(2);
  });

  it('휠: ZOOMFACTOR 60에서 예전 배율(한 칸 약 1.25배), 클수록 많이, 핀치는 그대로', () => {
    expect(wheelZoom(-100, 60, false)).toBeCloseTo(Math.exp(0.22), 12);
    expect(wheelZoom(100, 60, false)).toBeCloseTo(Math.exp(-0.22), 12);
    expect(wheelZoom(-100, 100, false)).toBeGreaterThan(wheelZoom(-100, 60, false));
    expect(wheelZoom(-100, 3, false)).toBeLessThan(wheelZoom(-100, 60, false));
    expect(wheelZoom(-100, 3, false)).toBeGreaterThan(1);
    expect(wheelZoom(-10, 100, true)).toBe(wheelZoom(-10, 3, true));
    // 범위 밖 값은 3~100으로
    expect(wheelZoom(-100, 500, false)).toBe(wheelZoom(-100, 100, false));
  });

  it('AUTOSNAP 비트: 1 표식기, 4 스냅 툴팁, 32 추적 툴팁', () => {
    expect([showSnapMarker(63), showSnapTip(63), showTrackTip(63)]).toEqual([true, true, true]);
    expect([showSnapMarker(0), showSnapTip(0), showTrackTip(0)]).toEqual([false, false, false]);
    expect([showSnapMarker(63 & ~1), showSnapTip(63 & ~4), showTrackTip(63 & ~32)]).toEqual([false, false, false]);
    expect(showSnapMarker(1)).toBe(true);
  });
});

describe('선택 계산', () => {
  it('PICKFIRST·SELECTIONPREVIEW·PICKAUTO', () => {
    expect(usePickfirst(1)).toBe(true);
    expect(usePickfirst(0)).toBe(false);
    expect([previewOn(3, true), previewOn(3, false)]).toEqual([true, true]);
    expect([previewOn(1, true), previewOn(1, false)]).toEqual([true, false]);
    expect([previewOn(2, true), previewOn(2, false)]).toEqual([false, true]);
    expect([previewOn(0, true), previewOn(0, false)]).toEqual([false, false]);
    expect([autoWindow(5, true), autoWindow(5, false)]).toEqual([true, true]);
    expect([autoWindow(1, true), autoWindow(1, false)]).toEqual([true, false]);
    expect([autoWindow(4, true), autoWindow(4, false)]).toEqual([false, true]);
    expect([autoWindow(0, true), autoWindow(0, false)]).toEqual([false, false]);
  });

  it('PICKADD 1·2는 예전과 같이 더하기·Shift 빼기, 0은 바꾸기·Shift 더하기', () => {
    for (const pa of [1, 2]) {
      expect(pickMode(pa, { shift: false })).toBe('add');
      expect(pickMode(pa, { shift: true })).toBe('remove');
      expect(pickMode(pa, { shift: true, selected: true })).toBe('remove');
      expect(pickMode(pa, { shift: true, selected: false })).toBe('add');
      expect(pickMode(pa, { shift: false, removing: true })).toBe('remove');
    }
    expect(pickMode(0, { shift: false })).toBe('replace');
    expect(pickMode(0, { shift: false, selected: true })).toBe('replace');
    expect(pickMode(0, { shift: true })).toBe('add');
    expect(pickMode(0, { shift: true, selected: false })).toBe('add');
    expect(pickMode(0, { shift: true, selected: true })).toBe('remove');
    expect(pickMode(0, { shift: false, removing: true })).toBe('remove');
  });
});

describe('오른쪽 클릭', () => {
  it('SHORTCUTMENU 11(기본): 기본·편집 모드 메뉴, 명령 모드는 옵션이 있을 때만 메뉴', () => {
    expect(contextAction(11, 'default', true)).toBe('menu');
    expect(contextAction(11, 'edit', true)).toBe('menu');
    expect(contextAction(11, 'command', true)).toBe('menu');
    expect(contextAction(11, 'command', false)).toBe('enter');
  });

  it('비트를 끄면 Enter(반복), 4는 명령 모드 늘 메뉴, 0은 모두 Enter', () => {
    expect(contextAction(10, 'default', true)).toBe('enter');
    expect(contextAction(9, 'edit', true)).toBe('enter');
    expect(contextAction(3, 'command', true)).toBe('enter');
    expect(contextAction(7, 'command', false)).toBe('menu');
    for (const m of ['default', 'edit', 'command'] as const) expect(contextAction(0, m, true)).toBe('enter');
  });

  it('시간에 민감한 오른쪽 클릭(16): 짧으면 Enter, 기준 시간 이상이면 메뉴, 누른 시간을 모르면 모드 비트', () => {
    expect(timedRightClick({ shortcutMenu: 11, shortcutMenuDuration: 250 })).toBeNull();
    expect(timedRightClick({ shortcutMenu: 27, shortcutMenuDuration: 400 })).toBe(400);
    expect(contextAction(27, 'default', true, 100, 250)).toBe('enter');
    expect(contextAction(27, 'command', false, 300, 250)).toBe('menu');
    expect(contextAction(16, 'edit', true, 250, 250)).toBe('menu');
    expect(contextAction(27, 'default', true, undefined, 250)).toBe('menu');
    expect(contextAction(16, 'default', true, undefined, 250)).toBe('enter');
    // 꺼져 있으면 누른 시간은 보지 않는다
    expect(contextAction(11, 'default', true, 10, 250)).toBe('menu');
  });

  it('누른 시간 재기: 누를 때 오는 contextmenu는 떼거나 기준 시간이 지날 때까지 기다리고, 뗄 때 오면 바로', () => {
    const t = new RightClickTimer();
    // macOS·Linux: 누름 → contextmenu(기다림) → 뗌
    t.down(1000);
    expect(t.context(1001)).toBe('wait');
    expect(t.up(1120)).toBe(120);
    // 길게 누르면 기준 시간에 보낸다(뒤의 뗌은 무시)
    t.down(2000);
    expect(t.context(2000)).toBe('wait');
    expect(t.timeout()).toBe(true);
    expect(t.up(2600)).toBeNull();
    expect(t.timeout()).toBe(false);
    // Windows: 누름 → 뗌 → contextmenu
    t.down(3000);
    expect(t.up(3300)).toBeNull();
    expect(t.context(3301)).toBe(300);
    // 키보드 메뉴 키(누름 없음)·오래된 기록은 모른다
    expect(t.context(4000)).toBeUndefined();
    t.down(5000);
    t.up(5100);
    expect(t.context(9000)).toBeUndefined();
  });
});
