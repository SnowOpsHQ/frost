import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// First of all stylesheets: every design token (specs/design-tokens.spec.ts), before any rule that reads one.
import './tokens.css';
// Right after the tokens: the bundled Geist faces (fonts.css, @font-face only; loaded only when a rule uses them).
import './fonts.css';
// Before `App`: the chrome's uncaught errors go to main from here on (kept only when `errors` is on).
import './settings-telemetry-errors';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
