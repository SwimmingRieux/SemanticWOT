import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfiguration, parseConfigurationText, parametersHash } from '../../src/adapters/config.js';
import { resolveConfiguration } from '../../src/application/config.js';
import { openSqliteCache } from '../../src/adapters/sqlite.js';
import { key, now, snapshot } from '../fixtures.js';

test('TOML parsing rejects syntax errors and hashes resolved semantics independent of formatting', () => {
  const a = parseConfigurationText('lambda=0.5\nlimit=2\n');
  const b = parseConfigurationText('# comments do not affect rankings\nlimit = 2\nlambda = 0.50\n');
  assert.ok(a.ok); assert.ok(b.ok);
  const ar = resolveConfiguration({ file: a.value });
  const br = resolveConfiguration({ file: b.value });
  assert.ok(ar.ok); assert.ok(br.ok);
  assert.equal(parametersHash(ar.value), parametersHash(br.value));
  assert.match(parametersHash(ar.value), /^[a-f0-9]{64}$/);
  const changed = resolveConfiguration({ file: { limit: 3 } }); assert.ok(changed.ok);
  assert.notEqual(parametersHash(ar.value), parametersHash(changed.value));
  const malformed = parseConfigurationText('limit = [');
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.match(malformed.error.message, /TOML/);
});

test('CLI applies file, environment and flags before reading the feed and keeps usage errors off stdout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wot-config-cli-'));
  const cliPath = resolve('dist/cli.js');
  const env = { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: join(dir, 'xdg') };
  const run = (args: string[], extra: Record<string, string> = {}) => spawnSync(process.execPath, [cliPath, 'feed', key(10), ...args], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8' });
  try {
    const opened = openSqliteCache({ path: join(dir, 'cache.sqlite') }); assert.ok(opened.ok);
    await opened.value.eventWriter.put(snapshot().events);
    await opened.value.embeddingWriter.put(snapshot().embeddings);
    await opened.value.indexedAtWriter.put(now);
    opened.value.close();
    const path = join(dir, 'settings.toml');
    await writeFile(path, 'model = "test"\ndimensions = 2\nlimit = 1\ncachePath = "cache.sqlite"\ncompact = true\n');
    const file = run(['--config', path, '--json']);
    assert.equal(file.status, 0, file.stderr); assert.ok(file.stdout, JSON.stringify(file)); assert.equal(JSON.parse(file.stdout).items.length, 1);
    assert.equal(file.stdout.trim().split('\n').length, 1);
    const environment = run(['--config', path], { WOT_LIMIT: '2' });
    assert.equal(environment.status, 0, environment.stderr); assert.equal(JSON.parse(environment.stdout).items.length, 2);
    const flags = run(['--config', path, '--limit', '0', '--lambda', '0', '--no-compact'], { WOT_LIMIT: '2' });
    assert.equal(flags.status, 0, flags.stderr); assert.equal(JSON.parse(flags.stdout).items.length, 0);
    assert.ok(flags.stdout.trim().split('\n').length > 1);
    for (const args of [['--config', 'missing.toml'], ['--dimensions', '0'], ['--limit', '-1'], ['--alpha', '0'], ['--epsilon', '1'], ['--lambda', '1.1'], ['--seed-half-life-days', '0'], ['--refresh', '--offline']]) {
      const invalid = run(args); assert.equal(invalid.status, 2, JSON.stringify({ args, ...invalid })); assert.equal(invalid.stdout, '');
    }
    await writeFile(path, 'limit = [');
    const malformed = run(['--config', path]); assert.equal(malformed.status, 2); assert.equal(malformed.stdout, ''); assert.match(malformed.stderr, /TOML/);
    await writeFile(path, 'limti = 1');
    const unknown = run(['--config', path]); assert.equal(unknown.status, 2); assert.match(unknown.stderr, /limti/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('configuration searches project then XDG, permits missing defaults, and requires explicit paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wot-config-'));
  const cwd = join(dir, 'project'), home = join(dir, 'home'), xdgConfigHome = join(dir, 'xdg');
  try {
    await mkdir(cwd); await mkdir(join(xdgConfigHome, 'semantic-wot'), { recursive: true });
    const input = { cwd, home, xdgConfigHome };
    const missing = await loadConfiguration(input); assert.ok(missing.ok); assert.equal(missing.value.limit, 20);
    await writeFile(join(xdgConfigHome, 'semantic-wot', 'config.toml'), 'limit = 2\n');
    const xdg = await loadConfiguration(input); assert.ok(xdg.ok); assert.equal(xdg.value.limit, 2);
    await writeFile(join(cwd, 'wot.toml'), 'limit = 3\n');
    const project = await loadConfiguration(input); assert.ok(project.ok); assert.equal(project.value.limit, 3);
    await writeFile(join(cwd, 'explicit.toml'), 'limit = 4\n');
    const explicit = await loadConfiguration({ ...input, configPath: 'explicit.toml', environment: { WOT_LIMIT: '5' }, flags: { limit: '6' } });
    assert.ok(explicit.ok); assert.equal(explicit.value.limit, 6);
    const envPath = await loadConfiguration({ ...input, environment: { WOT_CONFIG: 'explicit.toml' } });
    assert.ok(envPath.ok); assert.equal(envPath.value.limit, 4);
    assert.equal((await loadConfiguration({ ...input, configPath: 'missing.toml' })).ok, false);
    await writeFile(join(cwd, 'wot.toml'), 'limit = [');
    const malformed = await loadConfiguration(input); assert.equal(malformed.ok, false);
    if (!malformed.ok) assert.match(malformed.error.message, /wot\.toml.*TOML/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
