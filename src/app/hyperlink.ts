/**
 * 하이퍼링크: HYPERLINK(대화상자), -HYPERLINK(명령행), HYPERLINKOPEN, HYPERLINKOPTIONS.
 * 하이퍼링크가 있는 객체 위에서는 풍선말로 주소를 보이고 Ctrl+클릭하면 연다.
 * 웹 주소는 새 탭으로, 도면 안 위치는 그 명명된 뷰나 배치로 간다. 이 컴퓨터의 파일 경로는 브라우저가 열 수 없어 알리기만 한다.
 */
import { tableKey } from '../core/model';
import type { Entity } from '../core/model';
import { type Hyperlink, hyperlinkLabel, isWebUrl, readHyperlink, withHyperlink } from '../edit/hyperlink';
import type { EditOp } from '../edit/session';
import type { App, CommandContext } from './app';
import { unlockedOnly } from './layers';
import { form, toast } from './ui/dom';
import { restore } from './viewcmds';

const PREF = 'opencad.hyperlinkoptions';

/** 하이퍼링크 커서·풍선말 표시(HYPERLINKOPTIONS) */
function showTips(): boolean {
  try {
    return localStorage.getItem(PREF) !== '0';
  } catch {
    return true;
  }
}

/** 하이퍼링크를 따라간다 */
export async function followHyperlink(app: App, link: Hyperlink): Promise<void> {
  const st = app.active;
  if (link.url) {
    if (isWebUrl(link.url)) {
      const url = /^www\./i.test(link.url.trim()) ? `https://${link.url.trim()}` : link.url.trim();
      window.open(url, '_blank', 'noopener');
      app.cmd.print(`하이퍼링크를 열었습니다: ${url}`);
    } else app.cmd.print(`이 컴퓨터의 파일(${link.url})은 브라우저에서 열 수 없습니다. 파일을 직접 여십시오.`, 'err');
    if (!link.location) return;
  }
  if (!st || !link.location) return;
  const key = tableKey(link.location);
  const view = st.doc.views.get(key);
  if (view) {
    await restore(app, view);
    return;
  }
  const lay = st.layouts.find((l) => l.name.toUpperCase() === link.location.toUpperCase());
  if (lay) {
    await app.setSpace(tableKey(lay.blockName));
    return;
  }
  app.cmd.print(`도면 안 위치 "${link.location}"을(를) 찾을 수 없습니다.`, 'err');
}

function linkOps(app: App, handles: string[], link: Hyperlink | null): EditOp[] {
  const st = app.active!;
  const ops: EditOp[] = [];
  for (const h of handles) {
    const e = st.doc.entityIndex.get(h);
    const block = e ? st.session.ownerOf(h) : null;
    if (!e || !block) continue;
    const after = { ...e, xdata: withHyperlink(e.xdata, link) } as Entity;
    if (!after.xdata) delete (after as { xdata?: unknown }).xdata;
    ops.push({ kind: 'modify', block, before: e, after });
  }
  return ops;
}

async function pickObjects(app: App, ctx: CommandContext): Promise<string[]> {
  const pre = [...(app.active?.selection ?? [])];
  const hs = pre.length ? pre : ((await ctx.getSelection('객체 선택:')) ?? []);
  return unlockedOnly(app, hs);
}

export function registerHyperlinkCommands(app: App): void {
  // 객체 위 풍선말과 Ctrl+클릭
  app.hoverTip = (h) => {
    if (!showTips()) return null;
    const e = app.active?.doc.entityIndex.get(h);
    const l = e ? readHyperlink(e) : null;
    return l ? `${hyperlinkLabel(l)}\nCtrl+클릭하면 링크를 엽니다.` : null;
  };
  app.linkClick = (h) => {
    const e = app.active?.doc.entityIndex.get(h);
    const l = e ? readHyperlink(e) : null;
    if (!l) return false;
    void followHyperlink(app, l);
    return true;
  };

  app.register({
    name: 'HYPERLINK',
    aliases: ['INSERTHYPERLINK'],
    title: '하이퍼링크 삽입',
    async run(ctx) {
      const st = app.active!;
      const hs = await pickObjects(app, ctx);
      if (!hs.length) return;
      const links = hs.map((h) => readHyperlink(st.doc.entityIndex.get(h) ?? {})).filter((l): l is Hyperlink => !!l);
      const first = links[0];
      const views = [...st.doc.views.values()].map((v) => v.name);
      const v = await form('하이퍼링크 삽입', [
        { key: 'description', label: '표시할 문자', type: 'text', value: first?.description ?? '', wide: true },
        { key: 'url', label: '파일 또는 웹 페이지 이름', type: 'text', value: first?.url ?? '', placeholder: 'https://…', wide: true },
        {
          key: 'location',
          label: '이 도면의 뷰',
          type: 'select',
          value: first?.location ?? '',
          options: [{ value: '', label: '(없음)' }, ...views.map((n) => ({ value: n, label: n })), ...st.layouts.filter((l) => !/^\*MODEL_SPACE$/i.test(l.blockName)).map((l) => ({ value: l.name, label: `배치: ${l.name}` }))],
        },
        { key: 'remove', label: '링크 제거', type: 'check', value: false },
      ]);
      if (!v) return;
      const link: Hyperlink | null = v.remove ? null : { url: String(v.url).trim(), description: String(v.description).trim(), location: String(v.location) };
      if (link && !link.url && !link.location) {
        ctx.print('주소나 도면 안 위치를 입력하십시오.', 'err');
        return;
      }
      const ops = linkOps(app, hs, link);
      if (!ops.length) return;
      st.session.commit({ label: 'HYPERLINK', ops, group: ctx.group });
      ctx.print(link ? `객체 ${ops.length}개에 하이퍼링크를 넣었습니다.` : `하이퍼링크 ${links.length}개를 제거했습니다.`);
    },
  });

  app.register({
    name: '-HYPERLINK',
    title: '하이퍼링크(명령행)',
    async run(ctx) {
      const st = app.active!;
      const k = await ctx.getPoint('옵션 입력 [제거(R)/삽입(I)] <삽입>:', {
        keywords: [
          { key: 'R', label: '제거' },
          { key: 'I', label: '삽입' },
        ],
      });
      const remove = 'keyword' in k && k.keyword === 'R';
      const hs = unlockedOnly(app, (await ctx.getSelection('객체 선택:')) ?? []);
      if (!hs.length) return;
      if (remove) {
        const n = hs.filter((h) => readHyperlink(st.doc.entityIndex.get(h) ?? {})).length;
        const ops = linkOps(app, hs.filter((h) => readHyperlink(st.doc.entityIndex.get(h) ?? {})), null);
        if (ops.length) st.session.commit({ label: 'HYPERLINK', ops, group: ctx.group });
        ctx.print(`${n}개의 하이퍼링크가 삭제되었습니다.`);
        return;
      }
      const text = async (prompt: string): Promise<string | null> => {
        const r = await ctx.getPoint(prompt, { allowText: true });
        if ('text' in r) return r.text.trim();
        if ('enter' in r) return '';
        return null;
      };
      const url = await text('하이퍼링크 입력 <없음>:');
      if (url === null) return;
      const location = await text('명명된 위치 입력 <없음>:');
      if (location === null) return;
      if (!url && !location) return;
      const description = await text('설명 입력 <없음>:');
      if (description === null) return;
      const ops = linkOps(app, hs, { url, location, description });
      if (ops.length) st.session.commit({ label: 'HYPERLINK', ops, group: ctx.group });
    },
  });

  app.register({
    name: 'HYPERLINKOPEN',
    title: '하이퍼링크 열기',
    async run(ctx) {
      const st = app.active!;
      const r = await ctx.getEntity('하이퍼링크가 있는 객체 선택:');
      if (!('handle' in r)) return;
      const l = readHyperlink(st.doc.entityIndex.get(r.handle) ?? {});
      if (!l) {
        ctx.print('선택한 객체에 하이퍼링크가 없습니다.', 'err');
        return;
      }
      await followHyperlink(app, l);
    },
  });

  app.register({
    name: 'HYPERLINKOPTIONS',
    title: '하이퍼링크 옵션',
    noDoc: true,
    async run(ctx) {
      const r = await ctx.getPoint(`하이퍼링크 커서, 바로 가기 메뉴 및 툴팁 표시? [예(Y)/아니오(N)] <${showTips() ? '예' : '아니오'}>:`, {
        keywords: [
          { key: 'Y', label: '예' },
          { key: 'N', label: '아니오' },
        ],
      });
      if (!('keyword' in r)) return;
      try {
        localStorage.setItem(PREF, r.keyword === 'N' ? '0' : '1');
      } catch {
        toast('설정을 저장하지 못했습니다.', 'warn');
      }
    },
  });
}
