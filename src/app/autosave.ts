/**
 * 자동 저장과 도면 복구: SAVETIME(분, 0이면 끔), DRAWINGRECOVERY(도면 복구 관리자), DRAWINGRECOVERYHIDE, RECOVER.
 * 바뀐 도면을 SAVETIME마다 이 브라우저(IndexedDB)에 같은 형식으로 저장해 둔다(AutoCAD의 .sv$ 자리).
 * 저장하거나 닫으면 지우고, 브라우저가 갑자기 닫히면 남아 다음에 열 때 복구할 수 있다. 파일은 이 컴퓨터를 떠나지 않는다.
 */
import type { App, CommandContext } from './app';
import type { DocState } from './docstate';
import { sameFormat } from './save';
import { baseName, download } from './export';
import { ask, dialog, h, toast } from './ui/dom';

const DB = 'opencad-recovery';
const STORE = 'docs';
const PREF = 'opencad.savetime';
/** 이 창(탭)의 열쇠 앞머리: 여러 창이 같은 저장소를 써도 섞이지 않게 */
const SESSION = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export interface RecoveryEntry {
  id: string;
  name: string;
  format: 'dwg' | 'dxf';
  version: string;
  savedAt: number;
  size: number;
  data: Uint8Array;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore, done: (v: T) => void) => void, fallback: T): Promise<T> {
  const db = await openDb();
  if (!db) return fallback;
  try {
    return await new Promise<T>((resolve) => {
      const tx = db.transaction(STORE, mode);
      let out = fallback;
      fn(tx.objectStore(STORE), (v) => (out = v));
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => resolve(fallback);
      tx.onabort = () => resolve(fallback);
    });
  } catch {
    return fallback;
  } finally {
    db.close();
  }
}

export function listRecovery(): Promise<RecoveryEntry[]> {
  return withStore<RecoveryEntry[]>(
    'readonly',
    (s, done) => {
      const req = s.getAll();
      req.onsuccess = () => done((req.result as RecoveryEntry[]).sort((a, b) => b.savedAt - a.savedAt));
    },
    [],
  );
}

function putRecovery(e: RecoveryEntry): Promise<boolean> {
  return withStore<boolean>('readwrite', (s, done) => (s.put(e).onsuccess = () => done(true)), false);
}

export function deleteRecovery(id: string): Promise<boolean> {
  return withStore<boolean>('readwrite', (s, done) => (s.delete(id).onsuccess = () => done(true)), false);
}

// ---------------------------------------------------------------------------
// 자동 저장
// ---------------------------------------------------------------------------

/** SAVETIME(분). 이 브라우저에 보관 */
export function saveTime(): number {
  try {
    const v = localStorage.getItem(PREF);
    if (v !== null && Number.isFinite(Number(v))) return Math.max(0, Math.min(600, Math.round(Number(v))));
  } catch {
    /* 기본값 */
  }
  return 10;
}

function setSaveTime(v: number): void {
  try {
    localStorage.setItem(PREF, String(v));
  } catch {
    /* 이번 세션만 */
  }
}

const idOf = (st: DocState) => `${SESSION}-${st.docId}`;
/** 문서별 마지막 자동 저장(편집 세대, 시각) */
const last = new WeakMap<DocState, { gen: number; at: number }>();
let busy = false;

/** 바뀐 도면을 하나씩 자동 저장한다(때가 된 것만, force면 바뀐 것 모두) */
async function autosaveTick(app: App, force = false): Promise<number> {
  const minutes = saveTime();
  if (busy || (!force && minutes <= 0)) return 0;
  busy = true;
  let n = 0;
  try {
    for (const st of [...app.docs]) {
      if (!st.session?.dirty) continue;
      const prev = last.get(st);
      if (prev && prev.gen === st.gen) continue;
      const due = force || !prev || Date.now() - prev.at >= minutes * 60_000;
      if (!due) continue;
      const t = sameFormat(st) ?? { format: 'dxf' as const, version: 'AC1032', binary: false };
      try {
        await app.edits.flush(st);
        const gen = st.gen;
        const res = await app.engine.save(st.docId, t.format, t.version, false);
        if (!app.docs.includes(st)) continue;
        const ok = await putRecovery({ id: idOf(st), name: st.saveName, format: t.format, version: t.version, savedAt: Date.now(), size: res.data.byteLength, data: res.data });
        last.set(st, { gen, at: Date.now() });
        if (ok) n++;
      } catch {
        // 자동 저장이 실패해도 작업은 계속한다(다음 차례에 다시)
        last.set(st, { gen: -1, at: Date.now() });
      }
    }
  } finally {
    busy = false;
  }
  return n;
}

/** 저장하거나 닫은 도면의 자동 저장본을 지운다 */
export function forgetRecovery(st: DocState): void {
  last.delete(st);
  void deleteRecovery(idOf(st));
}

// ---------------------------------------------------------------------------
// 도면 복구 관리자
// ---------------------------------------------------------------------------

let manager: HTMLDivElement | null = null;

function fmtTime(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function openEntry(app: App, e: RecoveryEntry): Promise<void> {
  const ext = e.format === 'dwg' ? 'dwg' : 'dxf';
  const st = await app.openFile(`${baseName(e.name)}_recover.${ext}`, e.data.buffer.slice(e.data.byteOffset, e.data.byteOffset + e.data.byteLength) as ArrayBuffer);
  if (st) {
    st.saveName = e.name;
    app.cmd.print(`${e.name}의 자동 저장본(${fmtTime(e.savedAt)})을 열었습니다. 원래 파일에 저장하려면 다른 이름으로 저장하십시오.`);
  }
}

async function showManager(app: App): Promise<void> {
  manager?.remove();
  manager = null;
  const list = (await listRecovery()).filter((e) => !e.id.startsWith(`${SESSION}-`));
  const body = h('div', { class: 'recovery' });
  const render = (items: RecoveryEntry[]) => {
    body.replaceChildren();
    if (!items.length) {
      body.append(h('p', {}, '복구할 도면이 없습니다.'));
      return;
    }
    body.append(h('p', { style: 'margin:0 0 8px;color:var(--text-dim)' }, '브라우저가 갑자기 닫히기 전에 자동 저장한 도면입니다. 열어서 확인한 뒤 저장하십시오.'));
    const rows = items.map((e) => {
      const open = h('button', { class: 'btn primary' }, '열기');
      const save = h('button', { class: 'btn' }, '내려받기');
      const del = h('button', { class: 'btn' }, '삭제');
      open.addEventListener('click', () => void openEntry(app, e));
      save.addEventListener('click', () => download(new Blob([e.data as BlobPart]), `${baseName(e.name)}_recover.${e.format}`));
      del.addEventListener('click', async () => {
        await deleteRecovery(e.id);
        render(items.filter((x) => x !== e));
      });
      return h(
        'tr',
        {},
        h('td', {}, e.name),
        h('td', { style: 'white-space:nowrap' }, fmtTime(e.savedAt)),
        h('td', { style: 'white-space:nowrap;text-align:right' }, `${(e.size / 1024).toFixed(0)} KB`),
        h('td', { style: 'white-space:nowrap' }, open, ' ', save, ' ', del),
      );
    });
    body.append(h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', {}, '도면'), h('th', {}, '자동 저장'), h('th', {}, '크기'), h('th', {}, ''))), h('tbody', {}, ...rows)));
  };
  render(list);
  manager = dialog('도면 복구 관리자', body, [
    {
      label: '모두 삭제',
      run: () => {
        void (async () => {
          const items = (await listRecovery()).filter((e) => !e.id.startsWith(`${SESSION}-`));
          if (!items.length) return;
          const a = await ask('도면 복구 관리자', `자동 저장본 ${items.length}개를 모두 지울까요?`, [
            { label: '삭제', value: 'yes', primary: true },
            { label: '취소', value: 'no' },
          ]);
          if (a !== 'yes') return;
          for (const e of items) await deleteRecovery(e.id);
          render([]);
        })();
        return false;
      },
    },
    { label: '닫기', primary: true },
  ]);
}

export function registerAutosaveCommands(app: App): void {
  // 30초마다 때가 된 도면을 자동 저장
  setInterval(() => void autosaveTick(app), 30_000);
  // 닫은 도면은 자동 저장본을 지운다
  const prevClosed = app.onClosed;
  app.onClosed = (st) => {
    prevClosed?.(st);
    forgetRecovery(st);
  };
  // 시작할 때 다른 창에서 남은 자동 저장본이 있으면 알린다
  void listRecovery().then((items) => {
    const n = items.filter((e) => !e.id.startsWith(`${SESSION}-`)).length;
    if (n) toast(`복구할 수 있는 도면이 ${n}개 있습니다. DRAWINGRECOVERY로 여십시오.`, 'warn', 8000);
  });

  app.register({
    name: 'SAVETIME',
    title: '자동 저장 간격',
    noDoc: true,
    transparent: true,
    async run(ctx: CommandContext) {
      const cur = saveTime();
      const r = await ctx.getPoint(`SAVETIME에 대한 새 값 입력 <${cur}>:`, { preferNumber: true, allowText: true });
      if (!('text' in r)) return;
      const v = Math.round(Number(r.text));
      if (!Number.isFinite(v) || v < 0 || v > 600) {
        ctx.print('0과 600 사이의 정수를 입력하십시오.', 'err');
        return;
      }
      setSaveTime(v);
      ctx.print(v ? `${v}분마다 바뀐 도면을 이 브라우저에 자동 저장합니다.` : '자동 저장을 껐습니다.');
    },
  });

  app.register({
    name: 'DRAWINGRECOVERY',
    aliases: ['DRM'],
    title: '도면 복구 관리자',
    noDoc: true,
    run: () => showManager(app),
  });

  app.register({
    name: 'DRAWINGRECOVERYHIDE',
    title: '도면 복구 관리자 닫기',
    noDoc: true,
    run: () => {
      manager?.remove();
      manager = null;
    },
  });

  app.register({
    name: 'AUTOSAVENOW',
    title: '지금 자동 저장',
    async run(ctx) {
      const n = await autosaveTick(app, true);
      ctx.print(n ? `바뀐 도면 ${n}개를 이 브라우저에 자동 저장했습니다.` : '자동 저장할 바뀐 도면이 없습니다.');
    },
  });

  app.register({
    name: 'RECOVER',
    title: '복구',
    noDoc: true,
    async run(ctx) {
      // 파일을 골라 열고 감사(AUDIT)로 고친다
      const input = h('input', { type: 'file', accept: '.dxf,.dwg,.DXF,.DWG', hidden: true }) as HTMLInputElement;
      document.body.append(input);
      const file = await new Promise<File | null>((resolve) => {
        input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
        input.addEventListener('cancel', () => resolve(null), { once: true });
        input.click();
      });
      input.remove();
      if (!file) return;
      const st = await app.openFile(file.name, await file.arrayBuffer());
      if (!st) return;
      ctx.print(`${file.name}을(를) 열었습니다. 도면을 검사합니다.`);
      if (app.findCommand('AUDIT')) await app.run('AUDIT', 'Y');
    },
  });
}
