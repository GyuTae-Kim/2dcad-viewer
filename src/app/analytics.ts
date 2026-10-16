/** First-party GA4 adapter. Never pass file names, model data, URLs or exception text to events. */
export type AnalyticsTool = 'portfolio' | 'dwgdxf' | 'nc' | 'step' | 'skp';
export type InputKind = 'local' | 'sample' | 'url';
export type OpenError = 'size_limit' | 'read_error' | 'fetch_error' | 'unsupported' | 'empty' | 'parse_error';
export type ExportFormat = 'png' | 'jpg' | 'bmp' | 'pdf' | 'svg' | 'dxf' | 'dwg';
export type ContentGroup = '포트폴리오' | '프로젝트' | '연구' | 'OpenCAD 소개' | 'OpenCAD 가이드' | 'OpenCAD 앱' | '개발 노트' | '연락' | '오류';

const HOST = 'gyutae-kim.github.io';
const CONSENT_KEY = 'opencad.analytics-consent.v1';
const PATHS: Record<AnalyticsTool, string> = { portfolio: '/', dwgdxf: '/opencad-dwgdxf/', nc: '/opencad-nc/', step: '/opencad-step/', skp: '/opencad-skp/' };
const TITLES: Record<AnalyticsTool, string> = { portfolio: '포트폴리오 | 홈', dwgdxf: 'OpenCAD | DWG/DXF 캐드', nc: 'OpenCAD | NC 뷰어', step: 'OpenCAD | STEP 뷰어', skp: 'OpenCAD | SKP 뷰어' };
const FORMATS = new Set(['skp', 'step', 'stp', 'p21', 'stpz', 'stpx', 'zip', 'gz', 'dxf', 'dwg', 'nc', 'gcode', 'ngc', 'h', 'mpr']);
type AnalyticsWindow = Window & { dataLayer?: unknown[]; gtag?: (...args: unknown[]) => void };
let active: { id: string; tool: AnalyticsTool } | undefined;
let started = false;
// Legacy "denied" keeps its original meaning: no Google requests at all.
type Consent = 'granted' | 'limited' | 'denied' | null;
let consent: Consent = null;
let pagePath = '/';
let pageTitle = TITLES.portfolio;
let pageGroup: ContentGroup = '포트폴리오';
let pageReferrer = '';
let lastPage = '';
let pageReady = false;

/** Keep campaign slugs, excluding user-supplied file/URL parameters and fragments. */
export function campaignQuery(search: string): string {
  const out = new URLSearchParams();
  const input = new URLSearchParams(search);
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    const value = input.get(key);
    if (value && /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(value)) out.set(key, value);
  }
  return out.toString() ? `?${out}` : '';
}

function referrer(): string {
  try { return new URL(document.referrer).origin; } catch { return ''; }
}

function fields(): Record<string, string> {
  return { tool: active!.tool, page_title: pageTitle, content_group: pageGroup, page_location: `https://${HOST}${pagePath}${consent === 'granted' ? campaignQuery(location.search) : ''}`, page_referrer: consent === 'granted' ? pageReferrer : '' };
}

function send(name: string, params: Record<string, string | number> = {}): void {
  if (consent !== 'granted' || !started || !active) return;
  try { (window as AnalyticsWindow).gtag?.('event', name, { ...params, ...fields(), send_to: active.id }); } catch { /* Analytics never interrupts CAD. */ }
}

function pageView(): void {
  if (!started || !active || !pageReady || (consent !== 'granted' && consent !== 'limited') || lastPage === pagePath) return;
  const w = window as AnalyticsWindow;
  // Also pin automatic engagement/session events to public titles and locations.
  try {
    w.gtag?.('set', fields());
  } catch { return; }
  try { w.gtag?.('event', 'page_view', { ...fields(), send_to: active.id }); } catch { return; }
  lastPage = pagePath;
}

function start(): void {
  if (!active || started || (consent !== 'granted' && consent !== 'limited')) return;
  const w = window as AnalyticsWindow;
  w.dataLayer ??= [];
  w.gtag ??= function (..._args: unknown[]): void { w.dataLayer!.push(arguments); };
  w.gtag('consent', 'default', { analytics_storage: consent === 'granted' ? 'granted' : 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
  w.gtag('js', new Date());
  w.gtag('set', { ...fields(), allow_google_signals: false, allow_ad_personalization_signals: false, ads_data_redaction: true, url_passthrough: false });
  // Configure once per document. Route metadata lives in global set/event parameters.
  w.gtag('config', active.id, { send_page_view: false, cookie_domain: HOST, cookie_path: '/', allow_google_signals: false, allow_ad_personalization_signals: false });
  const script = document.createElement('script');
  script.id = 'opencad-ga4';
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${active.id}`;
  document.head.append(script);
  started = true;
  pageView();
}

function storedConsent(value: string | null): Consent {
  return value === 'granted' || value === 'limited' || value === 'denied' ? value : null;
}

function choice(): Consent {
  try { return storedConsent(localStorage.getItem(CONSENT_KEY)); } catch { return null; }
}

function choose(value: Consent, persist = true): void {
  if (persist) {
    try { if (value) localStorage.setItem(CONSENT_KEY, value); else localStorage.removeItem(CONSENT_KEY); } catch { /* Session-only choice. */ }
  }
  const previous = consent;
  consent = value;
  const collecting = value === 'granted' || value === 'limited';
  (window as unknown as Record<string, unknown>)[`ga-disable-${active!.id}`] = !collecting;
  if (value !== 'granted') {
    for (const cookie of document.cookie.split(';')) {
      const key = cookie.trim().split('=')[0]!;
      if (/^_ga(?:_|$)/.test(key)) {
        document.cookie = `${key}=; Max-Age=0; path=/; domain=${HOST}`;
        document.cookie = `${key}=; Max-Age=0; path=/`;
      }
    }
  }
  if (started && previous !== value) {
    try {
      const w = window as AnalyticsWindow;
      w.gtag?.('set', fields());
      w.gtag?.('consent', 'update', { analytics_storage: value === 'granted' ? 'granted' : 'denied' });
    } catch { /* Blocked tag. */ }
  }
  if (collecting) { start(); pageView(); }
  // Do not echo storage events to other tabs or create an extra page_view on a setting change.
  controls(value === null);
}

function controls(expanded: boolean): void {
  document.getElementById('opencad-analytics-choice')?.remove();
  if (!expanded) return;
  const box = document.createElement('aside');
  box.id = 'opencad-analytics-choice';
  box.setAttribute('aria-label', '방문 통계 설정');
  box.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:10000;box-sizing:border-box;width:340px;max-width:calc(100vw - 24px);padding:10px;border:1px solid #888;border-radius:6px;background:Canvas;color:CanvasText;font:13px/1.5 system-ui;box-shadow:0 2px 8px #0002';
  const button = (label: string, run: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label;
    b.style.cssText = 'margin:4px;padding:6px 10px;font:inherit;cursor:pointer';
    b.addEventListener('click', run);
    return b;
  };
  const text = document.createElement('p');
  text.style.margin = '0 0 6px';
  text.textContent = '허용하면 쿠키로 유입·기능 통계를 수집합니다. 거절하면 쿠키 없이 기본 방문 신호만 Google Analytics로 전송합니다. 파일명·내용·입력 주소는 보내지 않습니다. 푸터나 앱 메뉴에서 변경할 수 있습니다.';
  box.append(text, button('허용', () => choose('granted')), button('거절 (기본 방문만)', () => choose('limited')), button('수집 안 함', () => choose('denied')));
  document.body.append(box);
}

/** Reopen from a normal footer/menu, without a persistent floating button. */
export function showAnalyticsSettings(): void {
  if (active) controls(true);
}

/** Published pages only; no Google request until the visitor makes a choice. */
export function initAnalytics(id: string, tool: AnalyticsTool): void {
  try { initialize(id, tool); } catch { /* Tracking failures never prevent opening the app. */ }
}

function initialize(id: string, tool: AnalyticsTool): void {
  if (typeof window === 'undefined' || active || location.hostname !== HOST || location.protocol !== 'https:' || !/^G-[A-Z0-9]+$/.test(id)) return;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  if (nav.globalPrivacyControl || nav.doNotTrack === '1') return;
  active = { id, tool };
  pagePath = PATHS[tool]; pageTitle = TITLES[tool];
  pageGroup = tool === 'portfolio' ? '포트폴리오' : 'OpenCAD 앱';
  pageReferrer = referrer();
  pageReady = tool !== 'portfolio';
  choose(choice(), false);
  window.addEventListener('storage', (event) => {
    if (event.key === CONSENT_KEY || event.key === null) choose(event.key === null ? null : storedConsent(event.newValue), false);
  });
  document.addEventListener('click', (event) => {
    const link = (event.target instanceof Element ? event.target.closest('a[href]') : null) as HTMLAnchorElement | null;
    if (!link) return;
    try {
      const url = new URL(link.href);
      const tool = (Object.keys(PATHS) as AnalyticsTool[]).find((key) => key !== 'portfolio' && url.pathname.replace(/\/$/, '') === PATHS[key].replace(/\/$/, ''));
      if (url.hostname === HOST && tool) send('viewer_open', { target_tool: tool });
      else if (url.hostname === 'github.com' && /^\/GyuTae-Kim\/(?:opencad-(?:dwgdxf|nc|step|skp|viewer3d)|GyuTae-Kim.github.io)\/?$/i.test(url.pathname)) {
        const repo = url.pathname.split('/')[2]!.toLowerCase();
        send('source_open', { target_tool: repo.startsWith('opencad-') ? repo.slice(8) : 'portfolio' });
      }
    } catch { /* Non-HTTP links are irrelevant. */ }
  });
}

/** Call after SEO updates on an Angular navigation; never pass document-specific titles. */
export function trackPage(path: string, title: string, group: ContentGroup = '포트폴리오'): void {
  if (!active || active.tool !== 'portfolio') return;
  const nextPath = path.startsWith('/') ? path.split(/[?#]/)[0]! : '/404';
  if (pageReady && pagePath !== nextPath) pageReferrer = `https://${HOST}${pagePath}`;
  pagePath = nextPath;
  pageTitle = title;
  pageGroup = group;
  pageReady = true;
  pageView();
}

export interface OpenAttempt { success(): void; error(code: OpenError): void }
export function beginOpen(input: InputKind, format: string): OpenAttempt {
  const safeFormat = FORMATS.has(format.toLowerCase()) ? format.toLowerCase() : 'other';
  const startAt = performance.now();
  const params = { input_kind: input, file_format: safeFormat };
  let done = false;
  send('file_open_start', params);
  return {
    success(): void {
      if (done) return; done = true;
      send(input === 'sample' ? 'sample_open_success' : 'file_open_success', { ...params, duration_ms: Math.min(3_600_000, Math.max(0, Math.round(performance.now() - startAt))) });
    },
    error(code): void {
      if (done) return; done = true;
      send(input === 'sample' ? 'sample_open_error' : 'file_open_error', { ...params, error_code: code });
    },
  };
}

export function trackExport(format: ExportFormat): void { send('export_complete', { export_format: format }); }
