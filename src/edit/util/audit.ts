/**
 * AUDIT(UI 없음): 도면을 검사하고 고칠 작업을 만든다.
 * 검사: 헤더(현재 도면층·선종류·문자 스타일·치수 스타일, 핸들 시드), 표(도면층의 선종류), 객체(없는 도면층·선종류·문자 스타일·
 * 치수 스타일·블록, 빈 핸들·같은 핸들, 소유자, 수가 아닌 좌표, 0 반지름·0 축척), 블록(자기 참조), 그룹(없는 구성원·빈 그룹).
 */
import type { AttribEntity, CadDocument, Entity, Layer } from '../../core/model';
import { normalizeHandle, tableKey } from '../../core/model';
import type { EditOp } from '../session';
import { cloneEntity, isLayoutBlock } from '../session';
import { blockReaches } from './blockutil';
import { deleteGroupOps, listGroups, updateGroupOps } from './groups';

export type AuditPhase = 'header' | 'tables' | 'entities' | 'blocks' | 'objects';

export interface AuditIssue {
  phase: AuditPhase;
  /** 객체 핸들(있을 때) */
  handle?: string;
  /** 객체 종류 또는 대상 이름 */
  target: string;
  message: string;
  /** 고치는 방법 */
  fix: string;
}

export interface AuditReport {
  issues: AuditIssue[];
  /** 고칠 작업을 만든다(핸들은 newHandle로). 지우는 객체 수도 돌려준다 */
  fix(newHandle: () => string): { ops: EditOp[]; erased: number };
}

const isNum = (v: unknown) => typeof v === 'number';

/** 객체 안의 수가 모두 유한한지(dwgRaw·xdata·raw 태그는 보지 않는다) */
function allFinite(o: unknown, depth = 0): boolean {
  if (depth > 6 || o === null || typeof o !== 'object') return isNum(o) ? Number.isFinite(o as number) : true;
  if (ArrayBuffer.isView(o)) return true;
  if (Array.isArray(o)) return o.every((x) => allFinite(x, depth + 1));
  for (const [k, v] of Object.entries(o)) {
    if (k === 'dwgRaw' || k === 'xdata' || k === 'raw' || k === 'graphics' || k === 'overrides' || k === 'props') continue;
    if (!allFinite(v, depth + 1)) return false;
  }
  return true;
}

/** 문서에서 가장 큰 핸들 값 */
export function maxHandle(doc: CadDocument): bigint {
  let max = 0n;
  const see = (h: string | undefined) => {
    if (!h) return;
    try {
      const v = BigInt('0x' + h);
      if (v > max) max = v;
    } catch {
      /* 핸들이 아니다 */
    }
  };
  for (const b of doc.blocks.values()) {
    see(b.handle);
    see(b.recordHandle);
    see(b.endHandle);
    for (const e of b.entities) {
      see(e.handle);
      if (e.type === 'INSERT') for (const a of e.attribs) see(a.handle);
    }
  }
  for (const h of doc.objects.keys()) see(h);
  for (const t of [doc.layers, doc.linetypes, doc.textStyles, doc.dimStyles, doc.blockRecords, doc.views, doc.ucs, doc.appIds]) for (const r of t.values()) see(r.handle);
  for (const v of doc.vports) see(v.handle);
  for (const t of doc.tableHeads?.values() ?? []) see(t.handle);
  return max;
}

const BUILTIN_LT = new Set(['BYLAYER', 'BYBLOCK', 'CONTINUOUS']);

export function auditDocument(doc: CadDocument): AuditReport {
  const issues: AuditIssue[] = [];
  const fixes: ((ctx: FixCtx) => void)[] = [];
  const firstStyle = doc.textStyles.has('STANDARD') ? doc.textStyles.get('STANDARD')!.name : 'Standard';
  const dimFallback = doc.dimStyles.get('STANDARD')?.name ?? [...doc.dimStyles.values()][0]?.name ?? 'Standard';

  // ---------------------------------------------------------------- 헤더
  const hstr = (n: string) => {
    const v = doc.header.get(n);
    return typeof v === 'string' ? v : undefined;
  };
  const headerFix = (name: string, have: boolean, after: string, what: string) => {
    const v = hstr(name);
    if (v === undefined || !v || have) return;
    issues.push({ phase: 'header', target: name.slice(1), message: `${what} "${v}"이(가) 없습니다.`, fix: `${after}(으)로 설정` });
    fixes.push((c) => c.ops.push({ kind: 'header', name, before: v, after }));
  };
  headerFix('$CLAYER', doc.layers.has(tableKey(hstr('$CLAYER') ?? '0')), '0', '현재 도면층');
  const celt = hstr('$CELTYPE');
  headerFix('$CELTYPE', !celt || BUILTIN_LT.has(tableKey(celt)) || doc.linetypes.has(tableKey(celt)), 'ByLayer', '현재 선종류');
  headerFix('$TEXTSTYLE', doc.textStyles.has(tableKey(hstr('$TEXTSTYLE') ?? 'STANDARD')), firstStyle, '현재 문자 스타일');
  if (doc.dimStyles.size) headerFix('$DIMSTYLE', doc.dimStyles.has(tableKey(hstr('$DIMSTYLE') ?? 'STANDARD')), dimFallback, '현재 치수 스타일');
  const seed = hstr('$HANDSEED');
  const max = maxHandle(doc);
  let seedV = 0n;
  try {
    seedV = BigInt('0x' + (seed || '0'));
  } catch {
    seedV = 0n;
  }
  if (seedV <= max) {
    const after = normalizeHandle((max + 1n).toString(16));
    issues.push({ phase: 'header', target: 'HANDSEED', message: `핸들 시드 ${seed ?? '(없음)'}이(가) 가장 큰 핸들 ${normalizeHandle(max.toString(16))}보다 작습니다.`, fix: `${after}(으)로 설정` });
    fixes.push((c) => {
      const cur = doc.header.get('$HANDSEED');
      const v = typeof cur === 'string' ? cur : '0';
      let now = 0n;
      try {
        now = BigInt('0x' + v);
      } catch {
        now = 0n;
      }
      if (now <= max) c.ops.push({ kind: 'header', name: '$HANDSEED', before: cur, after });
    });
  }

  // ---------------------------------------------------------------- 표
  for (const [lk, l] of doc.layers) {
    if (!l.linetype || BUILTIN_LT.has(tableKey(l.linetype)) || doc.linetypes.has(tableKey(l.linetype))) continue;
    issues.push({ phase: 'tables', target: `도면층 ${l.name}`, message: `선종류 "${l.linetype}"이(가) 없습니다.`, fix: 'Continuous로 설정' });
    fixes.push((c) => c.ops.push({ kind: 'layer', key: lk, before: l, after: { ...l, linetype: 'Continuous' } }));
  }

  // ---------------------------------------------------------------- 객체
  const missingLayers = new Map<string, string>();
  const seen = new Map<string, { block: string; entity: Entity }>();
  const dupFirst = new Set<string>();
  /** 블록 → 고칠 객체(핸들 대신 자리로) */
  const replace = new Map<string, Map<number, { e: Entity; next: Entity | null; newHandle: boolean }>>();
  const plan = (block: string, index: number, e: Entity) => {
    let m = replace.get(block);
    if (!m) {
      m = new Map();
      replace.set(block, m);
    }
    let p = m.get(index);
    if (!p) {
      p = { e, next: cloneEntity(e), newHandle: false };
      m.set(index, p);
    }
    return p;
  };
  for (const [bk, b] of doc.blocks) {
    b.entities.forEach((e, i) => {
      const label = `${e.type}(${e.handle || '핸들 없음'})`;
      // 수가 아닌 값·0 반지름 → 지움
      if (!allFinite(e)) {
        issues.push({ phase: 'entities', handle: e.handle, target: label, message: '좌표나 값이 수가 아닙니다.', fix: '객체 삭제' });
        plan(bk, i, e).next = null;
        return;
      }
      if ((e.type === 'CIRCLE' || e.type === 'ARC') && !(e.radius > 0)) {
        issues.push({ phase: 'entities', handle: e.handle, target: label, message: '반지름이 0입니다.', fix: '객체 삭제' });
        plan(bk, i, e).next = null;
        return;
      }
      if (e.type === 'INSERT' && !doc.blocks.has(tableKey(e.block))) {
        issues.push({ phase: 'entities', handle: e.handle, target: label, message: `블록 "${e.block}"의 정의가 없습니다.`, fix: '객체 삭제' });
        plan(bk, i, e).next = null;
        return;
      }
      if (e.type === 'INSERT' && !isLayoutBlock(bk) && blockReaches(doc, e.block, bk)) {
        issues.push({ phase: 'blocks', handle: e.handle, target: `블록 ${b.name}`, message: `블록 "${e.block}" 참조가 자기 자신을 품습니다.`, fix: '객체 삭제' });
        plan(bk, i, e).next = null;
        return;
      }
      // 핸들
      if (!e.handle) {
        issues.push({ phase: 'entities', target: label, message: '핸들이 없습니다.', fix: '새 핸들' });
        plan(bk, i, e).newHandle = true;
      } else {
        const h = normalizeHandle(e.handle);
        const prev = seen.get(h);
        if (prev) {
          issues.push({ phase: 'entities', handle: e.handle, target: label, message: '같은 핸들을 가진 객체가 있습니다.', fix: '새 핸들' });
          plan(bk, i, e).newHandle = true;
          dupFirst.add(h);
        } else seen.set(h, { block: bk, entity: e });
      }
      // 소유자
      if (b.recordHandle && e.owner && normalizeHandle(e.owner) !== normalizeHandle(b.recordHandle)) {
        issues.push({ phase: 'entities', handle: e.handle, target: label, message: '소유자가 들어 있는 블록과 다릅니다.', fix: '소유자 고침' });
        plan(bk, i, e).next!.owner = b.recordHandle;
      }
      // 도면층
      const parts: Entity[] = [e, ...(e.type === 'INSERT' ? e.attribs : [])];
      for (const p of parts) {
        if (p.layer && !doc.layers.has(tableKey(p.layer))) {
          if (!missingLayers.has(tableKey(p.layer))) missingLayers.set(tableKey(p.layer), p.layer);
          issues.push({ phase: 'entities', handle: p.handle, target: label, message: `도면층 "${p.layer}"이(가) 없습니다.`, fix: '도면층 만들기' });
        }
      }
      // 선종류
      const bad = (lt: string) => !!lt && !BUILTIN_LT.has(tableKey(lt)) && !doc.linetypes.has(tableKey(lt));
      if (bad(e.linetype) || (e.type === 'INSERT' && e.attribs.some((a) => bad(a.linetype)))) {
        issues.push({ phase: 'entities', handle: e.handle, target: label, message: `선종류 "${e.linetype}"이(가) 없습니다.`, fix: 'ByLayer로 설정' });
        const n = plan(bk, i, e).next!;
        if (bad(n.linetype)) n.linetype = 'ByLayer';
        if (n.type === 'INSERT') for (const a of n.attribs) if (bad(a.linetype)) a.linetype = 'ByLayer';
      }
      // 문자 스타일
      const styleBad = (s: string | undefined) => !!s && !doc.textStyles.has(tableKey(s));
      const texts: { style?: string }[] = [];
      if (e.type === 'TEXT' || e.type === 'MTEXT' || e.type === 'ATTRIB' || e.type === 'ATTDEF') texts.push(e);
      if (e.type === 'INSERT') texts.push(...e.attribs);
      if (texts.some((t) => styleBad(t.style))) {
        issues.push({ phase: 'entities', handle: e.handle, target: label, message: '문자 스타일이 없습니다.', fix: `${firstStyle}(으)로 설정` });
        const n = plan(bk, i, e).next!;
        const fixT = (t: { style?: string }) => {
          if (styleBad(t.style)) t.style = firstStyle;
        };
        if (n.type === 'TEXT' || n.type === 'MTEXT' || n.type === 'ATTRIB' || n.type === 'ATTDEF') fixT(n);
        if (n.type === 'INSERT') n.attribs.forEach((a: AttribEntity) => fixT(a));
      }
      // 치수 스타일
      if ((e.type === 'DIMENSION' || e.type === 'LEADER' || e.type === 'TOLERANCE') && doc.dimStyles.size && e.dimStyle && !doc.dimStyles.has(tableKey(e.dimStyle))) {
        issues.push({ phase: 'entities', handle: e.handle, target: label, message: `치수 스타일 "${e.dimStyle}"이(가) 없습니다.`, fix: `${dimFallback}(으)로 설정` });
        (plan(bk, i, e).next as { dimStyle: string }).dimStyle = dimFallback;
      }
      // 0 축척 블록 참조
      if (e.type === 'INSERT' && (e.scale.x === 0 || e.scale.y === 0 || e.scale.z === 0)) {
        issues.push({ phase: 'entities', handle: e.handle, target: label, message: '축척이 0입니다.', fix: '축척 1로 설정' });
        const n = plan(bk, i, e).next as typeof e;
        n.scale = { x: e.scale.x || 1, y: e.scale.y || 1, z: e.scale.z || 1 };
      }
    });
  }
  if (missingLayers.size) {
    fixes.push((c) => {
      for (const [k, name] of missingLayers) {
        const layer: Layer = { name, handle: c.newHandle(), flags: 0, color: { aci: 7 }, off: false, frozen: false, locked: false, linetype: 'Continuous', lineweight: -3, plot: true, transparency: 255 };
        c.ops.push({ kind: 'layer', key: k, before: null, after: layer });
      }
    });
  }
  // 객체 고치기: 같은 블록은 뒤에서부터(지우기·바꾸기가 앞 번호를 흔들지 않게)
  fixes.push((c) => {
    for (const [bk, m] of replace) {
      const list = [...m.entries()].sort((a, b) => b[0] - a[0]);
      for (const [index, p] of list) {
        if (!p.next) {
          c.ops.push({ kind: 'remove', block: bk, entity: p.e, index });
          c.erased++;
          continue;
        }
        if (p.newHandle) {
          const n = p.next;
          n.handle = c.newHandle();
          delete n.dwgRaw;
          if (n.type === 'INSERT') for (const a of n.attribs) a.handle = c.newHandle();
          c.ops.push({ kind: 'remove', block: bk, entity: p.e, index }, { kind: 'add', block: bk, entity: n, index });
          continue;
        }
        delete p.next.dwgRaw;
        c.ops.push({ kind: 'modify', block: bk, before: p.e, after: p.next });
      }
    }
    // 같은 핸들의 첫 객체는 색인을 다시 건다(앞 작업이 그 핸들의 색인을 지웠다)
    for (const h of dupFirst) {
      const f = seen.get(h);
      if (f && !replace.get(f.block)?.has(doc.blocks.get(f.block)!.entities.indexOf(f.entity))) c.ops.push({ kind: 'modify', block: f.block, before: f.entity, after: f.entity });
    }
  });

  // ---------------------------------------------------------------- 그룹
  for (const g of listGroups(doc)) {
    const live = g.group.entities.filter((h) => doc.entityIndex.has(normalizeHandle(h)));
    if (live.length === g.group.entities.length) continue;
    if (!live.length) {
      issues.push({ phase: 'objects', handle: g.handle, target: `그룹 ${g.name}`, message: '구성원이 없습니다.', fix: '그룹 삭제' });
      fixes.push((c) => c.ops.push(...deleteGroupOps(doc, g.handle)));
    } else {
      issues.push({ phase: 'objects', handle: g.handle, target: `그룹 ${g.name}`, message: `없는 구성원 ${g.group.entities.length - live.length}개`, fix: '구성원에서 뺌' });
      fixes.push((c) => c.ops.push(...updateGroupOps(doc, g.handle, { entities: live })));
    }
  }

  return {
    issues,
    fix(newHandle) {
      const c: FixCtx = { ops: [], erased: 0, newHandle };
      for (const f of fixes) f(c);
      return { ops: c.ops, erased: c.erased };
    },
  };
}

interface FixCtx {
  ops: EditOp[];
  erased: number;
  newHandle: () => string;
}

/** AutoCAD 감사 출력의 단계 이름 */
export const AUDIT_PHASES: readonly { phase: AuditPhase; label: string }[] = [
  { phase: 'header', label: '헤더 감사' },
  { phase: 'tables', label: '테이블 감사' },
  { phase: 'entities', label: '엔티티 감사 단계 1' },
  { phase: 'blocks', label: '블록 감사' },
  { phase: 'objects', label: '객체 감사' },
];

// ---------------------------------------------------------------------------
// STATUS 통계
// ---------------------------------------------------------------------------

export interface DocStats {
  /** 모든 공간(모형·배치)의 최상위 객체 수 */
  total: number;
  /** 공간별 객체 수(배치 이름 → 수) */
  bySpace: { name: string; count: number }[];
  /** 종류별 객체 수(모든 공간) */
  byType: Map<string, number>;
  blocks: number;
  layers: number;
  linetypes: number;
  textStyles: number;
  dimStyles: number;
  groups: number;
}

export function docStats(doc: CadDocument): DocStats {
  const byType = new Map<string, number>();
  const bySpace: { name: string; count: number }[] = [];
  let total = 0;
  for (const l of doc.layouts) {
    const b = doc.blocks.get(tableKey(l.blockName));
    const n = b?.entities.length ?? 0;
    bySpace.push({ name: l.name, count: n });
    total += n;
    for (const e of b?.entities ?? []) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  }
  return {
    total,
    bySpace,
    byType,
    blocks: [...doc.blocks.values()].filter((b) => !b.name.startsWith('*')).length,
    layers: doc.layers.size,
    linetypes: doc.linetypes.size,
    textStyles: [...doc.textStyles.values()].filter((s) => s.name && !(s.flags & 1)).length,
    dimStyles: doc.dimStyles.size,
    groups: listGroups(doc).length,
  };
}
