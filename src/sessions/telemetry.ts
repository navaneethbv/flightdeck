import { getDb, now } from '../core/state.js';
import { loadConfig, type ModelRates } from '../core/config.js';
import { normalizeProjectRoot } from '../core/paths.js';
import type { DatabaseSync } from 'node:sqlite';

/**
 * One row of `session_telemetry`. Any field the harness does not report is
 * null, never a default or an average (spec "Prohibited: fabricated data").
 * `progress` is only non-null when Argus owns the session and has recorded a
 * completion pulse for it.
 */
export interface SessionTelemetry {
  sessionId: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  costUsd: number | null;
  turns: number | null;
  progress: number | null;
  updatedAt: number;
}

/**
 * What one parsed line of harness output contributes. `inputTokens` and
 * friends are token counts from a single event (a claude result event is
 * cumulative, a codex turn or opencode step is per-event) and are summed by
 * the collector.
 */
export interface TelemetryExtraction {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  turns?: number;
}

const COST_PER_1M = 1_000_000;

/**
 * Cost in USD for a token split under the config rate table. A null model or
 * a model with no entry yields null, never zero.
 */
export function computeCost(
  model: string | null | undefined,
  counts: { input: number; output: number; cacheRead: number; cacheWrite: number },
  models: Record<string, ModelRates> = loadConfig().models
): number | null {
  if (!model) return null;
  const rate = models[model];
  if (!rate) return null;
  const usd =
    (counts.input * rate.input +
      counts.output * rate.output +
      counts.cacheRead * (rate.cacheRead ?? 0) +
      counts.cacheWrite * (rate.cacheWrite ?? 0)) /
    COST_PER_1M;
  return usd;
}

function firstKey(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) return undefined;
  return Object.keys(record)[0];
}

function tryParseJson(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- extraction

/**
 * Claude Code `-p --output-format stream-json --verbose` emits JSONL. The
 * closing `result` event carries the final usage, model (via `modelUsage`),
 * and turn count. No other event type is useful for telemetry.
 */
export function parseClaudeLine(line: string): TelemetryExtraction | null {
  const event = tryParseJson(line);
  if (!event || event.type !== 'result') return null;
  const usage = (event.usage ?? {}) as Record<string, unknown>;
  if (typeof usage.input_tokens !== 'number') return null;
  return {
    model: firstKey(event.modelUsage as Record<string, unknown>),
    inputTokens: usage.input_tokens as number,
    outputTokens: usage.output_tokens as number,
    cacheReadTokens: usage.cache_read_input_tokens as number | undefined,
    cacheWriteTokens: usage.cache_creation_input_tokens as number | undefined,
    turns: typeof event.num_turns === 'number' ? (event.num_turns as number) : undefined,
  };
}

/**
 * Codex `exec --json` streams JSONL. A `turn.completed` event carries the
 * split usage for that turn. Codex never reports the model in the event
 * stream, so `model` stays null.
 */
export function parseCodexLine(line: string): TelemetryExtraction | null {
  const event = tryParseJson(line);
  if (!event || event.type !== 'turn.completed') return null;
  const usage = (event.usage ?? {}) as Record<string, unknown>;
  if (typeof usage.input_tokens !== 'number') return null;
  const cacheWrite = typeof usage.cache_write_input_tokens === 'number' ? (usage.cache_write_input_tokens as number) : 0;
  return {
    inputTokens: usage.input_tokens as number,
    outputTokens: usage.output_tokens as number,
    cacheReadTokens: usage.cached_input_tokens as number | undefined,
    cacheWriteTokens: cacheWrite > 0 ? cacheWrite : undefined,
    turns: 1,
  };
}

/**
 * OpenCode `run --format json --print-logs` emits usage in `step_finish`
 * events on stdout and the model id on stderr INFO lines shaped like
 * `message=stream providerID=... modelID=...`. A single line only ever yields
 * one side, so the collector sees model and usage arrive separately.
 */
export function parseOpencodeLine(line: string): TelemetryExtraction | null {
  const modelMatch = /modelID=([A-Za-z0-9._/-]+)/.exec(line);
  if (modelMatch) {
    return { model: modelMatch[1] };
  }
  const event = tryParseJson(line);
  if (!event || event.type !== 'step_finish') return null;
  const part = (event.part ?? {}) as Record<string, unknown>;
  const tokens = (part.tokens ?? {}) as Record<string, unknown>;
  if (typeof tokens.input !== 'number') return null;
  const cache = (tokens.cache ?? {}) as Record<string, unknown>;
  return {
    inputTokens: tokens.input as number,
    outputTokens: tokens.output as number,
    cacheReadTokens: typeof cache.read === 'number' ? (cache.read as number) : undefined,
    cacheWriteTokens: typeof cache.write === 'number' && (cache.write as number) > 0 ? (cache.write as number) : undefined,
    turns: 1,
  };
}

/**
 * Gemini `run` output has no documented model or usage reporting, so its
 * adapter declares a parser that always reports nothing. A legitimate null.
 */
export function parseGeminiLine(_line: string): TelemetryExtraction | null {
  return null;
}

// ------------------------------------------------------------- log rendering

/**
 * The session log must stay human-readable (spec line 165: follow is
 * spectator mode). Each render function turns one line of structured output
 * into readable text and returns null for noise that should not reach the log
 * at all.
 */

/** Claude `stream-json`: render assistant text, drop hook/status noise. */
export function renderClaudeLine(line: string, stream: 'stdout' | 'stderr'): string | null {
  if (stream !== 'stdout') return null;
  const event = tryParseJson(line);
  if (!event || event.type !== 'assistant') return null;
  const content = (event.message as { content?: unknown } | undefined)?.content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((c): c is { type: string; text: string } => typeof c === 'object' && c !== null && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text);
    return texts.length > 0 ? texts.join('\n') : null;
  }
  if (typeof content === 'string') return content;
  return null;
}

/** Codex `--json`: render agent messages, drop everything else. */
export function renderCodexLine(line: string, stream: 'stdout' | 'stderr'): string | null {
  if (stream !== 'stdout') return null;
  const event = tryParseJson(line);
  if (!event || event.type !== 'item.completed') return null;
  const item = (event.item ?? {}) as Record<string, unknown>;
  if (item.type !== 'agent_message' || typeof item.text !== 'string') return null;
  return item.text;
}

/** OpenCode `--format json`: render `text` events, drop tool/step noise. */
export function renderOpencodeLine(line: string, stream: 'stdout' | 'stderr'): string | null {
  if (stream !== 'stdout') return null;
  const event = tryParseJson(line);
  if (!event || event.type !== 'text') return null;
  const part = (event.part ?? {}) as Record<string, unknown>;
  return typeof part.text === 'string' ? part.text : null;
}

/** Gemini: plain text output already; pass it through untouched. */
export function renderGeminiLine(line: string, _stream: 'stdout' | 'stderr'): string | null {
  return line;
}

export function isUsefulExtraction(extraction: TelemetryExtraction | null): extraction is TelemetryExtraction {
  if (!extraction) return false;
  return (
    extraction.model !== undefined ||
    extraction.inputTokens !== undefined ||
    extraction.outputTokens !== undefined ||
    extraction.cacheReadTokens !== undefined ||
    extraction.cacheWriteTokens !== undefined ||
    extraction.turns !== undefined
  );
}

// ------------------------------------------------------------------ store

function rowToTelemetry(row: Record<string, unknown>): SessionTelemetry {
  return {
    sessionId: String(row.session_id),
    model: row.model === null ? null : String(row.model),
    inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
    cachedTokens: row.cached_tokens === null ? null : Number(row.cached_tokens),
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    turns: row.turns === null ? null : Number(row.turns),
    progress: row.progress === null ? null : Number(row.progress),
    updatedAt: Number(row.updated_at),
  };
}

const ARGUS_PROGRESS_TABLE = 't_argus_progress';

export class TelemetryStore {
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = normalizeProjectRoot(projectRoot);
  }

  /**
   * Progress is 100 only when Argus owns the session (argus_parent set) and
   * has written a `child_completed` row for it. Every other session is null.
   * A spawned-but-not-completed child is null too: mapping it to a number
   * would assert a completion estimate Argus never computed.
   */
  private computeProgress(db: DatabaseSync, sessionId: string): number | null {
    const session = db
      .prepare('SELECT argus_parent FROM sessions WHERE id = ?')
      .get(sessionId) as { argus_parent: string | null } | undefined;
    if (!session?.argus_parent) return null;
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(ARGUS_PROGRESS_TABLE);
    if (!exists) return null;
    const rows = db
      .prepare(`SELECT event FROM "${ARGUS_PROGRESS_TABLE}" WHERE session_id = ? AND event = 'child_completed'`)
      .all(sessionId) as { event: string }[];
    return rows.length > 0 ? 100 : null;
  }

  upsert(sessionId: string, fields: Omit<Partial<SessionTelemetry>, 'sessionId' | 'updatedAt' | 'progress'>): void {
    const db = getDb(this.projectRoot);
    const existing = this.get(sessionId);
    const progress = this.computeProgress(db, sessionId);
    const merged = {
      model: fields.model !== undefined ? fields.model : existing?.model ?? null,
      inputTokens: fields.inputTokens !== undefined ? fields.inputTokens : existing?.inputTokens ?? null,
      outputTokens: fields.outputTokens !== undefined ? fields.outputTokens : existing?.outputTokens ?? null,
      cachedTokens: fields.cachedTokens !== undefined ? fields.cachedTokens : existing?.cachedTokens ?? null,
      costUsd: fields.costUsd !== undefined ? fields.costUsd : existing?.costUsd ?? null,
      turns: fields.turns !== undefined ? fields.turns : existing?.turns ?? null,
      updatedAt: now(),
    };
    db.prepare(
      `INSERT INTO session_telemetry (session_id, model, input_tokens, output_tokens, cached_tokens, cost_usd, turns, progress, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         model = excluded.model,
         input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens,
         cached_tokens = excluded.cached_tokens,
         cost_usd = excluded.cost_usd,
         turns = excluded.turns,
         progress = excluded.progress,
         updated_at = excluded.updated_at`
    ).run(
      sessionId,
      merged.model,
      merged.inputTokens,
      merged.outputTokens,
      merged.cachedTokens,
      merged.costUsd,
      merged.turns,
      progress,
      merged.updatedAt
    );
  }

  get(sessionId: string): SessionTelemetry | null {
    const db = getDb(this.projectRoot);
    const row = db.prepare('SELECT * FROM session_telemetry WHERE session_id = ?').get(sessionId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const telemetry = rowToTelemetry(row);
    telemetry.progress = this.computeProgress(db, telemetry.sessionId);
    return telemetry;
  }

  list(): SessionTelemetry[] {
    const db = getDb(this.projectRoot);
    const rows = db.prepare('SELECT * FROM session_telemetry ORDER BY updated_at DESC').all() as Record<string, unknown>[];
    return rows.map((row) => {
      const telemetry = rowToTelemetry(row);
      telemetry.progress = this.computeProgress(db, telemetry.sessionId);
      return telemetry;
    });
  }
}

// ------------------------------------------------------------- collector

export interface TelemetryAccumulator {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
}

export interface TelemetryLineHandlers {
  parseLine: (line: string) => TelemetryExtraction | null;
  renderLine: (line: string, stream: 'stdout' | 'stderr') => string | null;
}

/**
 * Feeds output chunks from a live harness into per-line parsing, accumulates
 * the extracted fields, and persists to `session_telemetry` when they change.
 * It also renders readable log text so the session log never receives raw
 * JSONL or stderr debug noise.
 */
export class TelemetryCollector {
  private readonly store: TelemetryStore;
  private readonly parseLine: (line: string) => TelemetryExtraction | null;
  private readonly renderLine: (line: string, stream: 'stdout' | 'stderr') => string | null;
  private outBuffer = '';
  private errBuffer = '';
  private readonly acc: TelemetryAccumulator = {
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    turns: 0,
  };
  private lastPersisted = '';

  constructor(projectRoot: string, private readonly sessionId: string, handlers: TelemetryLineHandlers) {
    this.store = new TelemetryStore(projectRoot);
    this.parseLine = handlers.parseLine;
    this.renderLine = handlers.renderLine;
  }

  /**
   * Feed one raw output chunk. Returns the readable text that should be
   * appended to the session log for this chunk (empty when the adapter
   * suppresses it).
   */
  feed(chunk: string, stream: 'stdout' | 'stderr'): string {
    const buffer = stream === 'stdout' ? this.outBuffer : this.errBuffer;
    const parts = (buffer + chunk).split('\n');
    const leftover = parts.pop() ?? '';
    if (stream === 'stdout') this.outBuffer = leftover;
    else this.errBuffer = leftover;

    let rendered = '';
    let changed = false;
    for (const raw of parts) {
      const extraction = this.parseLine(raw);
      if (isUsefulExtraction(extraction)) {
        this.merge(extraction);
        changed = true;
      }
      const text = this.renderLine(raw, stream);
      if (text) rendered += text + '\n';
    }
    if (changed) this.persist();
    return rendered;
  }

  /**
   * Process any partial lines left over at end of stream. Returns the
   * rendered text for them, mirroring `feed`.
   */
  flush(): string {
    let rendered = '';
    let changed = false;
    for (const [buffer, stream] of [
      [this.outBuffer, 'stdout'],
      [this.errBuffer, 'stderr'],
    ] as const) {
      if (!buffer) continue;
      const extraction = this.parseLine(buffer);
      if (isUsefulExtraction(extraction)) {
        this.merge(extraction);
        changed = true;
      }
      const text = this.renderLine(buffer, stream);
      if (text) rendered += text + '\n';
    }
    this.outBuffer = '';
    this.errBuffer = '';
    if (changed) this.persist();
    return rendered;
  }

  private merge(extraction: TelemetryExtraction): void {
    if (extraction.model) this.acc.model = extraction.model;
    if (extraction.inputTokens !== undefined) this.acc.inputTokens += extraction.inputTokens;
    if (extraction.outputTokens !== undefined) this.acc.outputTokens += extraction.outputTokens;
    if (extraction.cacheReadTokens !== undefined) this.acc.cacheReadTokens += extraction.cacheReadTokens;
    if (extraction.cacheWriteTokens !== undefined) this.acc.cacheWriteTokens += extraction.cacheWriteTokens;
    if (extraction.turns !== undefined) this.acc.turns += extraction.turns;
  }

  private persist(): void {
    const snapshot = JSON.stringify(this.acc);
    if (snapshot === this.lastPersisted) return;
    this.lastPersisted = snapshot;
    const hasTokens =
      this.acc.inputTokens > 0 || this.acc.outputTokens > 0 || this.acc.cacheReadTokens > 0 || this.acc.cacheWriteTokens > 0;
    const costUsd = hasTokens
      ? computeCost(this.acc.model, {
          input: this.acc.inputTokens,
          output: this.acc.outputTokens,
          cacheRead: this.acc.cacheReadTokens,
          cacheWrite: this.acc.cacheWriteTokens,
        })
      : null;
    this.store.upsert(this.sessionId, {
      model: this.acc.model,
      inputTokens: hasTokens ? this.acc.inputTokens : null,
      outputTokens: hasTokens ? this.acc.outputTokens : null,
      cachedTokens: hasTokens ? this.acc.cacheReadTokens + this.acc.cacheWriteTokens : null,
      costUsd,
      turns: this.acc.turns > 0 ? this.acc.turns : null,
    });
  }
}
