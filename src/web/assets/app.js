import { renderCards } from './cards.js';
const form = document.querySelector('#viewer-form'), input = document.querySelector('#viewer'), status = document.querySelector('#status');
const feed = document.querySelector('#feed'), heading = document.querySelector('#feed-heading'), refresh = document.querySelector('#refresh');
let viewer, timer, generation = 0;
const phases = { seeds: 'Finding your sent note-zaps', targets: 'Finding shared zaps', curators: 'Exploring shared curators', notes: 'Collecting note content', persist: 'Saving evidence', embeddings: 'Preparing semantic embeddings', complete: 'Preparing your feed' };
function show(message, error = false) { status.textContent = message; status.className = error ? 'notice error' : 'notice'; }
function render(state) {
  viewer = state.viewer;
  if (state.saved) {
    heading.hidden = false; renderCards(feed, state.saved.feed.items);
    document.querySelector('#feed-age').textContent = `Completed ${new Date(state.saved.completedAt * 1000).toLocaleString()}`;
    const warnings = document.querySelector('#warnings'); warnings.replaceChildren(...state.saved.warnings.map(text => { const p = document.createElement('p'); p.textContent = text; return p; }));
  }
  refresh.disabled = state.job?.status === 'running';
  if (state.disposition === 'busy') { show('Another public key is being processed. Try again when it finishes. Saved feeds remain available.'); return; }
  if (state.job?.status === 'running') {
    const p = state.job.progress;
    show(p ? `${phases[p.phase]} · ${p.completed} of ${p.total} ${['persist', 'embeddings'].includes(p.phase) ? 'notes/events' : 'relay requests'} in this stage` : 'Starting collection…');
    return true;
  }
  if (state.job?.status === 'failed') { show(`${state.job.error.message} ${state.saved ? 'Use Refresh to retry. Your saved feed is still available.' : 'Submit your key again to retry.'}`, true); return; }
  if (state.job?.status === 'interrupted') { show(`Processing was interrupted. ${state.saved ? 'Use Refresh to retry. Your saved feed is still available.' : 'Submit your key again to retry.'}`, true); return; }
  if (state.saved?.emptyReason === 'no-seeds') show('No usable sent note-zaps were found. Try a key that has zapped notes, or refresh later. Relay coverage is limited.');
  else if (state.saved?.emptyReason) show('No recommendations were found in the available evidence. Try refreshing later; relay coverage and collection caps limit discovery.');
  else if (state.saved) show('Your feed is ready. Discoveries reflect the evidence available on queried relays.');
}
async function request(method, refreshRequested = false) {
  clearTimeout(timer); const current = ++generation;
  if (method === 'POST') show('Checking your public key…');
  try {
    const response = await fetch(method === 'GET' ? `/api/feed?viewer=${encodeURIComponent(viewer)}` : '/api/feed', { method, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer, refresh: refreshRequested }) } : {}) });
    const state = await response.json(); if (current !== generation) return;
    if (state.error) { show(state.error.message, true); return; }
    if (method === 'GET' && !state.job && !state.saved && state.disposition === 'idle') { void request('POST'); return; }
    if (render(state)) timer = setTimeout(() => request('GET'), 350);
    const url = new URL(location.href); url.searchParams.set('viewer', state.viewer); history.replaceState(null, '', url);
  } catch { if (current === generation) show('Cannot reach the local server. Check that the app is running and submit your key to reconnect.', true); }
}
form.addEventListener('submit', event => { event.preventDefault(); const next = input.value.trim(); if (next !== viewer) { feed.replaceChildren(); heading.hidden = true; document.querySelector('#feed-age').textContent = ''; document.querySelector('#warnings').replaceChildren(); } viewer = next; void request('POST'); });
refresh.addEventListener('click', () => { void request('POST', true); });
const initial = new URL(location.href).searchParams.get('viewer'); if (initial) { viewer = initial; input.value = initial; void request('GET'); }
