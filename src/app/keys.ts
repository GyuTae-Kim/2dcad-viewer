/**
 * Ctrl(맥은 ⌘) 단축키 가운데 AutoCAD 2026의 제도 보조·입력 키(Shift·Alt 없이):
 *   Ctrl+G 격자, Ctrl+B 스냅, Ctrl+L 직교, Ctrl+F 객체 스냅, Ctrl+U 극좌표, Ctrl+H PICKSTYLE(그룹 선택),
 *   Ctrl+K 하이퍼링크, Ctrl+0 화면 정리, Ctrl+8 빠른 계산기, Ctrl+J·Ctrl+M Enter, Ctrl+\ 취소.
 * 브라우저가 페이지에 넘기지 않는 조합(Ctrl+N·W·T·Tab, 맥의 ⌘H·⌘M·⌘Q)은 여기서 다룰 수 없다.
 * 열기·저장·명령 취소 같은 그 밖의 Ctrl 키는 app.ts onKey가 직접 다룬다.
 */
export type Toggle = 'grid' | 'snap' | 'ortho' | 'osnap' | 'polar' | 'pickstyle';

export type KeyAction = { toggle: Toggle } | { run: string } | { enter: true } | { cancel: true };

const MAP: Record<string, KeyAction> = {
  g: { toggle: 'grid' },
  b: { toggle: 'snap' },
  l: { toggle: 'ortho' },
  f: { toggle: 'osnap' },
  u: { toggle: 'polar' },
  h: { toggle: 'pickstyle' },
  k: { run: 'HYPERLINK' },
  '0': { run: 'CLEANSCREENON' },
  '8': { run: 'QUICKCALC' },
  j: { enter: true },
  m: { enter: true },
  '\\': { cancel: true },
};

/** Ctrl+키(Shift·Alt 없이)의 동작. 이 표에 없으면 null */
export function ctrlAction(ev: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): KeyAction | null {
  if (!(ev.ctrlKey || ev.metaKey) || ev.shiftKey || ev.altKey) return null;
  // 한글 자판 상태에서도 같은 자리의 키로(KeyG → g)
  const k = /^Key([A-Z])$/.exec(ev.code ?? '')?.[1]?.toLowerCase() ?? (ev.code === 'Digit0' ? '0' : ev.code === 'Digit8' ? '8' : ev.code === 'Backslash' ? '\\' : ev.key.toLowerCase());
  return MAP[k] ?? null;
}
