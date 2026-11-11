import { afterEach, describe, expect, test } from 'vitest';
import { isCopyVideoChannel } from './copyVideoChannels.ts';

describe('isCopyVideoChannel', () => {
  const saved = process.env.TUNARR_COPY_VIDEO_CHANNELS;
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.TUNARR_COPY_VIDEO_CHANNELS;
    } else {
      process.env.TUNARR_COPY_VIDEO_CHANNELS = saved;
    }
  });

  test('unset means no channel copies', () => {
    delete process.env.TUNARR_COPY_VIDEO_CHANNELS;
    expect(isCopyVideoChannel(990)).toBe(false);
  });

  test('matches listed channel numbers, ignoring spaces', () => {
    process.env.TUNARR_COPY_VIDEO_CHANNELS = '990, 991 ,992';
    expect(isCopyVideoChannel(991)).toBe(true);
    expect(isCopyVideoChannel(99)).toBe(false);
  });

  test('empty list means no channel copies', () => {
    process.env.TUNARR_COPY_VIDEO_CHANNELS = '';
    expect(isCopyVideoChannel(0)).toBe(false);
  });
});
