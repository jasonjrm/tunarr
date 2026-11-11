import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneFfmpegErrorLogs } from './FfmpegProcess.ts';

describe('pruneFfmpegErrorLogs', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tunarr-logs-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('keeps the newest logs by the timestamp in their name', async () => {
    // Written out of order, so only the timestamp in the name decides.
    const stamps = [1794000000300, 1794000000100, 1794000000400, 1794000000200];
    for (const at of stamps) {
      await fs.writeFile(
        path.join(dir, `ffmpeg-error-log-channel-2-transcode-${at}.log`),
        '',
      );
    }
    await fs.writeFile(path.join(dir, 'tunarr.log'), '');

    await pruneFfmpegErrorLogs(dir, 2);

    expect((await fs.readdir(dir)).sort()).toEqual([
      'ffmpeg-error-log-channel-2-transcode-1794000000300.log',
      'ffmpeg-error-log-channel-2-transcode-1794000000400.log',
      'tunarr.log',
    ]);
  });

  it('leaves the folder alone when under the limit', async () => {
    await fs.writeFile(
      path.join(dir, 'ffmpeg-error-log-channel-2-error-1794000000100.log'),
      '',
    );

    await pruneFfmpegErrorLogs(dir, 2);

    expect(await fs.readdir(dir)).toHaveLength(1);
  });
});
