/**
 * DWGPROPS: 도면 특성 대화상자(일반·요약·통계·사용자 정의 탭). AutoCAD 2026 "도면 특성"과 같은 칸.
 * 요약·사용자 정의 값은 DWGPROPS XRECORD(src/io/dwgprops.ts)에 쓰고 $HYPERLINKBASE도 맞춘다 — 명령 취소 한 단계.
 * DXF는 XRECORD 그대로, DWG R2004+는 저장할 때 AcDb:SummaryInfo 구역으로 옮겨 쓴다.
 */
import type { CadDocument, CadObject, DictionaryObject, XRecordObject } from '../core/model';
import { normalizeHandle } from '../core/model';
import type { EditOp } from '../edit/session';
import { DWGPROPS_KEY, MAX_CUSTOM_PROPS, type DrawingProps, drawingProps, dwgPropsObject, propTimes, tagsFromProps } from '../io/dwgprops';
import type { App, CommandContext } from './app';
import { h } from './ui/dom';
import { areaIn, btn, fail, pickList, resultDialog, row, tabs, textIn } from './mgr-ui';

/** 특성을 도면에 쓰는 작업(XRECORD 만들기·고치기, 루트 사전 항목, $HYPERLINKBASE). 바뀐 것이 없으면 빈 배열 */
export function drawingPropsOps(doc: CadDocument, next: DrawingProps, newHandle: () => string): EditOp[] {
  const cur = drawingProps(doc);
  const same = JSON.stringify({ ...cur, lastSavedBy: '' }) === JSON.stringify({ ...next, lastSavedBy: '' });
  if (same) return [];
  const ops: EditOp[] = [];
  const tags = tagsFromProps({ ...next, custom: next.custom.slice(0, MAX_CUSTOM_PROPS) }, propTimes(doc));
  const have = dwgPropsObject(doc);
  if (have) {
    const after: XRecordObject = { ...have, data: tags };
    delete after.dwgRaw;
    ops.push({ kind: 'object', key: have.handle, before: have, after });
  } else {
    const rh = doc.rootDictionary ? normalizeHandle(doc.rootDictionary) : '';
    const root = rh ? doc.objects.get(rh) : undefined;
    if (root && (root.type === 'DICTIONARY' || root.type === 'ACDBDICTIONARYWDFLT')) {
      const d = root as DictionaryObject;
      const hd = newHandle();
      const x: XRecordObject = { type: 'XRECORD', handle: hd, owner: d.handle, reactors: [d.handle], cloning: 1, data: tags };
      const entries = new Map(d.entries);
      entries.set(DWGPROPS_KEY, hd);
      const dAfter: DictionaryObject = { ...d, entries };
      delete dAfter.dwgRaw;
      ops.push({ kind: 'object', key: hd, before: null, after: x }, { kind: 'object', key: d.handle, before: d as CadObject, after: dAfter });
    }
  }
  const hb = doc.header.get('$HYPERLINKBASE');
  if ((typeof hb === 'string' ? hb : '') !== next.hyperlinkBase) ops.push({ kind: 'header', name: '$HYPERLINKBASE', before: hb, after: next.hyperlinkBase });
  // 예전 자리(머리말의 $TITLE …)가 있으면 지워 두 곳이 어긋나지 않게
  for (const k of ['$TITLE', '$SUBJECT', '$AUTHOR', '$KEYWORDS', '$COMMENTS', '$REVISIONNUMBER']) {
    const v = doc.header.get(k);
    if (v !== undefined) ops.push({ kind: 'header', name: k, before: v, after: undefined });
  }
  return ops;
}

/** 율리우스일 → 지역 날짜·시각 글 */
export function julianText(jd: unknown): string {
  if (typeof jd !== 'number' || !Number.isFinite(jd) || jd <= 0) return '';
  const ms = (jd - 2440587.5) * 86400000;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toLocaleString('ko-KR') : '';
}

/** 일 수 → "n일 h:mm:ss" */
export function durationText(days: unknown): string {
  if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) return '';
  const total = Math.round(days * 86400);
  const d = Math.floor(total / 86400);
  const hh = Math.floor((total % 86400) / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d ? `${d}일 ` : ''}${p(hh)}:${p(mm)}:${p(ss)}`;
}

const FORMAT_NAMES: Record<string, string> = {
  AC1009: 'R12',
  AC1012: 'R13',
  AC1014: 'R14',
  AC1015: '2000',
  AC1018: '2004',
  AC1021: '2007',
  AC1024: '2010',
  AC1027: '2013',
  AC1032: '2018',
};

async function dwgPropsDialog(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  const cur = drawingProps(doc);
  const H = doc.header;
  // 일반
  const fmt = doc.format === 'new' ? '새 도면(저장하지 않음)' : `${doc.format.toUpperCase()} — AutoCAD ${FORMAT_NAMES[doc.version] ?? doc.version} 형식`;
  const kv = (k: string, v: string) => h('div', { class: 'mgr-row' }, h('span', {}, k), h('div', {}, v || '-'));
  const general = h(
    'div',
    { class: 'mgr-dlg' },
    kv('파일 이름', st.name),
    kv('형식', fmt),
    kv('크기', st.size ? `${st.size.toLocaleString('ko-KR')}바이트` : ''),
    kv('객체 수', doc.entityIndex.size.toLocaleString('ko-KR')),
    kv('배치 수', String(doc.layouts.filter((l) => !/^\*MODEL_SPACE$/i.test(l.blockName)).length)),
  );
  // 요약
  const title = textIn(cur.title, '제목');
  const subject = textIn(cur.subject, '주제');
  const author = textIn(cur.author, '작성자');
  const keywords = textIn(cur.keywords, '키워드');
  const comments = areaIn(cur.comments, '주석', 3);
  const hyper = textIn(cur.hyperlinkBase, '하이퍼링크 기준');
  const summary = h('div', { class: 'mgr-dlg' }, row('제목(T)', title), row('주제(S)', subject), row('작성자(A)', author), row('키워드(K)', keywords), row('주석(C)', comments), row('하이퍼링크 기준(H)', hyper));
  // 통계
  const revision = textIn(cur.revisionNumber, '수정 번호');
  const stats = h(
    'div',
    { class: 'mgr-dlg' },
    kv('작성', julianText(H.get('$TDCREATE'))),
    kv('수정', julianText(H.get('$TDUPDATE'))),
    kv('마지막 저장자', cur.lastSavedBy),
    row('수정 번호', revision),
    kv('총 편집 시간', durationText(H.get('$TDINDWG'))),
  );
  // 사용자 정의
  type Prop = { name: string; value: string };
  const props: Prop[] = cur.custom.map(([name, value]) => ({ name, value }));
  const nameIn = textIn('', '이름');
  const valueIn = textIn('', '값');
  const cerr = h('div', { class: 'mgr-err' });
  const list = pickList<Prop>(['이름', '값'], (p) => [p.name, p.value], {
    height: 200,
    onPick: (p) => {
      if (!p) return;
      nameIn.value = p.name;
      valueIn.value = p.value;
    },
  });
  const refresh = (keep?: string) => list.refresh(props, keep ? (p) => p.name === keep : undefined);
  const add = () => {
    const n = nameIn.value.trim();
    if (!n) return void (cerr.textContent = '이름을 입력하십시오.');
    if (n.includes('=')) return void (cerr.textContent = '이름에 = 를 쓸 수 없습니다.');
    const had = props.find((p) => p.name.toUpperCase() === n.toUpperCase());
    if (had) had.value = valueIn.value;
    else {
      if (props.length >= MAX_CUSTOM_PROPS) return void (cerr.textContent = `사용자 정의 특성은 ${MAX_CUSTOM_PROPS}개까지 둘 수 있습니다.`);
      props.push({ name: n, value: valueIn.value });
    }
    cerr.textContent = '';
    refresh(had?.name ?? n);
  };
  const del = () => {
    const p = list.selected();
    if (!p) return void (cerr.textContent = '삭제할 특성을 고르십시오.');
    props.splice(props.indexOf(p), 1);
    refresh();
  };
  const custom = h(
    'div',
    { class: 'mgr-dlg' },
    list.el,
    h('div', { class: 'mgr-cols' }, row('이름(N)', nameIn), row('값(V)', valueIn)),
    h('div', { class: 'mgr-btns' }, btn('추가·고치기(A)', add), btn('삭제(D)', del)),
    cerr,
  );
  refresh();
  const t = tabs(
    [
      { label: '일반', body: general },
      { label: '요약', body: summary },
      { label: '통계', body: stats },
      { label: '사용자 정의', body: custom },
    ],
    1,
  );
  const next = await resultDialog<DrawingProps>(`${st.name} 특성`, t.el, {
    width: 560,
    submit: () => {
      const names = props.map((p) => p.name.toUpperCase());
      if (new Set(names).size !== names.length) return fail('같은 이름의 사용자 정의 특성이 있습니다.');
      return {
        title: title.value,
        subject: subject.value,
        author: author.value,
        keywords: keywords.value,
        comments: comments.value,
        lastSavedBy: cur.lastSavedBy,
        revisionNumber: revision.value,
        hyperlinkBase: hyper.value.trim(),
        custom: props.map((p) => [p.name, p.value] as [string, string]),
      };
    },
  });
  if (!next) return;
  const ops = drawingPropsOps(doc, next, () => st.session.newHandle());
  if (!ops.length) return;
  st.session.commit({ label: 'DWGPROPS', ops, group: ctx.group });
  ctx.print('도면 특성을 바꿨습니다.');
}

export function registerDwgProps(app: App): void {
  app.register({ name: 'DWGPROPS', title: '도면 특성', run: (ctx) => dwgPropsDialog(app, ctx) });
}
