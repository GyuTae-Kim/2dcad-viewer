// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

type TaggedWindow = Window & { dataLayer?: unknown[]; gtag?: (...args: unknown[]) => void };
const tagged = window as TaggedWindow;
const commands = (): unknown[][] => (tagged.dataLayer ?? []).map((entry) => Array.from(entry as ArrayLike<unknown>));
const events = (): unknown[][] => commands().filter((entry) => entry[0] === 'event');
const click = (text: string): void => [...document.querySelectorAll('button')].find((button) => button.textContent === text)!.click();

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.getElementById('opencad-ga4')?.remove();
  localStorage.clear();
  delete tagged.dataLayer;
  delete tagged.gtag;
  vi.stubGlobal('location', new URL('https://gyutae-kim.github.io/opencad-skp/?open=customer-secret.skp&utm_source=github&utm_medium=referral#private'));
  Object.defineProperty(navigator, 'doNotTrack', { value: '0', configurable: true });
  Object.defineProperty(navigator, 'globalPrivacyControl', { value: false, configurable: true });
});

describe('GA4 collection boundary', () => {
  it('waits for a choice, then refusal sends only cookie-free public visits', async () => {
    const ga = await import('../../src/app/analytics');
    ga.initAnalytics('G-TEST123', 'skp');
    ga.beginOpen('local', 'skp').success();
    expect(document.getElementById('opencad-ga4')).toBeNull();
    expect(commands()).toEqual([]);
    click('거절 (기본 방문만)');
    expect(localStorage.getItem('opencad.analytics-consent.v1')).toBe('limited');
    expect(document.getElementById('opencad-ga4')).not.toBeNull();
    expect(document.getElementById('opencad-analytics-choice')).toBeNull();
    expect(commands().find(entry => entry[0] === 'consent')![2]).toMatchObject({ analytics_storage: 'denied' });
    ga.beginOpen('local', 'skp').success(); ga.trackExport('png');
    expect(events().map(entry => entry[1])).toEqual(['page_view']);
    expect(events()[0]![2]).toMatchObject({ page_location: 'https://gyutae-kim.github.io/opencad-skp/', page_referrer: '' });
    expect(JSON.stringify(commands())).not.toMatch(/utm_source|utm_medium|customer-secret/);
  });

  it('pins public metadata and excludes file/URL/title/error content from events', async () => {
    const ga = await import('../../src/app/analytics');
    ga.initAnalytics('G-TEST123', 'skp');
    click('허용');
    document.title = 'private-customer.skp - OpenCAD';
    const attempt = ga.beginOpen('local', 'skp');
    attempt.success();
    attempt.success();
    attempt.error('parse_error');
    ga.beginOpen('url', 'secret/customer.nc').error('fetch_error');
    ga.trackExport('png');
    expect(events().map((event) => event[1])).toEqual(['page_view', 'file_open_start', 'file_open_success', 'file_open_start', 'file_open_error', 'export_complete']);
    const encoded = JSON.stringify(commands());
    expect(encoded).not.toMatch(/private-customer|customer-secret|secret\/customer|#private|open=/);
    expect(events().every((event) => (event[2] as Record<string, unknown>).page_title === 'OpenCAD | SKP 뷰어')).toBe(true);
    expect(encoded).toContain('utm_source=github');
    expect(commands().find((entry) => entry[0] === 'consent')![2]).toMatchObject({ ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
  });

  it('keeps sample success separate from real-file activation', async () => {
    localStorage.setItem('opencad.analytics-consent.v1', 'granted');
    const ga = await import('../../src/app/analytics');
    ga.initAnalytics('G-TEST123', 'skp');
    ga.beginOpen('sample', 'skp').success();
    expect(events().map((entry) => entry[1])).toContain('sample_open_success');
    expect(events().map((entry) => entry[1])).not.toContain('file_open_success');
  });

  it('supports withdrawal and does not send later CAD actions', async () => {
    const ga = await import('../../src/app/analytics');
    ga.initAnalytics('G-TEST123', 'skp');
    click('허용');
    const count = events().length;
    expect(document.getElementById('opencad-analytics-choice')).toBeNull();
    ga.showAnalyticsSettings(); click('거절 (기본 방문만)');
    ga.beginOpen('local', 'skp').success(); ga.trackExport('png');
    expect(events()).toHaveLength(count);
    expect((window as unknown as Record<string, unknown>)['ga-disable-G-TEST123']).toBe(false);
  });

  it('preserves old complete refusals without reprompting or silently enabling Google', async () => {
    localStorage.setItem('opencad.analytics-consent.v1', 'denied');
    const ga = await import('../../src/app/analytics');
    ga.initAnalytics('G-TEST123', 'skp');
    expect(commands()).toEqual([]);
    expect(document.getElementById('opencad-analytics-choice')).toBeNull();
    ga.showAnalyticsSettings(); click('수집 안 함');
    expect(commands()).toEqual([]);
    expect(document.getElementById('opencad-analytics-choice')).toBeNull();
  });

  it('remembers limited collection across app loads and sends each public SPA route once', async () => {
    localStorage.setItem('opencad.analytics-consent.v1', 'limited');
    const ga = await import('../../src/app/analytics');
    ga.initAnalytics('G-TEST123', 'portfolio');
    ga.trackPage('/research', '연구 | 목록', '연구');
    ga.trackPage('/research', '연구 | 목록', '연구');
    ga.trackPage('/opencad', 'OpenCAD | 도구 모음', 'OpenCAD 소개');
    ga.showAnalyticsSettings(); click('거절 (기본 방문만)');
    ga.showAnalyticsSettings(); click('허용');
    expect(events().map(entry => entry[1])).toEqual(['page_view', 'page_view']);
    expect(events().every(entry => (entry[2] as Record<string, string>).page_referrer === '')).toBe(true);
    expect(commands().filter(entry => entry[0] === 'config')).toHaveLength(1);
    ga.beginOpen('sample', 'skp').success();
    expect(events().at(-1)![1]).toBe('sample_open_success');
  });

  it('applies another tab’s choice without writing it back or continuing detailed collection', async () => {
    localStorage.setItem('opencad.analytics-consent.v1', 'granted');
    const listener = vi.spyOn(window, 'addEventListener');
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const ga = await import('../../src/app/analytics');
    ga.initAnalytics('G-TEST123', 'skp');
    const storage = listener.mock.calls.find(call => String(call[0]) === 'storage')![1] as unknown as (e: StorageEvent) => void;
    storage(new StorageEvent('storage', { key: 'opencad.analytics-consent.v1', newValue: 'limited' }));
    expect(write).not.toHaveBeenCalled();
    const count = events().length;
    ga.beginOpen('local', 'skp').success();
    expect(events()).toHaveLength(count);
    expect(commands().at(-1)).toEqual(['consent', 'update', { analytics_storage: 'denied' }]);
    storage(new StorageEvent('storage', { key: 'opencad.analytics-consent.v1', newValue: 'denied' }));
    expect((window as unknown as Record<string, unknown>)['ga-disable-G-TEST123']).toBe(true);
    listener.mockRestore(); write.mockRestore();
  });

  it.each(['localhost', 'preview.example.com'])('never loads GA on %s', async (host) => {
    vi.stubGlobal('location', new URL(`https://${host}/`));
    const ga = await import('../../src/app/analytics');
    ga.initAnalytics('G-TEST123', 'skp');
    expect(document.getElementById('opencad-analytics-choice')).toBeNull();
    expect(commands()).toEqual([]);
  });

  it('honors browser privacy signals without loading Google', async () => {
    localStorage.setItem('opencad.analytics-consent.v1', 'granted');
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true });
    const ga = await import('../../src/app/analytics');
    ga.initAnalytics('G-TEST123', 'skp');
    expect(commands()).toEqual([]);
  });

  it('sends one page view for each SPA route and does not invent a home visit', async () => {
    localStorage.setItem('opencad.analytics-consent.v1', 'granted');
    const ga = await import('../../src/app/analytics');
    ga.initAnalytics('G-TEST123', 'portfolio');
    expect(events()).toEqual([]);
    ga.trackPage('/opencad', 'OpenCAD | 도구 모음', 'OpenCAD 소개');
    ga.trackPage('/opencad', 'OpenCAD | 도구 모음', 'OpenCAD 소개');
    ga.trackPage('/opencad/projects/skp-viewer', 'OpenCAD 소개 | SKP 뷰어', 'OpenCAD 소개');
    expect(events().map((entry) => (entry[2] as Record<string, string>).page_location.split('?')[0])).toEqual(['https://gyutae-kim.github.io/opencad', 'https://gyutae-kim.github.io/opencad/projects/skp-viewer']);
    expect(commands().filter(entry => entry[0] === 'config')).toHaveLength(1);
    expect(events().map(entry => (entry[2] as Record<string, string>).content_group)).toEqual(['OpenCAD 소개', 'OpenCAD 소개']);
    expect((events()[1]![2] as Record<string, string>).page_referrer).toBe('https://gyutae-kim.github.io/opencad');
    const config = commands().find(entry => entry[0] === 'config')![2] as Record<string, unknown>;
    expect(config.page_title).toBeUndefined();
    const metadata = commands().filter(entry => entry[0] === 'set').at(-1)![1] as Record<string, string>;
    expect(metadata.page_title).toBe('OpenCAD 소개 | SKP 뷰어');
  });

  it.each([
    ['dwgdxf', 'OpenCAD | DWG/DXF 캐드'], ['nc', 'OpenCAD | NC 뷰어'],
    ['step', 'OpenCAD | STEP 뷰어'], ['skp', 'OpenCAD | SKP 뷰어'],
  ] as const)('uses a stable public identity for %s', async (tool, title) => {
    const ga = await import('../../src/app/analytics');
    ga.initAnalytics('G-TEST123', tool); click('허용');
    expect(events()[0]![2]).toMatchObject({ page_title: title, content_group: 'OpenCAD 앱' });
  });

  it('retains only campaign slugs and tolerates a broken tracking function', async () => {
    const ga = await import('../../src/app/analytics');
    expect(ga.campaignQuery('?utm_source=github&utm_medium=referral&utm_campaign=a%40b.com&open=secret&name=private')).toBe('?utm_source=github&utm_medium=referral');
    tagged.gtag = () => { throw new Error('blocked'); };
    localStorage.setItem('opencad.analytics-consent.v1', 'granted');
    expect(() => ga.initAnalytics('G-TEST123', 'skp')).not.toThrow();
    expect(() => ga.beginOpen('local', 'skp').success()).not.toThrow();
  });
});
