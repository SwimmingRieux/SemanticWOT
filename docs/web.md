# Local web runtime

After installing dependencies, run `npm run build` and `npm run start:web`, then
open http://127.0.0.1:3000. Docker startup is documented in the release README.
The server defaults to loopback; `HOST` and `PORT` control listening. `DATA_DIR`
(default `data`) holds the reusable library cache `wot.sqlite` and durable wrapper
state `web-state.sqlite`. Existing TOML/`WOT_*` configuration applies,
including `WOT_CONFIG` and `WOT_CACHE_PATH`. Web defaults use only `wss://nos.lol`
and caps of 20 seed zaps, 20 co-zappers, and 20 outgoing zaps per co-zapper.

Use an external Ollama service by setting a nonempty `WOT_ENDPOINT`; install its
embedding model yourself (`ollama pull nomic-embed-text`). Otherwise set
`OPENAI_API_KEY` on the server for OpenAI (`text-embedding-3-small` by default).
OpenAI sends public note text to the configured service. The app never downloads
models or switches providers after errors. Credentials stay in backend composition.
`WOT_MODEL`, `WOT_DIMENSIONS`, `WOT_BATCH_SIZE`, and the provider-specific endpoints
remain configurable. An OpenAI base URL uses `WOT_OPENAI_ENDPOINT`.

Enter an npub or lowercase hex public key. No login, signing, or private key is
needed. Named progress stages show stage-scoped counts, not an overall percentage.
No usable sent note-zaps is a successful empty result; sparse relay evidence can
also yield few or no recommendations. Fatal failures explain the dependency to
check and allow retry. Tracing remains opt-in with `SEMANTICWOT_TRACE=1` and the
existing OpenTelemetry exporter configuration.

The thin wrapper lives under `src/web`. `runtime.ts` composes the public
`indexAndReadFeed` workflow, SQLite, selected embedding adapter, and managed relay
pool. `jobs.ts` owns one active job independently of HTTP request lifetimes.
`server.ts` exposes `POST /api/feed` with `{ "viewer": "npub or hex", "refresh": false }`
and `GET /api/feed?viewer=...`; `types.ts` defines the result/job envelope.
Expected status codes are 202 (accepted), 200 (saved/existing/status), 409 (busy),
and 400 (invalid input). Job failures are typed in `job.error`. Only a successful
full workflow produces a saved result. Feed item order comes directly from the
library. The browser's `cards.js` owns note presentation independently of job UI.

`npm run test:browser` checks the built app with controlled local dependencies; see
[test/browser/README.md](../test/browser/README.md) for browser setup.

A saved feed is a snapshot of the last successful full workflow, with its completion
and indexing timestamps. Opening its URL or submitting its key displays that result
without collecting again. Use **Refresh feed** to collect explicitly; the previous
feed remains readable while work runs and after any failure. A successful empty
result is also saved. Saved feeds stay readable while another key is processing.

There is one processing job per app instance, with no queue. Equivalent npub/hex
submissions reconnect to its current status; another key receives a busy response
and can retry later. Closing a tab does not cancel backend work. The viewer key in
the page URL reconnects a reopened tab, including progress it missed while away.
Restarting the app interrupts active work; revisiting shows that state and keeps
any saved output. Retry with **Refresh feed** when saved output exists, or submit
the key again on first use. A retry starts the existing library workflow and reuses
safe cached events, completed coverage and compatible embeddings.

The wrapper commits each completed result and final job status atomically in its
own SQLite database. Cache invalidation, partial writes and failed refreshes cannot
replace a saved result. `WOT_CACHE_PATH` changes the library cache location; the
wrapper state defaults to `web-state.sqlite` beside that path. Programmatic
`createWebRuntime` callers can set `statePath` separately. Startup returns a
`WebRuntimeResult` (`Result<WebRuntime, IndexError>`); check `ok` before passing
`value` to `startWebServer`. Invalid data directories and database-open failures
return `cache-failure` with safe setup guidance. Keep the entire data
directory on the Docker volume, including SQLite sidecar files. These guarantees
apply to one local app process; running multiple server processes against one
volume is not supported.

Cards enrich author identity through wrapper-only `GET /api/profiles?authors=hex,hex`
(up to 50 authors). The executable supplies the configured collection relay list;
lookup uses at most its first three relays with a bounded timeout and never gates
feed completion or changes note order. Latest signed kind-0 metadata supplies
optional display names and HTTP(S) avatars. Missing, malformed and unavailable
profiles retain abbreviated keys and letter avatars. The disposable in-memory
cache holds at most 512 authors: one hour for metadata, five minutes for missing
profiles; simultaneous requests share in-flight lookups. Programmatic
`startWebServer` callers supply `profileRelays` (or a `profileReader` capability);
without either, profiles fall back locally without network lookup.

Long posts expand in place and stay expanded through status updates. Web URLs and
NIP-19 references link out; each note has a Nostr-client continuation link. Images
are optional HTTP(S) previews, limited to four per note; unavailable images retain
the original URL and an explicit fallback link. Names and note text render as text,
never HTML. External links open separately with no opener or referrer. Remote
media loads directly in the browser and can be observed by its host; the feed text
remains readable when remote images or metadata fail.
