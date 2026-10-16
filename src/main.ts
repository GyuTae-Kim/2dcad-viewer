import './styles.css';
import { mountWelcome } from './app/startup';

const root = document.getElementById('app');
if (root) mountWelcome(root, async () => (await import('./editor')).startEditor(root));
