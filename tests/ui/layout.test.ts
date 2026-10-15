import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NARROW_WIDTH, PHONE_WIDTH, clampBox, foldCount, keyboardLift, layoutClasses, layoutMode, ribbonOverlay, scrollLeftToShow, sheetFraction, statusHidden } from '../../src/app/ui/layout';

describe('폭 기준 배치 단계', () => {
  it('휴대폰·좁음·태블릿·데스크톱 경계', () => {
    expect(layoutMode(320)).toBe('phone');
    expect(layoutMode(375)).toBe('phone');
    expect(layoutMode(480)).toBe('phone');
    expect(layoutMode(481)).toBe('narrow');
    expect(layoutMode(759)).toBe('narrow');
    expect(layoutMode(760)).toBe('tablet');
    expect(layoutMode(768)).toBe('tablet');
    expect(layoutMode(1024)).toBe('tablet');
    expect(layoutMode(1279)).toBe('tablet');
    expect(layoutMode(1280)).toBe('desktop');
    expect(layoutMode(1920)).toBe('desktop');
  });

  it('겹침 리본: 760px 미만이거나 480px보다 낮은 화면', () => {
    expect(ribbonOverlay(375, 812)).toBe(true);
    expect(ribbonOverlay(600, 900)).toBe(true);
    expect(ribbonOverlay(759, 900)).toBe(true);
    expect(ribbonOverlay(760, 900)).toBe(false);
    expect(ribbonOverlay(1024, 768)).toBe(false);
    expect(ribbonOverlay(1280, 800)).toBe(false);
    // 가로로 눕힌 휴대폰
    expect(ribbonOverlay(812, 375)).toBe(true);
  });

  it('배치 클래스', () => {
    expect(layoutClasses(375, 812)).toEqual(['layout-phone', 'ribbon-overlay']);
    expect(layoutClasses(768, 1024)).toEqual(['layout-tablet']);
    expect(layoutClasses(1280, 800)).toEqual(['layout-desktop']);
    expect(layoutClasses(812, 375)).toEqual(['layout-tablet', 'ribbon-overlay']);
  });
});

describe('리본 패널 접기(오른쪽부터 단추 하나로)', () => {
  const full = [623, 411, 145, 600, 200, 250, 100];
  const folded = full.map(() => 63);

  it('다 들어가면 접지 않는다', () => {
    expect(foldCount(full, folded, 3000)).toBe(0);
    expect(foldCount(full, folded, full.reduce((a, b) => a + b, 0))).toBe(0);
  });

  it('오른쪽부터 넘치지 않을 때까지 접는다', () => {
    // 1280px 데스크톱(리본 안쪽 1272px): 첫 패널만 펼친 채로 남는다
    expect(foldCount(full, folded, 1272)).toBe(6);
    // 넉넉하면 앞의 둘이 남는다
    expect(foldCount(full, folded, 623 + 411 + 5 * 63)).toBe(5);
    expect(foldCount(full, folded, 623 + 411 + 5 * 63 - 2)).toBe(6);
  });

  it('나머지를 다 접어도 넘치면 첫 패널도 접는다', () => {
    // 768px 태블릿: 623 + 6×63 = 1001 > 760
    expect(foldCount(full, folded, 760)).toBe(7);
    // 다 접어도 넘치면 전부 접은 채로(나머지는 가로 스크롤)
    expect(foldCount(full, folded, 200)).toBe(7);
  });

  it('1px 반올림 오차는 넘침으로 보지 않는다', () => {
    expect(foldCount([100, 100], [50, 50], 200.5)).toBe(0);
    expect(foldCount([100, 100], [50, 50], 199)).toBe(0);
    expect(foldCount([100, 100], [50, 50], 198)).toBe(1);
  });
});

describe('상태 막대 넘침', () => {
  const items = [
    { w: 220, prio: 20 }, // 좌표
    { w: 10, prio: 0 }, // 구분선
    { w: 28, prio: 100 }, // 객체 스냅
    { w: 28, prio: 60 }, // 격자
    { w: 28, prio: 95 }, // 직교
    { w: 28, prio: 25 }, // 배경색
    { w: 28, prio: 85 }, // 특성
  ];

  it('넘치지 않으면 숨기지 않는다', () => {
    expect(statusHidden(items, 400, 30).size).toBe(0);
  });

  it('우선순위가 낮은 것부터 숨기고 "⋯" 자리를 뺀다', () => {
    // 합 370, "⋯" 30: 300에 맞추려면 구분선(0)·좌표(20)를 숨긴다
    const h = statusHidden(items, 300, 30);
    expect([...h].sort()).toEqual([0, 1]);
    // 더 좁으면 배경색·격자 순서로
    expect([...statusHidden(items, 120, 30)].sort()).toEqual([0, 1, 3, 5]);
  });

  it('같은 우선순위면 오른쪽 것부터', () => {
    const same = [
      { w: 50, prio: 10 },
      { w: 50, prio: 10 },
      { w: 50, prio: 10 },
    ];
    expect([...statusHidden(same, 120, 20)]).toEqual([2]);
    expect([...statusHidden(same, 110, 20)]).toEqual([2, 1]);
  });
});

describe('소프트 키보드', () => {
  it('보이는 영역 아래 끝보다 아래에 있는 만큼 올린다', () => {
    // 812px 화면, 작업 영역 아래 끝 738, 키보드 300px
    expect(keyboardLift(738, 0, 512)).toBe(226);
    // 키보드가 없으면 0
    expect(keyboardLift(738, 0, 812)).toBe(0);
    // iOS가 페이지를 위로 민 경우(offsetTop)
    expect(keyboardLift(738, 120, 512)).toBe(106);
  });

  it('손가락으로 확대한 동안은 올리지 않는다', () => {
    expect(keyboardLift(738, 300, 300, 2)).toBe(0);
  });
});

describe('떠 있는 상자와 시트', () => {
  it('화면 밖으로 나가지 않게 둔다', () => {
    expect(clampBox(350, 700, 220, 300, 375, 812)).toEqual({ left: 151, top: 508 });
    expect(clampBox(-20, -5, 100, 100, 375, 812)).toEqual({ left: 4, top: 4 });
  });

  it('시트 높이는 25%~90%', () => {
    expect(sheetFraction(0.5)).toBe(0.5);
    expect(sheetFraction(0.05)).toBe(0.25);
    expect(sheetFraction(1.4)).toBe(0.9);
    expect(sheetFraction(Number.NaN)).toBe(0.5);
  });

  it('가로 스크롤 상자 안에서 고른 탭이 보이게', () => {
    // 이미 보이면 그대로
    expect(scrollLeftToShow(0, 375, 100, 80)).toBe(0);
    // 오른쪽 밖이면 오른쪽 끝에 맞춘다
    expect(scrollLeftToShow(0, 375, 400, 80)).toBe(400 + 80 - 375 + 8);
    // 왼쪽 밖이면 왼쪽 끝에 맞춘다
    expect(scrollLeftToShow(300, 375, 100, 80)).toBe(92);
  });
});

describe('CSS와 배치 기준이 어긋나지 않는다', () => {
  const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');

  it('좁은 화면 미디어 쿼리는 NARROW_WIDTH 미만, 휴대폰은 PHONE_WIDTH 이하', () => {
    expect(NARROW_WIDTH).toBe(760);
    expect(PHONE_WIDTH).toBe(480);
    expect(css).toContain('@media (max-width: 759.98px)');
    expect(css).not.toMatch(/@media \(max-width: 760px\)/);
    expect(css).toContain('@media (max-width: 480px)');
  });

  it('작업 영역 행이 0이 되지 않게: 행을 못 박고, dvh를 모를 때의 높이를 먼저 둔다', () => {
    for (const [cls, row] of [
      ['titlebar', 1],
      ['ribbon-tabs', 2],
      ['ribbon', 3],
      ['filetabs', 4],
      ['workspace', 5],
      ['layouttabs', 6],
      ['statusbar', 7],
    ] as const)
      expect(css).toContain(`#app > .${cls} { grid-row: ${row}; }`);
    const app = /#app \{[^}]*\}/.exec(css)![0];
    expect(app).toMatch(/minmax\(0, 1fr\)/);
    expect(app.indexOf('height: 100%;')).toBeGreaterThan(-1);
    expect(app.indexOf('height: 100%;')).toBeLessThan(app.indexOf('height: 100dvh;'));
  });

  it('겹침 리본은 절대 위치라 작업 영역 행 높이를 바꾸지 않는다', () => {
    const block = /#app\.ribbon-overlay > \.ribbon \{[^}]*\}/.exec(css)![0];
    expect(block).toContain('position: absolute;');
    expect(css).toMatch(/#app\.ribbon-overlay \{\s*position: relative;/);
  });
});
