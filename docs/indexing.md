# Bounded co-zap indexing

`wot index <npub|hex>` collects outgoing kind-9735 receipts using uppercase `#P`,
then queries receipts targeting its seed notes (`#e`), selects shared curators by
their total exact millisatoshi spend on seeds, and collects their outgoing `#P`
receipts. It fetches referenced kind-1 notes by event ID and writes the shared disposable
cache. Ordinary `wot feed` reads remain cache-only. Bootstrap relays are supplemented
with receipt `e`/`p` hints and embedded request `relays` hints, bounded by
`maxRelays` (default **1**) unique relay identities per phase. All explicitly
configured bootstrap relays are retained even when their count exceeds `maxRelays`.
Hints are normalized and sorted before the remaining slots are selected, independently of reply order, and also supplement co-zapper discovery
and outgoing collection. NIP-11 limits are optional; no NIP-57 or NIP-65 advertisement is
required. Configuration controls timeouts, page size, pages and outgoing event caps.
Set a one-entry `relays` array with `maxRelays = 1` to use only that relay; hints
from both cached and newly collected receipts then receive no additional slots.

Receipt hints pass a pure URL admission policy at the application boundary before
they can consume relay slots. Explicitly configured relays bypass this policy,
including localhost and private addresses for local tests and self-hosting. Learned
hints exclude literal IPv4 loopback, private, shared-address, link-local, unspecified,
multicast, reserved, documentation and benchmark ranges. URL normalization happens
first, so short, integer, hexadecimal and octal IPv4 forms receive the same policy.
IPv6 hints admit global unicast literals excluding documentation, benchmark and
ORCHID ranges; IPv4-mapped and 6to4 literals also check their embedded IPv4 address.
Other IPv6 ranges, including loopback, unspecified, ULA, link-local and multicast,
are excluded. Single-label names and the suffixes `localhost`, `localdomain`,
`local`, `internal`, `lan` and `home.arpa` are excluded as local-use names.
Each rejected normalized URL produces one `ignored-relay-hint` diagnostic per
workflow, independent of repeated tags, receipts or collection phases. A hint
matching an explicitly configured relay is already retained and is not rejected.
This is a public hint admission convention: it performs no DNS resolution and
does not provide comprehensive SSRF or DNS-rebinding protection. Public-looking
hostnames are still admitted through the existing normalized, sorted relay cap.

`relayConcurrency` (default **8**, `WOT_RELAY_CONCURRENCY` or
`--relay-concurrency`) caps active relay queries across all scopes in an indexing
workflow. Each query performs its metadata lookup and paginated requests sequentially;
the cap covers those external operations too. Independent seed targets, selected
curators and note batches share the available slots instead of waiting for every
relay on the preceding scope. It is a positive integer and does not change the
receipt, curator, candidate or edge caps.

Relay hints are frozen at the start of each collection phase: viewer outgoing zaps,
seed targets, curator outgoing zaps, then note content. Hints learned during a phase
supplement the next phase; they do not change sibling scopes already being collected.
Replies are admitted in declared request order, independently of completion order.
This convention keeps relay admission and collection results stable when concurrency
changes or replies race. Earlier versions expanded hints between individual scopes;
a newly learned relay therefore no longer appears only on later sibling scopes.

Optional NIP-11 metadata is fetched once per relay per indexing workflow, sharing
an in-flight lookup between concurrent scopes. The observed limits remain in use
throughout that workflow even if a later metadata request would fail. A fresh
workflow creates a new metadata capability and checks the relay again.

The optional library capability `progress.report` receives phase names, completed
and total request counts, and each finished scope's status. The CLI writes these
updates immediately to stderr, starting before collection requests run; JSON remains
on stdout. A reported request completion is observational and does not publish a
history cursor or successful viewer timestamp. The workflow still publishes those
only after persistence and required embeddings succeed.

Every relay response reports complete, incomplete or failed status. Empty wire EOSE
is success; timeout, CLOSED and disconnect before EOSE are failures. A later page
failure preserves already fetched events as incomplete. Total outgoing-query failure
is an operational error. A successful empty collection creates an empty cache and
explains that the queried relays supplied no usable seeds; it makes no global claim
about the viewer's zap history. Missing note content is counted separately.

The transport adapter backs off a relay for 30 seconds after a failed WebSocket
connection attempt. Independent crawl scopes during that interval return explicit
failed statuses without repeating the connection or optional NIP-11 lookup. The next
request after expiry retries the relay. Subscription CLOSED, query deadlines and
disconnects after connection remain scope-specific failures and do not trigger this
cooldown. Other relays continue normally; skipped scopes never advance coverage.

Pagination retains an inclusive timestamp boundary and deduplicates IDs. A short page
is not treated as proof of historical completeness. When a repeated boundary makes no
progress, indexing continues below that second and records potentially missing events
in that second. Such traversal stays incomplete, including if a later page is empty.
Only accurately completed responses record complete coverage. Coverage keys pair the
normalized relay URL with `outgoing:<hex-pubkey>` or `target:<note-id>`. Each target
note has its own history scope, independent of request batch composition. An absent
cursor triggers initial discovery without `since`; subsequent completed requests use
inclusive `since = max(0, completedThrough - refreshOverlapSeconds)` (300 seconds by
default). Historical requests end at the workflow start time, so later arrivals cannot
be skipped by advancing a cursor beyond the examined interval. IDs and payment identities
are deduplicated across retries and relay copies. Failed, interrupted, page/event-capped
and unexhausted-boundary requests never advance that scope. A saturated scope can remain
in initial discovery until a request genuinely completes; freshness does not certify
complete history. Other successfully completed scopes can advance independently.

Events and audit records are saved before required embedding preparation. Only after
those stages succeed does one SQLite transaction publish completed scope cursors and
the requesting viewer's successful collection timestamp. An interrupted workflow may
leave reusable immutable work, but cannot publish new completion. Shared cached evidence
participates in incremental discovery, preserving older seeds and curator connections.
Immutable kind-1 content already retained in that shared state is reused: the note
collection phase requests only missing target IDs. Cached targets still count as
found candidates and seeds, remain available to the feed, and participate in required
embedding preparation alongside newly fetched content.
The viewer timestamp reports the latest successful workflow attempt, which can include
partial relay responses; per-request statuses remain the authority for history completeness.
Alice's timestamp never supplies Bob's collection freshness.

Production ingestion verifies the outer Nostr ID/signature and any embedded request
ID/signature, request kind, recipient agreement and parser evidence. Attribution comes
from uppercase P and/or the request pubkey, with disagreement rejected. Profile zaps,
malformed/ambiguous targets, missing sender evidence, unusable invoice prices and
request amount conflicts cannot contribute. The parser checks the invoice's Bech32
checksum and exact positive integer millisatoshis, rejecting fractional millisatoshis;
request amount never substitutes for invoice price. Historical paid receipts remain
usable after their invoice's payment window expires.

This policy **does not verify wallet authorization, invoice cryptographic signatures,
description-hash binding, or settlement authenticity**. A valid signed receipt is
relay evidence, not independently verified proof of payment. Each nonempty index
result records this limitation. Valid events, interpreted amounts (decimal strings),
validation diagnostics, source relay and request scope are retained in the cache.

Relay copies merge by event ID. Receipts for one payment hash are counted once, with
the lexicographically first receipt ID retained. If no hash is available, normalized
full invoice plus sender and target is the fallback identity. Distinct invoices with
equal amounts remain separate contributions; amounts never serve as a duplicate key.
Repeat seed payments retain their individual receipt-time/log-amount weights, while
graph contributions aggregate exact millisatoshis before shared-curator minima.

Embedding is an injected stage in the same indexing workflow. Calls without an
embedding hook report deferred vectors; cached note content alone is not a usable
semantic vector. A hook failure preserves fetched content but does not advance the
index timestamp. Frozen-vector and loopback adapter tests need no live relays or model.

Embedding preparation persists consecutive compatible cache hits in one batch,
including aliases for notes sharing cached content. It flushes that batch before
starting inference for a missing vector, then persists each newly computed note
before the next model request. A final batch flush completes cached preparation.
The existing writer still updates LRU and invalidates rankings for changed payloads;
batch failures propagate without publishing successful index completion. Completed
model work remains reusable after a later failure or interruption.

## Limits, choices and counts

The shipped web app and provider/TOML examples use bounded **20/20/20** caps
and only `wss://nos.lol`. The larger library defaults below apply when no release
example or web defaults are supplied. Caps bound new collection, not all retained
cache evidence.

The library/CLI default crawl selects **50 co-zappers**, retains **200 outgoing payments per
co-zapper**, admits **5,000 candidate note references** (including seeds), and builds
at most **20,000 canonical undirected pairs**. These are `maxCoZappers`,
`maxZapsPerCoZapper`, `maxCandidates` and `maxEdges` in TOML, environment and flags.
Co-zapper spend ties use ascending public key. Receipt caps retain newest receipt
time, then ascending receipt ID, after deduplicating relay copies and payment identity.
Seed-target receipts establishing a selected curator's connection are kept separately
from the outgoing cap so that older seed anchors cannot disappear behind recent zaps.
The union is deduplicated before graph construction. Distinct repeat payments add exact
millisatoshis before each pair's shared-curator minimum; there is no curator normalization
or whale-resistance claim.

The seed outgoing request and each seed-target batch use `maxSeedZaps` (10,000 by
default) per relay; outgoing curator requests use `maxZapsPerCoZapper` per relay,
then the same cap is applied to their merged unique payments. Receipt/page caps and
unexhausted timestamp buckets remain incomplete scopes, even if the count happens to
equal the limit. A single short page never certifies history completeness. Curator
selection uses the evidence actually collected and cannot claim global top curators.

Candidate references prioritize seed weight (the same time-decayed seed rule as the
feed), then ascending event ID. Missing content consumes its reference slot and is
reported, with no invented text or vectors and no replacement beyond the cap. Pairs
are admitted in ascending curator-key and ascending note-pair order; existing admitted
pairs still receive all retained curator contributions when the pair cap is exhausted.
The feed computes their semantic similarities and the adopted gated walk unchanged.

Index JSON exposes seed references/found/missing, `seedDiscoveryRate` (found/referenced,
or null without seeds), discovered/selected co-zappers, candidate references/found/missing,
retained edges and edge truncation, the four limits, and per-relay scope/event/page
counts with complete/incomplete/failed statuses. Diagnostics distinguish absent content,
request truncation and crawl caps from numerical walk residuals. CLI stderr also names
each request scope and prints the crawl counts. The index counts describe this crawl;
the cached feed can also use shared evidence retained by earlier viewer crawls, subject
to its own candidate and edge limits. Selected usable receipt evidence, notes and their
provenance persist in the shared cache; rejected and excluded observations remain in
the audit records. Undirected pairs are rebuilt deterministically from that evidence.

## Feed refresh and ranking ownership

`wot feed <pubkey> --refresh` and `wot index <pubkey>` both invoke `runIndexWorkflow`
(public composition: `indexAndReadFeed`). That workflow collects through `indexViewer`,
prepares required embeddings, ranks and persists a reusable ranking preparation. Index
prints its collection report; feed refresh prints the ranked feed. Refresh failures are
returned rather than silently falling back to an older feed. Plain feed and `--offline`
only read local inputs; `--offline --refresh` is a usage error. Missing viewer data asks
the caller to index that viewer or refresh explicitly. Shared evidence can be reused,
but never fabricates another viewer's successful collection timestamp.

The library's one-method `indexStateReader` reads retained events and scope cursors;
`indexCompletionWriter` atomically writes completion and viewer freshness. The old
`indexedAtWriter(number)` remains an explicit legacy frozen-snapshot import convention,
without any coverage inference. The first real viewer completion removes that global
legacy marker; production commands always use per-viewer completion. Legacy snapshots
should be reindexed to establish scoped coverage.

Prepared rankings are keyed by viewer, parameter hash and graph version. The CLI uses
SHA-256 over the resolved, versioned canonical configuration; injected callers can supply
`parameterHasher` (the library default uses the collision-free canonical string itself).
All behavioral parameters and embedding identities participate. A second preparation
identity excludes lambda and output limit: changing either reruns MMR against the same
prepared candidates, compatible vectors and walk scores. Only the indexing workflow
writes persistent rankings. Cache-only reads reuse a matching preparation or recompute
locally, leaving persistent rankings untouched. The ranking's `generatedAt` is the actual
preparation time. Default ranking TTL is 300 seconds; expired or future-dated preparations
are recomputed so time-decayed relevance is refreshed even without new events.

SQLite advances `graphVersion` and clears prepared rankings when a new immutable event
or a changed embedding payload/identity is committed. Reusing identical events/vectors
updates LRU only. Configuration changes select a different parameter identity, while
incompatible required vectors fail actionably until the indexing workflow prepares them.
Pruning clears viewer freshness, coverage and rankings together. Cached feed diagnostics
include `stale-cache` with the actual age in seconds once viewer collection exceeds its
300-second default TTL; the CLI emits this diagnostic on stderr. Collection age and
ranking preparation age remain distinct.
