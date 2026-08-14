import fs from 'node:fs';
import { globalConfigPath, globalDir } from './paths.js';
import type { HarnessKind } from './types.js';
import { HARNESSES } from './types.js';

export interface ArgusConfig {
  defaultPulseSec: number;
  defaultChildLimit: number;
  allowedLimits: number[];
}

export interface GlobalConfig {
  defaultHarness: HarnessKind;
  profileDir: Partial<Record<HarnessKind, string>>;
  argus: ArgusConfig;
}

const DEFAULTS: GlobalConfig = {
  defaultHarness: 'claude',
  profileDir: {},
  argus: {
    defaultPulseSec: 60,
    defaultChildLimit: 8,
    allowedLimits: [2, 4, 8, 16],
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
    argus: { ...DEFAULTS.argus, ...(file.argus ?? {}) },
    profileDir: file.profileDir ?? {},
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
