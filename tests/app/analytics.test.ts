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
  it('does not load Google or queue events before consent, including after refusal', async () => {
    const ga = await import('../../src/app/analytics');
    ga.initAnalytics('G-TEST123', 'skp');
    ga.beginOpen('local', 'skp').success();
    expect(document.getElementById('opencad-ga4')).toBeNull();
    expect(commands()).toEqual([]);
    click('거부');
    expect(localStorage.getItem('opencad.analytics-consent.v1')).toBe('denied');
    expect(document.getElementById('opencad-ga4')).toBeNull();
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
    expect(events().every((event) => (event[2] as Record<string, unknown>).page_title === 'OpenCAD SketchUp 뷰어')).toBe(true);
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
    click('방문 통계 설정'); click('거부');
    ga.beginOpen('local', 'skp').success(); ga.trackExport('png');
    expect(events()).toHaveLength(count);
    expect((window as unknown as Record<string, unknown>)['ga-disable-G-TEST123']).toBe(true);
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
    ga.trackPage('/opencad', 'OpenCAD');
    ga.trackPage('/opencad', 'OpenCAD');
    ga.trackPage('/opencad/projects/skp-viewer', 'SKP 뷰어');
    expect(events().map((entry) => (entry[2] as Record<string, string>).page_location.split('?')[0])).toEqual(['https://gyutae-kim.github.io/opencad', 'https://gyutae-kim.github.io/opencad/projects/skp-viewer']);
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
