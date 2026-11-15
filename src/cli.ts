#!/usr/bin/env node
import { runEvaluationCli } from './adapters/evaluation.js';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFeed, indexAndReadFeed, serializeFeed, parsePublicKey } from './index.js';
import { openSqliteCache } from './adapters/sqlite.js';
import { loadConfiguration, parametersHash } from './adapters/config.js';
import { createEmbeddingHook } from './application/embedding.js';
import { createEmbeddingAdapter } from './adapters/embedding.js';
import { parseReceipt, verifyIndexedEvent } from './adapters/nostr.js';
import { withRelayQuery } from './adapters/relay.js';
import { configurationFlagName, defaultConfiguration } from './application/config.js';

import { startTelemetry, traceCache, traceEmbeddingAdapter } from './adapters/tracing.js';
const telemetry = startTelemetry(process.env);
const trace = telemetry.runner;

async function main(): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  const usage = 'Usage: wot <index|feed> <npub|hex> [--config path] [--cache path] [--offline] [--json] [--compact] [--limit N]\n       wot stats|prune [--config path] [--cache path] [--cache-max-bytes N] [--compact]\n       wot eval --snapshot bundle --users users [--check --expected dir]\n';
  try {
    const options: Record<string, { type: 'string' | 'boolean'; short?: string }> = {
      snapshot: { type: 'string' }, users: { type: 'string' }, viewers: { type: 'string' }, expected: { type: 'string' }, baseline: { type: 'string' }, check: { type: 'boolean' },
      config: { type: 'string' }, cache: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    };
    for (const [key, value] of Object.entries(defaultConfiguration).filter(([key]) => key !== 'ollamaConfigured')) options[configurationFlagName(key)] = { type: typeof value === 'boolean' ? 'boolean' : 'string' };
    args = parseArgs({ allowPositionals: true, allowNegative: true, options });
  } catch (error) { process.stderr.write(`${(error as Error).message}\n`); return 2; }
  if (args.values.help) { process.stderr.write(usage); return 0; }
  const flags: Record<string, unknown> = {};
  for (const key of Object.keys(defaultConfiguration)) {
    const value = args.values[configurationFlagName(key)];
    if (value !== undefined) flags[key] = value;
  }
  if (args.values.cache !== undefined) {
    if (flags.cachePath !== undefined) { process.stderr.write('Use only one of --cache and --cache-path.\n'); return 2; }
    flags.cachePath = args.values.cache;
  }
  if (args.positionals[0] === 'eval') {
    if (args.positionals.length !== 1) { process.stderr.write(usage); return 2; }
    return runEvaluationCli(args.values, flags);
  }
  const maintenance = args.positionals[0] === 'stats' || args.positionals[0] === 'prune';
  if (maintenance ? args.positionals.length !== 1 : args.positionals.length !== 2 || !['index', 'feed'].includes(args.positionals[0])) { process.stderr.write(usage); return 2; }
  // Validate configuration before opening the database so mistakes always yield exit 2.
  const checked = await loadConfiguration({ cwd: process.cwd(), home: homedir(), xdgConfigHome: process.env.XDG_CONFIG_HOME,
    configPath: args.values.config === undefined ? undefined : String(args.values.config), environment: process.env, flags });
  if (!checked.ok) { process.stderr.write(`${checked.error.message}\n`); return 2; }
  const config = checked.value;
  if (maintenance) {
    const opened = openSqliteCache({ path: resolve(config.cachePath), readonly: args.positionals[0] === 'stats' });
    if (!opened.ok) { process.stderr.write(`${opened.error.message}\n`); return 1; }
    try {
      const result = args.positionals[0] === 'stats' ? await opened.value.statsReader.get() : await opened.value.cachePruner.prune({ maxBytes: config.cacheMaxBytes });
      if (!result.ok) { process.stderr.write(`${result.error.message}\n`); return result.error.code === 'invalid-input' ? 2 : 1; }
      process.stdout.write(JSON.stringify(result.value, null, config.compact ? undefined : 2) + '\n');
      return 0;
    } finally { opened.value.close(); }
  }
  const viewer = parsePublicKey(args.positionals[1]);
  if (!viewer.ok) { process.stderr.write(`${viewer.error.message}\n`); return 2; }
  const indexing = args.positionals[0] === 'index';
  if (indexing && config.offline) { process.stderr.write('Indexing requires network access; remove --offline.\n'); return 2; }
  const refreshing = indexing || config.refresh;
  const opened = openSqliteCache({ path: resolve(config.cachePath), fileMustExist: !refreshing });
  if (!opened.ok) { process.stderr.write(`${opened.error.message}${refreshing ? '' : ' Run wot index for this viewer or feed --refresh to create its cache.'}\n`); return 1; }
  const cache = traceCache(opened.value, trace);
  try {
    const clock = { now: () => Math.floor(Date.now() / 1000) };
    const feedPorts = { snapshotReader: cache.feedSnapshotReader, rankingReader: cache.rankingReader, parameterHasher: { hash: parametersHash }, clock };
    if (refreshing) {
      const adapter = createEmbeddingAdapter({ config, apiKey: process.env.OPENAI_API_KEY });
      if (!adapter.ok) { process.stderr.write(`${adapter.error.message}\n`); return 2; }
      const controller = new AbortController();
      const interrupt = () => controller.abort();
      process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
      const result = await withRelayQuery({ trace, signal: controller.signal }, async relayQuery => indexAndReadFeed({ viewer: viewer.value, config }, { ...feedPorts, rankingWriter: cache.rankingWriter, indexPorts: {
        trace, relayQuery, receiptParser: { parse: parseReceipt }, eventValidator: { validate: verifyIndexedEvent },
        eventWriter: cache.eventWriter, indexRecordWriter: cache.indexRecordWriter, indexedAtWriter: cache.indexedAtWriter,
        indexStateReader: cache.indexStateReader, indexCompletionWriter: cache.indexCompletionWriter,
        clock,
        progress: { report(update) {
          if (controller.signal.aborted) throw new Error('Indexing interrupted.');
          const request = update.request;
          process.stderr.write(`index ${update.phase} ${update.completed}/${update.total}${request ? ` ${request.relay} ${request.scope} ${request.status}: ${request.events} events, ${request.pages} pages${request.message ? ` (${request.message})` : ''}` : ''}\n`);
        } },
        embeddingHook: createEmbeddingHook({ ...traceEmbeddingAdapter(adapter.value, trace),
          embeddingReader: cache.embeddingReader, embeddingWriter: cache.embeddingWriter,
          progress: { report(diagnostic) { process.stderr.write(`${diagnostic.code}: ${diagnostic.message}\n`); } },
        }),
      } })).finally(() => { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); });
      if (!result.ok) { process.stderr.write(`${result.error.message}\n`); return result.error.code === 'invalid-input' ? 2 : 1; }
      for (const relay of result.value.collection.relays) process.stderr.write(`${relay.relay} ${relay.scope} ${relay.status}: ${relay.events} events, ${relay.pages} pages${relay.message ? ` (${relay.message})` : ''}\n`);
      const counts = result.value.collection;
      process.stderr.write(`Seeds ${counts.seeds.found}/${counts.seeds.referenced}; co-zappers ${counts.coZappers.selected}/${counts.coZappers.discovered}; candidate content ${counts.candidates.found}/${counts.candidates.referenced}; edges ${counts.edges.retained}${counts.edges.truncated ? ' (capped)' : ''}.\n`);
      for (const diagnostic of result.value.collection.diagnostics) process.stderr.write(`${diagnostic.code}: ${diagnostic.message}\n`);
      if (indexing) process.stdout.write(JSON.stringify(result.value.collection, null, config.compact ? undefined : 2) + '\n');
      else {
        for (const diagnostic of result.value.feed.diagnostics) process.stderr.write(`${diagnostic.code}: ${diagnostic.message}\n`);
        process.stdout.write(serializeFeed(result.value.feed, config.compact));
      }
      return 0;
    }
    const result = await readFeed({ viewer: viewer.value, config }, feedPorts);
    if (!result.ok) { process.stderr.write(`${result.error.message}\n`); return result.error.code === 'invalid-input' ? 2 : 1; }
    for (const diagnostic of result.value.diagnostics) process.stderr.write(`${diagnostic.code}: ${diagnostic.message}\n`);
    process.stdout.write(serializeFeed(result.value, config.compact));
    return 0;
  } finally { await trace.run('sqlite.close', {}, async () => cache.close()); }
}
trace.run('workflow.cli', {}, main).finally(() => telemetry.shutdown()).then(code => { process.exitCode = code; }, error => { process.stderr.write(`${(error as Error).message}\n`); process.exitCode = 1; });
