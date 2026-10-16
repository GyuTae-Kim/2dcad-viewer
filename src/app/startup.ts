import { RecentStore } from './recent';
import { colorTheme } from './theme';

export interface EditorActions {
  openFiles(files: File[]): Promise<void>;
  openSample(): Promise<void>;
  newDrawing(): Promise<void>;
  openRecent(name: string, bytes: ArrayBuffer): Promise<void>;
}

/** Keep file selection and the server-rendered guide usable before loading CAD. */
export function mountWelcome(root: HTMLElement, load: () => Promise<EditorActions>): () => void {
  if (colorTheme() === 1) document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  const intro = root.querySelector<HTMLElement>('.site-intro');
  if (!intro) throw new Error('Missing welcome page');
  intro.classList.add('boot-start');
  const events = new AbortController();
  const actions = document.createElement('div');
  actions.className = 'boot-actions';
  const status = document.createElement('p');
  status.className = 'boot-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.dxf,.dwg,.scr,.lsp,.mnl';
  input.multiple = true;
  input.hidden = true;
  let editor: Promise<EditorActions> | null = null;
  const busy = (value: boolean) => {
    intro.setAttribute('aria-busy', String(value));
    intro.querySelectorAll('button').forEach((button) => { button.disabled = value; });
  };
  const report = (message: string) => {
    status.setAttribute('role', 'alert');
    status.textContent = message;
  };
  const ensure = (): Promise<EditorActions> => {
    if (!editor) {
      busy(true);
      status.setAttribute('role', 'status');
      status.textContent = '뷰어를 준비하고 있습니다…';
      editor = Promise.resolve().then(load).then((ready) => {
        events.abort();
        return ready;
      }).catch((error: unknown) => {
        editor = null;
        if (!root.contains(intro)) events.abort(); // Preserve the editor's WebGL fallback.
        else {
          busy(false);
          report('뷰어를 준비하지 못했습니다. 인터넷 연결을 확인한 뒤 새로고침해 주세요.');
          status.append(button('새로고침', () => location.reload()));
        }
        throw error;
      });
    }
    return editor;
  };
  const run = (action: (ready: EditorActions) => Promise<void>) => {
    void ensure().then(action).catch(() => { /* Loading errors are announced above; CAD reports file errors. */ });
  };
  const button = (label: string, action: () => void, primary = false): HTMLButtonElement => {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = primary ? 'btn primary' : 'btn';
    element.textContent = label;
    element.addEventListener('click', action, { signal: events.signal });
    return element;
  };
  actions.append(
    button('파일 열기', () => input.click(), true),
    button('예제 도면 열기', () => run((ready) => ready.openSample())),
    button('새 도면', () => run((ready) => ready.newDrawing())),
  );
  intro.querySelector('h1 + p')?.after(actions, status);
  intro.append(input);
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length) run((ready) => ready.openFiles(files));
  }, { signal: events.signal });
  window.addEventListener('dragover', (event) => {
    event.preventDefault();
    intro.classList.add('drag');
  }, { signal: events.signal });
  window.addEventListener('dragleave', () => intro.classList.remove('drag'), { signal: events.signal });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    intro.classList.remove('drag');
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length) run((ready) => ready.openFiles(files));
  }, { signal: events.signal });
  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || editor) return;
    if (event.key.toLowerCase() === 'o') { event.preventDefault(); input.click(); }
    if (event.key.toLowerCase() === 'n') { event.preventDefault(); run((ready) => ready.newDrawing()); }
  }, { signal: events.signal });

  const recent = new RecentStore();
  const section = document.createElement('section');
  section.className = 'boot-recent';
  section.setAttribute('aria-label', '최근 문서');
  const heading = document.createElement('h2');
  heading.textContent = '최근 문서';
  const list = document.createElement('div');
  list.className = 'boot-recent-list';
  list.textContent = '최근 문서를 확인하고 있습니다…';
  section.append(heading, list);
  status.after(section);
  void recent.list().then((entries) => {
    if (!root.contains(intro)) return;
    list.replaceChildren();
    if (!entries.length) list.textContent = '이 브라우저에서 연 도면이 여기에 표시됩니다.';
    for (const entry of entries) {
      const item = button(entry.name, () => {
        void recent.get(entry.id).then((bytes) => {
          if (bytes) run((ready) => ready.openRecent(entry.name, bytes));
          else report('저장된 파일을 찾지 못했습니다. 파일 열기로 다시 선택해 주세요.');
        });
      });
      item.disabled = editor !== null;
      list.append(item);
    }
  });
  const params = new URLSearchParams(location.search);
  if (params.has('sample') || params.get('open')) void ensure().catch(() => {});
  return () => events.abort();
}
