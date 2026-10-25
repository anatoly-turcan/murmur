// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { App } from '../App.tsx';
import { createStore, StoreContext } from '../store/store.ts';
import { FakeEventSource, helloFrame } from './event-source.ts';
import { todoSnapshot, present } from './fixtures.ts';

function renderApp() {
  render(
    <StoreContext.Provider value={createStore()}>
      <App />
    </StoreContext.Provider>,
  );
}

async function hello() {
  await act(async () => {
    FakeEventSource.last?.emit('hello', helloFrame(todoSnapshot()));
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
}

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
  );
  window.location.hash = '#/';
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('app shell', () => {
  test('without a dev server the Flock shows the murmur dev empty state', () => {
    renderApp();
    expect(screen.getByText('murmur dev')).toBeTruthy();
    expect(FakeEventSource.last?.url).toBe('/api/events');
  });

  test('hello fills the tree rail and the graph with collapsed groups', async () => {
    renderApp();
    await hello();
    const tree = screen.getByRole('tree');
    expect(tree.textContent).toContain('todos');
    expect(tree.textContent).toContain('audit');
    expect(screen.getByLabelText('flock graph').textContent).toContain('▸3');
    expect(screen.getByText('live')).toBeTruthy();
  });

  test('expanding a group in the tree reveals its pieces', async () => {
    renderApp();
    await hello();
    const row = present(screen.getAllByRole('treeitem').find((r) => r.textContent?.includes('todos')));
    fireEvent.click(present(row.querySelector('button')));
    expect(screen.getByRole('tree').textContent).toContain('create');
  });

  test('events screen shows the waiting empty state with an emit fixture action', async () => {
    renderApp();
    await hello();

    await act(async () => {
      window.location.hash = '#/events';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    expect(screen.getByText('Waiting for events…')).toBeTruthy();
    expect(screen.getByText('emit fixture')).toBeTruthy();
  });

  test('theme toggle sets .dark on <html> and persists murmur.theme', async () => {
    renderApp();
    const before = document.documentElement.classList.contains('dark');
    fireEvent.click(screen.getByLabelText('toggle theme'));
    expect(document.documentElement.classList.contains('dark')).toBe(!before);
    expect(localStorage.getItem('murmur.theme')).toBe(before ? 'light' : 'dark');
  });
});
