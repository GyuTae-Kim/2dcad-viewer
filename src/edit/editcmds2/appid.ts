/**
 * APPID 표(등록한 앱 이름) 편집 작업(화면·DOM 없음).
 * regapp와 확장 데이터를 쓰기 전의 앱 등록을 편집 세션의 'appId' 작업으로 남겨 명령 취소(U)·다시 하기로 되돌린다.
 */
import type { CadDocument, TableRecordBase } from '../../core/model';
import { tableKey } from '../../core/model';
import type { EditOp } from '../session';

/** 앱 이름으로 쓸 수 없는 글자(표 기록 이름 규칙) */
const BAD = /[<>/\\":;?*|,=`]/;

/** 앱 이름이 맞는지(빈 이름·255자 초과·금지 글자면 거짓) */
export function validAppName(name: string): boolean {
  const n = name.trim();
  return !!n && n.length <= 255 && !BAD.test(n) && !/[\u0000-\u001f]/.test(n);
}

/**
 * 앱 이름 등록 작업 하나. 이미 등록했거나 이름이 틀리면 null.
 * handle은 부르는 쪽이 편집 세션에서 받은 새 핸들이다.
 */
export function regAppOp(doc: CadDocument, name: string, handle: string): EditOp | null {
  const n = name.trim();
  if (!validAppName(n)) return null;
  const key = tableKey(n);
  if (doc.appIds.has(key)) return null;
  const after: TableRecordBase = { name: n, handle, flags: 0 };
  return { kind: 'appId', key, before: null, after };
}

/** 확장 데이터가 쓰는 앱 중 아직 등록하지 않은 것을 등록하는 작업들(같은 이름은 한 번만) */
export function missingAppOps(doc: CadDocument, apps: readonly string[], newHandle: () => string): EditOp[] {
  const out: EditOp[] = [];
  const seen = new Set<string>();
  for (const a of apps) {
    const key = tableKey(a.trim());
    if (!validAppName(a) || seen.has(key) || doc.appIds.has(key)) continue;
    seen.add(key);
    const op = regAppOp(doc, a, newHandle());
    if (op) out.push(op);
  }
  return out;
}
