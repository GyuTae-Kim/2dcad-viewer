/**
 * 특성·표시 명령: CHPROP, CHANGE(-CH), COLOR(COL), DDPTYPE(PTYPE), ATTDISP, SOLID(SO), TIME
 * 프롬프트는 AutoCAD 2026 한국어판을 따른다.
 */
import type { CadColor, Entity, FaceEntity, HeaderValue } from '../core/model';
import { tableKey } from '../core/model';
import type { EditOp } from '../edit/session';
import type { App, CommandContext } from './app';
import type { DocState } from './docstate';
import { addEntities, currentProps } from './draw';
import { form } from './ui/dom';

type Pt = { x: number; y: number };

const COLOR_NAMES: Record<string, number> = {
  RED: 1, 빨간색: 1, 빨강: 1,
  YELLOW: 2, 노란색: 2, 노랑: 2,
  GREEN: 3, 초록색: 3, 초록: 3,
  CYAN: 4, 하늘색: 4,
  BLUE: 5, 파란색: 5, 파랑: 5,
  MAGENTA: 6, 선홍색: 6,
  WHITE: 7, 흰색: 7,
  BYLAYER: 256, 도면층별: 256,
  BYBLOCK: 0, 블록별: 0,
};

/** 색 입력: 번호(0~256), 이름, BYLAYER·BYBLOCK, "r,g,b"(트루컬러) */
export function parseColorInput(t: string): CadColor | null {
  const s = t.trim();
  const up = s.toUpperCase();
  if (up in COLOR_NAMES) return { aci: COLOR_NAMES[up]! };
  if (s in COLOR_NAMES) return { aci: COLOR_NAMES[s]! };
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n >= 0 && n <= 256 ? { aci: n } : null;
  }
  const rgb = /^(\d{1,3}),(\d{1,3}),(\d{1,3})$/.exec(s.replace(/\s+/g, ''));
  if (rgb) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number) as [number, number, number];
    if (r > 255 || g > 255 || b > 255) return null;
    return { aci: 7, rgb: (r << 16) | (g << 8) | b };
  }
  return null;
}

const colorLabel = (c: CadColor) => (c.rgb !== undefined ? `${(c.rgb >> 16) & 255},${(c.rgb >> 8) & 255},${c.rgb & 255}` : c.aci === 256 ? 'BYLAYER' : c.aci === 0 ? 'BYBLOCK' : String(c.aci));

function setHeader(st: DocState, ctx: CommandContext | null, label: string, name: string, value: HeaderValue): void {
  const before = st.doc.header.get(name);
  if (before === value) return;
  st.session.commit({ label, ops: [{ kind: 'header', name, before, after: value }], group: ctx?.group });
}

/** 고른 객체들을 같은 방식으로 바꾼다 */
function modifyAll(st: DocState, ctx: CommandContext, label: string, hs: string[], f: (e: Entity) => Entity | null): number {
  const ops: EditOp[] = [];
  for (const h of hs) {
    const e = st.doc.entityIndex.get(h);
    const block = e ? st.session.ownerOf(h) : null;
    if (!e || !block) continue;
    const after = f(e);
    if (after) ops.push({ kind: 'modify', block, before: e, after });
  }
  if (ops.length) st.session.commit({ label, ops, group: ctx.group });
  return ops.length;
}

/** CHPROP·CHANGE 특성(P) 공통: 특성을 하나씩 묻고 바꾼다 */
async function changeProps(app: App, ctx: CommandContext, hs: string[], label: string): Promise<void> {
  const st = app.active!;
  for (;;) {
    const r = await ctx.getPoint('변경할 특성 입력 [색상(C)/도면층(LA)/선종류(LT)/선종류 축척(S)/선가중치(LW)/두께(T)/투명도(TR)]:', {
      keywords: [
        { key: 'C', label: '색상' },
        { key: 'LA', label: '도면층' },
        { key: 'LT', label: '선종류' },
        { key: 'S', label: '선종류 축척' },
        { key: 'LW', label: '선가중치' },
        { key: 'T', label: '두께' },
        { key: 'TR', label: '투명도' },
      ],
    });
    if (!('keyword' in r)) return;
    const ask = async (prompt: string) => {
      const t = await ctx.getPoint(prompt, { allowText: true, preferNumber: true });
      return 'text' in t ? t.text.trim() : null;
    };
    switch (r.keyword) {
      case 'C': {
        const t = await ask('새 색상 [트루컬러(T)/색상표(CO)] <BYLAYER>:');
        const c = parseColorInput(t ?? 'BYLAYER');
        if (!c) ctx.print('색상 이름이나 번호(1~255), BYLAYER, BYBLOCK 또는 빨강,초록,파랑 값을 입력하십시오.', 'err');
        else modifyAll(st, ctx, label, hs, (e) => ({ ...e, color: c }) as Entity);
        break;
      }
      case 'LA': {
        const t = await ask('새 도면층 이름 입력:');
        const L = t ? st.doc.layers.get(tableKey(t)) : undefined;
        if (!L) ctx.print(`도면층 "${t ?? ''}"을(를) 찾을 수 없습니다.`, 'err');
        else modifyAll(st, ctx, label, hs, (e) => ({ ...e, layer: L.name }) as Entity);
        break;
      }
      case 'LT': {
        const t = await ask('새 선종류 이름 입력 <BYLAYER>:');
        const name = t || 'ByLayer';
        const k = tableKey(name);
        if (k !== 'BYLAYER' && k !== 'BYBLOCK' && !st.doc.linetypes.has(k)) ctx.print(`선종류 "${name}"을(를) 찾을 수 없습니다. 선종류 관리자(LINETYPE)에서 먼저 로드하십시오.`, 'err');
        else modifyAll(st, ctx, label, hs, (e) => ({ ...e, linetype: k === 'BYLAYER' ? 'ByLayer' : k === 'BYBLOCK' ? 'ByBlock' : st.doc.linetypes.get(k)!.name }) as Entity);
        break;
      }
      case 'S': {
        const v = Number(await ask('새 선종류 축척 지정 <1.0000>:'));
        if (v > 0) modifyAll(st, ctx, label, hs, (e) => ({ ...e, ltscale: v }) as Entity);
        break;
      }
      case 'LW': {
        const t = (await ask('새 선가중치 입력 <BYLAYER>:')) ?? '';
        const up = t.toUpperCase();
        const v = up === '' || up === 'BYLAYER' ? -1 : up === 'BYBLOCK' ? -2 : up === 'DEFAULT' || up === '기본값' ? -3 : Math.round(Number(t) * 100);
        if (!Number.isFinite(v)) ctx.print('선가중치는 mm 값(예: 0.25)이나 BYLAYER로 입력하십시오.', 'err');
        else modifyAll(st, ctx, label, hs, (e) => ({ ...e, lineweight: v }) as Entity);
        break;
      }
      case 'T': {
        const v = Number(await ask('새 두께 지정 <0.0000>:'));
        if (Number.isFinite(v)) modifyAll(st, ctx, label, hs, (e) => ({ ...e, thickness: v || undefined }) as Entity);
        break;
      }
      case 'TR': {
        const t = ((await ask('새 투명도 값 입력 [BYLAYER/BYBLOCK] <BYLAYER>:')) ?? '').toUpperCase();
        // 모델 값: -1 도면층별, 0 블록별, 그 밖에는 불투명도(255 = 불투명)
        const v = t === '' || t === 'BYLAYER' ? -1 : t === 'BYBLOCK' ? 0 : Math.round(255 * (1 - Math.min(90, Math.max(0, Number(t))) / 100));
        if (!Number.isFinite(v)) ctx.print('0에서 90 사이의 값을 입력하십시오.', 'err');
        else modifyAll(st, ctx, label, hs, (e) => ({ ...e, transparency: v }) as Entity);
        break;
      }
    }
  }
}

/** 선의 가까운 끝점을 옮기고, 원은 반지름을 바꾸고, 문자는 위치·높이·각도·내용을 묻는다 */
async function changePoint(app: App, ctx: CommandContext, hs: string[], p: Pt): Promise<void> {
  const st = app.active!;
  const ops: EditOp[] = [];
  for (const h of hs) {
    const e = st.doc.entityIndex.get(h);
    const block = e ? st.session.ownerOf(h) : null;
    if (!e || !block) continue;
    if (e.type === 'LINE') {
      const ds = Math.hypot(e.start.x - p.x, e.start.y - p.y);
      const de = Math.hypot(e.end.x - p.x, e.end.y - p.y);
      const np = { x: p.x, y: p.y, z: ds <= de ? e.start.z : e.end.z };
      ops.push({ kind: 'modify', block, before: e, after: ds <= de ? { ...e, start: np } : { ...e, end: np } });
    } else if (e.type === 'CIRCLE') {
      const r = Math.hypot(p.x - e.center.x, p.y - e.center.y);
      if (r > 1e-12) ops.push({ kind: 'modify', block, before: e, after: { ...e, radius: r } });
    } else if (e.type === 'TEXT' || e.type === 'ATTDEF') {
      const pt = { x: p.x, y: p.y, z: e.insert.z };
      const nh = await ctx.getPoint(`새 높이 지정 <${e.height.toFixed(4)}>:`, { allowText: true, preferNumber: true });
      const na = await ctx.getPoint(`새 회전 각도 지정 <${((e.rotation * 180) / Math.PI).toFixed(0)}>:`, { allowText: true, preferNumber: true });
      const nt = await ctx.getPoint(`새 문자 입력 <${e.text}>:`, { allowText: true });
      const height = 'text' in nh && Number(nh.text) > 0 ? Number(nh.text) : e.height;
      const rotation = 'text' in na && Number.isFinite(Number(na.text)) ? (Number(na.text) * Math.PI) / 180 : e.rotation;
      const text = 'text' in nt ? nt.text : e.text;
      const after = { ...e, insert: pt, height, rotation, text } as Entity;
      // 맞춤점을 쓰는 자리맞추기면 맞춤점도 같은 만큼 옮긴다
      if ('alignPoint' in e && e.alignPoint && (e.halign || e.valign)) (after as typeof e).alignPoint = { x: e.alignPoint.x + p.x - e.insert.x, y: e.alignPoint.y + p.y - e.insert.y, z: e.alignPoint.z };
      ops.push({ kind: 'modify', block, before: e, after });
    } else if (e.type === 'INSERT') {
      const na = await ctx.getPoint(`새 블록 회전 각도 지정 <${((e.rotation * 180) / Math.PI).toFixed(0)}>:`, { allowText: true, preferNumber: true });
      const rotation = 'text' in na && Number.isFinite(Number(na.text)) ? (Number(na.text) * Math.PI) / 180 : e.rotation;
      const dx = p.x - e.insert.x;
      const dy = p.y - e.insert.y;
      ops.push({ kind: 'modify', block, before: e, after: { ...e, insert: { x: p.x, y: p.y, z: e.insert.z }, rotation, attribs: e.attribs.map((a) => ({ ...a, insert: { ...a.insert, x: a.insert.x + dx, y: a.insert.y + dy } })) } });
    }
  }
  if (ops.length) st.session.commit({ label: 'CHANGE', ops, group: ctx.group });
}

/** PDMODE 그림 이름 */
const PDMODES: [number, string][] = [
  [0, '점(·)'],
  [1, '없음'],
  [2, '+'],
  [3, '×'],
  [4, '짧은 세로선'],
  [32, '원 안의 점'],
  [33, '원'],
  [34, '원 안의 +'],
  [35, '원 안의 ×'],
  [36, '원 안의 세로선'],
  [64, '사각형 안의 점'],
  [65, '사각형'],
  [66, '사각형 안의 +'],
  [67, '사각형 안의 ×'],
  [68, '사각형 안의 세로선'],
  [96, '원과 사각형 안의 점'],
  [97, '원과 사각형'],
  [98, '원과 사각형 안의 +'],
  [99, '원과 사각형 안의 ×'],
  [100, '원과 사각형 안의 세로선'],
];

/** 율리우스일 → 날짜 문자열 */
function julian(v: HeaderValue | undefined): string {
  if (typeof v !== 'number' || !(v > 2000000)) return '-';
  const d = new Date((v - 2440587.5) * 86400000);
  return d.toLocaleString('ko-KR');
}

function days(v: HeaderValue | undefined): string {
  if (typeof v !== 'number' || !(v >= 0)) return '-';
  const s = Math.round(v * 86400);
  return `${Math.floor(s / 86400)}일 ${String(Math.floor((s % 86400) / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function registerPropCommands(app: App): void {
  app.register({
    name: 'CHPROP',
    title: '특성 변경',
    async run(ctx) {
      const hs = await ctx.getSelection('객체 선택:');
      if (hs.length) await changeProps(app, ctx, hs, 'CHPROP');
    },
  });

  app.register({
    name: 'CHANGE',
    aliases: ['-CH'],
    title: '변경',
    async run(ctx) {
      const hs = await ctx.getSelection('객체 선택:');
      if (!hs.length) return;
      const r = await ctx.getPoint('변경점 지정 또는 [특성(P)]:', { keywords: [{ key: 'P', label: '특성' }] });
      if ('keyword' in r) await changeProps(app, ctx, hs, 'CHANGE');
      else if ('point' in r) await changePoint(app, ctx, hs, r.point);
    },
  });

  app.register({
    name: 'COLOR',
    aliases: ['COL', 'COLOUR', 'DDCOLOR'],
    title: '현재 색상',
    transparent: true,
    async run(ctx) {
      const st = app.active!;
      const cur = currentProps(app).color;
      const r = await ctx.getPoint(`새 객체 색상 입력 [트루컬러(T)] <${colorLabel(cur)}>:`, { keywords: [{ key: 'T', label: '트루컬러' }], allowText: true, preferNumber: true });
      let t: string | null = 'text' in r ? r.text : null;
      if ('keyword' in r) {
        const q = await ctx.getPoint('빨강,초록,파랑 값 입력:', { allowText: true });
        t = 'text' in q ? q.text : null;
      }
      if (t === null) return;
      const c = parseColorInput(t);
      if (!c) {
        ctx.print('색상 이름이나 번호(0~256), BYLAYER, BYBLOCK 또는 빨강,초록,파랑 값을 입력하십시오.', 'err');
        return;
      }
      if (c.rgb !== undefined) ctx.print('참고: 현재 색상은 가장 가까운 색상표 색으로 저장됩니다.');
      setHeader(st, ctx, 'COLOR', '$CECOLOR', c.aci);
      app.ui.refreshPalette();
    },
  });

  app.register({
    name: 'DDPTYPE',
    aliases: ['PTYPE'],
    title: '점 스타일',
    async run() {
      const st = app.active!;
      const mode = Number(st.doc.header.get('$PDMODE') ?? 0);
      const size = Number(st.doc.header.get('$PDSIZE') ?? 0);
      const v = await form(
        '점 스타일',
        [
          { key: 'mode', label: '점 모양', type: 'select', value: String(mode), options: PDMODES.map(([m, n]) => ({ value: String(m), label: `${m} — ${n}` })) },
          { key: 'size', label: '점 크기', type: 'number', value: Math.abs(size) || 5 },
          { key: 'rel', label: '화면에 상대적인 크기 설정(%)', type: 'check', value: size <= 0 },
        ],
        { validate: (x) => (Number(x.size) > 0 ? null : '점 크기는 0보다 커야 합니다.') },
      );
      if (!v) return;
      const ops: EditOp[] = [];
      const nm = Number(v.mode);
      const ns = v.rel ? -Number(v.size) : Number(v.size);
      if (nm !== mode) ops.push({ kind: 'header', name: '$PDMODE', before: st.doc.header.get('$PDMODE'), after: nm });
      if (ns !== size) ops.push({ kind: 'header', name: '$PDSIZE', before: st.doc.header.get('$PDSIZE'), after: ns });
      if (ops.length) st.session.commit({ label: 'DDPTYPE', ops });
    },
  });

  app.register({
    name: 'ATTDISP',
    title: '속성 표시',
    transparent: true,
    async run(ctx) {
      const st = app.active!;
      const cur = Number(st.doc.header.get('$ATTMODE') ?? 1);
      const r = await ctx.getPoint(`속성 가시성 설정 입력 [보통(N)/켜기(ON)/끄기(OFF)] <${cur === 0 ? '끄기' : cur === 2 ? '켜기' : '보통'}>:`, {
        keywords: [
          { key: 'N', label: '보통' },
          { key: 'ON', label: '켜기' },
          { key: 'OFF', label: '끄기' },
        ],
      });
      if (!('keyword' in r)) return;
      setHeader(st, ctx, 'ATTDISP', '$ATTMODE', r.keyword === 'OFF' ? 0 : r.keyword === 'ON' ? 2 : 1);
    },
  });

  app.register({
    name: 'SOLID',
    aliases: ['SO'],
    title: '2D 솔리드',
    async run(ctx) {
      const st = app.active!;
      const get = async (prompt: string, base: Pt | null, enterEnds: boolean): Promise<Pt | null> => {
        const r = await ctx.getPoint(prompt, { base });
        if ('point' in r) return r.point;
        if ('enter' in r && enterEnds) return null;
        return null;
      };
      let a = await get('첫 번째 점 지정:', null, false);
      if (!a) return;
      let b = await get('두 번째 점 지정:', a, false);
      if (!b) return;
      for (;;) {
        const c = await get('세 번째 점 지정:', b, true);
        if (!c) return;
        const d = await get('네 번째 점 지정 또는 <종료>:', c, true);
        const z = (p: Pt) => ({ x: p.x, y: p.y, z: 0 });
        const e: FaceEntity = { ...currentProps(app), type: 'SOLID', handle: '', points: [z(a), z(b), z(c), z(d ?? c)], invisibleEdges: 0 };
        addEntities(app, ctx, [e as Entity], 'SOLID');
        if (!d) return;
        a = c;
        b = d;
        void st;
      }
    },
  });

  app.register({
    name: 'TIME',
    title: '도면 시간',
    noDoc: false,
    run(ctx) {
      const st = app.active!;
      const hd = st.doc.header;
      ctx.print(`현재 시간:              ${new Date().toLocaleString('ko-KR')}`);
      ctx.print(`이 도면의 시간:`);
      ctx.print(`  작성:                 ${julian(hd.get('$TDCREATE'))}`);
      ctx.print(`  마지막 업데이트:      ${julian(hd.get('$TDUPDATE'))}`);
      ctx.print(`  총 편집 시간:         ${days(hd.get('$TDINDWG'))}`);
      ctx.print(`  경과 타이머(켜기):    ${days(hd.get('$TDUSRTIMER'))}`);
    },
  });
}
