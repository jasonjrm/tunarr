import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration.js';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { FileStreamSource } from '../../../../stream/types.ts';
import {
  createTempWorkdir,
  probeFile,
  runFfmpegWithPipeline,
} from '../../../../testing/ffmpeg/FfmpegIntegrationHelper.ts';
import {
  binaries,
  ffmpegTest,
  Fixtures,
} from '../../../../testing/ffmpeg/FfmpegTestFixtures.ts';
import type { FfmpegCapabilities } from '../../capabilities/FfmpegCapabilities.ts';
import type { FfmpegVersionResult } from '../../../ffmpegInfo.ts';
import {
  AudioFormats,
  defaultHlsOptions,
  HlsOutputFormat,
  VideoFormats,
} from '../../constants.ts';
import { PixelFormatYuv420P } from '../../format/PixelFormat.ts';
import { AudioInputSource } from '../../input/AudioInputSource.ts';
import { SubtitlesInputSource } from '../../input/SubtitlesInputSource.ts';
import { VideoInputSource } from '../../input/VideoInputSource.ts';
import {
  AudioStream,
  ExternalSubtitleStream,
  SubtitleMethods,
  VideoStream,
} from '../../MediaStream.ts';
import { AudioState } from '../../state/AudioState.ts';
import {
  DefaultPipelineOptions,
  FfmpegState,
} from '../../state/FfmpegState.ts';
import { FrameState } from '../../state/FrameState.ts';
import { FrameSize } from '../../types.ts';
import { SoftwarePipelineBuilder } from './SoftwarePipelineBuilder.ts';

dayjs.extend(duration);

/**
 * Copy-or-transcode hybrid: copy the video, transcode one audio track to AAC,
 * HLS output. The source is an MKV with non-AAC audio, the case where the old
 * copy-all passthrough wrote a master playlist without #EXT-X-STREAM-INF.
 */
describe.skipIf(!binaries)('copy video + AAC audio to HLS', () => {
  let workdir: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ dir: workdir, cleanup } = await createTempWorkdir());
  });

  afterAll(() => cleanup());

  function makeMkv(audioCodec: 'libopus' | 'flac') {
    const out = path.join(workdir, `source_${audioCodec}.mkv`);
    const result = spawnSync(binaries!.ffmpeg, [
      '-y',
      '-i',
      Fixtures.video720p,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-c:v',
      'copy',
      '-c:a',
      audioCodec,
      out,
    ]);
    return result.status === 0 ? out : undefined;
  }

  type RunOptions = {
    source: string;
    audioCodec: string;
    streamBasePath: string;
    segmentNameFormat: string;
    ptsOffset?: number;
    /** Seek into the source (ms), as when tuning in mid-program. */
    startMs?: number;
    /** An external SRT sent as the WebVTT sidecar. */
    subtitlePath?: string;
    /** Where to seek the subtitle input instead of startMs (ms). */
    subtitleStartMs?: number;
    isFirstTranscode?: boolean;
    binaryCapabilities: FfmpegCapabilities;
    ffmpegVersion: FfmpegVersionResult;
  };

  /** Run one program of an HLS session through the hybrid pipeline. */
  function runHybrid(opts: RunOptions) {
    const video = VideoInputSource.withStream(
      new FileStreamSource(opts.source),
      VideoStream.create({
        codec: 'h264',
        displayAspectRatio: '16:9',
        frameSize: FrameSize.withDimensions(1280, 720),
        index: 0,
        pixelFormat: new PixelFormatYuv420P(),
        providedSampleAspectRatio: null,
        colorFormat: null,
      }),
    );
    const audio = AudioInputSource.withStream(
      new FileStreamSource(opts.source),
      AudioStream.create({ channels: 2, codec: opts.audioCodec, index: 1 }),
      AudioState.create({
        audioEncoder: AudioFormats.Aac,
        audioChannels: 2,
        audioBitrate: 192,
        audioBufferSize: 384,
        audioSampleRate: 48,
      }),
    );

    // HlsSession creates the session directory before ffmpeg starts.
    mkdirSync(path.join(workdir, opts.streamBasePath), { recursive: true });
    const subtitle = opts.subtitlePath
      ? new SubtitlesInputSource(
          new FileStreamSource(opts.subtitlePath),
          [new ExternalSubtitleStream('subrip', SubtitleMethods.Convert)],
          SubtitleMethods.Convert,
        )
      : null;
    const pipeline = new SoftwarePipelineBuilder(
      video,
      audio,
      null,
      subtitle,
      null,
      opts.binaryCapabilities,
    ).build(
      FfmpegState.create({
        version: opts.ffmpegVersion,
        outputFormat: HlsOutputFormat({
          ...defaultHlsOptions,
          segmentBaseDirectory: workdir,
          streamBasePath: opts.streamBasePath,
          segmentNameFormat: opts.segmentNameFormat,
          streamNameFormat: 'stream.m3u8',
        }),
        ptsOffset: opts.ptsOffset ?? 0,
        start: opts.startMs ? dayjs.duration(opts.startMs) : undefined,
        subtitleStart:
          opts.subtitleStartMs !== undefined
            ? dayjs.duration(opts.subtitleStartMs)
            : undefined,
        isFirstTranscode: opts.isFirstTranscode ?? true,
        emitEndList: true,
      }),
      new FrameState({
        isAnamorphic: false,
        scaledSize: FrameSize.withDimensions(1280, 720),
        paddedSize: FrameSize.withDimensions(1280, 720),
        videoFormat: VideoFormats.Copy,
        videoTrackTimescale: 90000,
        realtime: false,
      }),
      DefaultPipelineOptions,
    );

    const args = pipeline.getCommandArgs();
    const { exitCode, stderr } = runFfmpegWithPipeline(binaries!.ffmpeg, args);
    expect(exitCode, `${args.join(' ')}\n${stderr}`).toBe(0);
    return args;
  }

  /** start_time (seconds) of each stream type in an MPEG-TS segment. */
  function streamStarts(file: string): Record<string, number> {
    const result = spawnSync(binaries!.ffprobe, [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_entries',
      'stream=codec_type,start_time',
      file,
    ]);
    const streams = JSON.parse(result.stdout.toString()).streams as {
      codec_type: string;
      start_time: string;
    }[];
    return Object.fromEntries(
      streams.map((s) => [s.codec_type, Number(s.start_time)]),
    );
  }

  ffmpegTest.for(['libopus', 'flac'] as const)(
    'MKV h264 + %s: video copied, audio AAC, master has a variant line',
    async (audioCodec, { binaryCapabilities, ffmpegVersion }) => {
      const source = makeMkv(audioCodec);
      expect(source, `could not build a ${audioCodec} MKV`).toBeDefined();

      const streamBasePath = `copy_${audioCodec}`;
      const args = runHybrid({
        source: source!,
        audioCodec: audioCodec === 'libopus' ? 'opus' : 'flac',
        streamBasePath,
        segmentNameFormat: 'seg%06d.ts',
        binaryCapabilities,
        ffmpegVersion,
      });

      const joined = args.join(' ');
      expect(joined).toContain('-c:v copy');
      expect(joined).toContain('-c:a aac');

      const dir = path.join(workdir, streamBasePath);
      const master = path.join(dir, 'playlist.m3u8');
      expect(existsSync(master)).toBe(true);
      expect(readFileSync(master, 'utf-8')).toContain('#EXT-X-STREAM-INF');

      const segment = readdirSync(dir).find((f) => f.endsWith('.ts'));
      expect(segment).toBeDefined();
      const probe = probeFile(binaries!.ffprobe, path.join(dir, segment!));
      const codecs = probe.streams.map(
        (s) => `${s.codec_type}:${s.codec_name}`,
      );
      expect(codecs).toContain('video:h264');
      expect(codecs).toContain('audio:aac');
    },
  );

  ffmpegTest(
    'a later copied program continues the session timeline (PTS offset)',
    async ({ binaryCapabilities, ffmpegVersion }) => {
      const source = makeMkv('flac');
      expect(source).toBeDefined();
      const common = {
        source: source!,
        audioCodec: 'flac',
        streamBasePath: 'copy_offset',
        binaryCapabilities,
        ffmpegVersion,
      };

      // Program 1 starts the session at 0; program 2 picks up at 60 s, the
      // offset HlsSession would compute from the last segment's end.
      runHybrid({ ...common, segmentNameFormat: 'a%06d.ts' });
      const args = runHybrid({
        ...common,
        segmentNameFormat: 'b%06d.ts',
        ptsOffset: 60 * 90000,
        isFirstTranscode: false,
      });
      expect(args.join(' ')).toContain('-output_ts_offset 60');

      const dir = path.join(workdir, 'copy_offset');
      // append_list keeps numbering across programs, so find each program's
      // first segment by its prefix.
      const firstSegment = (prefix: string) => {
        const name = readdirSync(dir)
          .filter((f) => f.startsWith(prefix) && f.endsWith('.ts'))
          .sort()[0];
        expect(name, `no ${prefix}*.ts in ${readdirSync(dir)}`).toBeDefined();
        return path.join(dir, name!);
      };
      const first = streamStarts(firstSegment('a'));
      const second = streamStarts(firstSegment('b'));
      expect(first['video']).toBeLessThan(5);
      expect(second['video']).toBeGreaterThanOrEqual(60);
      expect(second['video']).toBeLessThan(65);
      expect(second['audio']).toBeGreaterThanOrEqual(59);
      expect(second['audio']).toBeLessThan(65);
    },
  );

  ffmpegTest(
    'tuning in mid-program: audio starts with the copied video, not seconds later',
    async ({ binaryCapabilities, ffmpegVersion }) => {
      // 15 s source with a keyframe every 10 s (a long, Blu-ray-like GOP).
      const source = path.join(workdir, 'long_gop.mkv');
      const made = spawnSync(binaries!.ffmpeg, [
        '-y',
        '-stream_loop',
        '5',
        '-i',
        Fixtures.video720p,
        '-t',
        '15',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-g',
        '300',
        '-keyint_min',
        '300',
        '-sc_threshold',
        '0',
        '-c:a',
        'flac',
        source,
      ]);
      expect(made.status, made.stderr?.toString()).toBe(0);

      // Seek to 7 s: the copied video has to start at the 0 s keyframe.
      const args = runHybrid({
        source,
        audioCodec: 'flac',
        streamBasePath: 'copy_seek',
        segmentNameFormat: 's%06d.ts',
        startMs: 7000,
        binaryCapabilities,
        ffmpegVersion,
      });
      expect(args).toContain('-noaccurate_seek');

      const dir = path.join(workdir, 'copy_seek');
      const segment = readdirSync(dir)
        .filter((f) => f.endsWith('.ts'))
        .sort()[0];
      const starts = streamStarts(path.join(dir, segment!));
      expect(
        Math.abs(starts['audio']! - starts['video']!),
        JSON.stringify(starts),
      ).toBeLessThan(0.5);
    },
  );

  /**
   * Lip-sync clip: black video with one white frame every 2 s and a 100 ms
   * 1 kHz beep starting at the same instants. Video keyframe every 2 s.
   */
  function makeSyncClip(seconds: number) {
    const out = path.join(workdir, `sync_${seconds}.mkv`);
    const made = spawnSync(binaries!.ffmpeg, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=1280x720:r=25,drawbox=c=white:t=fill:enable=lt(mod(t\\,2)\\,0.04)',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=1000:sample_rate=48000,volume=if(lt(mod(t\\,2)\\,0.1)\\,1\\,0):eval=frame',
      '-t',
      `${seconds}`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-g',
      '50',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'flac',
      out,
    ]);
    expect(made.status, made.stderr?.toString()).toBe(0);
    return out;
  }

  /**
   * Read a session's segments back in order (the playlist's URIs carry the
   * stream base URL, so join the files instead) and pair every flash with the
   * nearest beep onset. Returns the offsets in ms (beep minus flash).
   */
  function measureSync(dir: string): number[] {
    const segments = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .sort()
      .map((f) => path.join(dir, f));
    const result = spawnSync(binaries!.ffmpeg, [
      '-hide_banner',
      '-nostats',
      '-i',
      `concat:${segments.join('|')}`,
      '-vf',
      'signalstats,metadata=print:key=lavfi.signalstats.YAVG',
      '-af',
      'silencedetect=n=-40dB:d=0.05',
      '-f',
      'null',
      '-',
    ]);
    const log = result.stderr.toString();
    const flashes: number[] = [];
    const beeps: number[] = [];
    let t = 0;
    let previous = 0;
    for (const line of log.split('\n')) {
      const pts = line.match(/pts_time:([0-9.]+)/);
      if (pts) t = Number(pts[1]);
      const luma = line.match(/YAVG=([0-9.]+)/);
      if (luma) {
        const y = Number(luma[1]);
        if (y > 128 && previous <= 128) flashes.push(t);
        previous = y;
      }
      const onset = line.match(/silence_end: ([0-9.]+)/);
      if (onset) beeps.push(Number(onset[1]));
    }
    return flashes.flatMap((f) => {
      const nearest = beeps.reduce(
        (best, b) => (Math.abs(b - f) < Math.abs(best - f) ? b : best),
        Infinity,
      );
      // A flash with no beep near it is the clip's first (audio starts
      // loud, so silencedetect reports no onset there).
      return Math.abs(nearest - f) < 0.5 ? [(nearest - f) * 1000] : [];
    });
  }

  // Broadcast lip-sync tolerance is roughly 45 ms audio-late / 15 ms early
  // (ITU-R BT.1359 detectability); one 25 fps frame is 40 ms.
  const maxSyncErrorMs = 45;

  ffmpegTest(
    'lip sync: copied video + AAC stay within 45 ms, from the start',
    async ({ binaryCapabilities, ffmpegVersion }) => {
      const clip = makeSyncClip(12);
      runHybrid({
        source: clip,
        audioCodec: 'flac',
        streamBasePath: 'sync_start',
        segmentNameFormat: 'a%06d.ts',
        binaryCapabilities,
        ffmpegVersion,
      });
      const offsets = measureSync(path.join(workdir, 'sync_start'));
      expect(offsets.length, JSON.stringify(offsets)).toBeGreaterThanOrEqual(4);
      for (const ms of offsets) {
        expect(Math.abs(ms), JSON.stringify(offsets)).toBeLessThanOrEqual(
          maxSyncErrorMs,
        );
      }
    },
  );

  ffmpegTest(
    'lip sync: tuning in mid-program keeps sync',
    async ({ binaryCapabilities, ffmpegVersion }) => {
      const clip = makeSyncClip(12);
      runHybrid({
        source: clip,
        audioCodec: 'flac',
        streamBasePath: 'sync_seek',
        segmentNameFormat: 'a%06d.ts',
        startMs: 3300,
        binaryCapabilities,
        ffmpegVersion,
      });
      const offsets = measureSync(path.join(workdir, 'sync_seek'));
      expect(offsets.length, JSON.stringify(offsets)).toBeGreaterThanOrEqual(3);
      for (const ms of offsets) {
        expect(Math.abs(ms), JSON.stringify(offsets)).toBeLessThanOrEqual(
          maxSyncErrorMs,
        );
      }
    },
  );

  ffmpegTest(
    'lip sync: a second copied program on the session timeline keeps sync',
    async ({ binaryCapabilities, ffmpegVersion }) => {
      const clip = makeSyncClip(12);
      const common = {
        source: clip,
        audioCodec: 'flac',
        streamBasePath: 'sync_two',
        binaryCapabilities,
        ffmpegVersion,
      };
      runHybrid({ ...common, segmentNameFormat: 'a%06d.ts' });
      // The session continues where program 1 ended (12 s).
      runHybrid({
        ...common,
        segmentNameFormat: 'b%06d.ts',
        ptsOffset: 12 * 90000,
        isFirstTranscode: false,
      });
      const offsets = measureSync(path.join(workdir, 'sync_two'));
      // Both programs' flashes, not just the first's.
      expect(offsets.length, JSON.stringify(offsets)).toBeGreaterThanOrEqual(9);
      for (const ms of offsets) {
        expect(Math.abs(ms), JSON.stringify(offsets)).toBeLessThanOrEqual(
          maxSyncErrorMs,
        );
      }
    },
  );

  ffmpegTest(
    'keyframeAtOrBefore is relative to the file start, like ffmpeg -ss (MPEG-TS starting at 10 s)',
    async ({ ffmpegInfo }) => {
      const ts = path.join(workdir, 'offset_start.ts');
      const made = spawnSync(binaries!.ffmpeg, [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=640x360:rate=30',
        '-t',
        '15',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-force_key_frames',
        'expr:gte(t,n_forced*5)',
        '-sc_threshold',
        '0',
        '-an',
        '-output_ts_offset',
        '10',
        ts,
      ]);
      expect(made.status, made.stderr?.toString()).toBe(0);
      // Keyframes every 5 s of content: a seek to 7 s lands on the 5 s one.
      const k = await ffmpegInfo.keyframeAtOrBefore(ts, dayjs.duration(7000));
      expect(k).toBeDefined();
      expect(Math.abs(k!.asMilliseconds() - 5000)).toBeLessThan(100);
    },
  );

  ffmpegTest(
    'sidecar subtitles start at the copied video keyframe after a mid-program tune-in',
    async ({ binaryCapabilities, ffmpegVersion, ffmpegInfo }) => {
      // 15 s source, keyframes at 0 s and 10 s; one cue at 10.0 s.
      const source = path.join(workdir, 'subs_long_gop.mkv');
      const made = spawnSync(binaries!.ffmpeg, [
        '-y',
        '-stream_loop',
        '5',
        '-i',
        Fixtures.video720p,
        '-t',
        '15',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-g',
        '300',
        '-keyint_min',
        '300',
        '-sc_threshold',
        '0',
        '-c:a',
        'flac',
        source,
      ]);
      expect(made.status, made.stderr?.toString()).toBe(0);
      const srt = path.join(workdir, 'ten.srt');
      writeFileSync(srt, '1\n00:00:10,000 --> 00:00:11,000\nTEN\n');

      // Tune in at 7 s: the copied video can only start at the 0 s keyframe.
      const keyframe = await ffmpegInfo.keyframeAtOrBefore(
        source,
        dayjs.duration(7000),
      );
      // The first video frame of the clip is one frame (33 ms) in.
      expect(keyframe!.asMilliseconds()).toBeLessThan(100);

      runHybrid({
        source,
        audioCodec: 'flac',
        streamBasePath: 'subs_seek',
        segmentNameFormat: 'v%06d.ts',
        startMs: 7000,
        subtitlePath: srt,
        subtitleStartMs: keyframe!.asMilliseconds(),
        binaryCapabilities,
        ffmpegVersion,
      });

      const dir = path.join(workdir, 'subs_seek');
      const vtt = readdirSync(dir)
        .filter((f) => f.endsWith('.vtt'))
        .map((f) => readFileSync(path.join(dir, f), 'utf-8'))
        .join('\n');
      const cue = vtt.match(/(?:(\d+):)?(\d+):(\d+\.\d+) -->[^\n]*\nTEN/);
      expect(cue, vtt).not.toBeNull();
      const seconds =
        Number(cue![1] ?? 0) * 3600 + Number(cue![2]) * 60 + Number(cue![3]);
      // The video shows content 10 s at output 10 s minus the keyframe offset,
      // so the cue must too (seeking the subtitles to 7 s would put it at 3 s).
      expect(Math.abs(seconds - (10 - keyframe!.asSeconds()))).toBeLessThan(
        0.05,
      );
    },
  );
});
