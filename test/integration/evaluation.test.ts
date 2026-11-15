import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { key } from '../fixtures.js';
const fixture = resolve('test/fixtures/evaluation');
const run = (...extra: string[]) => spawnSync(process.execPath, ['dist/cli.js', 'eval', '--snapshot', join(fixture, 'snapshot.json'), '--users', join(fixture, 'users.json'), '--compact', ...extra], { encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('WOT_'))) });

test('offline eval reads frozen JSON, emits byte-identical payloads and isolates runtime diagnostics', () => {
  const first = run(), second = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.equal(JSON.parse(first.stdout).viewers[0].feed.items.length, 3);
  assert.equal(first.stdout.trim().split('\n').length, 1);
  assert.doesNotMatch(first.stdout, /runtimeMs/);
  assert.match(first.stderr, /runtimeMs/);
  assert.match(first.stderr, /no-seeds/);
  const zap = run('--baseline', 'zap');
  assert.equal(zap.status, 0, zap.stderr);
  assert.deepEqual(JSON.parse(zap.stdout).viewers[0].baseline.items.map((item: { id: string }) => item.id), [key(1), key(2), key(3)]);
  const chrono = run('--baseline', 'chrono', '--limit', '2');
  assert.equal(chrono.status, 0, chrono.stderr);
  assert.equal(JSON.parse(chrono.stdout).viewers[0].baseline.items.length, 2);
});

test('CLI check compares committed per-viewer goldens, reports mismatches and never updates expectations', async () => {
  const checked = run('--check');
  assert.ifError(checked.error);
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stderr, /Expectations match for 2/);
  const dir = await mkdtemp(join(tmpdir(), 'wot-eval-'));
  try {
    const original = await readFile(join(fixture, 'expected', `${key(10)}.json`), 'utf8');
    const wrong = JSON.parse(original); wrong.items[0].content = 'outdated expectation';
    const path = join(dir, `${key(10)}.json`);
    const text = JSON.stringify(wrong);
    await writeFile(path, text);
    const mismatch = run('--check', '--expected', dir);
    assert.equal(mismatch.status, 1, mismatch.stderr);
    assert.ok(JSON.parse(mismatch.stdout).viewers.length);
    assert.match(mismatch.stderr, /Expectation mismatch .*\$\.items\[0\]\.content/);
    assert.match(mismatch.stderr, /missing expectation/);
    assert.equal(await readFile(path, 'utf8'), text);
    assert.equal(await readFile(join(fixture, 'expected', `${key(10)}.json`), 'utf8'), original);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('eval validates snapshot/user/configuration failures and applies snapshot, TOML, environment, flag precedence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wot-eval-config-'));
  try {
    const config = join(dir, 'wot.toml');
    await writeFile(config, 'lambda = 1\n');
    const configured = run('--config', config);
    assert.equal(configured.status, 0, configured.stderr);
    assert.equal(JSON.parse(configured.stdout).parameters.lambda, 1);
    const overridden = run('--config', config, '--lambda', '.25');
    assert.equal(overridden.status, 0, overridden.stderr);
    assert.equal(JSON.parse(overridden.stdout).parameters.lambda, .25);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('WOT_')));
    const environment = spawnSync(process.execPath, ['dist/cli.js', 'eval', '--snapshot', join(fixture, 'snapshot.json'), '--users', join(fixture, 'users.json'), '--config', config], { encoding: 'utf8', env: { ...env, WOT_LAMBDA: '.75' } });
    assert.equal(environment.status, 0, environment.stderr);
    assert.equal(JSON.parse(environment.stdout).parameters.lambda, .75);
    await writeFile(config, 'notASetting = 1\n');
    const badConfig = run('--config', config);
    assert.equal(badConfig.status, 2); assert.equal(badConfig.stdout, '');
    const badSnapshot = join(dir, 'bad.json');
    await writeFile(badSnapshot, '{}');
    assert.equal(run('--snapshot', badSnapshot).status, 2);
    assert.equal(run('--snapshot', join(dir, 'missing.json')).status, 1);
    assert.equal(run('--baseline', 'llm').status, 2);
    await writeFile(badSnapshot, '["not-a-pubkey"]');
    assert.equal(run('--users', badSnapshot).status, 2);
    assert.equal(run('--refresh').status, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
