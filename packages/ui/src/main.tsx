import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import { createStore, StoreContext } from './store/store.ts';
import { applyTheme, initialTheme } from './theme/useTheme.ts';

applyTheme(initialTheme());
const store = createStore();
const root = document.getElementById('root');

if (root) {
  createRoot(root).render(
    <StrictMode>
      <StoreContext.Provider value={store}>
        <App />
      </StoreContext.Provider>
    </StrictMode>,
  );
}
