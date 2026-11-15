# Configuration

Configuration is data in TOML. [wot.example.toml](../wot.example.toml) is a bounded
release example with optional provider settings; copy it to `./wot.toml` or
`$XDG_CONFIG_HOME/semantic-wot/config.toml` (`~/.config/semantic-wot/config.toml`
when XDG_CONFIG_HOME is unset). The project file takes priority over the XDG file;
the files are alternatives and are not merged. Missing default files are optional.
`--config path` or `WOT_CONFIG` selects one required file, with the flag taking
priority. Relative config and cache paths resolve from the current working directory.
A malformed or unreadable selected file is a configuration error, even when a lower
priority file exists.

For each setting, precedence is CLI flag, `WOT_*` environment value, selected file,
then default. File keys use camelCase, flags use kebab-case, and environment keys use
upper snake case: `seedHalfLifeDays`, `--seed-half-life-days`, and
`WOT_SEED_HALF_LIFE_DAYS`. Every setting in the example has both overrides. Arrays
use TOML array syntax in files and comma-separated values in environment/flags.
Booleans use TOML booleans or exactly `true`/`false` in the environment. Boolean
flags accept `--compact` and `--no-compact` forms. `--cache` is an alias for
`--cache-path`; using both is an error. Unknown file keys, unknown WOT environment
keys, invalid values (including overridden invalid values), and unknown flags fail
with exit 2 and stderr feedback. Non-WOT environment variables are ignored.

```sh
node dist/cli.js feed <npub-or-hex> --config ./feed.toml --offline --compact --limit 10
WOT_LIMIT=5 WOT_LAMBDA=1 node dist/cli.js feed <npub-or-hex> --config ./feed.toml
node dist/cli.js feed <npub-or-hex> --alpha 0.2 --epsilon 0.00001 --note-half-life-days 90
```

Output is always JSON, pretty by default. `--json` makes the intent explicit;
`--compact` prints one line. Diagnostics go to stderr. Exit codes are 0 success,
1 operational failure, and 2 usage/configuration failure. `limit = 0` is valid and
requests zero items. Lambda accepts both endpoints in [0,1], alpha is in (0,1],
and epsilon is in (0,1). Half-lives and similarity power are finite and positive.
Counts, dimensions, batch size, TTLs and cache bytes are positive safe integers;
limit, overlap and refresh overlap can be zero. Chunk overlap must be smaller than
chunk size. Relay URLs must use ws/wss and the embedding endpoint http/https.
No minimum number of configured relays is imposed, so a local test relay is usable.

`offline` and `refresh` cannot both be true. Ordinary CLI feed reads use cached
vectors without network or model calls. `feed --refresh` and `index` run the shared
collection, embedding, and ranking workflow. Refresh errors are returned rather
than silently serving old CLI output. The browser separately preserves its last
completed feed during refresh and after failure. See [indexing](indexing.md).

Without a supplied Ollama `endpoint`, embedding defaults select OpenAI with
`text-embedding-3-small`, 1536 dimensions, and `https://api.openai.com/v1`.
Supply `OPENAI_API_KEY` only in backend composition/environment when work needs
embeddings; it is not a TOML setting or part of the parameter hash. An explicit
nonempty `endpoint` (or `WOT_ENDPOINT`/`--endpoint`) selects external Ollama with
`nomic-embed-text` and 768 dimensions. Omit that setting entirely for OpenAI;
blank settings fail validation. `openaiEndpoint` customizes the OpenAI base URL.
Both default to batch size 32. See [providers](embedding-providers.md) for
precedence, model installation, remote text transmission, and identity details.

Library consumers can call `resolveConfiguration({file, environment, flags})` from
`semantic-wot` with explicit input records; this pure function reads no environment
or filesystem. Pass its successful `value` as `readFeed`'s `config`. Direct
`readFeed` calls use the same validator. `loadConfiguration({cwd, home,
xdgConfigHome, configPath, environment, flags})` from `semantic-wot/config` is the
filesystem/TOML adapter, with typed failures instead of expected exceptions.

`canonicalParameters(config)` exposes a stable versioned JSON payload and
`parametersHash(config)` from `semantic-wot/config` computes its SHA-256 hash.
Canonicalization uses sorted property names and resolved typed values, so TOML
comments, whitespace, numeric spellings and input key order have no effect. It
includes all ranking and collection bounds, diversity, model/provider/version,
processing version, dimensions, endpoint, batching, chunking and cache policy.
It excludes only cache location, JSON presentation and offline/refresh execution
mode. Relay array order is preserved because bounded discovery can depend on it.
Future algorithm changes must advance the payload version or processing identity.
`modelVersion = "default"` resolves to Ollama's installed digest or OpenAI's mutable
model-label namespace. A custom OpenAI revision is operator-managed, not proof of
immutable remote weights. The workflow preserves compatible processing identity
when caching vectors; provider/model changes require compatible reindexing.

`maxRelays` defaults to **1** and accepts a positive safe integer. It limits the
combined configured and discovered relay identities used per collection phase;
explicitly configured relays are always retained, even above this limit. Override
with `WOT_MAX_RELAYS` or `--max-relays`. The library/CLI retain six bootstrap
defaults and collection caps of
10,000 seed zaps, 50 co-zappers, and 200 outgoing zaps per co-zapper. The web
executable, provider env examples, and TOML example instead use the release's
bounded 20/20/20 caps and single nos.lol bootstrap. To select only one relay, set both:

```toml
relays = ["wss://nos.lol"]
maxRelays = 1
```

Cached and new receipt hints can fill only remaining slots. Raise `maxRelays` to
20 to restore the previous discovered-relay budget.
