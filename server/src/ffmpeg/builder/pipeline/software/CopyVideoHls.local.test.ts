import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
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
import {
  AudioFormats,
  defaultHlsOptions,
  HlsOutputFormat,
  VideoFormats,
} from '../../constants.ts';
import { PixelFormatYuv420P } from '../../format/PixelFormat.ts';
import { AudioInputSource } from '../../input/AudioInputSource.ts';
import { VideoInputSource } from '../../input/VideoInputSource.ts';
import { AudioStream, VideoStream } from '../../MediaStream.ts';
import { AudioState } from '../../state/AudioState.ts';
import {
  DefaultPipelineOptions,
  FfmpegState,
} from '../../state/FfmpegState.ts';
import { FrameState } from '../../state/FrameState.ts';
import { FrameSize } from '../../types.ts';
import { SoftwarePipelineBuilder } from './SoftwarePipelineBuilder.ts';

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

  ffmpegTest.for(['libopus', 'flac'] as const)(
    'MKV h264 + %s: video copied, audio AAC, master has a variant line',
    async (audioCodec, { binaryCapabilities, ffmpegVersion }) => {
      const source = makeMkv(audioCodec);
      expect(source, `could not build a ${audioCodec} MKV`).toBeDefined();

      const video = VideoInputSource.withStream(
        new FileStreamSource(source!),
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
        new FileStreamSource(source!),
        AudioStream.create({
          channels: 2,
          codec: audioCodec === 'libopus' ? 'opus' : 'flac',
          index: 1,
        }),
        AudioState.create({
          audioEncoder: AudioFormats.Aac,
          audioChannels: 2,
          audioBitrate: 192,
          audioBufferSize: 384,
          audioSampleRate: 48,
        }),
      );

      const builder = new SoftwarePipelineBuilder(
        video,
        audio,
        null,
        null,
        null,
        binaryCapabilities,
      );

      const streamBasePath = `copy_${audioCodec}`;
      // HlsSession creates the session directory before ffmpeg starts.
      mkdirSync(path.join(workdir, streamBasePath), { recursive: true });
      const pipeline = builder.build(
        FfmpegState.create({
          version: ffmpegVersion,
          outputFormat: HlsOutputFormat({
            ...defaultHlsOptions,
            segmentBaseDirectory: workdir,
            streamBasePath,
            segmentNameFormat: 'seg%06d.ts',
            streamNameFormat: 'stream.m3u8',
          }),
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
      const { exitCode, stderr } = runFfmpegWithPipeline(
        binaries!.ffmpeg,
        args,
      );
      expect(exitCode, `${args.join(' ')}\n${stderr}`).toBe(0);

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
});
