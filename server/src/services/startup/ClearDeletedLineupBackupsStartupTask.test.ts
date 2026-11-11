import { faker } from '@faker-js/faker';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IChannelDB } from '../../db/interfaces/IChannelDB.ts';
import { ClearDeletedLineupBackupsStartupTask } from './ClearDeletedLineupBackupsStartupTask.ts';

vi.mock('@/util/logging/LoggerFactory.js', () => {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
    setBindings: vi.fn(),
  };
  return {
    LoggerFactory: {
      isInitialized: true,
      root: logger,
      child: () => logger,
    },
  };
});

const mockDatabaseDirectory = vi.hoisted(() => ({ value: '' }));
vi.mock('../../globals.ts', () => ({
  serverOptions: () => ({ databaseDirectory: mockDatabaseDirectory.value }),
}));

function makeChannelDB(channelIds: string[]) {
  return {
    getAllChannels: () => Promise.resolve(channelIds.map((uuid) => ({ uuid }))),
  } as unknown as IChannelDB;
}

describe('ClearDeletedLineupBackupsStartupTask', () => {
  let root: string;
  let lineups: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'tunarr-lineups-'));
    mockDatabaseDirectory.value = root;
    lineups = path.join(root, 'channel-lineups');
    await fs.mkdir(lineups);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function files() {
    return (await fs.readdir(lineups)).sort();
  }

  it('removes backups of channels that no longer exist', async () => {
    const live = faker.string.uuid();
    const deleted = faker.string.uuid();
    await fs.writeFile(path.join(lineups, `${live}.json`), '{}');
    await fs.writeFile(path.join(lineups, `${deleted}.json.bak`), '{}');

    await new ClearDeletedLineupBackupsStartupTask(
      makeChannelDB([live]),
    ).getPromise();

    expect(await files()).toEqual([`${live}.json`]);
  });

  it('keeps a backup whose channel still exists', async () => {
    const live = faker.string.uuid();
    await fs.writeFile(path.join(lineups, `${live}.json.bak`), '{}');

    await new ClearDeletedLineupBackupsStartupTask(
      makeChannelDB([live]),
    ).getPromise();

    expect(await files()).toEqual([`${live}.json.bak`]);
  });

  it('keeps lineup migration backups and unrelated files', async () => {
    const channel = faker.string.uuid();
    const kept = [
      `${channel}_lineup_v5_1794000000000.json.bak`,
      'notes.json.bak',
    ].sort();
    for (const name of kept) {
      await fs.writeFile(path.join(lineups, name), '{}');
    }

    await new ClearDeletedLineupBackupsStartupTask(
      makeChannelDB([]),
    ).getPromise();

    expect(await files()).toEqual(kept);
  });

  it('does nothing when the lineup folder is missing', async () => {
    await fs.rm(lineups, { recursive: true });

    await expect(
      new ClearDeletedLineupBackupsStartupTask(makeChannelDB([])).getPromise(),
    ).resolves.toBeUndefined();
  });
});
