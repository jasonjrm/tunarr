import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaSourceId } from '../db/schema/base.ts';
import { Result } from '../types/result.ts';
import { SubtitleExtractorTask } from './SubtitleExtractorTask.ts';

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

// The task only needs TVGuideService as an injection token here, and importing
// the real one drags the DI container in through the scheduler, which cannot be
// constructed mid-import.
vi.mock('../services/TvGuideService.ts', () => ({
  TVGuideService: class {},
}));

// Used by PathCalculator (shared-storage lookups) and by the task's own
// check for whether an already-recorded subtitle file is still there.
const mockFileExists = vi.fn<(p: string) => Promise<boolean>>();
vi.mock('../util/fsUtil.ts', () => ({
  fileExists: (p: string) => mockFileExists(p),
}));

// Stands in for ffmpeg: each output path in the args gets what the test says
// the track contains, then the run fails if the test asks it to.
const mockFfmpeg = vi.fn<(args: string[]) => Promise<string>>();
vi.mock('../util/ChildProcessHelper.ts', () => ({
  ChildProcessHelper: class {
    getStdout(_exe: string, args: string[]) {
      return mockFfmpeg(args);
    }
  },
}));

const MEDIA_SOURCE_ID = 'media-source-1' as MediaSourceId;
const PROGRAM_ID = 'program-1';
const CHANNEL_ID = 'channel-1';
const CUSTOM_SHOW_ID = 'custom-show-1';
const SOURCE_SUBTITLE_PATH = '/data/media/movie.eng.srt';
const SHARED_SUBTITLE_PATH = '/mnt/media/movie.eng.srt';
const CACHED_SUBTITLE_PATH = '/tmp/test-tunarr/cache/subtitles/ab/cd/abcd.srt';
const SUBTITLE_KEY = '/Videos/jf-item-1/jf-item-1/Subtitles/0/Stream.srt';

type SubtitleRow = {
  uuid: string;
  subtitleType: 'embedded' | 'sidecar';
  codec: string;
  language: string;
  path?: string | null;
  sourcePath?: string | null;
  sourceKey?: string | null;
  streamIndex?: number | null;
  isExtracted?: boolean;
};

function makeSubtitle(row: SubtitleRow) {
  return {
    default: false,
    forced: false,
    isExtracted: false,
    path: null,
    programId: PROGRAM_ID,
    sdh: false,
    sourceKey: null,
    sourcePath: null,
    streamIndex: null,
    ...row,
  };
}

type Harness = ReturnType<typeof makeHarness>;

function makeHarness(opts: {
  subtitles: SubtitleRow[];
  sourceType?: 'jellyfin' | 'emby' | 'plex';
  replacePaths?: { localPath: string; serverPath: string }[];
  anyProfileMayPickSubtitles?: boolean;
  mayPickSubtitles?: boolean | ((ctx: { customShowId?: string }) => boolean);
  lineupCustomShowIds?: (string | undefined)[];
  fillerMayPickSubtitles?: boolean;
  enableSubtitleExtraction?: boolean;
  downloadedPath?: string;
  databaseDirectory?: string;
  embeddedSubtitleIndexes?: number[];
}) {
  const sourceType = opts.sourceType ?? 'jellyfin';

  const mediaSource = {
    uuid: MEDIA_SOURCE_ID,
    name: 'Test Source',
    type: sourceType,
    uri: 'http://localhost:8096',
    accessToken: 'token',
    libraries: [],
    paths: [],
    replacePaths: opts.replacePaths ?? [],
  };

  const dbProgram = {
    uuid: PROGRAM_ID,
    externalKey: 'jf-item-1',
    mediaSourceId: MEDIA_SOURCE_ID,
    sourceType,
    subtitles: opts.subtitles.map(makeSubtitle),
    externalIds: [],
  };

  const setSubtitlePath = vi.fn<(uuid: string, path: string) => Promise<void>>(
    () => Promise.resolve(),
  );
  const getSubtitlesByPath = vi.fn(() => Promise.resolve('subtitle contents'));
  const getSubtitlesByKey = vi.fn(() => Promise.resolve('subtitle contents'));

  // Stands in for the real downloader: runs the fetch callback the task hands
  // it, so the test also covers which client method the task reaches for.
  const downloadSubtitlesIfNecessary = vi.fn(
    async (
      _item: unknown,
      _details: unknown,
      cb: (args: { extension: string }) => Promise<unknown>,
    ) => {
      await cb({ extension: 'srt' });
      return opts.downloadedPath;
    },
  );

  const apiClient = {
    getSubtitlesByPath,
    getSubtitles: getSubtitlesByKey,
  };

  const getChannelGuides = vi.fn((_range: unknown) =>
    Promise.resolve([
      {
        id: CHANNEL_ID,
        programs: [
          {
            type: 'content',
            id: PROGRAM_ID,
            program: {
              title: 'Test Movie',
              externalId: 'jf-item-1',
              mediaSourceId: MEDIA_SOURCE_ID,
              sourceType,
            },
          },
        ],
      },
    ]),
  );

  const mayPickSubtitles = vi.fn((ctx: { customShowId?: string }) =>
    Promise.resolve(
      typeof opts.mayPickSubtitles === 'function'
        ? opts.mayPickSubtitles(ctx)
        : (opts.mayPickSubtitles ?? true),
    ),
  );

  const fillerListMayPickSubtitles = vi.fn(
    (_fillerListId: string, _channelIds: string[]) =>
      Promise.resolve(opts.fillerMayPickSubtitles ?? false),
  );

  const embeddedSubtitleIndexes = opts.embeddedSubtitleIndexes;
  const getStream = vi.fn(() =>
    embeddedSubtitleIndexes
      ? Promise.resolve(
          Result.success({
            streamSource: { type: 'file', path: '/media/show.mkv' },
            streamDetails: {
              subtitleDetails: embeddedSubtitleIndexes.map((index) => ({
                type: 'embedded',
                codec: 'ass',
                index,
              })),
            },
          }),
        )
      : Promise.reject(new Error('should not be called')),
  );
  const getFillerPrograms = vi.fn((_id: string) =>
    Promise.resolve([dbProgram]),
  );

  const task = new SubtitleExtractorTask(
    {
      get: () => Promise.resolve({}),
      getChannelGuides,
    } as never,
    {
      loadLineup: () =>
        Promise.resolve({
          items: (opts.lineupCustomShowIds ?? [CUSTOM_SHOW_ID]).map(
            (customShowId) => ({
              type: 'content',
              id: PROGRAM_ID,
              durationMs: 1000,
              customShowId,
            }),
          ),
        }),
    } as never,
    {
      getStream,
    } as never,
    { getAll: () => Promise.resolve([mediaSource]) } as never,
    {
      ffmpegSettings: () => ({
        enableSubtitleExtraction: opts.enableSubtitleExtraction ?? false,
      }),
    } as never,
    {
      databaseDirectory: opts.databaseDirectory ?? '/tmp/test-tunarr',
    } as never,
    {
      getProgramById: () => Promise.resolve(dbProgram),
      setSubtitlePath,
    } as never,
    { downloadSubtitlesIfNecessary } as never,
    {
      getJellyfinApiClientForMediaSource: () => Promise.resolve(apiClient),
      getEmbyApiClientForMediaSource: () => Promise.resolve(apiClient),
      getPlexApiClientForMediaSource: () => Promise.resolve(apiClient),
    } as never,
    {
      anyProfileMayPickSubtitles: () =>
        Promise.resolve(opts.anyProfileMayPickSubtitles ?? true),
      mayPickSubtitles,
      fillerListMayPickSubtitles,
    } as never,
    {
      getAllFillerIds: () => Promise.resolve(['filler-1']),
      getFillerPrograms,
    } as never,
  );

  return {
    task,
    getChannelGuides,
    mayPickSubtitles,
    fillerListMayPickSubtitles,
    getStream,
    getFillerPrograms,
    dbProgram,
    setSubtitlePath,
    downloadSubtitlesIfNecessary,
    getSubtitlesByPath,
    getSubtitlesByKey,
  };
}

async function run(harness: Harness) {
  const result = await harness.task.run({});
  expect(result.isSuccess()).toBe(true);
}

describe('SubtitleExtractorTask external subtitle top-up', () => {
  beforeEach(() => {
    mockFileExists.mockReset();
    mockFileExists.mockResolvedValue(false);
  });

  it('leaves a sidecar alone when its recorded file is still on disk', async () => {
    mockFileExists.mockImplementation((p) =>
      Promise.resolve(p === CACHED_SUBTITLE_PATH),
    );

    const harness = makeHarness({
      subtitles: [
        {
          uuid: 'sub-1',
          subtitleType: 'sidecar',
          codec: 'subrip',
          language: 'eng',
          path: CACHED_SUBTITLE_PATH,
          sourceKey: SUBTITLE_KEY,
        },
      ],
    });

    await run(harness);

    expect(harness.downloadSubtitlesIfNecessary).not.toHaveBeenCalled();
    expect(harness.setSubtitlePath).not.toHaveBeenCalled();
  });

  it('prefers storage shared with the media source over downloading', async () => {
    mockFileExists.mockImplementation((p) =>
      Promise.resolve(p === SHARED_SUBTITLE_PATH),
    );

    const harness = makeHarness({
      replacePaths: [{ localPath: '/mnt/media', serverPath: '/data/media' }],
      subtitles: [
        {
          uuid: 'sub-1',
          subtitleType: 'sidecar',
          codec: 'subrip',
          language: 'eng',
          sourcePath: SOURCE_SUBTITLE_PATH,
          sourceKey: SUBTITLE_KEY,
        },
      ],
    });

    await run(harness);

    expect(harness.downloadSubtitlesIfNecessary).not.toHaveBeenCalled();
    expect(harness.setSubtitlePath).toHaveBeenCalledWith(
      'sub-1',
      SHARED_SUBTITLE_PATH,
    );
  });

  it('downloads a sidecar the scan never managed to fetch', async () => {
    const harness = makeHarness({
      downloadedPath: CACHED_SUBTITLE_PATH,
      subtitles: [
        {
          uuid: 'sub-1',
          subtitleType: 'sidecar',
          codec: 'subrip',
          language: 'eng',
          sourcePath: SOURCE_SUBTITLE_PATH,
          sourceKey: SUBTITLE_KEY,
        },
      ],
    });

    await run(harness);

    expect(harness.downloadSubtitlesIfNecessary).toHaveBeenCalledTimes(1);
    expect(harness.setSubtitlePath).toHaveBeenCalledWith(
      'sub-1',
      CACHED_SUBTITLE_PATH,
    );
    // The in-memory row is kept in step with what was persisted.
    expect(harness.dbProgram.subtitles[0].path).toBe(CACHED_SUBTITLE_PATH);
  });

  it('re-downloads a sidecar whose cached copy has been deleted', async () => {
    const harness = makeHarness({
      downloadedPath: CACHED_SUBTITLE_PATH,
      subtitles: [
        {
          uuid: 'sub-1',
          subtitleType: 'sidecar',
          codec: 'subrip',
          language: 'eng',
          // Recorded during a previous scan, but the file is gone.
          path: CACHED_SUBTITLE_PATH,
          sourceKey: SUBTITLE_KEY,
        },
      ],
    });

    await run(harness);

    expect(harness.downloadSubtitlesIfNecessary).toHaveBeenCalledTimes(1);
  });

  it('addresses Jellyfin and Emby subtitles by their delivery route', async () => {
    for (const sourceType of ['jellyfin', 'emby'] as const) {
      const harness = makeHarness({
        sourceType,
        downloadedPath: CACHED_SUBTITLE_PATH,
        subtitles: [
          {
            uuid: 'sub-1',
            subtitleType: 'sidecar',
            codec: 'subrip',
            language: 'eng',
            sourceKey: SUBTITLE_KEY,
          },
        ],
      });

      await run(harness);

      expect(harness.getSubtitlesByPath).toHaveBeenCalledWith(SUBTITLE_KEY);
    }
  });

  it('addresses Plex subtitles by their stream key', async () => {
    const harness = makeHarness({
      sourceType: 'plex',
      downloadedPath: CACHED_SUBTITLE_PATH,
      subtitles: [
        {
          uuid: 'sub-1',
          subtitleType: 'sidecar',
          codec: 'subrip',
          language: 'eng',
          sourceKey: '/library/streams/12345',
        },
      ],
    });

    await run(harness);

    expect(harness.getSubtitlesByKey).toHaveBeenCalledWith(
      '/library/streams/12345',
    );
  });

  it('does not record a path when the download fails', async () => {
    const harness = makeHarness({
      // The downloader returns nothing when it could not write a file.
      downloadedPath: undefined,
      subtitles: [
        {
          uuid: 'sub-1',
          subtitleType: 'sidecar',
          codec: 'subrip',
          language: 'eng',
          sourceKey: SUBTITLE_KEY,
        },
      ],
    });

    await run(harness);

    expect(harness.setSubtitlePath).not.toHaveBeenCalled();
  });

  it('ignores embedded subtitles, which are extracted rather than fetched', async () => {
    const harness = makeHarness({
      subtitles: [
        {
          uuid: 'sub-1',
          subtitleType: 'embedded',
          codec: 'subrip',
          language: 'eng',
          streamIndex: 2,
        },
      ],
    });

    await run(harness);

    expect(harness.downloadSubtitlesIfNecessary).not.toHaveBeenCalled();
  });

  it('skips a sidecar with no way to reach it', async () => {
    const harness = makeHarness({
      subtitles: [
        {
          uuid: 'sub-1',
          subtitleType: 'sidecar',
          codec: 'subrip',
          language: 'eng',
        },
      ],
    });

    await run(harness);

    expect(harness.downloadSubtitlesIfNecessary).not.toHaveBeenCalled();
    expect(harness.setSubtitlePath).not.toHaveBeenCalled();
  });

  it('skips the guide entirely when no stored profile selects subtitles', async () => {
    const harness = makeHarness({
      anyProfileMayPickSubtitles: false,
      subtitles: [],
    });

    await run(harness);

    expect(harness.getChannelGuides).not.toHaveBeenCalled();
  });

  it('skips a program whose profile chain never selects subtitles', async () => {
    const harness = makeHarness({
      mayPickSubtitles: false,
      downloadedPath: CACHED_SUBTITLE_PATH,
      subtitles: [
        {
          uuid: 'sub-1',
          subtitleType: 'sidecar',
          codec: 'subrip',
          language: 'eng',
          sourceKey: SUBTITLE_KEY,
        },
      ],
    });

    await run(harness);

    expect(harness.downloadSubtitlesIfNecessary).not.toHaveBeenCalled();
  });

  it("resolves each program's chain with its custom show from the lineup", async () => {
    const harness = makeHarness({ subtitles: [] });

    await run(harness);

    expect(harness.mayPickSubtitles).toHaveBeenCalledExactlyOnceWith({
      channelId: CHANNEL_ID,
      programId: PROGRAM_ID,
      customShowId: CUSTOM_SHOW_ID,
    });
  });

  it('prepares a program when a later airing in a custom show selects subtitles', async () => {
    const harness = makeHarness({
      lineupCustomShowIds: [undefined, CUSTOM_SHOW_ID],
      mayPickSubtitles: ({ customShowId }) => customShowId === CUSTOM_SHOW_ID,
      downloadedPath: CACHED_SUBTITLE_PATH,
      subtitles: [
        {
          uuid: 'sub-1',
          subtitleType: 'sidecar',
          codec: 'subrip',
          language: 'eng',
          sourceKey: SUBTITLE_KEY,
        },
      ],
    });

    await run(harness);

    expect(harness.downloadSubtitlesIfNecessary).toHaveBeenCalledOnce();
  });

  it('leaves filler lists alone when their profiles never select subtitles', async () => {
    const harness = makeHarness({ mayPickSubtitles: false, subtitles: [] });

    await run(harness);

    expect(harness.getFillerPrograms).not.toHaveBeenCalled();
  });

  it('prepares programs in a filler list whose profile selects subtitles', async () => {
    const harness = makeHarness({
      mayPickSubtitles: false,
      fillerMayPickSubtitles: true,
      downloadedPath: CACHED_SUBTITLE_PATH,
      subtitles: [
        {
          uuid: 'sub-1',
          subtitleType: 'sidecar',
          codec: 'subrip',
          language: 'eng',
          sourceKey: SUBTITLE_KEY,
        },
      ],
    });

    await run(harness);

    expect(harness.fillerListMayPickSubtitles).toHaveBeenCalledWith(
      'filler-1',
      [CHANNEL_ID],
    );
    expect(harness.getFillerPrograms).toHaveBeenCalledWith('filler-1');
    expect(harness.downloadSubtitlesIfNecessary).toHaveBeenCalledOnce();
  });

  it('extracts an uncached embedded subtitle for a filler program', async () => {
    const harness = makeHarness({
      mayPickSubtitles: false,
      fillerMayPickSubtitles: true,
      enableSubtitleExtraction: true,
      subtitles: [
        {
          uuid: 'sub-1',
          subtitleType: 'embedded',
          codec: 'subrip',
          language: 'eng',
          streamIndex: 3,
        },
      ],
    });

    await run(harness);

    expect(harness.getStream).toHaveBeenCalledOnce();
  });

  it('skips fetching a filler program with no embedded text subtitles', async () => {
    const harness = makeHarness({
      mayPickSubtitles: false,
      fillerMayPickSubtitles: true,
      enableSubtitleExtraction: true,
      subtitles: [
        {
          uuid: 'sub-1',
          subtitleType: 'embedded',
          codec: 'hdmv_pgs_subtitle',
          language: 'eng',
          streamIndex: 3,
        },
      ],
    });

    await run(harness);

    expect(harness.getStream).not.toHaveBeenCalled();
  });

  it('fetches stream details for a filler program with no subtitle rows', async () => {
    const harness = makeHarness({
      mayPickSubtitles: false,
      fillerMayPickSubtitles: true,
      enableSubtitleExtraction: true,
      subtitles: [],
    });

    await run(harness);

    expect(harness.getStream).toHaveBeenCalledOnce();
  });
});

describe('SubtitleExtractorTask embedded extraction', () => {
  let dbDir: string;

  beforeEach(async () => {
    dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tunarr-subs-'));
    // Startup creates the cache folders (bootstrap.ts).
    await fs.mkdir(path.join(dbDir, 'cache', 'subtitles'), { recursive: true });
    mockFileExists.mockReset();
    mockFileExists.mockImplementation((p) =>
      fs.access(p).then(
        () => true,
        () => false,
      ),
    );
    mockFfmpeg.mockReset();
  });

  afterEach(async () => {
    await fs.rm(dbDir, { recursive: true, force: true });
  });

  function extractionHarness() {
    return makeHarness({
      mayPickSubtitles: true,
      enableSubtitleExtraction: true,
      databaseDirectory: dbDir,
      embeddedSubtitleIndexes: [2, 3],
      subtitles: [],
    });
  }

  // Output paths follow each `-c:s <codec>` pair in the ffmpeg args.
  function outputPaths(args: string[]) {
    return args.flatMap((arg, i) => (args[i - 2] === '-c:s' ? [arg] : []));
  }

  async function cachedFiles() {
    const root = path.join(dbDir, 'cache', 'subtitles');
    const entries = await fs
      .readdir(root, { recursive: true, withFileTypes: true })
      .catch(() => []);
    return entries.filter((e) => e.isFile());
  }

  async function workFolderEntries() {
    return fs
      .readdir(path.join(dbDir, 'cache', 'subtitles-tmp'))
      .catch(() => [] as string[]);
  }

  it('writes each track into the cache and leaves no work files behind', async () => {
    mockFfmpeg.mockImplementation(async (args) => {
      for (const out of outputPaths(args)) {
        // Work files must never land in the OS temp dir.
        expect(out.startsWith(path.join(dbDir, 'cache', 'subtitles-tmp'))).toBe(
          true,
        );
        await fs.writeFile(out, 'Dialogue:\u0000 hi');
      }
      return '';
    });

    await run(extractionHarness());

    const files = await cachedFiles();
    expect(files).toHaveLength(2);
    for (const file of files) {
      const contents = await fs.readFile(
        path.join(file.parentPath, file.name),
        'utf8',
      );
      expect(contents).toBe('Dialogue: hi');
    }
    expect(await workFolderEntries()).toEqual([]);
  });

  it('removes partial output when ffmpeg fails and caches nothing', async () => {
    mockFfmpeg.mockImplementation(async (args) => {
      await fs.writeFile(outputPaths(args)[0]!, 'Dialogue: half');
      throw new Error('ffmpeg timed out');
    });

    await run(extractionHarness());

    expect(await cachedFiles()).toEqual([]);
    expect(await workFolderEntries()).toEqual([]);
  });

  it('clears work folders orphaned by a crash at the start of a pass', async () => {
    const orphan = path.join(dbDir, 'cache', 'subtitles-tmp', 'extract-old');
    await fs.mkdir(orphan, { recursive: true });
    await fs.writeFile(path.join(orphan, '2.raw.ass'), 'left over');
    mockFfmpeg.mockResolvedValue('');

    await run(extractionHarness());

    expect(await workFolderEntries()).toEqual([]);
  });

  it('skips tracks already in the cache on the next pass', async () => {
    mockFfmpeg.mockImplementation(async (args) => {
      for (const out of outputPaths(args)) {
        await fs.writeFile(out, 'Dialogue: hi');
      }
      return '';
    });
    const harness = extractionHarness();

    await run(harness);
    await run(harness);

    expect(mockFfmpeg).toHaveBeenCalledOnce();
  });

  it('runs overlapping requests as one pass plus one follow-up', async () => {
    mockFfmpeg.mockResolvedValue('');
    const harness = extractionHarness();
    let releaseFirst!: () => void;
    const firstPassBlocked = new Promise<void>((r) => (releaseFirst = r));
    const guides = await harness.getChannelGuides(undefined);
    harness.getChannelGuides.mockReset();
    harness.getChannelGuides
      .mockImplementationOnce(async () => {
        await firstPassBlocked;
        return guides;
      })
      .mockResolvedValue(guides);

    const first = harness.task.run({});
    // Let the first pass reach the guide before the others arrive.
    await vi.waitFor(() =>
      expect(harness.getChannelGuides).toHaveBeenCalledOnce(),
    );
    const others = [1, 2, 3, 4].map(() => harness.task.run({}));
    releaseFirst();
    const results = await Promise.all([first, ...others]);

    expect(results.every((r) => r.isSuccess())).toBe(true);
    expect(harness.getChannelGuides).toHaveBeenCalledTimes(2);
  });
});
