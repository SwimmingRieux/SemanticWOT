import { untraced, type TraceRunner } from './tracing.js';
import type { Clock, ReceiptParser } from './feed.js';
import type { EventWriter, IndexedAtWriter } from './cache.js';
import { resolveConfiguration, type Configuration } from './config.js';
import { isPublicRelayHint } from './relay-hints.js';
import { buildCoZapPairs, deriveSeeds } from '../core/graph.js';
import { compareIds, type Diagnostic, type FeedError, type NostrEvent, type Result, type Zap, type IndexRecord } from '../core/types.js';
export interface RelayFilter { kinds?: number[]; ids?: string[]; since?: number; until?: number; '#P'?: string[]; '#e'?: string[] }
export interface RelayRequest { relay: string; filter: RelayFilter; timeoutMs: number; pageSize: number; maxPages: number; maxEvents: number }
export interface RelayResponse { events: NostrEvent[]; complete: boolean; pages: number; reason?: string }
export interface IndexError { code: 'relay-failure' | FeedError['code']; message: string }
export interface RelayQuery { query(input: RelayRequest): Promise<Result<RelayResponse, IndexError>> }
export interface EventValidator { validate(event: NostrEvent): Result<boolean, Diagnostic> }
export type { IndexRecord } from '../core/types.js';
export interface IndexRecordWriter { put(records: IndexRecord[]): Promise<Result<number, FeedError>> }
export interface IndexEmbeddingHook { prepare(input: { notes: NostrEvent[]; config: Configuration }): Promise<Result<unknown, FeedError>> }
export interface Coverage { relay: string; scope: string; through: number }
export interface IndexState { events: NostrEvent[]; coverage: Coverage[] }
export interface IndexStateReader { get(): Promise<Result<IndexState, FeedError>> }
export interface IndexCompletion { viewer: string; indexedAt: number; coverage: Coverage[] }
/** Atomically commits completed scope cursors and this viewer's successful collection timestamp. */
export interface IndexCompletionWriter { put(input: IndexCompletion): Promise<Result<number, FeedError>> }
export type IndexPhase = 'seeds' | 'targets' | 'curators' | 'notes' | 'persist' | 'embeddings' | 'complete';
export interface IndexProgress { phase: IndexPhase; completed: number; total: number; request?: RelayStatus }
export interface IndexProgressReporter { report(progress: IndexProgress): void }
export interface IndexPorts { trace?: TraceRunner; indexStateReader?: IndexStateReader; indexCompletionWriter?: IndexCompletionWriter; relayQuery: RelayQuery; eventValidator: EventValidator; receiptParser: ReceiptParser; eventWriter: EventWriter; indexRecordWriter: IndexRecordWriter; indexedAtWriter: IndexedAtWriter; clock: Clock; embeddingHook?: IndexEmbeddingHook; progress?: IndexProgressReporter }
export interface IndexInput { viewer: string; config?: Partial<Configuration> }
export interface RelayStatus { relay: string; scope: string; status: 'complete' | 'incomplete' | 'failed'; events: number; pages: number; message?: string }
export interface IndexOutput { viewer: string; indexedAt: number; receipts: number; seeds: { referenced: number; found: number; missing: number }; seedDiscoveryRate: number | null; coZappers: { discovered: number; selected: number }; candidates: { referenced: number; found: number; missing: number }; edges: { retained: number; truncated: boolean }; limits: { maxCoZappers: number; maxZapsPerCoZapper: number; maxCandidates: number; maxEdges: number }; relays: RelayStatus[]; diagnostics: Diagnostic[] }
export function normalizeRelay(value: string): string {
  const url = new URL(value);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid relay URL.');
  url.hash = '';
  return url.pathname === '/' ? `${url.protocol}//${url.host}${url.search}` : url.toString();
}
/** Shared collection workflow: feed refresh must call this rather than fetch independently. */
export async function indexViewer(input: IndexInput, ports: IndexPorts): Promise<Result<IndexOutput, IndexError>> {
  const checked = resolveConfiguration({ file: input.config });
  if (!checked.ok) return { ok: false, error: { code: 'invalid-input', message: checked.error.message } };
  const config = checked.value;
  if (!/^[0-9a-f]{64}$/.test(input.viewer) || config.offline) return { ok: false, error: { code: 'invalid-input', message: 'Indexing requires a hex public key and network access; remove --offline.' } };
  const now = ports.clock.now();
  if (!Number.isSafeInteger(now) || now < 0) return { ok: false, error: { code: 'invalid-input', message: 'Clock must return nonnegative Unix seconds.' } };
  const relays = [...new Set(config.relays.map(normalizeRelay))];
  const diagnostics: Diagnostic[] = [], statuses: RelayStatus[] = [], records: IndexRecord[] = [];
  const state = ports.indexStateReader ? await ports.indexStateReader.get() : { ok: true as const, value: { events: [], coverage: [] } };
  if (!state.ok) return state;
  const priorCoverage = state.value.coverage;
  const completed: Coverage[] = [];
  const collected = new Map<string, NostrEvent>(state.value.events.map(event => [event.id, event]));
  const observations = new Map<string, IndexRecord[]>();
  const ignoredHints = new Set<string>();
  function requestFor(relay: string, scope: string, filter: RelayFilter, maxEvents: number) {
    const previous = priorCoverage.find(item => item.relay === relay && item.scope === scope);
    const historical = !filter.ids;
    filter = { ...filter, ...(historical ? { until: now, ...(previous ? { since: Math.max(0, previous.through - config.refreshOverlapSeconds) } : {}) } : {}) };
    return { relay, scope, filter, timeoutMs: config.relayTimeoutMs, pageSize: config.relayPageSize, maxPages: config.maxRelayPages, maxEvents };
  }
  function responseStatus(request: RelayRequest & { scope: string }, result: Result<RelayResponse, IndexError>): RelayStatus {
    const { relay, scope, filter, maxEvents } = request;
    if (!result.ok) return { relay, scope, status: 'failed', events: 0, pages: 0, message: result.error.message };
    const complete = result.value.complete && (Boolean(filter.ids) || result.value.events.length < maxEvents);
    return { relay, scope, status: complete ? 'complete' : 'incomplete', events: result.value.events.length, pages: result.value.pages, message: result.value.reason };
  }
  function collect(request: RelayRequest & { scope: string }, result: Result<RelayResponse, IndexError>) {
    const { relay, scope, filter } = request;
    const status = responseStatus(request, result);
    statuses.push(status);
    if (!result.ok) return false;
    const complete = status.status === 'complete';
    if (complete && !filter.ids) completed.push({ relay, scope, through: now });
    records.push({ relay, scope, observedAt: now, complete });
    for (const event of result.value.events) {
      const valid = ports.eventValidator.validate(event);
      if (!valid.ok) { diagnostics.push(valid.error); records.push({ relay, scope, observedAt: now, eventId: event.id, diagnostic: valid.error }); continue; }
      const selected = filter.ids ? filter.ids.includes(event.id) && event.kind === 1 : event.kind === 9735 &&
        (!filter['#P'] || event.tags.some(t => t[0] === 'P' && filter['#P']!.includes(t[1]))) &&
        (!filter['#e'] || event.tags.some(t => t[0] === 'e' && filter['#e']!.includes(t[1])));
      if (!selected || filter.since !== undefined && event.created_at < filter.since || filter.until !== undefined && event.created_at > filter.until) continue;
      collected.set(event.id, event);
      const observation = { relay, scope, observedAt: now, eventId: event.id };
      records.push(observation);
      const sources = observations.get(event.id) ?? []; sources.push(observation); observations.set(event.id, sources);
    }
    return true;
  }
  async function collectPhase(phase: IndexPhase, scopes: { scope: string; filter: RelayFilter; maxEvents: number }[], sources: string[]) {
    return (ports.trace ?? untraced).run(`collection.${phase}`, { 'scopes.count': scopes.length, 'relays.count': sources.length, 'requests.count': scopes.length * sources.length, 'concurrency.limit': config.relayConcurrency }, async () => {
      // Freeze hints for the phase, then consume in declared order so reply races cannot
      // change subsequent hint admission, duplicate receipt choices or audit ordering.
      const requests = scopes.flatMap(scope => sources.map(relay => requestFor(relay, scope.scope, scope.filter, scope.maxEvents)));
      const results: Result<RelayResponse, IndexError>[] = new Array(requests.length);
      let next = 0, done = 0;
      ports.progress?.report({ phase, completed: 0, total: requests.length });
      await Promise.all(Array.from({ length: Math.min(config.relayConcurrency, requests.length) }, async () => {
        while (next < requests.length) {
          const index = next++, request = requests[index];
          const result = await ports.relayQuery.query(request);
          results[index] = result;
          ports.progress?.report({ phase, completed: ++done, total: requests.length, request: responseStatus(request, result) });
        }
      }));
      return requests.map((request, index) => collect(request, results[index]));
    });
  }
  // Hints supplement bootstrap relays; never replace them or require NIP-65/NIP-57.
  function sourceRelays(): string[] {
  const hints: string[] = [];
  function addHint(value: string) {
    try {
      const hint = normalizeRelay(value);
      if (relays.includes(hint)) return;
      if (isPublicRelayHint(new URL(hint))) hints.push(hint);
      else if (!ignoredHints.has(hint)) {
        ignoredHints.add(hint);
        diagnostics.push({ code: 'ignored-relay-hint', message: `Ignored nonpublic receipt relay hint ${hint}.` });
      }
    } catch { /* malformed hint */ }
  }
  for (const event of collected.values()) {
    try {
      const request = JSON.parse(event.tags.find(t => t[0] === 'description')?.[1] ?? 'null') as NostrEvent | null;
      for (const tag of request?.tags ?? []) if (tag[0] === 'relays') for (const value of tag.slice(1)) {
        addHint(value);
      }
    } catch { /* parser records malformed request diagnostics */ }
  }
  for (const event of collected.values()) for (const tag of event.tags) if ((tag[0] === 'e' || tag[0] === 'p') && tag[2]) {
    addHint(tag[2]);
  }
  return [...new Set([...relays, ...hints.sort(compareIds)])].slice(0, Math.max(config.maxRelays, relays.length));
  }
  const outgoingScope = `outgoing:${input.viewer}`;
  const successes = await collectPhase('seeds', [{ scope: outgoingScope, filter: { kinds: [9735], '#P': [input.viewer] }, maxEvents: config.maxSeedZaps }], relays);
  if (!successes.some(Boolean)) return { ok: false, error: { code: 'relay-failure', message: 'All relays failed while collecting outgoing zaps. Check relay connectivity and retry.' } };
  const parsedEvents = new Set<string>();
  function usable(events: NostrEvent[]): Zap[] {
    const zaps: Zap[] = [], payments = new Set<string>();
    for (const event of events.sort((a, b) => compareIds(a.id, b.id))) {
    const parsed = ports.receiptParser.parse(event);
    if (!parsed.ok) { if (!parsedEvents.has(event.id)) { diagnostics.push(parsed.error); for (const record of observations.get(event.id) ?? []) records.push({ ...record, diagnostic: parsed.error }); parsedEvents.add(event.id); } continue; }
    const invoice = event.tags.find(t => t[0] === 'bolt11')?.[1].toLowerCase();
    const identity = parsed.value.paymentId ?? `${parsed.value.sender}:${parsed.value.target}:${invoice}`;
    if (payments.has(identity)) { if (!parsedEvents.has(event.id)) diagnostics.push({ code: 'duplicate-payment', eventId: event.id, message: 'Another receipt for the same invoice was retained; distinct invoices remain distinct payments.' }); parsedEvents.add(event.id); continue; }
    payments.add(identity); zaps.push(parsed.value);
    if (!parsedEvents.has(event.id)) { for (const record of observations.get(event.id) ?? []) records.push({ ...record, zap: { ...parsed.value, amountMsat: String(parsed.value.amountMsat) } }); parsedEvents.add(event.id); }
    }
    return zaps;
  }
  const newest = (a: Zap, b: Zap) => b.createdAt - a.createdAt || compareIds(a.id, b.id);
  const seedZaps = usable([...collected.values()]).filter(zap => zap.sender === input.viewer).sort(newest);
  if (seedZaps.length > config.maxSeedZaps) diagnostics.push({ code: 'seed-zap-cap', message: 'Outgoing seed receipt cap reached; newest receipts then ascending IDs retained.' });
  let zaps = seedZaps.slice(0, config.maxSeedZaps);
  const seedTargets = [...new Set(zaps.map(zap => zap.target))].sort(compareIds);
  await collectPhase('targets', seedTargets.map(target => ({ scope: `target:${target}`, filter: { kinds: [9735], '#e': [target] }, maxEvents: config.maxSeedZaps })), sourceRelays());
  const shared = usable([...collected.values()]).filter(zap => seedTargets.includes(zap.target) && zap.sender !== input.viewer);
  const spending = new Map<string, bigint>();
  for (const zap of shared) spending.set(zap.sender, (spending.get(zap.sender) ?? 0n) + zap.amountMsat);
  const curators = [...spending.keys()].sort((a, b) => spending.get(a)! === spending.get(b)! ? compareIds(a, b) : spending.get(a)! > spending.get(b)! ? -1 : 1);
  const selectedCurators = curators.slice(0, config.maxCoZappers);
  zaps.push(...shared.filter(zap => selectedCurators.includes(zap.sender)));
  if (curators.length > selectedCurators.length) diagnostics.push({ code: 'co-zapper-cap', message: `Selected ${selectedCurators.length} of ${curators.length} co-zappers by exact seed spend, then ascending public key.` });
  await collectPhase('curators', selectedCurators.map(sender => ({ scope: `outgoing:${sender}`, filter: { kinds: [9735], '#P': [sender] }, maxEvents: config.maxZapsPerCoZapper })), sourceRelays());
  for (const sender of selectedCurators) {
    const outgoingIds = new Set([...collected.values()].filter(event => event.tags.some(tag => tag[0] === 'P' && tag[1] === sender)).map(event => event.id));
    const outgoing = usable([...collected.values()].filter(event => outgoingIds.has(event.id))).filter(zap => zap.sender === sender).sort(newest);
    if (outgoing.length > config.maxZapsPerCoZapper) diagnostics.push({ code: 'co-zapper-zap-cap', message: `Outgoing receipt cap reached for ${sender}; newest receipts then ascending IDs retained.` });
    zaps.push(...outgoing.slice(0, config.maxZapsPerCoZapper));
  }
  const admitted = new Set(zaps.map(zap => zap.id));
  zaps = usable([...collected.values()].filter(event => admitted.has(event.id)));
  const weights = deriveSeeds({ viewer: input.viewer, zaps, noteIds: seedTargets, now, halfLifeDays: config.seedHalfLifeDays });
  const targets = [...new Set(zaps.map(zap => zap.target))].sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0) || compareIds(a, b)).slice(0, config.maxCandidates);
  if (new Set(zaps.map(zap => zap.target)).size > targets.length) diagnostics.push({ code: 'candidate-cap', message: `Candidate references truncated to ${config.maxCandidates}; seeds first, then ascending event ID. Missing content still consumes a slot.` });
  const batches: { scope: string; filter: RelayFilter; maxEvents: number }[] = [];
  const knownNoteIds = new Set([...collected.values()].filter(event => event.kind === 1).map(event => event.id));
  const missingTargets = targets.filter(id => !knownNoteIds.has(id));
  for (let start = 0; start < missingTargets.length; start += Math.min(config.relayPageSize, 100)) {
    const ids = missingTargets.slice(start, start + Math.min(config.relayPageSize, 100));
    batches.push({ scope: `notes:${ids.join(',')}`, filter: { ids, kinds: [1] }, maxEvents: ids.length });
  }
  await collectPhase('notes', batches, sourceRelays());
  const admittedReceipts = new Set(zaps.map(zap => zap.id));
  const events = [...collected.values()].filter(event => event.kind === 1 || admittedReceipts.has(event.id)).sort((a, b) => compareIds(a.id, b.id));
  const notes = events.filter(event => event.kind === 1 && targets.includes(event.id));
  const edges = buildCoZapPairs({ noteIds: notes.map(note => note.id), zaps, maxEdges: config.maxEdges });
  if (edges.truncated) diagnostics.push({ code: 'edge-cap', message: `Canonical co-zap pairs truncated to ${config.maxEdges}; collection limits are separate from the solver residual bound.` });
  ports.progress?.report({ phase: 'persist', completed: 0, total: events.length });
  const written = await ports.eventWriter.put(events); if (!written.ok) return written;
  const recorded = await ports.indexRecordWriter.put(records); if (!recorded.ok) return recorded;
  ports.progress?.report({ phase: 'persist', completed: events.length, total: events.length });
  if (notes.length && ports.embeddingHook) {
    const embeddingNotes = events.filter(event => event.kind === 1);
    ports.progress?.report({ phase: 'embeddings', completed: 0, total: embeddingNotes.length });
    const embedded = await (ports.trace ?? untraced).run('embedding.prepare', { 'notes.count': embeddingNotes.length }, () => ports.embeddingHook!.prepare({ notes: embeddingNotes, config })); if (!embedded.ok) return embedded;
    ports.progress?.report({ phase: 'embeddings', completed: embeddingNotes.length, total: embeddingNotes.length });
  }
  const foundSeeds = notes.filter(note => seedTargets.includes(note.id)).length;
  if (!seedTargets.length) diagnostics.push({ code: 'no-seeds', message: 'No usable outgoing note zaps were found on the queried relays; feed will be empty.' });
  if (foundSeeds < seedTargets.length) diagnostics.push({ code: 'missing-seed-notes', message: `${foundSeeds} of ${seedTargets.length} referenced seed notes found by event ID. Missing content may be absent from the queried relays or excluded by a cap.` });
  if (notes.length < targets.length) diagnostics.push({ code: 'missing-candidate-notes', message: `${targets.length - notes.length} candidate notes have no content and cannot be ranked or embedded.` });
  if (notes.length && !ports.embeddingHook) diagnostics.push({ code: 'embeddings-deferred', message: 'Note content is cached; vectors were not produced by this indexing call.' });
  if (zaps.length) diagnostics.push({ code: 'validation-policy', message: 'Signed Nostr envelopes and embedded request agreement are checked by the production validator. Invoice checksum/amount are checked; wallet authorization, invoice signature, description-hash binding and settlement authenticity remain unverified.' });
  const marked = ports.indexCompletionWriter ? await ports.indexCompletionWriter.put({ viewer: input.viewer, indexedAt: now, coverage: completed }) : await ports.indexedAtWriter.put(now); if (!marked.ok) return marked;
  ports.progress?.report({ phase: 'complete', completed: statuses.length, total: statuses.length });
  statuses.sort((a, b) => compareIds(a.relay, b.relay) || compareIds(a.scope, b.scope));
  diagnostics.sort((a, b) => compareIds(a.code, b.code) || compareIds(a.eventId ?? '', b.eventId ?? '') || compareIds(a.message, b.message));
  return { ok: true, value: { viewer: input.viewer, indexedAt: now, receipts: zaps.length, seeds: { referenced: seedTargets.length, found: foundSeeds, missing: seedTargets.length - foundSeeds }, seedDiscoveryRate: seedTargets.length ? foundSeeds / seedTargets.length : null, coZappers: { discovered: curators.length, selected: selectedCurators.length }, candidates: { referenced: targets.length, found: notes.length, missing: targets.length - notes.length }, edges: { retained: edges.pairs.length, truncated: edges.truncated }, limits: { maxCoZappers: config.maxCoZappers, maxZapsPerCoZapper: config.maxZapsPerCoZapper, maxCandidates: config.maxCandidates, maxEdges: config.maxEdges }, relays: statuses, diagnostics } };
}
