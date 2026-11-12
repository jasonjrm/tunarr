import type { ISettingsDB } from '@/db/interfaces/ISettingsDB.js';
import type { ChannelOrmWithTranscodeConfig } from '@/db/schema/derivedTypes.js';
import type { OutputFormat } from '@/ffmpeg/builder/constants.js';
import type { OnDemandChannelService } from '@/services/OnDemandChannelService.js';
import type { PlayerContext } from '@/stream/PlayerStreamContext.js';
import type { StreamProgramCalculator } from '@/stream/StreamProgramCalculator.js';
import { Result } from '@/types/result.js';
import dayjs from 'dayjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import tmp from 'tmp';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { GetSegmentStreamEndsTask } from '@/ffmpeg/GetSegmentStreamEnds.js';
import { MeasureAudioEncoderLeadTask } from '@/ffmpeg/MeasureAudioEncoderLeadTask.js';
import { ProgramStream } from '../ProgramStream.ts';
import type { HlsSessionOptions } from './HlsSession.js';
import { HlsSession, nextProgramPtsOffset } from './HlsSession.js';

vi.mock('@/util/logging/LoggerFactory.js', () => ({
  LoggerFactory: {
    child: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

vi.mock('@/stream/ConnectionTracker.ts', () => {
  return {
    ConnectionTracker: class {
      on = vi.fn();
      cancelCleanup = vi.fn();
      recordHeartbeat = vi.fn();
      removeStaleConnections = vi.fn(() => []);
    },
  };
});

const channelUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

type MakeSessionOverrides = {
  streamMode?: HlsSessionOptions['streamMode'];
  channel?: Partial<ChannelOrmWithTranscodeConfig>;
  transcodeConfig?: Partial<ChannelOrmWithTranscodeConfig['transcodeConfig']>;
  settingsDB?: ISettingsDB;
};

function makeSession(
  transcodeDirectory: string,
  overrides: MakeSessionOverrides = {},
): HlsSession {
  const channel = {
    uuid: channelUuid,
    transcodeConfig: overrides.transcodeConfig ?? {},
    ...overrides.channel,
  } as ChannelOrmWithTranscodeConfig;

  const options = {
    streamMode: overrides.streamMode ?? 'hls',
    initialSegmentCount: 2,
    transcodeDirectory,
  };

  return new HlsSession(
    channel,
    options,
    {} as StreamProgramCalculator,
    overrides.settingsDB ?? ({} as ISettingsDB),
    {} as OnDemandChannelService,
    (() => ({}) as unknown as ProgramStream) as (
      ctx: PlayerContext,
      fmt: OutputFormat,
    ) => ProgramStream,
  );
}
describe('HlsSession', () => {
  describe('getMasterPlaylist', () => {
    let dir: tmp.DirResult;

    beforeEach(() => {
      dir = tmp.dirSync({ unsafeCleanup: true });
    });

    afterEach(() => {
      dir.removeCallback();
    });

    test('returns undefined when playlist.m3u8 does not exist', async () => {
      // Working directory will be created by initDirectories, but we skip that here.
      // The file simply won't exist.
      const session = makeSession(dir.name);
      const result = await session.getMasterPlaylist();
      expect(result.isSuccess()).toBe(true);
      expect(result.get()).toBeUndefined();
    });

    describe('subtitle rendition (sidecar)', () => {
      const savedEnv = process.env.TUNARR_WEBVTT_SIDECAR_ENABLED;
      afterEach(() => {
        if (savedEnv === undefined) {
          delete process.env.TUNARR_WEBVTT_SIDECAR_ENABLED;
        } else {
          process.env.TUNARR_WEBVTT_SIDECAR_ENABLED = savedEnv;
        }
      });

      async function master(
        channel: Partial<ChannelOrmWithTranscodeConfig>,
        sidecar: boolean,
      ) {
        delete process.env.TUNARR_WEBVTT_SIDECAR_ENABLED;
        const session = makeSession(dir.name, {
          channel,
          settingsDB: {
            featureFlags: () => ({ webvttSidecarEnabled: sidecar }),
          } as unknown as ISettingsDB,
        });
        await fs.mkdir(session.workingDirectory, { recursive: true });
        await fs.writeFile(
          path.join(session.workingDirectory, 'playlist.m3u8'),
          '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-STREAM-INF:BANDWIDTH=3511200,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"\nstream.m3u8\n',
        );
        return { session, text: (await session.getMasterPlaylist()).get()! };
      }

      test('advertised for the whole session, off by default, before any program has subtitles', async () => {
        const { text } = await master({ subtitlesEnabled: true }, true);
        expect(text).toContain('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs"');
        expect(text).toContain('DEFAULT=NO,AUTOSELECT=NO');
        expect(text).toMatch(/#EXT-X-STREAM-INF:.*SUBTITLES="subs"/);
      });

      test('a stream selection profile alone is enough', async () => {
        const { text } = await master(
          { streamSelectionProfileId: 'profile-1' },
          true,
        );
        expect(text).toContain('TYPE=SUBTITLES');
      });

      test('not advertised when the sidecar is off', async () => {
        const { text } = await master({ subtitlesEnabled: true }, false);
        expect(text).not.toContain('SUBTITLES');
      });

      test('not advertised on a channel that never selects subtitles', async () => {
        const { text } = await master({}, true);
        expect(text).not.toContain('SUBTITLES');
      });

      test('the env override turns the sidecar on', async () => {
        const session = makeSession(dir.name, {
          channel: { subtitlesEnabled: true },
          settingsDB: {
            featureFlags: () => ({ webvttSidecarEnabled: false }),
          } as unknown as ISettingsDB,
        });
        process.env.TUNARR_WEBVTT_SIDECAR_ENABLED = 'true';
        await fs.mkdir(session.workingDirectory, { recursive: true });
        await fs.writeFile(
          path.join(session.workingDirectory, 'playlist.m3u8'),
          '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nstream.m3u8\n',
        );
        expect((await session.getMasterPlaylist()).get()).toContain(
          'TYPE=SUBTITLES',
        );
      });

      test('the same rendition on every request', async () => {
        const { session, text } = await master(
          { subtitlesEnabled: true },
          true,
        );
        process.env.TUNARR_WEBVTT_SIDECAR_ENABLED = 'false';
        expect((await session.getMasterPlaylist()).get()).toBe(text);
      });
    });
  });

  describe('trimSubtitlePlaylist', () => {
    let dir: tmp.DirResult;

    beforeEach(() => {
      dir = tmp.dirSync({ unsafeCleanup: true });
    });

    afterEach(() => {
      dir.removeCallback();
    });

    test('returns undefined when subs.m3u8 does not exist', async () => {
      const session = makeSession(dir.name);
      const result = await session.trimSubtitlePlaylist();
      expect(result.isSuccess()).toBe(true);
      expect(result.get()).toBeUndefined();
    });

    test('derives a non-zero media sequence from segment file numbers on disk', async () => {
      const session = makeSession(dir.name);
      const workingDir = session.workingDirectory;
      await fs.mkdir(workingDir, { recursive: true });

      const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:0',
      ];
      for (let i = 20; i < 25; i++) {
        lines.push('#EXTINF:4.000000,', `sub${String(i).padStart(6, '0')}.vtt`);
      }
      await fs.writeFile(path.join(workingDir, 'subs.m3u8'), lines.join('\n'));

      const result = await session.trimSubtitlePlaylist();
      expect(result.isSuccess()).toBe(true);
      const trimResult = result.get();
      expect(trimResult).toBeDefined();
      expect(trimResult!.sequence).toBe(20);
      expect(trimResult!.playlist).toContain('#EXT-X-MEDIA-SEQUENCE:20');
    });

    test('trims a long subtitle playlist to its newest 20 segments', async () => {
      const session = makeSession(dir.name);
      const workingDir = session.workingDirectory;
      await fs.mkdir(workingDir, { recursive: true });

      const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:0',
      ];
      for (let i = 0; i < 60; i++) {
        lines.push('#EXTINF:4.000000,', `sub${String(i).padStart(6, '0')}.vtt`);
      }
      await fs.writeFile(path.join(workingDir, 'subs.m3u8'), lines.join('\n'));

      const result = await session.trimSubtitlePlaylist();
      expect(result.isSuccess()).toBe(true);
      const trimResult = result.get();
      expect(trimResult).toBeDefined();
      expect(trimResult!.sequence).toBe(40);
    });
  });

  describe('trimPlaylist', () => {
    let dir: tmp.DirResult;

    beforeEach(() => {
      dir = tmp.dirSync({ unsafeCleanup: true });
    });

    afterEach(() => {
      dir.removeCallback();
    });

    test('lists only segments that pruning kept', async () => {
      const session = makeSession(dir.name);

      // startInternal() sets the playlist start that trimPlaylist() needs.
      // The mocked transcode loop bails on its first call.
      await (
        session as unknown as { startInternal(): Promise<void> }
      ).startInternal();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const workingDir = session.workingDirectory;
      await fs.mkdir(workingDir, { recursive: true });

      // ffmpeg writes three lines per segment. A two-line fixture parses to
      // zero segments.
      const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:6',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:0',
      ];
      for (let i = 0; i < 60; i++) {
        const name = `data${String(i).padStart(6, '0')}.ts`;
        lines.push(
          '#EXTINF:4.000000,',
          '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000+0000',
          name,
        );
        await fs.writeFile(path.join(workingDir, name), '');
      }
      await fs.writeFile(
        path.join(workingDir, 'stream.m3u8'),
        lines.join('\n'),
      );

      expect((await session.trimPlaylist()).get()?.sequence).toBe(40);

      // The prune runs in the background, so wait for it to remove everything
      // below 40.
      const onDisk = await vi.waitFor(async () => {
        const files = (await fs.readdir(workingDir))
          .filter((f) => f.startsWith('data'))
          .sort();
        expect(files[0]).toBe('data000040.ts');
        return files;
      });

      const playlist = (await session.trimPlaylist()).get()?.playlist ?? '';
      const listed = [...playlist.matchAll(/data\d{6}\.ts/g)]
        .map((m) => m[0])
        .sort();
      expect(listed.length).toBeGreaterThan(0);
      expect(listed[0]).toBe('data000040.ts');
      for (const file of listed) {
        expect(onDisk).toContain(file);
      }
    });
  });

  describe('audio encoder lead prefetch', () => {
    let dir: tmp.DirResult;

    const settingsDB = {
      ffmpegSettings: () => ({ ffmpegExecutablePath: '/usr/bin/ffmpeg' }),
    } as unknown as ISettingsDB;

    const transcodeConfig = {
      audioFormat: 'aac',
      audioSampleRate: 48,
      audioChannels: 2,
    } as const;

    type PrefetchInternals = {
      startInternal(): Promise<void>;
      getAudioEncoderLead(): Promise<number>;
      getPtsOffset(): Promise<number>;
    };

    beforeEach(() => {
      dir = tmp.dirSync({ unsafeCleanup: true });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      dir.removeCallback();
    });

    test('measures once when an hls session starts and reuses the result', async () => {
      const run = vi
        .spyOn(MeasureAudioEncoderLeadTask.prototype, 'run')
        .mockResolvedValue(Result.success(1920));
      const session = makeSession(dir.name, { settingsDB, transcodeConfig });
      const internals = session as unknown as PrefetchInternals;

      await internals.startInternal();

      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith({
        encoder: 'aac',
        sampleRateKhz: 48,
        channels: 2,
      });

      // A program boundary reads the cached measurement.
      await expect(internals.getAudioEncoderLead()).resolves.toBe(1920);
      expect(run).toHaveBeenCalledTimes(1);
    });

    test('does not measure for hls_direct_v2', async () => {
      const run = vi.spyOn(MeasureAudioEncoderLeadTask.prototype, 'run');
      const session = makeSession(dir.name, {
        streamMode: 'hls_direct_v2',
        settingsDB,
        transcodeConfig,
      });

      await (session as unknown as PrefetchInternals).startInternal();

      expect(run).not.toHaveBeenCalled();
    });

    test('uses no lead and skips the probe when audio is copied', async () => {
      const run = vi.spyOn(MeasureAudioEncoderLeadTask.prototype, 'run');
      const session = makeSession(dir.name, {
        settingsDB,
        transcodeConfig: { ...transcodeConfig, audioFormat: 'copy' },
      });

      await expect(
        (session as unknown as PrefetchInternals).getAudioEncoderLead(),
      ).resolves.toBe(0);
      expect(run).not.toHaveBeenCalled();
    });

    test('uses no lead when the probe reports a failure', async () => {
      vi.spyOn(MeasureAudioEncoderLeadTask.prototype, 'run').mockResolvedValue(
        Result.failure('unknown encoder'),
      );
      const session = makeSession(dir.name, { settingsDB, transcodeConfig });

      await expect(
        (session as unknown as PrefetchInternals).getAudioEncoderLead(),
      ).resolves.toBe(0);
    });

    // The session prefetches without awaiting, so a rejected cached promise
    // would make every later program boundary throw.
    test('uses no lead when the probe throws, and keeps serving the cached result', async () => {
      const run = vi
        .spyOn(MeasureAudioEncoderLeadTask.prototype, 'run')
        .mockRejectedValue(new Error('spawn ffmpeg ENOENT'));
      const session = makeSession(dir.name, { settingsDB, transcodeConfig });
      const internals = session as unknown as PrefetchInternals;

      await internals.startInternal();

      await expect(internals.getAudioEncoderLead()).resolves.toBe(0);
      await expect(internals.getAudioEncoderLead()).resolves.toBe(0);
      expect(run).toHaveBeenCalledTimes(1);
    });

    test('offsets the next program from the newest segment and the encoder lead', async () => {
      const segmentEnds = vi
        .spyOn(GetSegmentStreamEndsTask.prototype, 'run')
        .mockResolvedValue(
          Result.success({ audioEnd: 1083361, nonAudioEnd: 1083001 }),
        );
      vi.spyOn(MeasureAudioEncoderLeadTask.prototype, 'run').mockResolvedValue(
        Result.success(1920),
      );
      const session = makeSession(dir.name, { settingsDB, transcodeConfig });
      await fs.mkdir(session.workingDirectory, { recursive: true });
      for (const file of ['data000001.ts', 'data000002.ts']) {
        await fs.writeFile(path.join(session.workingDirectory, file), '');
      }

      const offset = await (
        session as unknown as PrefetchInternals
      ).getPtsOffset();

      expect(segmentEnds).toHaveBeenCalledWith(
        path.join(session.workingDirectory, 'data000002.ts'),
      );
      // Audio end plus the lead, one tick past.
      expect(offset).toBe(1085282);
    });
  });

  describe('getLastSubtitleSegmentNumber (private)', () => {
    let dir: tmp.DirResult;

    beforeEach(() => {
      dir = tmp.dirSync({ unsafeCleanup: true });
    });

    afterEach(() => {
      dir.removeCallback();
    });

    test('returns 0 when no .vtt segments exist', async () => {
      const session = makeSession(dir.name);
      await fs.mkdir(session.workingDirectory, { recursive: true });

      const result = await (
        session as unknown as {
          getLastSubtitleSegmentNumber(): Promise<number>;
        }
      ).getLastSubtitleSegmentNumber();

      expect(result).toBe(0);
    });

    test('returns one past the highest existing .vtt segment number', async () => {
      const session = makeSession(dir.name);
      const workingDir = session.workingDirectory;
      await fs.mkdir(workingDir, { recursive: true });
      for (const n of [0, 1, 2, 3, 4]) {
        await fs.writeFile(
          path.join(workingDir, `sub${String(n).padStart(6, '0')}.vtt`),
          'WEBVTT\n',
        );
      }

      const result = await (
        session as unknown as {
          getLastSubtitleSegmentNumber(): Promise<number>;
        }
      ).getLastSubtitleSegmentNumber();

      expect(result).toBe(5);
    });
  });

  describe('deleteOldSegmentFiles (private)', () => {
    let dir: tmp.DirResult;

    beforeEach(() => {
      dir = tmp.dirSync({ unsafeCleanup: true });
    });

    afterEach(() => {
      dir.removeCallback();
    });

    async function callDeleteOldSegmentFiles(
      session: HlsSession,
      sequenceNum: number,
      extensions: string[],
    ) {
      return (
        session as unknown as {
          deleteOldSegmentFiles(
            sequenceNum: number,
            extensions: string[],
          ): Promise<void>;
        }
      ).deleteOldSegmentFiles(sequenceNum, extensions);
    }

    test('deletes .ts/.mp4 segments below the sequence number (regression)', async () => {
      const session = makeSession(dir.name);
      const workingDir = session.workingDirectory;
      await fs.mkdir(workingDir, { recursive: true });
      for (const n of [0, 1, 2, 3, 4]) {
        await fs.writeFile(
          path.join(workingDir, `data${String(n).padStart(6, '0')}.ts`),
          '',
        );
      }

      await callDeleteOldSegmentFiles(session, 3, ['.ts', '.mp4']);

      const remaining = await fs.readdir(workingDir);
      expect(remaining.sort()).toEqual(['data000003.ts', 'data000004.ts']);
    });

    test('deletes .vtt segments below the sequence number', async () => {
      const session = makeSession(dir.name);
      const workingDir = session.workingDirectory;
      await fs.mkdir(workingDir, { recursive: true });
      for (const n of [0, 1, 2, 3, 4]) {
        await fs.writeFile(
          path.join(workingDir, `sub${String(n).padStart(6, '0')}.vtt`),
          'WEBVTT\n',
        );
      }

      await callDeleteOldSegmentFiles(session, 3, ['.vtt']);

      const remaining = await fs.readdir(workingDir);
      expect(remaining.sort()).toEqual(['sub000003.vtt', 'sub000004.vtt']);
    });

    test('extensions filter is respected — .vtt deletion leaves .ts files untouched', async () => {
      const session = makeSession(dir.name);
      const workingDir = session.workingDirectory;
      await fs.mkdir(workingDir, { recursive: true });
      await fs.writeFile(path.join(workingDir, 'data000000.ts'), '');
      await fs.writeFile(path.join(workingDir, 'sub000000.vtt'), 'WEBVTT\n');

      await callDeleteOldSegmentFiles(session, 5, ['.vtt']);

      const remaining = await fs.readdir(workingDir);
      expect(remaining.sort()).toEqual(['data000000.ts']);
    });
  });

  describe('stop during program setup', () => {
    let tmpDir: tmp.DirResult;

    beforeEach(() => {
      tmpDir = tmp.dirSync({ unsafeCleanup: true });
    });

    afterEach(() => {
      tmpDir.removeCallback();
    });

    // A stop that lands while the next program is still probing must not
    // leave a freshly spawned ffmpeg that nothing tracks (issue #1950).
    test('does not start a transcode once the session has stopped', async () => {
      let finishSetup: (value: Result<unknown>) => void = () => {};
      const setupDone = new Promise<Result<unknown>>((resolve) => {
        finishSetup = resolve;
      });

      const transcodeSession = {
        streamDuration: dayjs.duration(30, 'minutes'),
        kill: vi.fn(),
        wait: vi.fn(() => Promise.resolve({ code: 0, signal: null })),
        exited: Promise.resolve(),
      };
      const start = vi.fn(() => Promise.resolve());
      const programStream = {
        on: vi.fn(),
        setup: vi.fn(() => setupDone),
        start,
        renditions: undefined,
        transcodeSession,
      };

      const session = new HlsSession(
        {
          uuid: channelUuid,
          transcodeConfig: {},
        } as ChannelOrmWithTranscodeConfig,
        {
          streamMode: 'hls',
          initialSegmentCount: 2,
          transcodeDirectory: tmpDir.name,
        },
        {
          getCurrentLineupItem: vi.fn(() =>
            Promise.resolve(
              Result.success({
                lineupItem: { streamDuration: 1_800_000, duration: 1_800_000 },
                channelContext: {},
                sourceChannel: {},
              }),
            ),
          ),
        } as unknown as StreamProgramCalculator,
        {} as ISettingsDB,
        {
          getLiveTimestamp: vi.fn(() => Promise.resolve(Date.now())),
        } as unknown as OnDemandChannelService,
        (() => programStream as unknown as ProgramStream) as (
          ctx: PlayerContext,
          fmt: OutputFormat,
        ) => ProgramStream,
      );

      const internals = session as unknown as {
        startInternal(): Promise<void>;
      };
      await internals.startInternal();
      await vi.waitFor(() => expect(programStream.setup).toHaveBeenCalled());

      await session.stop({ waitForExit: false });
      expect(session.state).toBe('stopped');

      finishSetup(Result.success(transcodeSession));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(start).not.toHaveBeenCalled();
    });
  });
});

describe('required files at start (subtitle sidecar)', () => {
  let tmpDir: tmp.DirResult;
  beforeEach(() => {
    tmpDir = tmp.dirSync({ unsafeCleanup: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    tmpDir.removeCallback();
  });

  async function requiredFiles(streamMode: HlsSessionOptions['streamMode']) {
    vi.spyOn(MeasureAudioEncoderLeadTask.prototype, 'run').mockResolvedValue(
      Result.success(0),
    );
    let session: HlsSession;
    const programStream = {
      on: vi.fn(),
      setup: vi.fn(() =>
        Promise.resolve(Result.success(programStream.transcodeSession)),
      ),
      start: vi.fn(() => Promise.resolve()),
      renditions: {
        audio: [],
        subtitle: { language: 'eng', default: false, forced: false },
      },
      copiedVideo: false,
      transcodeSession: {
        streamDuration: dayjs.duration(50, 'seconds'),
        kill: vi.fn(),
        wait: vi.fn(async () => {
          await session.stop({ waitForExit: false });
          return { code: 0, signal: null };
        }),
        exited: Promise.resolve(),
      },
    };
    session = new HlsSession(
      {
        uuid: channelUuid,
        transcodeConfig: {},
      } as ChannelOrmWithTranscodeConfig,
      { streamMode, initialSegmentCount: 2, transcodeDirectory: tmpDir.name },
      {
        getCurrentLineupItem: vi.fn(() =>
          Promise.resolve(
            Result.success({
              lineupItem: {
                type: 'program',
                streamDuration: 50_000,
                duration: 50_000,
                program: { uuid: 'p' },
              },
              channelContext: {},
              sourceChannel: {},
            }),
          ),
        ),
      } as unknown as StreamProgramCalculator,
      {} as ISettingsDB,
      {
        getLiveTimestamp: vi.fn((_id: string, ts: number) =>
          Promise.resolve(ts),
        ),
      } as unknown as OnDemandChannelService,
      (() => programStream as unknown as ProgramStream) as (
        ctx: PlayerContext,
        fmt: OutputFormat,
      ) => ProgramStream,
    );
    await (
      session as unknown as { startInternal(): Promise<void> }
    ).startInternal();
    await vi.waitFor(() => expect(programStream.start).toHaveBeenCalled());
    return (
      session as unknown as { getAdditionalRequiredFiles(): string[] }
    ).getAdditionalRequiredFiles();
  }

  test("transcoded HLS never waits for ffmpeg's subs.m3u8 (written only at the first cue)", async () => {
    expect(await requiredFiles('hls')).toEqual([]);
  });

  test('hls_direct_v2 still waits for it (it serves that file)', async () => {
    expect(await requiredFiles('hls_direct_v2')).toEqual(['subs.m3u8']);
  });
});

describe('copied-video fallback (CT-4)', () => {
  let tmpDir: tmp.DirResult;
  const savedEnv = process.env.TUNARR_COPY_VIDEO_CHANNELS;

  beforeEach(() => {
    tmpDir = tmp.dirSync({ unsafeCleanup: true });
    process.env.TUNARR_COPY_VIDEO_CHANNELS = '989';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    tmpDir.removeCallback();
    if (savedEnv === undefined) {
      delete process.env.TUNARR_COPY_VIDEO_CHANNELS;
    } else {
      process.env.TUNARR_COPY_VIDEO_CHANNELS = savedEnv;
    }
  });

  type Run = { copiedVideo: boolean; exitCode: number };

  /**
   * Drive the real session loop over one 50-second program (short, so the
   * loop's 60 s buffer check asks for the next program at once). Each entry in
   * `runs` is one ffmpeg run of it; `writtenTicks[i]` is the PTS offset the
   * session reads after run i (90 kHz ticks).
   */
  async function play(runs: Run[], writtenTicks: (number | undefined)[]) {
    // The first program of a session starts at 0 without reading an offset.
    const ptsOffsets: (number | undefined)[] = [...writtenTicks];
    vi.spyOn(
      HlsSession.prototype as unknown as {
        measurePtsOffset(): Promise<number | undefined>;
      },
      'measurePtsOffset',
    ).mockImplementation(() => Promise.resolve(ptsOffsets.shift()));
    vi.spyOn(MeasureAudioEncoderLeadTask.prototype, 'run').mockResolvedValue(
      Result.success(0),
    );

    const requests: { copyVideo?: boolean }[] = [];
    const lineupStarts: number[] = [];
    let session: HlsSession;
    let call = 0;

    const factory = (
      _ctx: PlayerContext,
      _fmt: OutputFormat,
      opts?: { copyVideo?: boolean },
    ) => {
      requests.push({ copyVideo: opts?.copyVideo });
      const run = runs[Math.min(call++, runs.length - 1)]!;
      const transcodeSession = {
        streamDuration: dayjs.duration(50, 'seconds'),
        kill: vi.fn(),
        wait: vi.fn(async () => {
          if (call >= runs.length) {
            // Last run: end the test session instead of looping forever.
            await session.stop({ waitForExit: false });
          }
          return { code: run.exitCode, signal: null };
        }),
        exited: Promise.resolve(),
      };
      return {
        on: vi.fn(),
        setup: vi.fn(() => Promise.resolve(Result.success(transcodeSession))),
        start: vi.fn(() => Promise.resolve()),
        renditions: undefined,
        copiedVideo: run.copiedVideo,
        transcodeSession,
      } as unknown as ProgramStream;
    };

    session = new HlsSession(
      {
        uuid: channelUuid,
        number: 989,
        transcodeConfig: {},
      } as ChannelOrmWithTranscodeConfig,
      {
        streamMode: 'hls',
        initialSegmentCount: 2,
        transcodeDirectory: tmpDir.name,
      },
      {
        getCurrentLineupItem: vi.fn((req: { startTime: number }) => {
          lineupStarts.push(req.startTime);
          return Promise.resolve(
            Result.success({
              lineupItem: {
                type: 'program',
                streamDuration: 50_000,
                duration: 50_000,
                program: { uuid: 'program-1' },
              },
              channelContext: {},
              sourceChannel: {},
            }),
          );
        }),
      } as unknown as StreamProgramCalculator,
      {} as ISettingsDB,
      {
        getLiveTimestamp: vi.fn((_id: string, ts: number) =>
          Promise.resolve(ts),
        ),
      } as unknown as OnDemandChannelService,
      factory as unknown as (
        ctx: PlayerContext,
        fmt: OutputFormat,
      ) => ProgramStream,
    );

    await (
      session as unknown as { startInternal(): Promise<void> }
    ).startInternal();
    await vi.waitFor(() => expect(session.state).toBe('stopped'));
    return { requests, lineupStarts };
  }

  test('a failed copied program is replayed from where it stopped, as a full transcode', async () => {
    const { requests, lineupStarts } = await play(
      [
        { copiedVideo: true, exitCode: 1 },
        { copiedVideo: false, exitCode: 0 },
      ],
      [10 * 90_000, 0],
    );

    expect(requests.map((r) => r.copyVideo)).toEqual([true, false]);
    // The retry starts 10 s into the program, not after its 50.
    expect(lineupStarts[1]! - lineupStarts[0]!).toBe(10_000);
  });

  test('a copied program that ended well short of its length, even with code 0, is retried', async () => {
    const { requests, lineupStarts } = await play(
      [
        { copiedVideo: true, exitCode: 0 },
        { copiedVideo: false, exitCode: 0 },
      ],
      [20 * 90_000, 0],
    );

    expect(requests.map((r) => r.copyVideo)).toEqual([true, false]);
    expect(lineupStarts[1]! - lineupStarts[0]!).toBe(20_000);
  });

  test('a copied program that played to its end moves on normally', async () => {
    const { requests, lineupStarts } = await play(
      [
        { copiedVideo: true, exitCode: 0 },
        { copiedVideo: true, exitCode: 0 },
      ],
      [50 * 90_000, 0],
    );

    expect(requests.map((r) => r.copyVideo)).toEqual([true, true]);
    expect(lineupStarts[1]! - lineupStarts[0]!).toBe(50_000);
  });

  test('a clean exit whose output cannot be measured is not replayed', async () => {
    const { requests, lineupStarts } = await play(
      [
        { copiedVideo: true, exitCode: 0 },
        { copiedVideo: true, exitCode: 0 },
      ],
      [undefined, 0],
    );

    expect(requests.map((r) => r.copyVideo)).toEqual([true, true]);
    expect(lineupStarts[1]! - lineupStarts[0]!).toBe(50_000);
  });

  test('a failed copied program whose output cannot be measured is replayed from its start', async () => {
    const { requests, lineupStarts } = await play(
      [
        { copiedVideo: true, exitCode: 1 },
        { copiedVideo: false, exitCode: 0 },
      ],
      [undefined, 0],
    );

    expect(requests.map((r) => r.copyVideo)).toEqual([true, false]);
    expect(lineupStarts[1]! - lineupStarts[0]!).toBe(0);
  });

  test('a failed transcoded program is not retried here (it keeps the error screen path)', async () => {
    const { requests, lineupStarts } = await play(
      [
        { copiedVideo: false, exitCode: 1 },
        { copiedVideo: false, exitCode: 0 },
      ],
      [10 * 90_000, 0],
    );

    expect(requests.map((r) => r.copyVideo)).toEqual([true, true]);
    expect(lineupStarts[1]! - lineupStarts[0]!).toBe(50_000);
  });
});

describe('nextProgramPtsOffset', () => {
  test('starts the next audio where the previous audio ended', () => {
    // Audio ends 360 ticks after video, and AAC places its first packet 1920
    // ticks before the offset.
    const offset = nextProgramPtsOffset(
      { audioEnd: 1083361, nonAudioEnd: 1083001 },
      1920,
    );

    expect(offset).toBe(1085282);
    expect(offset - 1920).toBe(1083361 + 1);
  });

  test('absorbs an audio shortfall up to the encoder lead without an audio gap', () => {
    // Audio ends 240 ticks before video. The lead still covers it.
    const offset = nextProgramPtsOffset(
      { audioEnd: 1082761, nonAudioEnd: 1083001 },
      1920,
    );

    expect(offset - 1920).toBe(1082761 + 1);
  });

  test('never starts video before the previous video ended', () => {
    // The audio shortfall is larger than the lead, so video sets the offset.
    const offset = nextProgramPtsOffset(
      { audioEnd: 1080000, nonAudioEnd: 1083001 },
      480,
    );

    expect(offset).toBe(1083002);
  });

  test('uses the remaining stream when the segment has only one kind', () => {
    expect(nextProgramPtsOffset({ nonAudioEnd: 9000 }, 1920)).toBe(9001);
    expect(nextProgramPtsOffset({ audioEnd: 9000 }, 1920)).toBe(10921);
  });

  test('matches the old offset when there is no lead and audio ends first', () => {
    expect(nextProgramPtsOffset({ audioEnd: 8000, nonAudioEnd: 9000 }, 0)).toBe(
      9001,
    );
  });
});
