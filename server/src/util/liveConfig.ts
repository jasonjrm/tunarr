import { readFileSync, statSync } from 'node:fs';
import { TUNARR_ENV_VARS } from './env.ts';

/**
 * Stream-limit settings that may change while Tunarr runs. Each is read where
 * it's used (per tune-in, per cleanup, per ffmpeg spawn), so setting it in
 * process.env takes effect at once; the sweep interval is restarted by the
 * caller. Anything else in the file is ignored.
 */
export const LiveConfigKeys: ReadonlySet<string> = new Set([
  TUNARR_ENV_VARS.MAX_SESSIONS,
  TUNARR_ENV_VARS.SESSION_EVICT_IDLE_MS,
  TUNARR_ENV_VARS.SESSION_STALENESS_MS,
  TUNARR_ENV_VARS.SESSION_SWEEP_INTERVAL_MS,
  TUNARR_ENV_VARS.SESSION_CLEANUP_DELAY_SECONDS,
  TUNARR_ENV_VARS.MIN_FREE_VRAM_MB,
  TUNARR_ENV_VARS.MIN_AVAILABLE_RAM_MB,
  TUNARR_ENV_VARS.STREAM_VRAM_ESTIMATE_MB,
  TUNARR_ENV_VARS.STREAM_RAM_ESTIMATE_MB,
  TUNARR_ENV_VARS.FFMPEG_INITIAL_BURST_SECONDS,
]);

export type LiveConfigResult = {
  /** Keys whose effective value changed, with the new value (undefined = removed). */
  changed: Record<string, string | undefined>;
  /** Lines that were ignored, and why. */
  problems: string[];
};

/**
 * Apply a KEY=value settings file to process.env. Blank lines and # comments
 * are skipped; values must be whole numbers >= 0. A bad line keeps the
 * previous value. A key removed from the file goes back to the value the
 * process started with (or unset).
 */
export class LiveConfig {
  readonly #startup: Record<string, string | undefined> = {};
  #applied = new Set<string>();
  #mtimeMs = -1;

  constructor(private readonly path: string) {
    for (const key of LiveConfigKeys) {
      this.#startup[key] = process.env[key];
    }
  }

  /** Re-read the file if it changed since the last load. */
  reloadIfChanged(): LiveConfigResult | undefined {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.path).mtimeMs;
    } catch {
      mtimeMs = 0; // missing file: everything back to startup values
    }
    if (mtimeMs === this.#mtimeMs) {
      return;
    }
    this.#mtimeMs = mtimeMs;
    return this.load();
  }

  load(): LiveConfigResult {
    const problems: string[] = [];
    const wanted = new Map<string, string>();
    let text = '';
    try {
      text = readFileSync(this.path, 'utf-8');
    } catch (e) {
      problems.push(`cannot read ${this.path}: ${(e as Error).message}`);
    }

    text.split('\n').forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) {
        return;
      }
      const eq = line.indexOf('=');
      const key = eq > 0 ? line.slice(0, eq).trim() : line;
      const value = eq > 0 ? line.slice(eq + 1).trim() : '';
      if (!LiveConfigKeys.has(key)) {
        problems.push(`line ${i + 1}: ${key} is not a live setting; ignored`);
      } else if (!/^\d+$/.test(value)) {
        problems.push(`line ${i + 1}: ${key}=${value} is not a whole number >= 0; keeping ${process.env[key] ?? 'unset'}`);
        if (process.env[key] !== undefined) {
          wanted.set(key, process.env[key]);
        }
      } else {
        wanted.set(key, value);
      }
    });

    const changed: Record<string, string | undefined> = {};
    for (const key of LiveConfigKeys) {
      const next = wanted.has(key) ? wanted.get(key) : this.#applied.has(key) ? this.#startup[key] : process.env[key];
      if (next !== process.env[key]) {
        changed[key] = next;
        if (next === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = next;
        }
      }
    }
    this.#applied = new Set(wanted.keys());
    return { changed, problems };
  }
}
