import type {
  AudioStreamDetails,
  SubtitleStreamDetails,
  VideoStreamDetails,
} from '@/stream/types.js';
import { isImageBasedSubtitle } from '@/stream/util.js';
import type { Maybe } from '@/types/util.js';

/**
 * Per-program copy-or-transcode decision.
 *
 * Every program decides on its own whether its video can be copied and
 * whether its (single, already selected) audio track can be copied. Anything
 * the client or the HLS transport can't take falls back to the normal
 * transcode path. `reasons` explains every transcode so it can be logged and
 * reported by the library scanner.
 *
 * This is a pure function: no I/O, no settings lookups. Callers pass in the
 * streams the stream selector already picked.
 */

export type VideoDecision = 'copy' | 'transcode';
export type AudioDecision = 'copy' | 'transcode';
export type SubtitleDecision = 'off' | 'sidecar' | 'burn';

export type CopyOrTranscodeDecision = {
  video: VideoDecision;
  audio: AudioDecision;
  subtitles: SubtitleDecision;
  reasons: string[];
};

export type ClientProfile = {
  /** Video codec -> allowed profiles (lowercase, as ffprobe reports them). */
  videoCodecs: Record<string, { profiles: string[]; maxBitDepth: number }>;
  maxWidth: number;
  maxHeight: number;
  hdr: boolean;
  audioCodecs: string[];
  maxAudioChannels: number;
};

/** What can be copied into the MPEG-TS HLS segments we write today. */
export const MpegTsTransport = {
  videoCodecs: ['h264', 'hevc', 'mpeg2video'],
  audioCodecs: ['aac', 'ac3', 'eac3', 'mp3', 'mp2'],
} as const;

/**
 * Syndie (Media3 / ExoPlayer on Android TV, Fire TV, phones, tablets).
 *
 * One session is shared by every viewer of a channel, so this has to be what
 * EVERY device can play, not the best one. Kept conservative on purpose:
 * - no Hi10P H.264 (no Android hardware decoder);
 * - no HDR until tonemap-vs-passthrough is device-tested;
 * - AAC only: AC-3/E-AC-3 are silent in Chrome and untested on the TVs.
 */
export const SyndieClientProfile: ClientProfile = {
  videoCodecs: {
    h264: {
      profiles: ['constrained baseline', 'baseline', 'main', 'high'],
      maxBitDepth: 8,
    },
    hevc: { profiles: ['main', 'main 10'], maxBitDepth: 10 },
  },
  maxWidth: 1920,
  maxHeight: 1080,
  hdr: false,
  audioCodecs: ['aac'],
  maxAudioChannels: 2,
};

export type ChannelCopyPolicy = {
  mode: 'auto' | 'always-transcode';
  /** Copy video only at or below this bitrate. Undefined = no cap. */
  maxVideoBitrateKbps?: number;
  /** A server-side watermark has to be drawn into the video. */
  watermark: boolean;
  /** Loudness normalization runs on the audio. */
  loudnorm: boolean;
  /** ASS/SSA: keep styling by burning, or send as plain WebVTT. */
  assSubtitles: 'sidecar' | 'burn';
  /** The webvttSidecarEnabled feature flag. Off = every subtitle burns. */
  sidecarEnabled: boolean;
};

export type CopyOrTranscodeInput = {
  video: Maybe<VideoStreamDetails>;
  /** Total container bitrate (bps), used when the stream has none. */
  containerBitrate?: number;
  audio: Maybe<AudioStreamDetails>;
  subtitle: Maybe<SubtitleStreamDetails>;
  profile: ClientProfile;
  channel: ChannelCopyPolicy;
};

// Different sources (ffprobe, Plex, Jellyfin) name a few codecs differently.
const CodecAliases: Record<string, string> = {
  dca: 'dts',
  avc: 'h264',
  avc1: 'h264',
  h265: 'hevc',
  hvc1: 'hevc',
  hev1: 'hevc',
  libopus: 'opus',
  mpeg2: 'mpeg2video',
  srt: 'subrip',
  ssa: 'ass',
  tx3g: 'mov_text',
  vtt: 'webvtt',
};

export function normalizeCodec(codec: Maybe<string>): string {
  const lower = (codec ?? '').trim().toLowerCase();
  return CodecAliases[lower] ?? lower;
}

const TextSubtitleCodecs = new Set(['subrip', 'mov_text', 'webvtt', 'text']);
const AssSubtitleCodecs = new Set(['ass']);
const HdrTransfers = new Set(['smpte2084', 'arib-std-b67']);
const DolbyVisionCodecs = new Set(['dvhe', 'dvh1']);

export function decideCopyOrTranscode(
  input: CopyOrTranscodeInput,
): CopyOrTranscodeDecision {
  const reasons: string[] = [];

  const subtitles = decideSubtitles(input, reasons);

  if (input.channel.mode === 'always-transcode') {
    reasons.push('channel: always-transcode');
    return { video: 'transcode', audio: 'transcode', subtitles, reasons };
  }

  const videoReasons = videoTranscodeReasons(input);
  if (subtitles === 'burn') {
    videoReasons.push('video: subtitles must be burned in');
  }
  if (input.channel.watermark) {
    videoReasons.push('video: watermark must be drawn');
  }
  reasons.push(...videoReasons);

  const audioReasons = audioTranscodeReasons(input);
  reasons.push(...audioReasons);

  return {
    video: videoReasons.length === 0 ? 'copy' : 'transcode',
    audio: audioReasons.length === 0 ? 'copy' : 'transcode',
    subtitles,
    reasons,
  };
}

function videoTranscodeReasons(input: CopyOrTranscodeInput): string[] {
  const { video, profile, channel } = input;
  if (!video || video.isAttachedPic) {
    return ['video: no video stream'];
  }

  const reasons: string[] = [];
  const codec = normalizeCodec(video.codec);
  const codecProfile = (video.profile ?? '').trim().toLowerCase();

  if (DolbyVisionCodecs.has(codec)) {
    reasons.push(`video: Dolby Vision (${codec})`);
    return reasons;
  }

  const supported = profile.videoCodecs[codec];
  if (!supported) {
    reasons.push(`video: codec ${codec || 'unknown'} not in client profile`);
  } else if (
    !(MpegTsTransport.videoCodecs as readonly string[]).includes(codec)
  ) {
    reasons.push(`video: codec ${codec} not supported by MPEG-TS`);
  } else {
    // An unknown profile is let through: plenty of sources don't report one.
    // Nothing downstream catches a wrong guess here: the server-side fallback
    // only sees ffmpeg failing, not a client that can't decode what it copied.
    if (codecProfile && !supported.profiles.includes(codecProfile)) {
      reasons.push(`video: ${codec} profile "${codecProfile}" not supported`);
    }
    // Android decoders only promise 4:2:0. A 4:2:2/4:4:4 source normally shows
    // in the profile too, but not every source reports one.
    const pix = (video.pixelFormat ?? '').toLowerCase();
    if (/(422|444)/.test(pix)) {
      reasons.push(`video: ${codec} ${pix} chroma not supported`);
    }
    const bitDepth = video.bitDepth ?? bitDepthFromPixelFormat(video);
    if (bitDepth && bitDepth > supported.maxBitDepth) {
      reasons.push(`video: ${codec} ${bitDepth}-bit not supported`);
    }
  }

  if (video.width > profile.maxWidth || video.height > profile.maxHeight) {
    reasons.push(
      `video: ${video.width}x${video.height} exceeds ${profile.maxWidth}x${profile.maxHeight}`,
    );
  }

  const transfer = (video.colorTransfer ?? '').toLowerCase();
  if (HdrTransfers.has(transfer) && !profile.hdr) {
    reasons.push(`video: HDR (${transfer}) not supported`);
  }

  if (video.scanType === 'interlaced') {
    reasons.push('video: interlaced');
  }

  if (channel.maxVideoBitrateKbps !== undefined) {
    const bps = video.bitrate ?? input.containerBitrate;
    if (bps && bps / 1000 > channel.maxVideoBitrateKbps) {
      reasons.push(
        `video: ${Math.round(bps / 1000)} kbps exceeds cap ${channel.maxVideoBitrateKbps} kbps`,
      );
    }
  }

  return reasons;
}

function bitDepthFromPixelFormat(video: VideoStreamDetails): Maybe<number> {
  const pix = (video.pixelFormat ?? '').toLowerCase();
  if (/p10|p010/.test(pix)) return 10;
  if (/p12/.test(pix)) return 12;
  return undefined;
}

function audioTranscodeReasons(input: CopyOrTranscodeInput): string[] {
  const { audio, profile, channel } = input;
  if (!audio) {
    // Silence gets generated by the transcode path.
    return ['audio: no audio stream'];
  }

  const reasons: string[] = [];
  const codec = normalizeCodec(audio.codec);

  if (!profile.audioCodecs.includes(codec)) {
    reasons.push(`audio: codec ${codec || 'unknown'} not in client profile`);
  } else if (
    !(MpegTsTransport.audioCodecs as readonly string[]).includes(codec)
  ) {
    reasons.push(`audio: codec ${codec} not supported by MPEG-TS`);
  }

  if (audio.channels && audio.channels > profile.maxAudioChannels) {
    reasons.push(
      `audio: ${audio.channels} channels exceeds ${profile.maxAudioChannels}`,
    );
  }

  if (channel.loudnorm) {
    reasons.push('audio: loudness normalization');
  }

  return reasons;
}

function decideSubtitles(
  input: CopyOrTranscodeInput,
  reasons: string[],
): SubtitleDecision {
  const { subtitle, channel } = input;
  if (!subtitle) {
    return 'off';
  }

  const codec = normalizeCodec(subtitle.codec);

  if (isImageBasedSubtitle(codec)) {
    reasons.push(`subtitles: image-based (${codec}), burning`);
    return 'burn';
  }

  if (!channel.sidecarEnabled) {
    reasons.push('subtitles: WebVTT sidecar disabled, burning');
    return 'burn';
  }

  if (AssSubtitleCodecs.has(codec)) {
    if (channel.assSubtitles === 'burn') {
      reasons.push('subtitles: ASS styling kept, burning');
      return 'burn';
    }
    return 'sidecar';
  }

  if (TextSubtitleCodecs.has(codec)) {
    return 'sidecar';
  }

  // Unknown subtitle format: burning works for anything ffmpeg can render.
  reasons.push(`subtitles: unknown format ${codec || 'unknown'}, burning`);
  return 'burn';
}
