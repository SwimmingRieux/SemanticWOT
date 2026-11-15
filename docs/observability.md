# Optional workflow traces

Normal app and CLI startup needs no tracing backend. Set `SEMANTICWOT_TRACE=1`
to enable OpenTelemetry spans; all spans are sampled when enabled. The executable
owns SDK startup/shutdown, while library workflows accept an optional trace runner.
No captured traces or diagnostic databases are shipped.

For a host-run CLI or web app, the optional local Collector → Jaeger stack is:

```sh
docker compose -f tools/observability/compose.yaml up -d
npm run build
SEMANTICWOT_TRACE=1 node dist/cli.js feed <npub-or-hex> --config wot.example.toml --refresh
# Or: SEMANTICWOT_TRACE=1 npm run start:web
```

Open http://127.0.0.1:16686 and select service `semantic-wot`. The collector accepts
OTLP/HTTP at `http://127.0.0.1:4318/v1/traces`, the host-process default. Override
the full URL with `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`.

For the application **container**, add to its selected backend runtime env file:

```dotenv
SEMANTICWOT_TRACE=1
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://host.docker.internal:4318/v1/traces
```

Then run `docker compose up -d --force-recreate`. Docker Desktop can reach host
services through that hostname. The supplied diagnostic stack publishes its
collector on host loopback only; a native Linux bridge cannot reach a loopback
listener through the host gateway mapping. On native Linux, use your own
container-reachable collector URL, or an explicit shared Docker network with
the collector, rather than assuming host loopback is reachable. Do not expose
an unauthenticated diagnostic endpoint publicly. See [Docker setup](docker.md).

| Span | Work observed |
| --- | --- |
| `collection.seeds/targets/curators/notes` | Collection phases, request counts and scope outcomes |
| `relay.query`, `relay.page` | Logical requests, pagination and incomplete coverage |
| `relay.metadata.fetch`, `relay.metadata` | Optional NIP-11 fetches and shared metadata access |
| `relay.reserve`, `relay.connection.wait`, `relay.admission` | Socket capacity, readiness and subscription waits |
| `sqlite.*` | Cache capability calls and input/result counts |
| `embedding.prepare`, `embedding.model.resolve`, `embedding.inference` | Compatible cache preparation, selected-provider identity and inference |
| `feed.prepare` | Snapshot, graph, ranking and feed work |

Spans omit note bodies, invoices, API keys and raw exception messages. Relay URLs
have credentials, query strings and fragments removed; counts and typed outcomes
remain visible. There is no automatic HTTP instrumentation propagating headers
to external services. SDK shutdown flushes queued spans, but export failure does
not establish delivery. View a completed workflow to avoid unfinished spans.

Concurrent child durations overlap; do not sum them as elapsed time. Traces cannot
separate remote relay compute from network latency or inspect model server
internals. Completed collection does not prove complete public-relay coverage.

Jaeger uses disposable in-memory storage in this optional stack. To remove its
containers (and lose those diagnostic traces):

```sh
docker compose -f tools/observability/compose.yaml down
```
