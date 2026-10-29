import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
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
