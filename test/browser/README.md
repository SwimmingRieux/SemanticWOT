# Browser checks

Run `npm ci`, then `npm run test:browser`. The command builds the real web server
and copies browser assets into `dist`; tests exercise these shipped modules with
an isolated SQLite directory, signed Nostr events over a controlled WebSocket
relay, and real local HTTP embedding services. No live relay, model, or paid API
is required. Test data is removed on completion.

Set `CHROME_PATH=/path/to/chrome` to use an installed Chromium browser. Google
Chrome at `/opt/google/chrome/chrome` is detected automatically. Otherwise install
Playwright Chromium with `npx playwright-core install chromium` (on a new Linux
machine, `npx playwright-core install --with-deps chromium` also installs browser
system libraries), and the tests use that download. Browser downloads are outside
the source tree. Browser tests run separately from unit/integration checks.

`test/integration/helpers/web-services.ts` provides reusable controlled services
and a genuinely signed two-note/shared-zap inventory. `holdEmbeddings()`,
`embeddingStarted`, and `releaseEmbeddings()` allow lifecycle tests to observe work
at a deterministic boundary without arbitrary sleeps. Always close the app and
services in `finally`; release held work before closing.

The lifecycle suite also uses `holdRelays()`/`releaseRelays()` and `setMode()` to
control refresh completion/failure. It covers simultaneous npub/hex reconnects,
busy guidance, tab disconnect/reconnect, saved reads during another job, explicit
refresh and failed-refresh preservation. A child process imports the same built
runtime and server; killing it during a refresh verifies SQLite restart recovery,
saved-feed persistence and an explicit retry. Child processes and isolated data
are owned by the tests and torn down afterward.
