# Note embeddings and cache identity

Both external Ollama and OpenAI implement the same embedding capability. See
[provider setup](embedding-providers.md) for selection, endpoints, defaults,
credentials, model installation, and remote note-text transmission. No server or
model is bundled and errors never cause provider failover. Cached feed reads
contact neither service and require no API key.

Ollama uses `POST /api/embed` with input arrays, configured dimensions and
`truncate:false`. Before indexing, `/api/tags` resolves its installed model digest;
explicit version pins must match. OpenAI uses the embeddings endpoint, restores
response-index ordering, and validates the returned model. Its default identity
is `openai-label:<model>`, a mutable remote label, not an immutable weights digest.
A custom revision is operator-managed; advance it after remote alias changes.

## Tokenizer convention

`utf8-bytes-v1` uses each UTF-8 byte as a conservative token budget unit. Chunks
contain exact original text, with boundaries adjusted to preserve Unicode
scalars. A chunk uses at most `chunkTokens` bytes, except that a single scalar
is retained intact when the configured budget is smaller than its width.
Overlap is the longest scalar-aligned suffix using at most `chunkOverlap`
bytes, with forward progress required. Default budgets are 500 bytes, 64 bytes
of overlap and eight chunks. This deliberately underfills the model's real
BERT WordPiece token budget rather than depending on a downloaded tokenizer.
It is an explicit conservative tokenizer convention, not a claim to count
WordPiece tokens exactly.

Each note chunk is prefixed with `clustering: ` for symmetric note-to-note
similarity, as recommended by the Nomic v1.5 publisher for grouping topics and
semantic duplicates. Short notes yield one chunk; empty notes yield one chunk
whose model input is the prefix alone. Content is never replaced with invented
vectors. The Ollama nomic baseline is 2048 tokens. The byte budget plus prefix
and five special-token allowance must fit that baseline; oversized settings
fail before a model call. `truncate:false` additionally makes server context
errors visible. Other Ollama models also expose context failures through that
option. OpenAI uses the same prepared text and reports context/API failures.

## Library use and cache identity

`embedCachedNotes({notes, embeddings, config}, ports)` embeds already-cached
kind-1 notes with fake or real `Embedder`, `EmbeddingWriter` and `Progress`
capabilities. Pass the resolved model identity as `config.modelVersion`.
`createEmbeddingHook` resolves it through an injected `ModelIdentityReader`
and loads existing vectors
through an `EmbeddingReader` for the indexing workflow.

The canonical cache key includes exact content, provider, model, resolved model
version, dimensions, processing version, tokenizer convention, prefix, chunk
budget, overlap and cap. Equal content can reuse vectors across note IDs and
viewers. Endpoint and batch size affect transport, so they do not invalidate
vectors. Chunk count, dimensionality, finite components and nonzero norm are
validated before persistence and reuse. Old records without processing identity
are incompatible and require reindexing. Cached feed reads enforce the same
identity and vector checks without receiving a model or network capability.

Adapter contract tests inject HTTP responses; unit tests inject embedding and
storage ports. No routine suite requires an installed model or paid calls.
Live model quality and availability are outside these deterministic checks.

Sources: [Ollama embed API](https://docs.ollama.com/api/embed),
[Ollama nomic model](https://ollama.com/library/nomic-embed-text),
[Nomic v1.5 model card](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5).
