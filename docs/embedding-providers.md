# Embedding providers

The library and CLI share `createEmbeddingAdapter`. Configure an external Ollama
service or OpenAI; the application never starts a model server, pulls models, or
falls back to another provider after an error. Shared chunking, the `clustering: `
input prefix, propagation, similarity and MMR are unchanged.

With no supplied Ollama `endpoint`, OpenAI uses `text-embedding-3-small`, 1536
dimensions and `https://api.openai.com/v1`. Supply `OPENAI_API_KEY` in the backend
process environment. Note text is sent to the configured OpenAI service and API
usage can incur charges. Keys belong only in composition inputs/environment,
never TOML, ranking configuration, browser responses, persisted records or logs.

```sh
export OPENAI_API_KEY='dummy-replace-with-your-key'
wot feed <npub-or-hex> --refresh
```

An explicitly supplied nonempty `endpoint` selects Ollama, even when an OpenAI
key and `openaiEndpoint` are also configured. Its defaults are `nomic-embed-text`
and 768 dimensions. Start Ollama and install the model yourself before indexing:

```sh
ollama pull nomic-embed-text
wot feed <npub-or-hex> --refresh --endpoint http://127.0.0.1:11434
```

Flags override `WOT_` environment variables, which override TOML and defaults.
For example, `--endpoint`, `WOT_ENDPOINT` and TOML `endpoint` select Ollama;
`--openai-endpoint`, `WOT_OPENAI_ENDPOINT` and `openaiEndpoint` customize OpenAI's
base URL (include `/v1`). Omit the Ollama variable entirely for OpenAI: setting it
to an empty string is an error. Explicit invalid values in any supplied layer are
rejected, even if another layer overrides them. Endpoint URLs cannot contain user
credentials, query parameters or fragments. An explicit `provider=openai` contradicting an Ollama endpoint fails
with setup guidance. Custom providers remain available through injected ports.

Supported overrides include `model`, `dimensions`, `modelVersion`, `batchSize`,
`chunkTokens`, `chunkOverlap`, `maxChunks`, and `processingVersion`. Defaults for
model/dimensions are chosen together for the selected provider; explicit overrides
win. Set compatible model/dimension pairs. Resolved configuration carries
`ollamaConfigured` provenance so serializing and resolving it again preserves
selection; this is output metadata, not an environment variable or CLI setting.
An offline historical configuration can retain `provider=ollama` as vector
identity without a service endpoint; composing its transport requires explicitly
supplying `endpoint`.

Ollama resolves installed model digests through `/api/tags` and rejects mismatched
pins. OpenAI does not expose an immutable weights digest: default identity is a
mutable `openai-label:<model>` namespace. A nondefault `modelVersion` is an
operator-managed revision, not proof of remote weights. Bump it after changes to
a remote alias, or configure a stable model label where available. Both adapters
preserve batch ordering and validate response count, dimensions, finite values and
nonzero vectors. OpenAI uses the response indexes, checks the returned model,
and reports typed failures without echoing provider error bodies or credentials.
The transport follows the [OpenAI embeddings API](https://developers.openai.com/api/reference/resources/embeddings/methods/create).

Embedding keys include content, provider, model/version, dimensions, processing,
chunking and prefix identity. Incompatible vectors are replaced and rankings
recomputed. Cached and `--offline` reads retain compatibility checks and do not
contact either embedding provider or require API credentials. Switching providers
requires indexing compatible embeddings first.

A library caller can keep all network composition outside the workflow:

```ts
import { createEmbeddingAdapter, createEmbeddingHook, resolveConfiguration } from 'semantic-wot';

const config = resolveConfiguration({ environment: serverEnvironment });
if (!config.ok) throw new Error(config.error.message);
const adapter = createEmbeddingAdapter({ config: config.value, apiKey: serverEnvironment.OPENAI_API_KEY });
if (!adapter.ok) throw new Error(adapter.error.message);
const embeddingHook = createEmbeddingHook({
  ...adapter.value,
  embeddingReader: cache.embeddingReader,
  embeddingWriter: cache.embeddingWriter,
  progress: { report: onDiagnostic },
});
// Supply embeddingHook to the existing indexPorts of indexAndReadFeed.
```

Missing credentials fail when embeddings are needed; a no-seed result can still
succeed. An explicitly supplied blank/whitespace credential fails composition.
Network, authorization, quota, missing-model and malformed-vector failures never
trigger provider failover or model installation. Retry after correcting the
selected provider's setup. `npm test` uses injected transports; explicit
`npm run test:integration` also exercises local HTTP and CLI services with dummy
credentials, isolated SQLite data and controlled relay evidence.
