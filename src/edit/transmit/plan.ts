/**
 * 전송(ETRANSMIT) 패키지 구성(UI 없음): 파일마다 패키지 안 경로, 도면 사본에서 바꿀 참조 경로, 전송 보고서 글.
 *
 * 경로 규칙
 *  - 트리 유지: 도면에 저장된 상대 경로를 그 도면의 폴더에서 풀어 같은 자리에 둔다(받는 쪽에서 풀면 그대로 찾는다).
 *    절대 경로나 패키지 밖으로 나가는 경로(..\)는 참조하는 도면의 폴더에 두고 경로를 파일 이름만으로 바꾼다.
 *  - 단일 폴더: 모든 파일을 맨 위에 두고 모든 참조 경로를 파일 이름만으로 바꾼다.
 *  - 경로 지우기: 트리 유지여도 참조 경로를 파일 이름만으로(파일은 참조하는 도면의 폴더에).
 *  - 같은 파일(이름이 같은 것)은 한 번만 넣는다. 이름이 겹치는 다른 파일은 `이름(2).확장자`로 넣고 경로를 바꾼다.
 *  - 도면 형식을 바꾸면(.dxf → .dwg 등) 그 도면을 가리키는 경로의 확장자도 바꾼다.
 */

export type TransmitKind = 'drawing' | 'xref' | 'image' | 'pdf' | 'font' | 'plotstyle';

export interface TransmitItem {
  id: string;
  kind: TransmitKind;
  /** 파일 이름(형식 변환 전) */
  name: string;
  /** 같은 파일 열쇠(파일 이름 소문자) */
  key: string;
  /** 소유 도면에 저장된 경로(주 도면·글꼴·플롯 스타일은 '') */
  path: string;
  /** 소유 도면 항목 id(주 도면은 null) */
  owner: string | null;
  /** 이 세션에 파일이 있는지 */
  found: boolean;
  /** 패키지에 넣을지(확인란) */
  include: boolean;
  /** 트리 깊이(주 도면 0) */
  depth: number;
  /** 겹침 외부 참조 등 */
  note?: string;
}

export type TransmitFormat = 'keep' | 'AC1032' | 'AC1027' | 'AC1024' | 'AC1018' | 'AC1015' | 'dxf';

export interface TransmitSettings {
  folder: 'tree' | 'flat';
  format: TransmitFormat;
  /** 외부 참조를 결합으로 바꾸기 */
  bind: boolean;
  /** 참조 경로 지우기(파일 이름만) */
  clearPaths: boolean;
  /** 전송 보고서를 패키지에 넣기 */
  report: boolean;
}

export const DEFAULT_SETTINGS: TransmitSettings = { folder: 'tree', format: 'keep', bind: false, clearPaths: false, report: true };

export const FORMAT_LABELS: Record<TransmitFormat, string> = {
  keep: '기존 파일 형식 유지',
  AC1032: 'AutoCAD 2018 도면(*.dwg)',
  AC1027: 'AutoCAD 2013 도면(*.dwg)',
  AC1024: 'AutoCAD 2010 도면(*.dwg)',
  AC1018: 'AutoCAD 2004 도면(*.dwg)',
  AC1015: 'AutoCAD 2000 도면(*.dwg)',
  dxf: 'AutoCAD 2018 DXF(*.dxf)',
};

export interface PlannedFile {
  item: TransmitItem;
  /** 패키지 안 경로('/') */
  zipPath: string;
}

export interface PackagePlan {
  /** 넣을 파일(열쇠마다 하나, 주 도면이 첫째) */
  files: PlannedFile[];
  /** 도면 항목 id → (참조 항목 id → 사본에 쓸 새 경로) */
  rewrites: Map<string, Map<string, string>>;
  /** 찾을 수 없는 파일(넣으려 했지만 이 세션에 없음) */
  missing: TransmitItem[];
  /** 확인란을 끈 파일 */
  excluded: TransmitItem[];
  /** 결합해 패키지에 넣지 않는 외부 참조(와 그 안의 참조) */
  bound: TransmitItem[];
  /** 항목 id → 패키지 안 경로(넣지 않는 것도 계산한 자리) */
  placement: Map<string, string>;
}

const segs = (p: string) => p.split(/[\\/]+/).filter((s) => s.length > 0);

export function baseNameOf(p: string): string {
  const s = segs(p);
  return s[s.length - 1] ?? p;
}

export function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:/.test(p) || /^[\\/]/.test(p);
}

/** folder에서 상대 경로의 폴더 부분을 푼다(패키지 밖으로 나가면 null) */
function resolveDir(folder: readonly string[], p: string): string[] | null {
  const parts = segs(p);
  parts.pop();
  const out = [...folder];
  for (const s of parts) {
    if (s === '.') continue;
    if (s === '..') {
      if (!out.length) return null;
      out.pop();
      continue;
    }
    out.push(s);
  }
  return out;
}

/** from 폴더에서 to 파일로 가는 Windows식 상대 경로(같은 폴더면 파일 이름만) */
export function relativePath(from: readonly string[], to: readonly string[]): string {
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i]!.toLowerCase() === to[i]!.toLowerCase()) i++;
  const ups = from.length - i;
  const rest = to.slice(i);
  if (!ups && rest.length === 1) return rest[0]!;
  return [...(ups ? Array<string>(ups).fill('..') : ['.']), ...rest].join('\\');
}

/** 형식 변환 뒤 도면 파일 이름 */
export function drawingName(name: string, format: TransmitFormat): string {
  if (format === 'keep') return name;
  const ext = format === 'dxf' ? '.dxf' : '.dwg';
  return /\.(dwg|dxf)$/i.test(name) ? name.replace(/\.(dwg|dxf)$/i, ext) : name + ext;
}

/** 저장된 경로의 파일 이름 부분만 바꾼다 */
function withBase(p: string, base: string): string {
  const m = /^(.*[\\/])?[^\\/]*$/.exec(p);
  return (m?.[1] ?? '') + base;
}

const sameText = (a: string, b: string) => a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();

export function planPackage(items: readonly TransmitItem[], settings: TransmitSettings): PackagePlan {
  const byId = new Map(items.map((i) => [i.id, i]));
  const root = items.find((i) => i.owner === null && i.kind === 'drawing');
  const plan: PackagePlan = { files: [], rewrites: new Map(), missing: [], excluded: [], bound: [], placement: new Map() };
  if (!root) return plan;
  const folderOf = new Map<string, string[]>([[root.id, []]]);
  const placedByKey = new Map<string, string[]>();
  const taken = new Map<string, string>(); // 패키지 경로(소문자) → 열쇠
  const rootName = drawingName(root.name, settings.format);
  taken.set(rootName.toLowerCase(), root.key);
  placedByKey.set(root.key, [rootName]);
  plan.placement.set(root.id, rootName);
  const boundIds = new Set<string>();
  const rewrite = (owner: string, id: string, p: string) => {
    let m = plan.rewrites.get(owner);
    if (!m) plan.rewrites.set(owner, (m = new Map()));
    m.set(id, p);
  };
  for (const it of items) {
    if (it === root) continue;
    const owner = it.owner ?? root.id;
    if (settings.bind && ((it.kind === 'xref' && owner === root.id) || boundIds.has(owner))) {
      boundIds.add(it.id);
      plan.bound.push(it);
      continue;
    }
    const F = folderOf.get(owner) ?? [];
    const isDrawing = it.kind === 'xref' || it.kind === 'drawing';
    const stored = it.path || it.name;
    let base = isDrawing ? drawingName(baseNameOf(stored), settings.format) : baseNameOf(stored);
    let zip: string[];
    let newPath: string | null = null;
    if (it.kind === 'font' || it.kind === 'plotstyle') {
      zip = settings.folder === 'flat' ? [base] : [it.kind === 'font' ? 'Fonts' : 'PlotStyles', base];
    } else if (settings.folder === 'flat') {
      zip = [base];
      newPath = base;
    } else {
      const dir = !settings.clearPaths && !isAbsolutePath(stored) ? resolveDir(F, stored) : null;
      if (dir) {
        zip = [...dir, base];
        newPath = withBase(stored, base);
      } else {
        zip = [...F, base];
        newPath = base;
      }
    }
    // 같은 파일은 한 번만: 먼저 놓은 자리를 가리키게
    const prev = placedByKey.get(it.key);
    if (prev) {
      if (newPath !== null && zip.join('/').toLowerCase() !== prev.join('/').toLowerCase()) newPath = settings.folder === 'flat' ? prev[prev.length - 1]! : relativePath(F, prev);
      zip = prev;
    } else {
      // 이름이 겹치는 다른 파일은 번호를 붙인다
      let n = 2;
      while (taken.has(zip.join('/').toLowerCase()) && taken.get(zip.join('/').toLowerCase()) !== it.key) {
        const dot = base.lastIndexOf('.');
        const stem = dot > 0 ? base.slice(0, dot).replace(/\(\d+\)$/, '') : base;
        const ext = dot > 0 ? base.slice(dot) : '';
        base = `${stem}(${n++})${ext}`;
        zip = [...zip.slice(0, -1), base];
        if (newPath !== null) newPath = settings.folder === 'flat' ? base : relativePath(F, zip);
      }
      taken.set(zip.join('/').toLowerCase(), it.key);
      placedByKey.set(it.key, zip);
    }
    plan.placement.set(it.id, zip.join('/'));
    if (isDrawing) folderOf.set(it.id, zip.slice(0, -1));
    if (newPath !== null && !sameText(newPath, it.path)) rewrite(owner, it.id, newPath);
  }
  // 넣을 파일: 열쇠마다 하나(넣기로 한 것 중 파일이 있는 것)
  const done = new Set<string>();
  plan.files.push({ item: root, zipPath: rootName });
  done.add(root.key);
  for (const it of items) {
    if (it === root || boundIds.has(it.id) || done.has(it.key)) continue;
    const same = items.filter((x) => x.key === it.key && !boundIds.has(x.id));
    const wanted = same.filter((x) => x.include && (x.owner === null || ownerIncluded(x, byId, root.id)));
    if (!wanted.length) {
      plan.excluded.push(it);
      done.add(it.key);
      continue;
    }
    const withFile = wanted.find((x) => x.found);
    if (!withFile) {
      plan.missing.push(it);
      done.add(it.key);
      continue;
    }
    plan.files.push({ item: withFile, zipPath: plan.placement.get(it.id) ?? plan.placement.get(withFile.id)! });
    done.add(it.key);
  }
  return plan;
}

/** 소유 도면(들)이 패키지에 들어가는지(뺀 도면 안의 참조는 넣지 않는다) */
function ownerIncluded(it: TransmitItem, byId: ReadonlyMap<string, TransmitItem>, rootId: string): boolean {
  let o = it.owner;
  for (let guard = 0; o && o !== rootId && guard < 64; guard++) {
    const p = byId.get(o);
    if (!p || !p.include || !p.found) return false;
    o = p.owner;
  }
  return true;
}

const KIND_LABEL: Record<TransmitKind, string> = { drawing: '도면', xref: '외부 참조', image: '래스터 이미지', pdf: 'PDF 언더레이', font: '글꼴', plotstyle: '플롯 스타일 테이블' };

export function kindLabel(k: TransmitKind): string {
  return KIND_LABEL[k];
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 전송 보고서(UTF-8 글, BOM은 쓰는 쪽에서) */
export function transmitReport(o: {
  items: readonly TransmitItem[];
  plan: PackagePlan;
  settings: TransmitSettings;
  zipName: string;
  date: Date;
  notes?: readonly string[];
  memo?: string;
}): string {
  const { plan, settings } = o;
  const root = o.items.find((i) => i.owner === null && i.kind === 'drawing');
  const byId = new Map(o.items.map((i) => [i.id, i]));
  const L: string[] = [];
  L.push('전송 보고서', '');
  L.push(`만든 날짜: ${stamp(o.date)}`);
  L.push(`만든 프로그램: OpenCAD 2D 뷰어(브라우저 — 파일은 이 컴퓨터에서 묶었습니다)`);
  L.push(`주 도면: ${root?.name ?? ''}`);
  L.push(`전송 패키지: ${o.zipName}`);
  L.push('');
  L.push('전송 설정');
  L.push(`  폴더 유형: ${settings.folder === 'flat' ? '단일 폴더(모든 파일을 하나의 폴더에)' : '트리 유지(도면에 저장된 상대 경로대로)'}`);
  L.push(`  도면 파일 형식: ${FORMAT_LABELS[settings.format]}`);
  L.push(`  외부 참조: ${settings.bind ? '결합으로 바꿈(외부 참조 파일은 넣지 않음)' : '그대로'}`);
  L.push(`  참조 경로: ${settings.clearPaths || settings.folder === 'flat' ? '지움(파일 이름만)' : '유지'}`);
  L.push('');
  L.push(`포함한 파일 (${plan.files.length}${settings.report ? ' + 이 보고서' : ''})`);
  for (const f of plan.files) {
    const it = f.item;
    const what = it.owner === null && it.kind === 'drawing' ? '주 도면' : kindLabel(it.kind);
    const from = it.owner && it.path ? ` — "${byId.get(it.owner)?.name ?? ''}"에 저장된 경로 "${it.path}"` : '';
    L.push(`  ${f.zipPath}    ${what}${from}`);
  }
  if (plan.missing.length) {
    L.push('');
    L.push(`찾을 수 없는 파일 (${plan.missing.length})`);
    for (const it of plan.missing) L.push(`  ${it.name}    ${kindLabel(it.kind)}${it.path ? ` — 경로 "${it.path}"` : ''} — 이 세션에서 파일을 고르지 않았거나 로드되지 않았습니다. 받는 사람에게 따로 보내십시오.`);
  }
  if (plan.excluded.length) {
    L.push('');
    L.push(`넣지 않은 파일 (${plan.excluded.length})`);
    for (const it of plan.excluded) L.push(`  ${it.name}    ${kindLabel(it.kind)}`);
  }
  if (plan.bound.length) {
    L.push('');
    L.push(`결합한 외부 참조 (${plan.bound.length})`);
    for (const it of plan.bound) L.push(`  ${it.name}${it.owner && byId.get(it.owner)?.kind === 'xref' ? '    — 결합한 참조 안의 참조라 결합 블록에 넣지 않았습니다' : ''}`);
  }
  const rw: string[] = [];
  for (const [owner, m] of plan.rewrites)
    for (const [id, p] of m) {
      const it = byId.get(id);
      if (it) rw.push(`  ${byId.get(owner)?.name ?? ''}: "${it.path || it.name}" → "${p}"`);
    }
  if (rw.length) {
    L.push('');
    L.push(`경로를 바꾼 참조 (${rw.length}) — 패키지 안의 도면 사본만 바꿨습니다(열린 도면은 그대로)`);
    L.push(...rw);
  }
  if (o.notes?.length) {
    L.push('');
    L.push('참고');
    for (const n of o.notes) L.push(`  - ${n}`);
  }
  if (o.memo?.trim()) {
    L.push('');
    L.push('메모');
    for (const line of o.memo.trim().split(/\r?\n/)) L.push(`  ${line}`);
  }
  L.push('');
  return L.join('\r\n');
}
