import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { canonicalParameters, resolveConfiguration, type Configuration, type ConfigurationError, type ConfigurationInput } from '../application/config.js';
import type { Result } from '../core/types.js';

export function parseConfigurationText(text: string): Result<Record<string, unknown>, ConfigurationError> {
  try { return { ok: true, value: parse(text, { unsafeKeyBehaviour: 'throw' }) }; }
  catch (error) { return { ok: false, error: { code: 'invalid-config', message: `Invalid TOML configuration: ${(error as Error).message}` } }; }
}
export function parametersHash(config: Configuration): string {
  return createHash('sha256').update(canonicalParameters(config)).digest('hex');
}
export interface LoadConfigurationInput extends Omit<ConfigurationInput, 'file'> {
  cwd: string; home: string; xdgConfigHome?: string; configPath?: string; base?: Record<string, unknown>;
}
/** Filesystem adapter. The composition root supplies environment and directory values. */
export async function loadConfiguration(input: LoadConfigurationInput): Promise<Result<Configuration, ConfigurationError>> {
  const explicit = input.configPath ?? input.environment?.WOT_CONFIG;
  if (explicit !== undefined && !explicit.trim()) return { ok: false, error: { code: 'invalid-config', message: 'config path must be nonempty.' } };
  const paths = explicit !== undefined ? [resolve(input.cwd, explicit)] : [
    join(input.cwd, 'wot.toml'),
    join(input.xdgConfigHome || join(input.home, '.config'), 'semantic-wot', 'config.toml'),
  ];
  for (const path of paths) {
    let text: string;
    try { text = await readFile(path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && explicit === undefined) continue;
      return { ok: false, error: { code: 'invalid-config', message: `Cannot read configuration ${path}: ${(error as Error).message}` } };
    }
    const file = parseConfigurationText(text);
    const result = file.ok ? resolveConfiguration({ ...input, file: { ...input.base, ...file.value } }) : file;
    if (!result.ok) return { ok: false, error: { ...result.error, message: `${path}: ${result.error.message}` } };
    return result;
  }
  return resolveConfiguration({ ...input, file: input.base });
}
