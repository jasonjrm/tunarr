import type { ISettingsDB } from '@/db/interfaces/ISettingsDB.js';
import type { ChannelOrmWithTranscodeConfig } from '@/db/schema/derivedTypes.js';
import type { FfmpegTranscodeSession } from '@/ffmpeg/FfmpegTrancodeSession.js';
import type { SegmentStreamEnds } from '@/ffmpeg/GetSegmentStreamEnds.js';
import { GetSegmentStreamEndsTask } from '@/ffmpeg/GetSegmentStreamEnds.js';
import { MeasureAudioEncoderLeadTask } from '@/ffmpeg/MeasureAudioEncoderLeadTask.js';
import type { HlsOptions } from '@/ffmpeg/builder/constants.js';
import {
  HlsDirectOutputFormat,
  HlsOutputFormat,
} from '@/ffmpeg/builder/constants.js';
import type { OnDemandChannelService } from '@/services/OnDemandChannelService.js';
import { PlayerContext } from '@/stream/PlayerStreamContext.js';
import type { StopOptions } from '@/stream/Session.js';
import type { StreamProgramCalculator } from '@/stream/StreamProgramCalculator.js';
import type { HlsSlowerSession } from '@/stream/hls/HlsSlowerSession.js';
import type {
  AudioRenditionInfo,
  SubtitleRenditionInfo,
} from '@/stream/types.js';
import { Result } from '@/types/result.js';
import type { Maybe } from '@/types/util.js';
import { isContentBackedLineupItem } from '@/db/derived_types/StreamLineup.js';
import { resolveFeatureFlagFromEnv } from '@/services/FeatureFlagService.js';
import { TUNARR_ENV_VARS } from '@/util/env.js';
import { isCopyVideoChannel } from '@/util/copyVideoChannels.js';
import { fileExists } from '@/util/fsUtil.js';
import { wait } from '@/util/index.js';
import { seq } from '@tunarr/shared/util';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { filter, isEmpty, last, maxBy, sortBy } from 'lodash-es';
import fs from 'node:fs/promises';
import path, { basename, dirname, extname } from 'node:path';
import type { DeepRequired } from 'ts-essentials';
import type { ProgramStreamFactory } from '../ProgramStreamFactory.ts';
import type { BaseHlsSessionOptions } from './BaseHlsSession.js';
import { BaseHlsSession, SegmentNameRegex } from './BaseHlsSession.js';
import { HlsMasterPlaylistMutator } from './HlsMasterPlaylistMutator.js';
import type {
  FilterBeforeSegmentNumber,
  HlsPlaylistFilterOptions,
} from './HlsPlaylistMutator.js';
import { HlsPlaylistMutator } from './HlsPlaylistMutator.js';
import type { Cue } from './HlsSubtitlePlaylist.js';
import {
  firstNeededCueFile,
  parseCues,
  segmentWindows,
  subtitlePlaylistFromVideo,
  subtitleWindowVtt,
} from './HlsSubtitlePlaylist.js';

export type HlsSessionProvider = (
  channel: ChannelOrmWithTranscodeConfig,
  options: HlsSessionOptions,
) => HlsSession;

export type HlsSlowerSessionProvider = (
  channel: ChannelOrmWithTranscodeConfig,
  options: BaseHlsSessionOptions,
) => HlsSlowerSession;

export interface HlsSessionOptions extends BaseHlsSessionOptions {
  streamMode: 'hls' | 'hls_direct_v2';
}

/**
 * Initializes an ffmpeg process that concatenates via the /playlist
 * endpoint and outputs an HLS format + segments
 */
// A copied program that ends more than this far short of its length, even
// with exit code 0, is treated as failed (TODO CT-4).
const CopyFallbackShortfallMs = 10_000;

export class HlsSession extends BaseHlsSession<HlsSessionOptions> {
  #playlistStart?: Dayjs;
  #hlsPlaylistMutator: HlsPlaylistMutator = new HlsPlaylistMutator();
  #currentSession: Maybe<FfmpegTranscodeSession>;
  #lastDelete: Dayjs = dayjs().subtract(1, 'year');
  #lastSubtitleDelete: Dayjs = dayjs().subtract(1, 'year');
  #audioEncoderLead?: Promise<number>;
  #lastServedPlaylist: string | undefined;

  // Session time, in seconds, of the first entry in the on-disk stream.m3u8.
  // Anything that trims that file must add the removed segments' EXTINF
  // durations here, or subtitle windows shift.
  #playlistStartOffset = 0;

  #cueFiles = new Map<number, Cue[]>();
  #isFirstTranscode = true;
  #lastDiscontinuitySequence: number | undefined;
  #currentSubtitleRendition: SubtitleRenditionInfo | undefined;
  #currentAudioRenditions: AudioRenditionInfo[] = [];
  // Taken once, here: a live-config edit applies to the next session, never to
  // one that is already streaming, and every program in this session agrees.
  readonly #copyVideo: boolean;
  // The subtitle rendition the master playlist advertises, fixed for the
  // session once chosen (clients read the master once, at tune-in).
  #advertisedSubtitles: SubtitleRenditionInfo | null | undefined;
  // Programs whose copied video failed in this session. They are retried, and
  // replayed later in the session, as a full transcode.
  readonly #copyVideoFailed = new Set<string>();

  constructor(
    channel: ChannelOrmWithTranscodeConfig,
    options: HlsSessionOptions,
    private programCalculator: StreamProgramCalculator,
    private settingsDB: ISettingsDB,
    private onDemandService: OnDemandChannelService,
    private programStreamFactory: ProgramStreamFactory,
  ) {
    super(channel, options);
    this.#copyVideo = isCopyVideoChannel(channel.number);
  }

  public get sessionType(): HlsSessionOptions['streamMode'] {
    return this.sessionOptions.streamMode;
  }

  async getPlaylist() {
    return this.readPlaylist();
  }

  async getMasterPlaylist(): Promise<Result<string | undefined>> {
    return Result.attemptAsync(async () => {
      if (!(await fileExists(this._masterPlaylistPath))) {
        return undefined;
      }
      const content = await fs.readFile(this._masterPlaylistPath, 'utf-8');
      const rendition = this.advertisedSubtitleRendition();
      const hlsOptions = this.getHlsOptions();
      const lines = HlsMasterPlaylistMutator.rewriteVariantPlaylistUrls(
        content,
        rendition,
        hlsOptions,
      );
      if (rendition) {
        HlsMasterPlaylistMutator.injectSubtitleMediaTag(
          lines,
          rendition,
          hlsOptions,
        );
      }
      if (this.#currentAudioRenditions.length > 0) {
        HlsMasterPlaylistMutator.injectAudioMediaTags(
          lines,
          this.#currentAudioRenditions,
          hlsOptions,
        );
      }
      return lines.join('\n');
    });
  }

  async trimPlaylist(filterOpts?: HlsPlaylistFilterOptions) {
    return Result.attemptAsync(async () => {
      return await this.lock.runExclusive(async () => {
        const playlistLines = await this.readPlaylist();
        if (playlistLines) {
          const trimResult = this.#hlsPlaylistMutator.trimPlaylist(
            this.#playlistStart!,
            filterOpts,
            playlistLines,
            {
              maxSegmentsToKeep: 20,
              targetDuration: this.getHlsOptions().hlsTime,
              previousDiscontinuitySequence: this.#lastDiscontinuitySequence,
              endWithDiscontinuity: false,
            },
          );
          this.#lastDiscontinuitySequence = trimResult.discontinuitySequence;
          this.#lastServedPlaylist = trimResult.playlist;
          const now = dayjs();
          if (now.isAfter(this.#lastDelete.add(30, 'seconds'))) {
            this.logger.debug(
              'Deleting old segments from stream (channel id = %s, number = %d)',
              this.channel.uuid,
              this.channel.number,
            );
            this.deleteOldSegmentFiles(trimResult.sequence, [
              '.ts',
              '.mp4',
            ]).catch((e) => this.logger.error(e));
            this.#lastDelete = now;
          }

          return trimResult;
        }

        this.logger.trace(
          'No playlist for HLS sessions at %s',
          this._m3u8PlaylistPath,
        );
        return;
      });
    });
  }

  /**
   * Subtitle playlist aligned segment for segment with the last video playlist
   * served. The segment muxer only writes a .vtt when there is a cue, so its
   * own playlist covers far less time than the video and players that lay
   * segments out by EXTINF (AVPlayer) never show the cues. Transcoded HLS
   * only: hls_direct_v2 keeps cues on the source clock (-copyts).
   */
  async alignedSubtitlePlaylist() {
    if (this.#lastServedPlaylist === undefined) {
      const trimmed = await this.trimPlaylist();
      if (trimmed.isFailure()) {
        throw trimmed.error;
      }
    }
    const served = this.#lastServedPlaylist;
    if (served === undefined) {
      return;
    }
    await this.pruneCueFiles(served);
    return subtitlePlaylistFromVideo(served);
  }

  /** WebVTT holding the cues that start inside video segment `segmentNumber`. */
  async subtitleWindow(segmentNumber: number) {
    const window = await this.segmentWindow(segmentNumber);
    if (!window) {
      return;
    }
    const cueFiles = await this.readCueFiles();
    return subtitleWindowVtt([...cueFiles.values()].flat(), ...window);
  }

  private async segmentWindow(segmentNumber: number) {
    const playlistLines = await this.readPlaylist();
    return playlistLines
      ? segmentWindows(playlistLines.join('\n'), this.#playlistStartOffset).get(
          segmentNumber,
        )
      : undefined;
  }

  private async readCueFiles() {
    const files = seq.collect(
      await fs.readdir(this._workingDirectory),
      (file) => {
        const n = file.match(/^sub(\d+)\.vtt$/)?.[1];
        return n === undefined ? undefined : ([parseInt(n), file] as const);
      },
    );
    const newest = Math.max(...files.map(([n]) => n));
    const cueFiles = new Map<number, Cue[]>();
    for (const [n, file] of files) {
      // ffmpeg may still be writing the newest file; older ones are final.
      const cues =
        (n === newest ? undefined : this.#cueFiles.get(n)) ??
        parseCues(
          await fs
            .readFile(path.join(this._workingDirectory, file), 'utf-8')
            .catch(() => ''),
        );
      if (n !== newest) {
        this.#cueFiles.set(n, cues);
      }
      cueFiles.set(n, cues);
    }
    return cueFiles;
  }

  private async pruneCueFiles(servedPlaylist: string) {
    const now = dayjs();
    if (!now.isAfter(this.#lastSubtitleDelete.add(30, 'seconds'))) {
      return;
    }
    this.#lastSubtitleDelete = now;
    const firstSegment = servedPlaylist.match(
      /#EXT-X-MEDIA-SEQUENCE:(\d+)/,
    )?.[1];
    const window =
      firstSegment === undefined
        ? undefined
        : await this.segmentWindow(parseInt(firstSegment));
    if (!window) {
      return;
    }
    const keepFrom = firstNeededCueFile(await this.readCueFiles(), window[0]);
    if (keepFrom === undefined) {
      return;
    }
    for (const n of this.#cueFiles.keys()) {
      if (n < keepFrom) {
        this.#cueFiles.delete(n);
      }
    }
    this.deleteOldSegmentFiles(keepFrom, ['.vtt']).catch((e) =>
      this.logger.error(e),
    );
  }

  async trimSubtitlePlaylist(filterOpts?: FilterBeforeSegmentNumber) {
    return Result.attemptAsync(async () => {
      return await this.lock.runExclusive(async () => {
        const playlistLines = await this.readSubtitlePlaylist();
        if (playlistLines) {
          const trimResult = this.#hlsPlaylistMutator.trimSubtitlePlaylist(
            playlistLines,
            filterOpts,
            { maxSegmentsToKeep: 20 },
          );

          const now = dayjs();
          if (now.isAfter(this.#lastSubtitleDelete.add(30, 'seconds'))) {
            this.deleteOldSegmentFiles(trimResult.sequence, ['.vtt']).catch(
              (e) => this.logger.error(e),
            );
            this.#lastSubtitleDelete = now;
          }

          return trimResult;
        }

        this.logger.trace(
          'No subtitle playlist for HLS sessions at %s',
          this._subtitlePlaylistPath,
        );
        return;
      });
    });
  }

  protected async startInternal() {
    if (this.state === 'started') {
      return;
    }

    await this.initDirectories();

    this.state = 'started';
    this.#playlistStart = this.transcodedUntil = dayjs();

    // Measure while the first program transcodes, so the first program
    // boundary does not wait on it.
    if (this.sessionOptions.streamMode === 'hls') {
      void this.getAudioEncoderLead();
    }

    // Fire-and-forget
    this.run().catch((e) => this.logger.error(e));
  }

  private async run() {
    while (this.state === 'started') {
      const transcodeBuffer = dayjs
        .duration(dayjs(this.transcodedUntil).diff())
        .asSeconds();

      if (transcodeBuffer <= 60) {
        const realtime = transcodeBuffer >= 30;
        this.logger.trace(
          'Transcode buffer is %d. Starting next transcode (realtime = %s)',
          transcodeBuffer,
          realtime,
        );
        await this.transcode(realtime);
        this.#isFirstTranscode = false;
      } else {
        // trim and delete
        // await this.trimPlaylistAndDeleteSegments();
        await wait(dayjs.duration({ seconds: 5 }));
      }
    }

    this.logger.debug('HLS worker ended main loop with state = %s', this.state);

    // Only schedule cleanup if the session wasn't already explicitly stopped
    // (e.g. via endSession). If the session is already stopped, its cleanup
    // has been handled and scheduling another timer would risk deleting a
    // replacement session that now occupies the same map key.
    if (!this.stoppingOrStopped) {
      this.scheduleCleanup();
    }
  }

  protected async stopInternal(options: StopOptions): Promise<void> {
    try {
      await this.stopStream(options);
    } catch (e) {
      this.logger.error(e, 'Error while shutting down session');
    }
  }

  private async transcode(realtime: boolean) {
    const ptsOffset =
      this.#isFirstTranscode ||
      this.sessionOptions.streamMode === 'hls_direct_v2'
        ? 0
        : await this.getPtsOffset();
    // Unlike ptsOffset, this applies regardless of isFirstTranscode/
    // streamMode: scanning a fresh/empty working directory already
    // naturally yields 0, and hls_direct_v2's subs.m3u8 has the same
    // restart-numbering problem as hls (only the video/audio -copyts
    // handling is hls_direct_v2-specific).
    const subtitleSegmentStartNumber =
      await this.getLastSubtitleSegmentNumber();

    const lineupItemResult = await this.programCalculator.getCurrentLineupItem({
      allowSkip: true,
      channelId: this.channel.uuid,
      startTime: await this.onDemandService.getLiveTimestamp(
        this.channel.uuid,
        +(this.transcodedUntil ?? dayjs()),
      ),
    });

    const transcodeResult = await lineupItemResult.mapAsync(async (result) => {
      this.logger.debug(
        'About to play lineup item: %s',
        JSON.stringify(result.lineupItem, undefined, 4),
      );
      const context = new PlayerContext(
        result.lineupItem,
        result.channelContext,
        result.sourceChannel,
        this.channel.transcodeConfig,
        {
          audioOnly: false,
          realtime,
          streamMode: this.sessionType,
        },
      );

      // Offline and error items have no program, and never copy video.
      const programId = isContentBackedLineupItem(result.lineupItem)
        ? result.lineupItem.program.uuid
        : undefined;
      let programStream = this.getProgramStream(
        context,
        ptsOffset,
        subtitleSegmentStartNumber,
        programId === undefined || !this.#copyVideoFailed.has(programId),
      );

      programStream.on('error', () => {
        this.state = 'error';
        this.error = new Error(
          `Unrecoverable error in underlying FFMPEG process`,
        );
        this.emit('error', this.error);
      });

      let transcodeSessionResult = await programStream.setup();

      if (transcodeSessionResult.isFailure()) {
        this.logger.error(
          transcodeSessionResult.error,
          'Error while starting program stream. Attempting to subtitute with error stream',
        );

        programStream = this.getProgramStream(
          PlayerContext.error(
            result.lineupItem.streamDuration ?? result.lineupItem.duration,
            transcodeSessionResult.error,
            result.channelContext,
            this.channel,
            realtime,
            this.channel.transcodeConfig,
            this.sessionType,
          ),
          ptsOffset,
          subtitleSegmentStartNumber,
        );

        transcodeSessionResult = await programStream.setup();

        if (transcodeSessionResult.isFailure()) {
          this.state = 'error';
          this.error = transcodeSessionResult.error;
          this.emit('error', this.error);
        }
      }

      // A stop that landed during setup has already killed the previous
      // transcode. Starting this one would leave an ffmpeg nothing kills.
      if (this.state !== 'started') {
        return;
      }

      const programStart = this.transcodedUntil ?? dayjs();
      transcodeSessionResult.forEach((transcodeSession) => {
        this.transcodedUntil = programStart.add(
          transcodeSession.streamDuration,
        );
        this.#currentSession = transcodeSession;
        this.#currentSubtitleRendition = programStream.renditions?.subtitle;
        this.#currentAudioRenditions = programStream.renditions?.audio ?? [];
      });

      if (this.sessionOptions.streamMode === 'hls') {
        // await this.trimPlaylistAndDeleteSegments();
      }
      await programStream.start();
      const exit = await programStream.transcodeSession!.wait();
      if (programStream.copiedVideo && programId !== undefined) {
        await this.fallBackIfCopyFailed(
          programId,
          exit.code,
          programStart,
          ptsOffset,
        );
      }
      return exit;
    });

    if (transcodeResult.isFailure()) {
      this.logger.error(
        transcodeResult.error,
        'Error while transcoding program stream.',
      );
    }

    this.logger.debug('Stream ended.');
  }

  /**
   * A copied-video program whose ffmpeg failed, or ended well short of its
   * length, is played again from where its output stopped, as a full
   * transcode: rewind the schedule position to what was actually written and
   * let the main loop pick the same program up there.
   */
  private async fallBackIfCopyFailed(
    programId: string,
    exitCode: number | null,
    programStart: Dayjs,
    ptsOffset: number,
  ) {
    if (this.state !== 'started') {
      return; // stopped or killed by us
    }
    const expectedMs = dayjs(this.transcodedUntil).diff(programStart);
    const nextOffset = await this.measurePtsOffset();
    if (nextOffset === undefined && exitCode === 0) {
      // Ended cleanly but the output could not be measured: don't replay a
      // program that probably played in full.
      return;
    }
    const writtenMs = Math.max(0, ((nextOffset ?? ptsOffset) - ptsOffset) / 90);
    const shortMs = expectedMs - writtenMs;
    if (exitCode === 0 && shortMs <= CopyFallbackShortfallMs) {
      return;
    }
    this.#copyVideoFailed.add(programId);
    this.transcodedUntil = programStart.add(Math.min(writtenMs, expectedMs));
    this.logger.warn(
      'Channel %d program %s: copied video ended after %ds of %ds (exit code %s); retrying the rest as a full transcode',
      this.channel.number,
      programId,
      Math.round(writtenMs / 1000),
      Math.round(expectedMs / 1000),
      exitCode ?? 'none',
    );
  }

  /**
   * One subtitle rendition for the whole session, so a viewer who tunes in
   * during a program without subtitles still gets them for later programs.
   * Advertised when the WebVTT sidecar is on and the channel can select
   * subtitles; programs without any serve empty windows. Off by default
   * (DEFAULT/AUTOSELECT=NO): the viewer switches it on with CC.
   */
  private advertisedSubtitleRendition(): SubtitleRenditionInfo | undefined {
    if (this.#advertisedSubtitles === undefined) {
      const current = this.#currentSubtitleRendition;
      if (this.sidecarEnabled() && this.channelMaySelectSubtitles()) {
        this.#advertisedSubtitles = {
          language: current?.language ?? 'und',
          languageName: current?.languageName,
          title: 'Subtitles',
          default: false,
          forced: false,
        };
      } else if (current) {
        // Sidecar off but a rendition exists (e.g. hls_direct_v2): keep the
        // per-program behaviour, without switching it on for the viewer.
        return { ...current, default: false };
      } else {
        return undefined;
      }
    }
    return this.#advertisedSubtitles ?? undefined;
  }

  private channelMaySelectSubtitles(): boolean {
    return (
      !!this.channel.subtitlesEnabled || !!this.channel.streamSelectionProfileId
    );
  }

  // Same resolution as FeatureFlagService: an env override wins, else settings.
  private sidecarEnabled(): boolean {
    const envValue = process.env[TUNARR_ENV_VARS.WEBVTT_SIDECAR_ENABLED];
    if (envValue !== undefined && envValue !== '') {
      return resolveFeatureFlagFromEnv('webvttSidecarEnabled');
    }
    try {
      return this.settingsDB.featureFlags().webvttSidecarEnabled ?? false;
    } catch {
      return false;
    }
  }

  protected override getAdditionalRequiredFiles(): string[] {
    // Transcoded HLS serves a subtitle playlist built from the video playlist
    // (alignedSubtitlePlaylist), so it never waits for ffmpeg's own subs.m3u8.
    // ffmpeg's segment muxer writes that file only once the first cue arrives,
    // so waiting for it failed the start whenever the next line of dialogue
    // was more than the 15 s start timeout away (an opening song, a quiet
    // scene). hls_direct_v2 does serve ffmpeg's file.
    return this.#currentSubtitleRendition &&
      this.sessionOptions.streamMode === 'hls_direct_v2'
      ? [this.getHlsOptions().subtitleStreamNameFormat]
      : [];
  }

  protected getHlsOptions(): DeepRequired<HlsOptions> {
    return {
      hlsDeleteThreshold: 3,
      streamNameFormat: 'stream.m3u8',
      subtitleStreamNameFormat: 'subs.m3u8',
      segmentNameFormat: BaseHlsSession.SegmentNameFormat,
      segmentBaseDirectory: dirname(this.workingDirectory),
      streamBasePath: basename(this.workingDirectory),
      streamBaseUrl: `/stream/channels/${this.channel.uuid}/${this.sessionType}/`,
      hlsTime: 4,
      hlsListSize: 0,
      deleteThreshold: null,
      appendSegments: true,
    };
  }

  private getProgramStream(
    context: PlayerContext,
    ptsOffset: Maybe<number>,
    subtitleSegmentStartNumber: Maybe<number>,
    allowCopyVideo: boolean = true,
  ) {
    const hlsOptions = this.getHlsOptions();

    const outputFormat =
      this.sessionType === 'hls_direct_v2'
        ? HlsDirectOutputFormat(hlsOptions)
        : HlsOutputFormat(hlsOptions);

    return this.programStreamFactory(context, outputFormat, {
      ptsOffset,
      isFirstTranscode: this.#isFirstTranscode,
      subtitleSegmentStartNumber,
      copyVideo: this.#copyVideo && allowCopyVideo,
    });
  }

  private async getPtsOffset() {
    return (await this.measurePtsOffset()) ?? 0;
  }

  /**
   * The PTS (90 kHz ticks) the next program should start at, from the newest
   * segment; undefined when there is no segment or it could not be probed.
   */
  private async measurePtsOffset(): Promise<number | undefined> {
    const lastSegment = await this.getLastSegment();

    if (!lastSegment) {
      if (!this.#isFirstTranscode) {
        this.logger.debug('No last segment found. Starting with PTS offset 0.');
      }
      return undefined;
    }

    const result = await new GetSegmentStreamEndsTask(this.settingsDB).run(
      lastSegment,
    );

    if (result.isFailure()) {
      this.logger.error(result.error);
      return undefined;
    }

    return nextProgramPtsOffset(result.get(), await this.getAudioEncoderLead());
  }

  private getAudioEncoderLead(): Promise<number> {
    this.#audioEncoderLead ??= this.measureAudioEncoderLead().catch((e) => {
      this.logger.warn(
        e,
        'Could not measure the audio encoder lead. Audio may overlap at program boundaries.',
      );
      return 0;
    });
    return this.#audioEncoderLead;
  }

  private async measureAudioEncoderLead(): Promise<number> {
    const { audioFormat, audioSampleRate, audioChannels } =
      this.channel.transcodeConfig;
    if (audioFormat === 'copy') {
      return 0;
    }

    const result = await new MeasureAudioEncoderLeadTask(
      this.settingsDB.ffmpegSettings().ffmpegExecutablePath,
    ).run({
      encoder: audioFormat,
      sampleRateKhz: audioSampleRate,
      channels: audioChannels,
    });

    if (result.isFailure()) {
      this.logger.warn(
        result.error,
        'Could not measure the audio encoder lead. Audio may overlap at program boundaries.',
      );
      return 0;
    }

    this.logger.debug(
      'Audio encoder %s starts %d ticks before the output offset',
      audioFormat,
      result.get(),
    );
    return result.get();
  }

  private async getLastSegment() {
    const workingDirectoryFiles = await Result.attemptAsync(() =>
      fs.readdir(this._workingDirectory),
    );

    if (workingDirectoryFiles.isFailure()) {
      this.logger.error(workingDirectoryFiles.error);
      return;
    }

    if (workingDirectoryFiles.get().length === 0) {
      return;
    }

    const p = last(
      sortBy(
        filter(
          workingDirectoryFiles.get(),
          (f) => extname(f) === '.ts' || extname(f) === '.mp4',
        ),
      ),
    );

    if (p) {
      return path.join(this._workingDirectory, p);
    }

    return;
  }

  private async getLastSubtitleSegmentNumber(): Promise<number> {
    const workingDirectoryFiles = await Result.attemptAsync(() =>
      fs.readdir(this._workingDirectory),
    );

    if (workingDirectoryFiles.isFailure()) {
      this.logger.error(workingDirectoryFiles.error);
      return 0;
    }

    const numbers = seq.collect(
      filter(workingDirectoryFiles.get(), (f) => extname(f) === '.vtt'),
      (file) => {
        const matches = file.match(SegmentNameRegex);
        if (!matches || matches.length < 2) {
          return;
        }
        const n = parseInt(matches[1]!);
        return isNaN(n) ? undefined : n;
      },
    );

    if (isEmpty(numbers)) {
      return 0;
    }

    return Math.max(...numbers) + 1;
  }

  isStale(): boolean {
    const remainingConnections = this.removeStaleConnections();
    return isEmpty(remainingConnections);
  }

  private get _subtitlePlaylistPath() {
    return path.join(
      this._workingDirectory,
      this.getHlsOptions().subtitleStreamNameFormat,
    );
  }

  private async readPlaylist() {
    if (!(await fileExists(this._m3u8PlaylistPath))) {
      return;
    }

    const playlistContents = await fs.readFile(this._m3u8PlaylistPath, {
      encoding: 'utf-8',
    });

    return playlistContents.toString().split('\n');
  }

  private async readSubtitlePlaylist() {
    if (!(await fileExists(this._subtitlePlaylistPath))) {
      return;
    }

    const playlistContents = await fs.readFile(this._subtitlePlaylistPath, {
      encoding: 'utf-8',
    });

    return playlistContents.toString().split('\n');
  }

  private async deleteOldSegmentFiles(
    sequenceNum: number,
    extensions: string[],
  ) {
    const workingDirectoryFiles = await fs.readdir(this._workingDirectory);
    const segments = filter(
      seq.collect(
        filter(workingDirectoryFiles, (f) => extensions.includes(extname(f))),
        (file) => {
          const matches = file.match(SegmentNameRegex);
          if (!matches || matches.length < 2) {
            return;
          }
          const n = parseInt(matches[1]!);
          if (isNaN(n)) {
            return;
          }
          return {
            file,
            seq: n,
          };
        },
      ),
      ({ seq }) => seq < sequenceNum,
    );

    if (segments.length > 0) {
      this.logger.trace(
        'Deleting %d segments. Max segment number: %d',
        segments.length,
        maxBy(segments, (seg) => seg.seq)?.seq ?? 0,
      );
    }

    for (const { file } of segments) {
      try {
        await fs.unlink(path.join(this._workingDirectory, file));
      } catch (e) {
        this.logger.error(e);
      }
    }
  }

  protected async stopStream(options: StopOptions): Promise<void> {
    if (this.#currentSession) {
      this.#currentSession.kill();
      await this.waitForExit(this.#currentSession, options);
    }

    this.logger.debug(
      `Cleaning out stream path for session: %s`,
      this._workingDirectory,
    );

    return await this.cleanupDirectory();
  }
}

/**
 * Where the next program starts, in 90 kHz ticks. Its video must start after
 * every previous stream has ended. Its audio encoder places the first audio
 * packet `audioEncoderLeadTicks` before the offset, so the offset also sits
 * at least that far past the previous audio's end. When that is the later of
 * the two, the new audio continues exactly where the old audio stopped and
 * only the video timeline skips ahead.
 */
export function nextProgramPtsOffset(
  previous: SegmentStreamEnds,
  audioEncoderLeadTicks: number,
): number {
  const audioBound =
    previous.audioEnd === undefined
      ? -Infinity
      : previous.audioEnd + audioEncoderLeadTicks;
  const nonAudioBound = previous.nonAudioEnd ?? -Infinity;
  return Math.max(audioBound, nonAudioBound) + 1;
}
