/**
 * 사용자 좌표계(UCS): 2D 범위(원점과 XY 평면 안의 회전)만 다룬다.
 * 현재 UCS는 머리말 $UCSORG·$UCSXDIR(배치는 $PUCSORG·$PUCSXDIR)로 저장되어 명령 취소·저장에 그대로 따라간다.
 * 명령: UCS, UCSICON, UCSMAN(이름 붙은 UCS 목록). 프롬프트는 AutoCAD 2026 한국어판을 따른다.
 */
import type { CadDocument, Entity, HeaderValue, UcsRecord, Vec3 } from '../core/model';
import { tableKey } from '../core/model';
import type { EditOp } from '../edit/session';
import type { App, CommandContext } from './app';
import type { DocState } from './docstate';
import { dialog, h } from './ui/dom';
import { lwPoints } from '../core/lwpoly';

type Pt = { x: number; y: number };

export interface Ucs {
  ox: number;
  oy: number;
  /** X축 각도(라디안) */
  angle: number;
}

export const WORLD: Ucs = { ox: 0, oy: 0, angle: 0 };

const vec = (v: HeaderValue | undefined): Vec3 | null => (v && typeof v === 'object' ? { x: v.x, y: v.y, z: 'z' in v ? v.z : 0 } : null);

function names(st: DocState): { org: string; xdir: string; ydir: string; name: string } {
  const paper = st.onLayout && !st.msVp;
  return paper ? { org: '$PUCSORG', xdir: '$PUCSXDIR', ydir: '$PUCSYDIR', name: '$PUCSNAME' } : { org: '$UCSORG', xdir: '$UCSXDIR', ydir: '$UCSYDIR', name: '$UCSNAME' };
}

/** 지금 공간의 UCS(3D로 기운 UCS는 XY 평면 회전만 쓴다) */
export function currentUcs(st: DocState | null): Ucs {
  if (!st || st.blockEdit) return WORLD;
  const n = names(st);
  const o = vec(st.doc.header.get(n.org));
  const x = vec(st.doc.header.get(n.xdir));
  const angle = x && Math.hypot(x.x, x.y) > 1e-9 ? Math.atan2(x.y, x.x) : 0;
  return { ox: o?.x ?? 0, oy: o?.y ?? 0, angle: Math.abs(angle) < 1e-12 ? 0 : angle };
}

export const isWorld = (u: Ucs) => u.ox === 0 && u.oy === 0 && u.angle === 0;

/** UCS 좌표 → WCS */
export function toWcs(u: Ucs, p: Pt): Pt {
  const c = Math.cos(u.angle);
  const s = Math.sin(u.angle);
  return { x: u.ox + p.x * c - p.y * s, y: u.oy + p.x * s + p.y * c };
}

/** WCS → UCS 좌표 */
export function toUcs(u: Ucs, p: Pt): Pt {
  const c = Math.cos(u.angle);
  const s = Math.sin(u.angle);
  const dx = p.x - u.ox;
  const dy = p.y - u.oy;
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

/** 방향(벡터)만 돌린다 */
export function dirToUcs(u: Ucs, d: Pt): Pt {
  const c = Math.cos(u.angle);
  const s = Math.sin(u.angle);
  return { x: d.x * c + d.y * s, y: -d.x * s + d.y * c };
}

/** UCS를 머리말에 쓰는 편집(현재 공간) */
function setUcsOps(st: DocState, u: Ucs, name = ''): EditOp[] {
  const n = names(st);
  const hd = st.doc.header;
  const vals: [string, HeaderValue][] = [
    [n.org, { x: u.ox, y: u.oy, z: 0 }],
    [n.xdir, { x: Math.cos(u.angle), y: Math.sin(u.angle), z: 0 }],
    [n.ydir, { x: -Math.sin(u.angle), y: Math.cos(u.angle), z: 0 }],
    [n.name, name],
  ];
  return vals.map(([k, v]) => ({ kind: 'header', name: k, before: hd.get(k), after: v }));
}

/** 이전 UCS(공간마다, 세션 동안) */
const history = new WeakMap<DocState, Map<string, Ucs[]>>();

function pushHistory(st: DocState, u: Ucs): void {
  let m = history.get(st);
  if (!m) history.set(st, (m = new Map()));
  const k = names(st).org;
  const list = m.get(k) ?? [];
  list.push(u);
  if (list.length > 10) list.shift();
  m.set(k, list);
}

export function applyUcs(app: App, st: DocState, u: Ucs, ctx: CommandContext | null, name = ''): void {
  pushHistory(st, currentUcs(st));
  st.session.commit({ label: 'UCS', ops: setUcsOps(st, u, name), group: ctx?.group });
  app.view.requestOverlay();
  app.ui.refreshStatus();
}

/** 객체에 맞춘 UCS: 선·폴리선 첫 선분은 그 방향, 원·호는 중심, 문자·블록은 삽입점과 회전 */
function ucsFromEntity(e: Entity, pick: Pt): Ucs | null {
  switch (e.type) {
    case 'LINE': {
      const a = Math.hypot(pick.x - e.start.x, pick.y - e.start.y) <= Math.hypot(pick.x - e.end.x, pick.y - e.end.y) ? e.start : e.end;
      const b = a === e.start ? e.end : e.start;
      return { ox: a.x, oy: a.y, angle: Math.atan2(b.y - a.y, b.x - a.x) };
    }
    case 'LWPOLYLINE': {
      const v = lwPoints(e);
      if (v.length < 2) return null;
      return { ox: v[0]!.x, oy: v[0]!.y, angle: Math.atan2(v[1]!.y - v[0]!.y, v[1]!.x - v[0]!.x) };
    }
    case 'CIRCLE':
    case 'ARC':
      return { ox: e.center.x, oy: e.center.y, angle: Math.atan2(pick.y - e.center.y, pick.x - e.center.x) };
    case 'TEXT':
    case 'MTEXT':
    case 'INSERT':
      return { ox: e.insert.x, oy: e.insert.y, angle: e.type === 'MTEXT' ? Math.atan2(e.direction?.y ?? 0, e.direction?.x ?? 1) : e.rotation };
    case 'ATTDEF':
      return { ox: e.insert.x, oy: e.insert.y, angle: e.rotation };
  }
  return null;
}

function namedUcs(doc: CadDocument): UcsRecord[] {
  return [...doc.ucs.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const recUcs = (r: UcsRecord): Ucs => ({ ox: r.origin.x, oy: r.origin.y, angle: Math.atan2(r.xAxis.y, r.xAxis.x) });

function saveNamed(st: DocState, name: string, u: Ucs, ctx: CommandContext | null): void {
  const key = tableKey(name);
  const before = st.doc.ucs.get(key) ?? null;
  const after: UcsRecord = {
    name,
    handle: before?.handle ?? st.session.newHandle(),
    flags: 0,
    origin: { x: u.ox, y: u.oy, z: 0 },
    xAxis: { x: Math.cos(u.angle), y: Math.sin(u.angle), z: 0 },
    yAxis: { x: -Math.sin(u.angle), y: Math.cos(u.angle), z: 0 },
  };
  st.session.commit({ label: 'UCS', ops: [{ kind: 'ucs', key, before, after }], group: ctx?.group });
}

export function registerUcsCommands(app: App): void {
  app.register({
    name: 'UCS',
    title: '사용자 좌표계',
    async run(ctx) {
      const st = app.active!;
      const cur = currentUcs(st);
      const curName = String(st.doc.header.get(names(st).name) ?? '') || (isWorld(cur) ? '*표준*' : '*이름 없음*');
      ctx.print(`현재 UCS 이름: ${curName}`);
      const r = await ctx.getPoint('UCS의 원점 지정 또는 [이름(NA)/객체(OB)/이전(P)/뷰(V)/표준(W)/Z] <표준>:', {
        keywords: [
          { key: 'NA', label: '이름' },
          { key: 'OB', label: '객체' },
          { key: 'P', label: '이전' },
          { key: 'V', label: '뷰' },
          { key: 'W', label: '표준' },
          { key: 'Z', label: 'Z' },
        ],
      });
      if ('enter' in r || ('keyword' in r && (r.keyword === 'W' || r.keyword === 'V'))) {
        applyUcs(app, st, WORLD, ctx);
        return;
      }
      if ('point' in r) {
        const o = r.point;
        const q = await ctx.getPoint('X축 위의 점 지정 또는 <수락>:', { base: o });
        const angle = 'point' in q && Math.hypot(q.point.x - o.x, q.point.y - o.y) > 1e-12 ? Math.atan2(q.point.y - o.y, q.point.x - o.x) : cur.angle;
        if ('point' in q) await ctx.getPoint('XY 평면 위의 점 지정 또는 <수락>:', { base: o });
        applyUcs(app, st, { ox: o.x, oy: o.y, angle }, ctx);
        return;
      }
      if (!('keyword' in r)) return;
      switch (r.keyword) {
        case 'P': {
          const list = history.get(st)?.get(names(st).org);
          const prev = list?.pop();
          if (!prev) {
            ctx.print('이전 UCS가 없습니다.', 'err');
            return;
          }
          st.session.commit({ label: 'UCS', ops: setUcsOps(st, prev), group: ctx.group });
          app.view.requestOverlay();
          return;
        }
        case 'Z': {
          const a = await ctx.getPoint('Z축을 중심으로 회전 각도 지정 <90>:', { allowText: true, preferNumber: true });
          const deg = 'text' in a ? Number(a.text) : 'enter' in a ? 90 : NaN;
          if (!Number.isFinite(deg)) return;
          applyUcs(app, st, { ...cur, angle: cur.angle + (deg * Math.PI) / 180 }, ctx);
          return;
        }
        case 'OB': {
          const e = await ctx.getEntity('UCS를 정렬할 객체 선택:');
          if (!('handle' in e)) return;
          const ent = st.doc.entityIndex.get(e.handle);
          const u = ent ? ucsFromEntity(ent, e.point) : null;
          if (!u) {
            ctx.print('이 객체에는 UCS를 맞출 수 없습니다.', 'err');
            return;
          }
          applyUcs(app, st, u, ctx);
          return;
        }
        case 'NA': {
          const o = await ctx.getPoint('옵션 입력 [복원(R)/저장(S)/삭제(D)/?]:', {
            keywords: [
              { key: 'R', label: '복원' },
              { key: 'S', label: '저장' },
              { key: 'D', label: '삭제' },
              { key: '?', label: '?' },
            ],
          });
          if (!('keyword' in o)) return;
          if (o.keyword === '?') {
            const list = namedUcs(st.doc);
            if (!list.length) ctx.print('저장된 UCS가 없습니다.');
            for (const u of list) ctx.print(`${u.name}  원점 = ${u.origin.x.toFixed(4)},${u.origin.y.toFixed(4)}  X축 각도 = ${((Math.atan2(u.xAxis.y, u.xAxis.x) * 180) / Math.PI).toFixed(2)}`);
            return;
          }
          const t = await ctx.getPoint(o.keyword === 'S' ? 'UCS를 저장할 이름 입력 또는 [?]:' : o.keyword === 'R' ? '복원할 UCS의 이름 입력 또는 [?]:' : '삭제할 UCS 이름 입력 <없음>:', { allowText: true });
          const name = 'text' in t ? t.text.trim() : '';
          if (!name) return;
          if (o.keyword === 'S') saveNamed(st, name, cur, ctx);
          else if (o.keyword === 'R') {
            const rec = st.doc.ucs.get(tableKey(name));
            if (!rec) ctx.print(`UCS "${name}"을(를) 찾을 수 없습니다.`, 'err');
            else applyUcs(app, st, recUcs(rec), ctx, rec.name);
          } else {
            const rec = st.doc.ucs.get(tableKey(name));
            if (!rec) ctx.print(`UCS "${name}"을(를) 찾을 수 없습니다.`, 'err');
            else st.session.commit({ label: 'UCS', ops: [{ kind: 'ucs', key: tableKey(name), before: rec, after: null }], group: ctx.group });
          }
          return;
        }
      }
    },
  });

  app.register({
    name: 'UCSICON',
    title: 'UCS 아이콘',
    transparent: true,
    async run(ctx) {
      const r = await ctx.getPoint(`옵션 입력 [켜기(ON)/끄기(OFF)/전체(A)/원점 없음(N)/원점(OR)] <${app.view.ucsIcon.on ? '켜기' : '끄기'}>:`, {
        keywords: [
          { key: 'ON', label: '켜기' },
          { key: 'OFF', label: '끄기' },
          { key: 'A', label: '전체' },
          { key: 'N', label: '원점 없음' },
          { key: 'OR', label: '원점' },
        ],
      });
      if (!('keyword' in r)) return;
      if (r.keyword === 'ON' || r.keyword === 'OFF') app.view.ucsIcon.on = r.keyword === 'ON';
      if (r.keyword === 'N') app.view.ucsIcon.origin = false;
      if (r.keyword === 'OR') app.view.ucsIcon.origin = true;
      app.view.requestOverlay();
    },
  });

  app.register({
    name: 'UCSMAN',
    aliases: ['UC'],
    title: 'UCS 관리자',
    run() {
      const st = app.active!;
      let picked: string | null = null;
      const body = h('div', {});
      const render = () => {
        body.replaceChildren();
        const rows = [{ name: '표준', rec: null as UcsRecord | null }, ...namedUcs(st.doc).map((r) => ({ name: r.name, rec: r }))].map((it) => {
          const tr = h('tr', { style: picked === it.name ? 'background:var(--sel, rgba(61,141,255,0.25))' : 'cursor:pointer' }, h('td', {}, it.name), h('td', {}, it.rec ? `${it.rec.origin.x.toFixed(2)}, ${it.rec.origin.y.toFixed(2)}` : '0, 0'), h('td', {}, it.rec ? `${((Math.atan2(it.rec.xAxis.y, it.rec.xAxis.x) * 180) / Math.PI).toFixed(2)}°` : '0°'));
          tr.addEventListener('click', () => {
            picked = it.name;
            render();
          });
          return tr;
        });
        body.append(h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', {}, '이름'), h('th', {}, '원점'), h('th', {}, 'X축 각도'))), h('tbody', {}, ...rows)));
      };
      render();
      dialog('UCS 관리자', body, [
        {
          label: '삭제',
          run: () => {
            const rec = picked && picked !== '표준' ? st.doc.ucs.get(tableKey(picked)) : undefined;
            if (rec) st.session.commit({ label: 'UCS', ops: [{ kind: 'ucs', key: tableKey(rec.name), before: rec, after: null }] });
            picked = null;
            render();
            return false;
          },
        },
        {
          label: '현재로 설정',
          primary: true,
          run: () => {
            if (!picked) return false;
            if (picked === '표준') applyUcs(app, st, WORLD, null);
            else {
              const rec = st.doc.ucs.get(tableKey(picked));
              if (rec) applyUcs(app, st, recUcs(rec), null, rec.name);
            }
            return true;
          },
        },
        { label: '닫기' },
      ]);
    },
  });
}
