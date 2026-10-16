import './styles.css';
import { initAnalytics } from './app/analytics';
import { GA4_MEASUREMENT_ID } from './app/analytics-config';
import { mountWelcome } from './app/startup';

const root = document.getElementById('app');
if (root) {
  initAnalytics(GA4_MEASUREMENT_ID, 'dwgdxf');
  mountWelcome(root, async () => (await import('./editor')).startEditor(root));
}
