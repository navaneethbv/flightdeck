import fs from 'node:fs';
import { globalConfigPath, globalDir } from './paths.js';
import type { HarnessKind } from './types.js';
import { HARNESSES } from './types.js';

export interface ArgusConfig {
  defaultPulseSec: number;
  defaultChildLimit: number;
  allowedLimits: number[];
}

/**
 * Per-model token pricing in USD per 1,000,000 tokens.
 * `cacheRead` and `cacheWrite` are optional; absent rates price cached tokens
 * at zero. Cost is only ever computed for a model present in `models`; an
 * unknown model yields a null cost, never zero.
 */
export interface ModelRates {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface GlobalConfig {
  defaultHarness: HarnessKind;
  profileDir: Partial<Record<HarnessKind, string>>;
  argus: ArgusConfig;
  models: Record<string, ModelRates>;
}

const DEFAULTS: GlobalConfig = {
  defaultHarness: 'claude',
  profileDir: {},
  argus: {
    defaultPulseSec: 60,
    defaultChildLimit: 8,
    allowedLimits: [2, 4, 8, 16],
  },
  models: {
    'claude-opus-5': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    'gpt-5-codex': { input: 1.25, output: 10, cacheRead: 0.625 },
    'gpt-5.6-sol': { input: 1.25, output: 10, cacheRead: 0.625 },
    'deepseek-v4-flash': { input: 0.27, output: 1.1 },
  },
};

let cache: GlobalConfig | null = null;

export function loadConfig(): GlobalConfig {
  if (cache) return cache;
  let file: Partial<GlobalConfig> = {};
  try {
    const raw = fs.readFileSync(globalConfigPath, 'utf8');
    file = JSON.parse(raw) as Partial<GlobalConfig>;
  } catch {
    // no config yet, use defaults
  }
  const config: GlobalConfig = {
    ...DEFAULTS,
    ...file,
    argus: { ...DEFAULTS.argus, ...file.argus },
    profileDir: file.profileDir ?? {},
    models: { ...DEFAULTS.models, ...file.models },
  };
  if (!HARNESSES.includes(config.defaultHarness)) {
    config.defaultHarness = DEFAULTS.defaultHarness;
  }
  cache = config;
  return config;
}

export function saveConfig(config: GlobalConfig): void {
  fs.mkdirSync(globalDir, { recursive: true });
  fs.writeFileSync(globalConfigPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  cache = config;
}

export function getDefaultHarness(): HarnessKind {
  return loadConfig().defaultHarness;
}

export function setDefaultHarness(harness: HarnessKind): GlobalConfig {
  const config = loadConfig();
  config.defaultHarness = harness;
  saveConfig(config);
  return config;
}

export function setProfileDir(harness: HarnessKind, dir: string): GlobalConfig {
  const config = loadConfig();
  config.profileDir[harness] = dir;
  saveConfig(config);
  return config;
}
