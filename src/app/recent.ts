/** 최근 문서: 이 브라우저의 IndexedDB에만 저장한다(서버로 보내지 않는다). */
export interface RecentEntry {
  id: string;
  name: string;
  size: number;
  time: number;
}

const DB = 'opencad-2d';
const STORE = 'recent';
const MAX = 8;
const MAX_SIZE = 60 * 1024 * 1024;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const r = fn(t.objectStore(STORE));
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      }),
  );
}

export class RecentStore {
  async list(): Promise<RecentEntry[]> {
    try {
      const all = (await tx('readonly', (s) => s.getAll())) as (RecentEntry & { data?: ArrayBuffer })[];
      return all.map(({ id, name, size, time }) => ({ id, name, size, time })).sort((a, b) => b.time - a.time);
    } catch {
      return [];
    }
  }

  async add(name: string, data: ArrayBuffer): Promise<void> {
    if (data.byteLength > MAX_SIZE) return;
    try {
      const id = `${name}:${data.byteLength}`;
      await tx('readwrite', (s) => s.put({ id, name, size: data.byteLength, time: Date.now(), data }));
      const list = await this.list();
      for (const old of list.slice(MAX)) await tx('readwrite', (s) => s.delete(old.id));
    } catch {
      /* 저장 공간을 쓸 수 없는 환경(비공개 창 등) */
    }
  }

  async get(id: string): Promise<ArrayBuffer | null> {
    try {
      const r = (await tx('readonly', (s) => s.get(id))) as { data?: ArrayBuffer } | undefined;
      if (r?.data) await tx('readwrite', (s) => s.put({ ...r, time: Date.now() }));
      return r?.data ?? null;
    } catch {
      return null;
    }
  }
}
