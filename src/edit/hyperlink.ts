/**
 * 하이퍼링크: AutoCAD는 객체의 확장 자료 PE_URL에 둔다.
 * 1000 주소, 그리고 설명이 있으면 1002 { · 1000 설명 · 1000 도면 안 위치(뷰 이름) · 1002 }.
 */
import type { XData } from '../core/model';

export const HYPERLINK_APP = 'PE_URL';

export interface Hyperlink {
  /** 파일 또는 웹 페이지 주소(비어 있으면 도면 안 위치만) */
  url: string;
  /** 표시할 문자(없으면 주소) */
  description: string;
  /** 도면 안 위치(명명된 뷰·배치 이름) */
  location: string;
}

/** 객체의 하이퍼링크(없으면 null) */
export function readHyperlink(e: { xdata?: XData[] }): Hyperlink | null {
  const x = e.xdata?.find((d) => d.app.toUpperCase() === HYPERLINK_APP);
  if (!x) return null;
  const strs = x.items.filter((i) => i.code === 1000).map((i) => String(i.value));
  if (!strs.length) return null;
  return { url: strs[0] ?? '', description: strs[1] ?? '', location: strs[2] ?? '' };
}

/** 하이퍼링크를 넣거나(link) 지운(null) 확장 자료. 다른 앱의 자료는 그대로 */
export function withHyperlink(xdata: XData[] | undefined, link: Hyperlink | null): XData[] | undefined {
  const rest = (xdata ?? []).filter((d) => d.app.toUpperCase() !== HYPERLINK_APP);
  if (!link || (!link.url && !link.location)) return rest.length ? rest : undefined;
  const items: XData['items'] = [{ code: 1000, value: link.url }];
  if (link.description || link.location) {
    items.push({ code: 1002, value: '{' }, { code: 1000, value: link.description || link.url });
    if (link.location) items.push({ code: 1000, value: link.location });
    items.push({ code: 1002, value: '}' });
  }
  return [...rest, { app: HYPERLINK_APP, items }];
}

/** 웹에서 열 수 있는 주소인지(파일 경로·도면 파일은 브라우저가 열 수 없다) */
export function isWebUrl(url: string): boolean {
  return /^(https?:|mailto:)/i.test(url.trim()) || /^www\./i.test(url.trim());
}

/** 화면에 보일 이름 */
export function hyperlinkLabel(l: Hyperlink): string {
  const target = l.url || (l.location ? `#${l.location}` : '');
  return l.description && l.description !== l.url ? `${l.description} (${target})` : target;
}
