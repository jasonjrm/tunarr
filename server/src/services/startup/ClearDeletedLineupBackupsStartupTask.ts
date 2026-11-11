import { inject, injectable } from 'inversify';
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { IChannelDB } from '../../db/interfaces/IChannelDB.ts';
import { serverOptions } from '../../globals.ts';
import { KEYS } from '../../types/inject.ts';
import { ChannelLineupsFolderName } from '../../util/constants.ts';
import { isNodeError } from '../../util/index.ts';
import { InjectLogger } from '../../util/inject.ts';
import type { Logger } from '../../util/logging/LoggerFactory.ts';
import { SimpleStartupTask } from './IStartupTask.ts';

// <channel>.json.bak, which a channel delete leaves while it runs. Lineup
// migration backups (<channel>_lineup_v<n>_<time>.json.bak) have a different
// shape and are left alone.
export const DeletedLineupBackupRegex =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json\.bak$/i;

/**
 * Removes lineup backups of channels that no longer exist. A delete removes
 * its own backup once it commits; these are from deletes interrupted by a
 * crash, or from versions that never removed them.
 */
@injectable()
export class ClearDeletedLineupBackupsStartupTask extends SimpleStartupTask {
  id = ClearDeletedLineupBackupsStartupTask.name;
  dependencies: string[] = [];

  @InjectLogger() declare private readonly logger: Logger;

  constructor(@inject(KEYS.ChannelDB) private channelDB: IChannelDB) {
    super();
  }

  async getPromise(): Promise<void> {
    const folder = path.join(
      serverOptions().databaseDirectory,
      ChannelLineupsFolderName,
    );

    let entries: Dirent[];
    try {
      entries = await fs.readdir(folder, { withFileTypes: true });
    } catch (e) {
      if (!isNodeError(e) || e.code !== 'ENOENT') {
        this.logger.warn(e, 'Could not read lineup folder: %s', folder);
      }
      return;
    }

    const channelIds = new Set(
      (await this.channelDB.getAllChannels()).map((channel) =>
        channel.uuid.toLowerCase(),
      ),
    );

    let removed = 0;
    for (const entry of entries) {
      const channelId = entry.isFile()
        ? entry.name.match(DeletedLineupBackupRegex)?.[1]?.toLowerCase()
        : undefined;
      // A backup next to a live channel is a delete that failed and could not
      // be undone. It may be the only copy, so it stays.
      if (!channelId || channelIds.has(channelId)) {
        continue;
      }
      await fs
        .rm(path.join(folder, entry.name), { force: true })
        .then(() => removed++)
        .catch((e: unknown) =>
          this.logger.warn(e, 'Could not remove lineup backup: %s', entry.name),
        );
    }

    if (removed > 0) {
      this.logger.info(
        'Removed %d lineup backups of deleted channels',
        removed,
      );
    }
  }
}
