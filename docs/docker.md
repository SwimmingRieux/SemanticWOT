# Run locally with Docker

The app needs Docker Engine with the Compose plugin (or Docker Desktop), network
access to Nostr relays, and **one** external embedding provider. Node, SQLite build
tools and embedding models are not required on the app host for Docker startup.
The image builds its own Node/native SQLite dependencies. Ollama and OpenAI are
alternatives; the app starts neither an embedding server nor a model download.

```sh
git clone https://github.com/SwimmingRieux/SemanticWOT.git
cd SemanticWOT
```

Choose one runtime configuration below, then start the app:

```sh
docker compose up --build -d
```

Open **http://localhost:3000**, enter an `npub` or hex public key, and read the feed
when processing completes. No private key or sign-in is needed. Watch real phase
names and counts; they are not an overall percentage or ETA. A first feed collects
relay evidence and embeds notes. Startup alone makes no embedding requests.

## OpenAI

```sh
cp examples/openai.env .env
# Edit .env and replace OPENAI_API_KEY with your own key.
```

Use an API account/key with access to `text-embedding-3-small`. The defaults are
1536 dimensions and batches of up to 32 prepared text chunks. Note text is sent
to the configured OpenAI service to compute embeddings; API usage may cost money.
No Ollama install, model pull or local model is required on this path.

`WOT_ENDPOINT` must be **absent**, including from any custom config file, to select
OpenAI. Setting it to an empty string is invalid. `WOT_OPENAI_ENDPOINT` defaults
to `https://api.openai.com/v1`; it customizes the remote API base URL.

## External Ollama

Install and start Ollama separately on a machine the app container can reach.
Before requesting a feed, explicitly install the model on that machine:

```sh
ollama pull nomic-embed-text
cp examples/ollama.env .env
```

The example sets `WOT_ENDPOINT=http://host.docker.internal:11434`, selecting Ollama
with `nomic-embed-text`, 768 dimensions and batches of up to 32 text chunks.
No OpenAI key is needed. An explicitly configured Ollama endpoint takes priority;
connection or model failures never trigger a remote paid fallback. The app never
pulls models automatically. A missing model requires the separate pull step above.

Docker Desktop provides `host.docker.internal` for host services, including on
macOS/Windows. On native Linux Docker Engine, Compose maps that name to Docker's
host gateway. **This mapping does not make a native Linux loopback-only listener
reachable.** Ollama normally listens on
`127.0.0.1:11434`; configure its `OLLAMA_HOST` to an interface reachable from the
Docker bridge, using the service setup appropriate for your Ollama installation.
For example, `OLLAMA_HOST=0.0.0.0:11434 ollama serve` works for a manually managed
server, provided the port is protected by host firewall rules. For an installed
system service, set its environment through its service manager, then restart
that Ollama service yourself. Restrict access to the container/host interfaces
that need it; do not expose an unauthenticated embedding listener to the internet.
A remote Ollama machine instead needs its reachable hostname in `WOT_ENDPOINT`.
See [Docker networking](https://docs.docker.com/compose/how-tos/networking/) and
[Ollama configuration](https://docs.ollama.com/faq).

## Runtime settings and collection bounds

Compose reads `.env` into the **backend at runtime** via `env_file`. It does not
bake keys into the image or send them to the browser. Keep `.env` private. To use
another file, run `WOT_ENV_FILE=/absolute/path/settings.env docker compose up -d`.
After changing settings, recreate the app with `docker compose up -d --force-recreate`;
`restart` retains the old container environment. Host shell variables do not
replace values inside `env_file`; edit the selected file.

Both examples and the shipped web defaults use exactly `wss://nos.lol` and limits
of 20 viewer-sent seed zaps, 20 co-zappers, and 20 outgoing zaps per co-zapper:

```dotenv
WOT_RELAYS=wss://nos.lol
WOT_MAX_RELAYS=1
WOT_MAX_SEED_ZAPS=20
WOT_MAX_CO_ZAPPERS=20
WOT_MAX_ZAPS_PER_CO_ZAPPER=20
```

Raise the three caps in your runtime file for broader collection, or set
`WOT_RELAYS=wss://nos.lol,wss://your-other-relay.example` and increase
`WOT_MAX_RELAYS`. All explicitly listed bootstrap relays are retained even if
the relay budget is smaller. Caps bound new collection, not all evidence retained
in a reused cache. A short or empty result reflects available evidence under these
bounds; it is not a complete view of Nostr or a guarantee of ranking quality.

Optional overrides include `WOT_MODEL`, `WOT_DIMENSIONS`, `WOT_MODEL_VERSION`, and
`WOT_BATCH_SIZE`. Use a model/dimension pair supported by your selected provider;
changing provider/model identity invalidates incompatible cached vectors.
See [provider settings](embedding-providers.md) and
[configuration reference](configuration.md). The image includes no `wot.toml`;
`wot.example.toml` is a sanitized bounded example for CLI/library use. If mounting
a custom config, use a read-only bind mount and set `WOT_CONFIG` to its container
path. Keep `cachePath` at `/app/data/wot.sqlite` (or set
`WOT_CACHE_PATH=/app/data/wot.sqlite` in the runtime file) so both databases stay
on the persistent volume. Do not place credentials in TOML.

Use `PORT=3001 docker compose up -d` for a different host port. The app is published
on host loopback only; this is a local, single-user application without multi-user
authentication. `WOT_IMAGE` optionally changes the locally built image tag.

## Saved feeds, refresh and recovery

The named Compose `data` volume mounts `/app/data` and holds `wot.sqlite`,
`web-state.sqlite`, and SQLite WAL/SHM sidecars. The first database is reusable
collection/embedding/ranking cache; the second keeps jobs and completed feeds.
Reopening a processed public key reads its saved feed and age without silently
collecting again. Use **Refresh** for new collection; the previous completed feed
stays visible during work and survives a failed or interrupted refresh. Compatible
cached embeddings are reused. Jobs continue after closing the browser tab.

```sh
docker compose restart app  # Keeps the volume and saved feeds.
docker compose down        # Removes this project's containers; keeps the volume.
docker compose up -d       # Reuses that volume.
docker compose logs app    # Startup and actionable configuration errors.
```

A container restart interrupts active processing. Reopen the key and use the
shown retry/Refresh action; execution resumes through safe cached inputs rather
than continuing an exact processing checkpoint. Do not use `docker compose down
-v` unless you intend to delete all this app's saved feeds and cache. Back up the
whole data volume with the app stopped, including any SQLite sidecars.

If there are no usable sent note-zaps, an empty feed is expected: there is no
follow-based fallback. Sparse relays can also yield few recommendations. Check
relay connectivity/bounds before refreshing. Embedding errors need the selected
provider's endpoint/model/key/dimensions/quota checked, then a retry. For Ollama
connection errors on Linux, check its bind address as well as the gateway mapping.
Profile/image failures leave note text readable. The project does not promise a
universal first-run time or network discovery coverage.

## Optional tracing and verification

Normal startup needs no tracing backend. To opt in, add these backend settings to
your selected runtime file and recreate the app:

```dotenv
SEMANTICWOT_TRACE=1
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://host.docker.internal:4318/v1/traces
```

Supply your own reachable OTLP collector (the same host binding rules apply).
Existing phase/cache/provider tracing remains available; no captured traces or
collector are bundled into the image. See [observability](observability.md).

The controlled Docker acceptance test is separate from routine tests. Contributors
need host Node 24+, `npm ci`, Docker and Compose to run `npm run test:docker`.
It builds without Docker layer cache, exercises the actual shipped app main and
library with signed local relay fixtures plus local Ollama/OpenAI HTTP fixtures,
and checks first feed, saved revisit, refresh/cache reuse and restart persistence
for both provider paths. It uses dummy keys, no live relays, paid API, model server
or model download. It removes only its own test containers, volumes and images.
Fixtures bind a container-reachable host interface during the test. Reusable test
source is in `test/docker/`; generated data is temporary and not shipped.

Verified scope: Linux amd64 host with Docker Desktop Engine 29.6.2, Compose 5.3.1,
Node 24 image and native SQLite. Native Linux Engine and macOS/Windows host
guidance follows upstream networking documentation; those hosts were not tested. This verification establishes packaging
and workflow behavior under controlled services, not live recommendation quality
or a speed benchmark.
