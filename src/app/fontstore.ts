/**
 * 사용자가 불러온 SHX 글꼴을 이 브라우저(IndexedDB)에 보관한다. 다음에 열 때 다시 고르지 않아도 된다.
 * 저장소를 쓸 수 없는 환경(사생활 보호 창 등)에서는 조용히 건너뛴다.
 */
const DB = 'opencad-fonts';
const STORE = 'shx';

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveFonts(files: { name: string; data: Uint8Array }[]): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      for (const f of files) st.put(f.data, f.name.toLowerCase());
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    /* 보관하지 못해도 이번에는 쓴다 */
  } finally {
    db.close();
  }
}

export async function loadFonts(): Promise<{ name: string; data: Uint8Array }[]> {
  const db = await open();
  if (!db) return [];
  try {
    return await new Promise((resolve) => {
      const out: { name: string; data: Uint8Array }[] = [];
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(out);
        const v = c.value as Uint8Array | ArrayBuffer;
        out.push({ name: String(c.key), data: v instanceof Uint8Array ? v : new Uint8Array(v) });
        c.continue();
      };
      req.onerror = () => resolve(out);
    });
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export async function clearFonts(): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* 무시 */
  } finally {
    db.close();
  }
}
