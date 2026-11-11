import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LiveConfig } from './liveConfig.ts';

describe('LiveConfig', () => {
  let dir: string;
  let file: string;
  const saved = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'liveconfig-'));
    file = path.join(dir, 'tunaar.conf');
    delete process.env.TUNARR_MAX_SESSIONS;
    delete process.env.TUNARR_SESSION_EVICT_IDLE_MS;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...saved };
  });

  const write = (text: string, mtime: number) => {
    writeFileSync(file, text);
    utimesSync(file, mtime, mtime);
  };

  it('applies settings, skipping comments and blank lines', () => {
    write('# cap\n\nTUNARR_MAX_SESSIONS=11\nTUNARR_SESSION_EVICT_IDLE_MS = 10000\n', 1000);
    const r = new LiveConfig(file).reloadIfChanged()!;
    expect(process.env.TUNARR_MAX_SESSIONS).toBe('11');
    expect(process.env.TUNARR_SESSION_EVICT_IDLE_MS).toBe('10000');
    expect(r.problems).toEqual([]);
  });

  it('picks up an edit, and only when the file changed', () => {
    const cfg = new LiveConfig(file);
    write('TUNARR_MAX_SESSIONS=11\n', 1000);
    cfg.reloadIfChanged();
    expect(cfg.reloadIfChanged()).toBeUndefined();
    write('TUNARR_MAX_SESSIONS=8\n', 2000);
    expect(cfg.reloadIfChanged()!.changed).toEqual({ TUNARR_MAX_SESSIONS: '8' });
    expect(process.env.TUNARR_MAX_SESSIONS).toBe('8');
  });

  it('keeps the previous value when a line is bad', () => {
    const cfg = new LiveConfig(file);
    write('TUNARR_MAX_SESSIONS=11\n', 1000);
    cfg.reloadIfChanged();
    write('TUNARR_MAX_SESSIONS=eleven\nTUNARR_MAX_SESSION=3\n', 2000);
    const r = cfg.reloadIfChanged()!;
    expect(process.env.TUNARR_MAX_SESSIONS).toBe('11');
    expect(r.problems).toHaveLength(2);
    expect(r.changed).toEqual({});
  });

  it('a key removed from the file goes back to its startup value', () => {
    process.env.TUNARR_MAX_SESSIONS = '5'; // e.g. from systemd
    const cfg = new LiveConfig(file);
    write('TUNARR_MAX_SESSIONS=11\n', 1000);
    cfg.reloadIfChanged();
    write('# nothing\n', 2000);
    cfg.reloadIfChanged();
    expect(process.env.TUNARR_MAX_SESSIONS).toBe('5');
  });

  it('a missing file reverts to startup values without throwing', () => {
    const cfg = new LiveConfig(file);
    write('TUNARR_MAX_SESSIONS=11\n', 1000);
    cfg.reloadIfChanged();
    rmSync(file);
    cfg.reloadIfChanged();
    expect(process.env.TUNARR_MAX_SESSIONS).toBeUndefined();
  });
});
