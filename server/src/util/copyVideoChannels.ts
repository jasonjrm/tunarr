import { getEnvVar, TUNARR_ENV_VARS } from './env.ts';

/**
 * Whether a channel is listed in TUNARR_COPY_VIDEO_CHANNELS (comma-separated
 * channel numbers, live-reloadable). Read once per HLS session, when it starts,
 * so a config edit never changes a session that is already running.
 */
export function isCopyVideoChannel(channelNumber: number): boolean {
  const list = getEnvVar(TUNARR_ENV_VARS.COPY_VIDEO_CHANNELS) ?? '';
  return list
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n !== '')
    .map(Number)
    .includes(channelNumber);
}
