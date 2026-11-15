# Cache inspection and explicit pruning

```sh
wot stats --cache ./wot.sqlite --compact
wot prune --cache ./wot.sqlite --cache-max-bytes 2000000000 --compact
```

Both commands emit JSON to stdout; errors go to stderr. They use the same validated
TOML, `WOT_*` environment and flag configuration as indexing and feeds. Maintenance
never contacts relays or an embedding server. Stats opens an existing database
read-only. Prune is an explicit writable maintenance operation; indexing and reads
never invoke it automatically.

`tables` reports each stored logical table's row count and payload `bytes`.
Payload means the UTF-8 byte lengths of the stored column values, including keys,
serialized event/vector JSON and model identities, excluding SQL NULL and the
internal `last_used` access counter. Duplicated values in separate stored columns
are counted separately. `totalBytes` sums all reported table payloads;
`immutableBytes` is the events plus embeddings subtotal. Neither quantity includes
SQLite row headers, indexes or unused pages. They describe retained data, rather
than claiming to measure file allocation.

`databaseBytes` is SQLite page count times page size, including indexes and free
pages. `allocatedBytes` is the current main database file plus any SQLite WAL and
shared-memory sidecars. For an in-memory database it equals `databaseBytes`.
Allocated storage can exceed retained payload because SQLite needs its own storage
structures. Stats does not checkpoint, vacuum or update recency.

The immutable-payload budget defaults to **2,000,000,000 bytes** (decimal 2 GB).
Configure `cacheMaxBytes`, `WOT_CACHE_MAX_BYTES` or `--cache-max-bytes`. The library
also exposes the one-method `cachePruner.prune({ maxBytes? })` capability. A library
budget of zero clears all immutable payload. CLI configuration requires a positive
byte cap; a cap of one also removes every normal event/vector record.

Prune chooses the least recently used event or embedding across both tables until
`immutableBytes` fits the cap. Every stored model variant is a separate vector
entry. Recency uses persistent monotonically increasing access counters, without
wall-clock resolution ties. Equal counters use table name, event/note ID and model
as deterministic tie breaks. Legacy records start equally old. Evicting an event
also evicts its vectors, even if those vectors were used more recently.

Prune returns before/after stats, the applied cap, event/vector eviction counts and
`invalidated`. Any eviction transaction also clears indexing metadata and discovery
audit/coverage records. Retained events and compatible vectors remain reusable,
but the cache cannot claim a complete indexed snapshot after losing inputs.
Prepared rankings and per-viewer freshness are cleared in the same eviction transaction,
so a retained ranking cannot hide an eviction. Missing inputs
become a typed cache miss, and vector compatibility is still checked by the normal
feed/embedding pipeline. After deletion commits, prune runs SQLite `VACUUM` to
reclaim free pages. This can take time and requires SQLite's usual temporary disk
space and exclusive maintenance access; a concurrent reader may cause an
operational error. No unrelated background deletion process exists.

Writable library event reads update recency for the requested retained IDs;
writable snapshot and embedding reads update all records they return. Indexing
writes, including reuse of existing immutable events and vectors, update recency.
Opening a writable cache may migrate its schema. The CLI's cache-only feed opens
an existing database writable to record use, without creating a missing cache,
changing indexing markers or persisting rankings. Matching prepared rankings can be reused;
misses are recomputed locally. Read-only library handles
do not update recency.
An explicit `feed --refresh` uses the shared indexing workflow and persists rankings there.
See [indexing and refresh](indexing.md) for scope cursors, graph versions and legacy imports.
These local usage updates require no network or model access.

The cache is disposable shared work. Explicitly index again after pruning or
deleting it to fetch source events and recompute missing vectors. Compatible
surviving data can be reused across viewers. This discards local work, not unique
application state; recovery still depends on relays retaining and serving the
source events and on availability of the configured model. No indefinite relay
retention is promised. Integration checks exercise rebuilds from frozen supplied
source events and a fake model, without claiming live relay/model availability.

The SQLite adapter exposes `feedSnapshotReader` for normal feed preparation and
reads. It returns events, embeddings, viewer freshness and graph version without
loading audit history. The existing `snapshotReader` still returns the full
snapshot including audit records. Both readers use the same snapshot transaction,
legacy/viewer freshness rules and LRU updates; read-only handles leave LRU unchanged.
The CLI uses the feed projection. Library callers can select either capability.

Reusing an identical embedding updates its access order without rewriting its
vector payload or changing graph version. A new or changed payload still invalidates
prepared rankings. A failed batch rolls back payload changes and access updates
together; newly inferred vectors retain their existing per-note durability boundary.
