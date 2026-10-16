// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountWelcome, type EditorActions } from '../src/app/startup';
const recent = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
vi.mock('../src/app/recent', () => ({ RecentStore: class { list = recent.list; get = recent.get; } }));
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
let dispose: (() => void) | undefined;
let root: HTMLElement;
let ready: EditorActions;
const click = (label: string) => {
  const button = [...root.querySelectorAll('button')].find((b) => b.textContent === label)!;
  button.click();
};
beforeEach(() => {
  vi.clearAllMocks();
  recent.list.mockResolvedValue([]);
  recent.get.mockResolvedValue(null);
  history.replaceState(null, '', '/');
  localStorage.clear();
  document.body.innerHTML = '<div id="app"><main class="site-intro"><h1>OpenCAD</h1><p>DWG·DXF</p><section id="viewer-guide">안내</section></main></div>';
  root = document.getElementById('app')!;
  ready = { openFiles: vi.fn().mockResolvedValue(undefined), openSample: vi.fn().mockResolvedValue(undefined), newDrawing: vi.fn().mockResolvedValue(undefined), openRecent: vi.fn().mockResolvedValue(undefined) };
});
afterEach(() => { dispose?.(); dispose = undefined; });
describe('intent-driven CAD startup', () => {
  it('keeps the guide and native picker usable without downloading CAD, including cancellation', async () => {
    const load = vi.fn().mockResolvedValue(ready);
    const picker = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    dispose = mountWelcome(root, load);
    click('파일 열기');
    expect(picker).toHaveBeenCalledOnce();
    root.querySelector('input')!.dispatchEvent(new Event('change'));
    await flush();
    expect(load).not.toHaveBeenCalled();
    expect(root.querySelector('#viewer-guide')!.textContent).toBe('안내');
    picker.mockRestore();
  });
  it('loads once and opens all selected files through the existing editor actions', async () => {
    const load = vi.fn().mockResolvedValue(ready);
    dispose = mountWelcome(root, load);
    const files = [new File(['DXF'], 'a.dxf'), new File(['DWG'], 'b.dwg')];
    const input = root.querySelector('input')!;
    Object.defineProperty(input, 'files', { value: files });
    input.dispatchEvent(new Event('change'));
    await flush();
    expect(load).toHaveBeenCalledOnce();
    expect(ready.openFiles).toHaveBeenCalledWith(files);
  });
  it.each([['예제 도면 열기', 'openSample'], ['새 도면', 'newDrawing']] as const)('starts %s only after intent', async (label, method) => {
    const load = vi.fn().mockResolvedValue(ready);
    dispose = mountWelcome(root, load);
    expect(load).not.toHaveBeenCalled();
    click(label);
    await flush();
    expect(load).toHaveBeenCalledOnce();
    expect(ready[method]).toHaveBeenCalledOnce();
  });
  it('preserves global drop and releases its listeners when CAD takes over', async () => {
    const load = vi.fn().mockResolvedValue(ready);
    dispose = mountWelcome(root, load);
    const files = [new File(['DXF'], 'drop.dxf')];
    const drop = () => {
      const event = new Event('drop', { cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { files } });
      window.dispatchEvent(event);
    };
    drop(); await flush(); drop(); await flush();
    expect(load).toHaveBeenCalledOnce();
    expect(ready.openFiles).toHaveBeenCalledOnce();
  });
  it('deduplicates concurrent initialization and allows retry after download failure', async () => {
    let fail!: (error: Error) => void;
    const load = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; })).mockResolvedValue(ready);
    dispose = mountWelcome(root, load);
    click('예제 도면 열기');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true }));
    await flush();
    expect(load).toHaveBeenCalledOnce();
    fail(new Error('offline')); await flush();
    expect(root.querySelector('[role="alert"]')!.textContent).toContain('새로고침');
    click('예제 도면 열기'); await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(ready.openSample).toHaveBeenCalledOnce();
  });
  it.each(['?sample', '?open=/samples/test.dxf'])('hands launch URL %s to the original editor', async (query) => {
    history.replaceState(null, '', '/' + query);
    const load = vi.fn().mockResolvedValue(ready);
    dispose = mountWelcome(root, load); await flush();
    expect(load).toHaveBeenCalledOnce();
    expect(location.search).toBe(query);
  });
  it('restores the saved theme and recent file without uploading it', async () => {
    localStorage.setItem('opencad.colortheme', '1');
    recent.list.mockResolvedValue([{ id: 'recent', name: '최근.dwg' }]);
    const bytes = new ArrayBuffer(4);
    recent.get.mockResolvedValue(bytes);
    const load = vi.fn().mockResolvedValue(ready);
    dispose = mountWelcome(root, load); await flush();
    expect(document.documentElement.dataset.theme).toBe('light');
    click('최근.dwg'); await flush();
    expect(ready.openRecent).toHaveBeenCalledWith('최근.dwg', bytes);
  });
  it('announces an evicted recent file without loading CAD', async () => {
    recent.list.mockResolvedValue([{ id: 'gone', name: 'gone.dwg' }]);
    const load = vi.fn().mockResolvedValue(ready);
    dispose = mountWelcome(root, load); await flush(); click('gone.dwg'); await flush();
    expect(load).not.toHaveBeenCalled();
    expect(root.querySelector('[role="alert"]')!.textContent).toContain('파일을 찾지 못했습니다');
  });
});
