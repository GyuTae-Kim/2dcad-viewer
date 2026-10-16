/**
 * 설정 연결: OPTIONS 대화상자·시스템 변수(sysvars.ts의 이 브라우저 변수, options.ts의 AutoSnap 표식기 크기)를
 * 화면·입력이 쓰는 값으로 바꾸는 순수 계산. 값을 읽고 바뀔 때(onSysvarChange) 다시 읽는 일은 App(app.ts의 settings)이 하고,
 * 화면(view.ts)은 App이 넣어 주는 CadView.prefs만 읽는다. 이 모듈은 아무것도 가져오지 않는다(화면·시험이 가볍게 쓴다).
 * 기본값(AutoCAD 2026)에서는 설정을 잇기 전의 고정 크기·동작과 같게 맞췄다.
 */

/** 화면·입력이 읽는 설정(괄호 안은 시스템 변수 이름) */
export interface Settings {
  /** 선택 상자 반 변, 픽셀(PICKBOX) */
  pickbox: number;
  /** 그립 상자 크기, 픽셀(GRIPSIZE) */
  gripSize: number;
  /** 0이면 선택한 객체의 그립을 보이지 않는다(GRIPS) */
  grips: number;
  /** 십자선 길이, 화면 크기의 %. 100이면 화면 끝까지(CURSORSIZE) */
  cursorSize: number;
  /** 객체 스냅 조준창, 픽셀(APERTURE) */
  aperture: number;
  /** 1 표식기, 2 마그넷, 4 스냅 툴팁, 8 극좌표 추적, 16 객체 스냅 추적, 32 추적 툴팁(AUTOSNAP) */
  autosnap: number;
  /** AutoSnap 표식기 크기 1~20(OPTIONS 제도 탭, options.ts AUTOSNAPMARKER) */
  markerSize: number;
  /** 0이면 명령 전에 고른 객체를 명령이 쓰지 않는다 — 명사/동사 선택 끄기(PICKFIRST) */
  pickfirst: number;
  /** 0이면 새로 고른 것이 선택을 바꾸고 Shift로 더한다(PICKADD) */
  pickadd: number;
  /** 빈 곳을 누르면 창 선택: 1 객체 선택 프롬프트, 4 명령 프롬프트(PICKAUTO) */
  pickauto: number;
  /** 호버·창·올가미 미리 강조: 1 명령 중, 2 명령 없을 때(SELECTIONPREVIEW) */
  selectionPreview: number;
  /** 1 기본 모드 메뉴, 2 편집 모드 메뉴, 4 명령 모드 늘 메뉴, 8 옵션이 있을 때만, 16 시간에 민감한 오른쪽 클릭(SHORTCUTMENU) */
  shortcutMenu: number;
  /** 시간에 민감한 오른쪽 클릭에서 이만큼 누르면 메뉴, 밀리초(SHORTCUTMENUDURATION) */
  shortcutMenuDuration: number;
  /** 휠 한 칸의 확대 정도 3~100(ZOOMFACTOR) */
  zoomFactor: number;
}

/** AutoCAD 2026 기본값(sysvars.ts BROWSER_VARS와 같다) */
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  pickbox: 5,
  gripSize: 5,
  grips: 2,
  cursorSize: 5,
  aperture: 10,
  autosnap: 63,
  markerSize: 5,
  pickfirst: 1,
  pickadd: 2,
  pickauto: 5,
  selectionPreview: 3,
  shortcutMenu: 11,
  shortcutMenuDuration: 250,
  zoomFactor: 60,
});

/** 설정 칸 ↔ 변수 이름(options.ts optionValue가 받는 이름) */
export const SETTING_VARS: Readonly<Record<keyof Settings, string>> = {
  pickbox: 'PICKBOX',
  gripSize: 'GRIPSIZE',
  grips: 'GRIPS',
  cursorSize: 'CURSORSIZE',
  aperture: 'APERTURE',
  autosnap: 'AUTOSNAP',
  markerSize: 'AUTOSNAPMARKER',
  pickfirst: 'PICKFIRST',
  pickadd: 'PICKADD',
  pickauto: 'PICKAUTO',
  selectionPreview: 'SELECTIONPREVIEW',
  shortcutMenu: 'SHORTCUTMENU',
  shortcutMenuDuration: 'SHORTCUTMENUDURATION',
  zoomFactor: 'ZOOMFACTOR',
};

/** 이름 → 값 함수(optionValue)로 설정 묶음을 만든다. 읽지 못한 값(NaN 등)은 기본값 */
export function readSettings(get: (name: string) => number): Settings {
  const out = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(SETTING_VARS) as (keyof Settings)[]) {
    let v: number;
    try {
      v = get(SETTING_VARS[k]);
    } catch {
      continue;
    }
    if (Number.isFinite(v)) out[k] = v;
  }
  return out;
}

// --------------------------------------------------------------------------- 화면(view.ts)

/** 그립 상자 반 변(픽셀). GRIPSIZE 5에서 4 — 예전 고정 크기(8픽셀 상자) */
export function gripHalf(gripSize: number): number {
  return Math.max(1, gripSize * 0.8);
}

/** 그립을 고르는 거리(픽셀): 상자보다 2픽셀 넉넉히, 터치는 두 배. GRIPSIZE 5에서 6(터치 12) — 예전과 같다 */
export function gripPickRadius(gripSize: number, touch = false): number {
  return (gripHalf(gripSize) + 2) * (touch ? 2 : 1);
}

/**
 * 십자선 팔 길이(커서에서 한쪽 끝까지, 픽셀). CURSORSIZE 5에서 예전과 같은 "화면 긴 변의 5% + 20",
 * 100이면 커서가 어디 있어도 화면 끝에 닿는 길이
 */
export function crosshairArm(cursorSize: number, w: number, h: number): number {
  if (cursorSize >= 100) return (w + h) * 2;
  return (Math.max(w, h) * Math.max(1, cursorSize)) / 100 + 20;
}

/** AutoSnap 표식기 반지름(픽셀). 크기 5에서 6 — 예전 고정 크기 */
export function snapMarkerRadius(markerSize: number): number {
  return Math.max(1, markerSize) + 1;
}

/**
 * 휠 확대 배율(1보다 크면 확대). 마우스 휠은 ZOOMFACTOR에 비례해(60에서 한 칸(100) 약 1.25배 — 예전과 같다),
 * 트랙패드 핀치(ctrlKey)는 ZOOMFACTOR와 상관없이 세밀하게
 */
export function wheelZoom(deltaY: number, zoomFactor: number, pinch: boolean): number {
  if (pinch) return Math.exp(-deltaY * 0.01);
  return Math.exp(-deltaY * 0.0022 * (Math.min(100, Math.max(3, zoomFactor)) / 60));
}

/** AutoSnap 표식기를 그리는지(AUTOSNAP 1) */
export function showSnapMarker(autosnap: number): boolean {
  return (autosnap & 1) !== 0;
}

/** 객체 스냅 툴팁(스냅 이름)을 보이는지(AUTOSNAP 4) */
export function showSnapTip(autosnap: number): boolean {
  return (autosnap & 4) !== 0;
}

/** 극좌표·객체 스냅 추적 툴팁(거리 < 각도)을 보이는지(AUTOSNAP 32) */
export function showTrackTip(autosnap: number): boolean {
  return (autosnap & 32) !== 0;
}

/** 시간에 민감한 오른쪽 클릭이 켜져 있으면 길게 누름 기준(밀리초), 꺼져 있으면 null */
export function timedRightClick(s: Pick<Settings, 'shortcutMenu' | 'shortcutMenuDuration'>): number | null {
  return s.shortcutMenu & 16 ? s.shortcutMenuDuration : null;
}

/**
 * 시간에 민감한 오른쪽 클릭의 누른 시간 재기. contextmenu는 브라우저·운영체제에 따라 누를 때(macOS·Linux)나
 * 뗄 때(Windows) 오므로, 오른쪽 버튼 누름·뗌과 contextmenu를 받아 바로 보낼지 기다릴지 정한다(시각은 밀리초)
 */
export class RightClickTimer {
  private downAt: number | null = null;
  private upAt: number | null = null;
  /** 누른 채 온 contextmenu가 뗌(또는 기준 시간)을 기다리는 중 */
  private pending = false;

  /** 오른쪽 버튼을 눌렀다 */
  down(t: number): void {
    this.downAt = t;
    this.upAt = null;
    this.pending = false;
  }

  /** 오른쪽 버튼을 뗐다: 기다리던 contextmenu가 있으면 그 누른 시간, 없으면 null(뒤에 올 contextmenu가 쓴다) */
  up(t: number): number | null {
    if (this.downAt === null) return null;
    this.upAt = t;
    if (!this.pending) return null;
    const held = t - this.downAt;
    this.reset();
    return held;
  }

  /**
   * contextmenu가 왔다: 바로 보낼 누른 시간, 'wait'(아직 누르고 있다 — 뗌이나 기준 시간을 기다린다),
   * 누른 때를 모르면(키보드 메뉴 키, 오래된 기록) undefined
   */
  context(t: number): number | 'wait' | undefined {
    const d = this.downAt;
    if (d === null || t - d > 60_000 || (this.upAt !== null && t - this.upAt > 1000)) {
      this.reset();
      return undefined;
    }
    if (this.upAt === null) {
      this.pending = true;
      return 'wait';
    }
    const held = this.upAt - d;
    this.reset();
    return held;
  }

  /** 기준 시간이 지나도록 누르고 있다: 기다리던 contextmenu가 있으면 true(길게 누름으로 보낸다) */
  timeout(): boolean {
    if (!this.pending) return false;
    this.reset();
    return true;
  }

  private reset(): void {
    this.downAt = null;
    this.upAt = null;
    this.pending = false;
  }
}

// --------------------------------------------------------------------------- 선택·메뉴(app.ts)

/** 그립을 보이는지(GRIPS 0이면 그립도, 그립 편집도 없다) */
export function gripsOn(grips: number): boolean {
  return grips !== 0;
}

/** 명령이 먼저 고른 객체(명사/동사)를 쓰는지(PICKFIRST) */
export function usePickfirst(pickfirst: number): boolean {
  return pickfirst !== 0;
}

/** 선택 미리보기(호버 강조, 창·올가미에 걸릴 객체 강조)를 보이는지 */
export function previewOn(selectionPreview: number, commandActive: boolean): boolean {
  return (selectionPreview & (commandActive ? 1 : 2)) !== 0;
}

/** 빈 곳을 누르거나 끌 때 창·올가미 선택을 시작하는지(PICKAUTO 1 객체 선택 프롬프트, 4 명령 프롬프트) */
export function autoWindow(pickauto: number, selectPrompt: boolean): boolean {
  return (pickauto & (selectPrompt ? 1 : 4)) !== 0;
}

export type PickMode = 'add' | 'remove' | 'replace';

/**
 * 고르기 한 번(클릭·창·올가미)이 선택 세트를 바꾸는 방식(PICKADD).
 * removing: 객체 선택의 제거(R) 모드. selected: 누른 객체가 이미 골라져 있는지(명령 없이 한 개를 누를 때만 준다).
 *  - PICKADD 1·2: 더한다. Shift는 뺀다(명령 없이 고르지 않은 객체를 Shift로 누르면 더한다 — 예전과 같다)
 *  - PICKADD 0: 새로 고른 것으로 바꾼다. Shift는 더한다(이미 고른 객체를 Shift로 누르면 뺀다)
 */
export function pickMode(pickadd: number, o: { shift: boolean; removing?: boolean; selected?: boolean }): PickMode {
  if (o.removing) return 'remove';
  if (pickadd === 0) return o.shift ? (o.selected ? 'remove' : 'add') : 'replace';
  return o.shift ? (o.selected === false ? 'add' : 'remove') : 'add';
}

export type ContextMode = 'default' | 'edit' | 'command';

/**
 * 도면 영역 오른쪽 클릭: 메뉴를 띄울지, Enter(명령이 없으면 직전 명령 반복)인지(SHORTCUTMENU).
 * 기본 모드(선택 없음)는 1, 편집 모드(선택 있음)는 2, 명령 모드는 4(늘)·8(옵션이 있을 때만)이 켜져 있으면 메뉴.
 * 시간에 민감한 오른쪽 클릭(16)이 켜져 있고 누른 시간(held)을 알면 짧게 = Enter, duration 이상 = 메뉴
 */
export function contextAction(shortcutMenu: number, mode: ContextMode, hasOptions: boolean, held?: number, duration = DEFAULT_SETTINGS.shortcutMenuDuration): 'menu' | 'enter' {
  if (shortcutMenu & 16 && held !== undefined) return held >= duration ? 'menu' : 'enter';
  if (mode === 'default') return shortcutMenu & 1 ? 'menu' : 'enter';
  if (mode === 'edit') return shortcutMenu & 2 ? 'menu' : 'enter';
  if (shortcutMenu & 4) return 'menu';
  return shortcutMenu & 8 && hasOptions ? 'menu' : 'enter';
}
