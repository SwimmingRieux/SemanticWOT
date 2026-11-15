# Frozen snapshot evaluation

Evaluate the same receipt parsing, graph, local-push, age adjustment and MMR application
pipeline used by `readFeed` and `wot feed`, without SQLite, relays or an embedding server.
The default output limit is 20; fewer eligible notes produce a shorter feed.

```sh
npm ci
npm run build
node dist/cli.js eval \
  --snapshot test/fixtures/evaluation/snapshot.json \
  --users test/fixtures/evaluation/users.json \
  --check --compact
node dist/cli.js eval \
  --snapshot test/fixtures/evaluation/snapshot.json \
  --users test/fixtures/evaluation/users.json \
  --baseline zap
```

The checked-in fixture is synthetic. It demonstrates ranking mechanics and regression
checking; it is not evidence of improved real-world feed quality. Live collection and
real-data evaluation are separate workflows.

## Inputs and reproducibility

`--snapshot` names one JSON bundle. `--users` names a JSON array of hex public keys or
npubs (`--viewers` is an alias). Viewers are normalized, deduplicated and sorted by hex
public key so input ordering does not change the report.

```json
{
  "version": 1,
  "evaluationTime": 1800000000,
  "parameters": {
    "alpha": 0.15,
    "epsilon": 0.0001,
    "maxPushesPerNode": 10000,
    "seedHalfLifeDays": 30,
    "noteHalfLifeDays": 180,
    "candidatePool": 200,
    "limit": 20,
    "lambda": 0.5,
    "maxCandidates": 5000,
    "maxEdges": 20000,
    "model": "test",
    "dimensions": 2,
    "chunkTokens": 500,
    "chunkOverlap": 64,
    "maxChunks": 8,
    "similarityPower": 4
  },
  "snapshot": {
    "indexedAt": 1800000000,
    "events": [],
    "embeddings": []
  }
}
```

All ranking fields shown above are required so changes to production ranking defaults
cannot silently change an old bundle. Events use the Nostr event shape: `id`, `pubkey`,
`created_at`, `kind`, `tags`, `content` (and optionally `sig`). Identifiers are lowercase
64-character hex. Include kind-1 notes and kind-9735 receipts with the same structural
receipt requirements as normal cached feeds. Relay copies deduplicate by event ID
through the production pipeline.

Each precomputed embedding is `{noteId, model, vectors}`, where `vectors` is an array
of chunk vectors. Include all embedding identity metadata when exporting a snapshot.
Every admitted note needs compatible vectors when the viewer has seeds. Vectors are
read as supplied and never regenerated. Missing or incompatible vectors fail with an
actionable error. Event times, indexing time and evaluation time are integer Unix
seconds. Note/receipt age is measured against `evaluationTime`, never the wall clock.

Configuration precedence is flags, `WOT_*` environment, TOML, bundle parameters, then
remaining application defaults. `--config`, ranking flags and the normal TOML search
locations work as documented in [configuration.md](configuration.md). The resolved
parameters are included in the report. To reproduce a committed expectation, keep
those layers fixed; remove unrelated `WOT_*` overrides and local TOML settings.
Evaluation never collects data, including when `--offline` is omitted. `--refresh` is
a usage error. `--limit` applies equally to the personalized and baseline feeds.

## Output and comparison

Stdout is one deterministic JSON document, pretty by default or compact with
`--compact`. It includes each viewer's complete production feed, optional baseline,
counts and collection-coverage status. Feed items preserve graph score, raw relevance
and MMR selection score. Solver output retains pushes, stopping reason, residual,
accumulated mass and normalized error bound. Candidate and edge truncation diagnostics
remain separate from solver convergence.

Stderr contains feed diagnostics and a separate `{ "runtimeMs": ... }` measurement for
the evaluation call, excluding file/config loading and expectation reads. Runtime is
never added to feed payloads or expectation data. Fixed snapshot, vectors, resolved
parameters, users and time produce byte-identical feed/report output under the same
serialization settings.

`--check` reads `<snapshot-directory>/expected/<hex-public-key>.json` by default;
`--expected <directory>` selects another directory. Each file stores the complete
production `FeedOutput` for that viewer, including diagnostics and solver results.
Checks compare JSON values, ignoring whitespace and object key order, while preserving
array order and exact numeric values. The first differing field is reported per
viewer. Missing/malformed expectations also fail. The evaluator never creates or
updates expected files. Review changed feeds, then explicitly replace the relevant
expectation files as a separate maintainer action.

Exit codes are 0 for success (including a no-seed empty feed), 1 for failed checks or
operational input/embedding failures, and 2 for malformed snapshot/users, invalid
configuration or command usage. A failed comparison still prints the evaluation
report so a reviewer can inspect the current result.

## Baselines and counts

Use `--baseline zap` or `--baseline chrono` to add one comparison feed per viewer.
Both use exactly the production-admitted kind-1 notes: viewer seeds take precedence
under the candidate cap, with event IDs deciding other admission ties. Baselines run
before the production relevance pool/MMR selection, so they do not inherit a relevance
ranking. Seed notes remain eligible, as they do in production.

- **Zap:** sum exact millisatoshis from all valid, deduplicated receipts targeting each
  admitted note, including repeat payments and viewer payments. Sort by descending
  total, then ascending event ID. Notes with zero zaps remain eligible. Expose totals
  as decimal `zapAmountMsat` strings to avoid loss of integer precision. No age decay
  or curator normalization is applied.
- **Chronological:** sort by descending note `created_at`, then ascending event ID.
  No zap or relevance weighting is applied.

Counts mean retained seed notes, distinct non-viewer senders observed zapping retained
seed notes (`coZappers`), admitted graph candidates, admitted edges, embeddings used by
the production feed, and local pushes. They describe the supplied snapshot, not what
might exist on relays. A no-seed feed does not consume embeddings or solve a graph,
so those counts are zero. Its simple baseline can still show the admitted notes.

Every viewer has `collection.status: "unavailable"`: frozen inputs do not establish
relay request completeness, discovery rate, attempted fetches or live co-zapper
selection counts. These metrics are not inferred from synthetic data or reported as
zero. Numerical error bounds concern only the fixed admitted graph.

## Library and verification

`evaluateSnapshot({viewers, snapshot, evaluationTime, config?, baseline?})` composes the
same receipt adapter as `readFeed`. It returns a typed result; it performs no external
I/O. `checkEvaluation(output, expectationsByHexPubkey)` is a pure comparison and
`serializeEvaluation(output, compact?)` appends the normal final newline. The
application seam `evaluateFrozenSnapshot` accepts an injected `ReceiptParser` when a
caller needs a different receipt adapter.

`npm test` covers deterministic evaluation, no seeds, shared baseline admission,
expectation mismatch reporting, weak bridges, repeated topics and nonconvergence.
`npm run test:integration` separately exercises frozen JSON files, committed per-viewer
goldens, CLI exit codes, configuration layers, and expectation-file immutability.
Neither command requires live infrastructure.
