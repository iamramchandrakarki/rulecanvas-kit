import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/workbench.css';
import './styles/expr-editor.css';
import { App } from './App.js';

const rootEl = document.getElementById('root');
if (rootEl !== null) {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
