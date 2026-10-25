# @murmur/ui

The dev web UI: a live view over `GET /api/snapshot` + the `GET /api/events` SSE stream of `murmur dev` (dev protocol
§6.3, types from `@murmur/dev-protocol`). React 19, Tailwind 4, Vite 8. The only package with a build step; it publishes
`dist/` and the dev server serves `dist/index.html` at `/` (asset urls are relative, `base: './'`).

```
pnpm --filter @murmur/ui dev      # vite on :5173, proxies /api to http://127.0.0.1:4242 (run `murmur dev` too)
pnpm build:ui                     # dist/
pnpm test:ui                      # vitest: reducer, filters, tree, layout, waterfall, stream, build, app shell, contract-kind labels
```

Layout: `src/store` (SSE stream, reducer + 20k ring with indexes, filter mini-language, tree builder, selectors),
`src/graph` (pure layered layout, edges, pulse limiter), `src/components`, `src/screens/{Flock,Events,Traces,Piece,Group,Catalog}`,
`src/chrome` (top bar, bottom strip, palette items, shortcut sheet), `src/keys`, `src/theme`.

## Manual checklist (run against `examples/todo-api`)

Start `pnpm example` (or `murmur dev` in `examples/todo-api`) and open the printed URL. Tick each line.

- [ ] Tree navigation: the left rail shows the folder tree under `pieces/`; `j`/`k` move, `h`/`l` collapse/expand,
      `Enter` opens; the filter box narrows rows; selecting a group sets `?scope=` and opens the group page; the
      breadcrumb mirrors the path and each segment is clickable.
- [ ] Group expand: on Flock, groups start collapsed with a child-count badge; clicking the badge (or `l` on a
      selected node) expands in place and shows internal contracts as dashed edges; the state survives a reload.
- [ ] Flock: ingress diamonds on the left with the edge pieces (`api/*`) in the column next to them, guard calls
      dashed from the diamond to `auth`, edges labelled with a kind badge and class name (`Q GetTodo`), dead-letter sink on the right; `curl -XPOST localhost:3000/todos -d …`
      makes dots travel the edges; drag a node and reload — it stays; `0` resets, `f` fits; clicking an edge opens
      Events filtered by that contract; a failing delivery turns the node and its edges red for 10 s.
- [ ] Events: rows stream in; the filter `piece:todos/* failed:` narrows them; `freeze` stops the list and shows an
      "N new" pill; clicking a row expands the payload and headers; `t` opens its trace.
- [ ] Traces: the list groups by root contract; a trace shows the waterfall indented by group depth with causation
      guide lines, retries as thin bars with dotted backoff gaps, the request/reply bracket and failures in red; an
      HTTP trace starts at an `ingress` root with the guard requests first, an anonymous `GET /todos/t1` shows
      `rejected 401` on `auth.Authenticate`; a deduplicated query shows `×N` with a dashed link from its caller; an
      SSE emit outside a request is a `background` root;
      `←`/`→` collapse/expand, `l` interleaves logs; pasting an id prefix opens it.
- [ ] Piece page: Overview renders `context.md` and the class name with its kind (`domain`/`edge`/`mixed`),
      Contracts shows kind badges, fields / JSON Schema toggle / fixture with "emit", Serves lists `api/rest`'s
      routes with effective guards (`GET /stats` → `RateLimit` only), Deliveries lists failures first, Logs, Files,
      Context shows token meter with warn/fail caps, budget slider and "copy for agent"; `1–7` switch tabs.
- [ ] Catalog: contracts with kind badges (`Q`/`C`/`E`/`G`) and class names (wire name on hover), ROUTES per token,
      pieces as an indented tree with summaries, capabilities, warnings with "why it matters", mermaid export copies.
- [ ] Palette: `⌘K` or `/` finds pieces, contracts, capabilities, recent traces, screens and actions; `?` shows the sheet.
- [ ] Empty states: with no dev server the Flock says "Dev server not reachable — `murmur dev`"; an empty app says
      "No pieces yet — `murmur new piece <path>`"; an empty buffer says "Waiting for events…" with "emit fixture".
- [ ] Reconnect: stop `murmur dev` — the dot turns amber; restart it — the dot goes green and, if the buffer evicted
      events meanwhile, the strip says "N events missed (buffer evicted)". Touch a piece file — toast with the file,
      graph dims, then returns; break `piece.ts` — the strip turns red with the boot report and the graph stays at 40 %.
- [ ] Dark mode: follows the system on first load; the theme button toggles and persists (`localStorage['murmur.theme']`).
