import type {
  AudioStreamDetails,
  SubtitleStreamDetails,
  VideoStreamDetails,
} from '@/stream/types.js';
import {
  decideCopyOrTranscode,
  normalizeCodec,
  SyndieClientProfile,
  type ChannelCopyPolicy,
  type CopyOrTranscodeInput,
} from './CopyOrTranscodePolicy.ts';

function video(
  overrides: Partial<VideoStreamDetails> = {},
): VideoStreamDetails {
  return {
    codec: 'h264',
    profile: 'high',
    width: 1920,
    height: 1080,
    framerate: 23.976,
    scanType: 'progressive',
    pixelFormat: 'yuv420p',
    bitDepth: 8,
    streamIndex: 0,
    displayAspectRatio: '16:9',
    anamorphic: false,
    bitrate: undefined,
    isAttachedPic: false,
    colorRange: 'tv',
    colorSpace: 'bt709',
    colorTransfer: 'bt709',
    colorPrimaries: 'bt709',
    ...overrides,
  };
}

function audio(
  overrides: Partial<AudioStreamDetails> = {},
): AudioStreamDetails {
  return { codec: 'aac', channels: 2, index: 1, ...overrides };
}

function subtitle(
  overrides: Partial<SubtitleStreamDetails> = {},
): SubtitleStreamDetails {
  return {
    type: 'embedded',
    codec: 'subrip',
    index: 2,
    default: false,
    forced: false,
    sdh: false,
    ...overrides,
  };
}

const channel: ChannelCopyPolicy = {
  mode: 'auto',
  watermark: false,
  loudnorm: false,
  assSubtitles: 'sidecar',
  sidecarEnabled: true,
};

function decide(overrides: Partial<CopyOrTranscodeInput> = {}) {
  return decideCopyOrTranscode({
    video: video(),
    audio: audio(),
    subtitle: undefined,
    profile: SyndieClientProfile,
    channel,
    ...overrides,
  });
}

describe('decideCopyOrTranscode', () => {
  test('H.264 High + stereo AAC copies both', () => {
    expect(decide()).toEqual({
      video: 'copy',
      audio: 'copy',
      subtitles: 'off',
      reasons: [],
    });
  });

  test('MKV H.264 + Opus: copy video, transcode audio (the master-playlist bug case)', () => {
    const d = decide({ audio: audio({ codec: 'opus' }) });
    expect(d.video).toBe('copy');
    expect(d.audio).toBe('transcode');
    expect(d.reasons).toContain('audio: codec opus not in client profile');
  });

  test.each(['flac', 'dts', 'dca', 'truehd', 'vorbis', 'ac3', 'eac3', 'mp3'])(
    'audio %s transcodes to AAC',
    (codec) => {
      expect(decide({ audio: audio({ codec }) }).audio).toBe('transcode');
    },
  );

  test('5.1 AAC transcodes (stereo downmix)', () => {
    const d = decide({ audio: audio({ channels: 6 }) });
    expect(d.audio).toBe('transcode');
    expect(d.reasons).toContain('audio: 6 channels exceeds 2');
  });

  test('HE-AAC copies (profile is not checked for audio)', () => {
    expect(decide({ audio: audio({ profile: 'HE-AAC' }) }).audio).toBe('copy');
  });

  test('loudnorm forces audio transcode, video still copies', () => {
    const d = decide({ channel: { ...channel, loudnorm: true } });
    expect(d).toMatchObject({ video: 'copy', audio: 'transcode' });
  });

  test('no audio stream: transcode path generates silence', () => {
    expect(decide({ audio: undefined }).audio).toBe('transcode');
  });

  test('Hi10P H.264 (anime) transcodes video', () => {
    const d = decide({
      video: video({
        profile: 'high 10',
        bitDepth: 10,
        pixelFormat: 'yuv420p10le',
      }),
    });
    expect(d.video).toBe('transcode');
    expect(d.reasons).toContain('video: h264 profile "high 10" not supported');
    expect(d.reasons).toContain('video: h264 10-bit not supported');
  });

  test('HEVC Main 10 SDR copies, bit depth taken from pixel format', () => {
    const d = decide({
      video: video({
        codec: 'hevc',
        profile: 'Main 10',
        bitDepth: undefined,
        pixelFormat: 'yuv420p10le',
      }),
    });
    expect(d.video).toBe('copy');
  });

  test('HDR10 transcodes while the profile has hdr: false', () => {
    const d = decide({
      video: video({
        codec: 'hevc',
        profile: 'main 10',
        colorTransfer: 'smpte2084',
      }),
    });
    expect(d.video).toBe('transcode');
    expect(d.reasons).toContain('video: HDR (smpte2084) not supported');
  });

  test('HDR10 copies once the profile allows HDR', () => {
    const d = decide({
      video: video({
        codec: 'hevc',
        profile: 'main 10',
        colorTransfer: 'smpte2084',
      }),
      profile: { ...SyndieClientProfile, hdr: true },
    });
    expect(d.video).toBe('copy');
  });

  test.each(['dvhe', 'dvh1'])(
    'Dolby Vision (%s) always transcodes',
    (codec) => {
      const d = decide({
        video: video({ codec }),
        profile: { ...SyndieClientProfile, hdr: true },
      });
      expect(d.video).toBe('transcode');
    },
  );

  test.each(['mpeg4', 'msmpeg4v3', 'vp8', 'vp9', 'av1', 'mpeg2video', 'vc1'])(
    'video %s transcodes with the Syndie profile',
    (codec) => {
      expect(
        decide({ video: video({ codec, profile: undefined }) }).video,
      ).toBe('transcode');
    },
  );

  test('codec in the client profile but not in MPEG-TS transcodes', () => {
    const d = decide({
      video: video({ codec: 'av1', profile: 'main' }),
      profile: {
        ...SyndieClientProfile,
        videoCodecs: {
          ...SyndieClientProfile.videoCodecs,
          av1: { profiles: ['main'], maxBitDepth: 10 },
        },
      },
    });
    expect(d.reasons).toContain('video: codec av1 not supported by MPEG-TS');
  });

  test('4K transcodes', () => {
    const d = decide({ video: video({ width: 3840, height: 2160 }) });
    expect(d.video).toBe('transcode');
    expect(d.reasons).toContain('video: 3840x2160 exceeds 1920x1080');
  });

  test('interlaced transcodes (deinterlace)', () => {
    expect(decide({ video: video({ scanType: 'interlaced' }) }).video).toBe(
      'transcode',
    );
  });

  test.each(['yuv422p', 'yuv444p', 'yuv422p10le'])(
    '%s chroma transcodes even without a reported profile',
    (pixelFormat) => {
      const d = decide({ video: video({ profile: undefined, pixelFormat }) });
      expect(d.video).toBe('transcode');
    },
  );

  test('unknown profile is let through', () => {
    expect(decide({ video: video({ profile: undefined }) }).video).toBe('copy');
  });

  describe('bitrate cap', () => {
    const capped = { ...channel, maxVideoBitrateKbps: 6000 };

    test('over the cap transcodes', () => {
      const d = decide({
        video: video({ bitrate: 12_000_000 }),
        channel: capped,
      });
      expect(d.reasons).toContain('video: 12000 kbps exceeds cap 6000 kbps');
    });

    test('falls back to the container bitrate', () => {
      const d = decide({ containerBitrate: 9_000_000, channel: capped });
      expect(d.video).toBe('transcode');
    });

    test('unknown bitrate copies', () => {
      expect(decide({ channel: capped }).video).toBe('copy');
    });
  });

  test('watermark forces video transcode', () => {
    const d = decide({ channel: { ...channel, watermark: true } });
    expect(d).toMatchObject({ video: 'transcode', audio: 'copy' });
  });

  test('always-transcode channel transcodes everything', () => {
    const d = decide({ channel: { ...channel, mode: 'always-transcode' } });
    expect(d).toMatchObject({ video: 'transcode', audio: 'transcode' });
    expect(d.reasons).toEqual(['channel: always-transcode']);
  });

  test('no video stream transcodes video', () => {
    expect(decide({ video: undefined }).video).toBe('transcode');
    expect(decide({ video: video({ isAttachedPic: true }) }).video).toBe(
      'transcode',
    );
  });

  describe('subtitles', () => {
    test.each(['subrip', 'srt', 'mov_text', 'webvtt'])(
      'text %s goes to the sidecar and keeps video copy',
      (codec) => {
        const d = decide({ subtitle: subtitle({ codec }) });
        expect(d).toMatchObject({ video: 'copy', subtitles: 'sidecar' });
      },
    );

    test.each(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvbsub'])(
      'image %s burns and forces video transcode',
      (codec) => {
        const d = decide({ subtitle: subtitle({ codec }) });
        expect(d).toMatchObject({ video: 'transcode', subtitles: 'burn' });
        expect(d.reasons).toContain('video: subtitles must be burned in');
      },
    );

    test('ASS goes to the sidecar by default', () => {
      expect(decide({ subtitle: subtitle({ codec: 'ass' }) }).subtitles).toBe(
        'sidecar',
      );
    });

    test('ASS burns when the channel keeps styling', () => {
      const d = decide({
        subtitle: subtitle({ codec: 'ssa' }),
        channel: { ...channel, assSubtitles: 'burn' },
      });
      expect(d).toMatchObject({ video: 'transcode', subtitles: 'burn' });
    });

    test('sidecar feature flag off burns everything', () => {
      const d = decide({
        subtitle: subtitle(),
        channel: { ...channel, sidecarEnabled: false },
      });
      expect(d).toMatchObject({ video: 'transcode', subtitles: 'burn' });
    });

    test('always-transcode still picks a subtitle method', () => {
      const d = decide({
        subtitle: subtitle(),
        channel: { ...channel, mode: 'always-transcode' },
      });
      expect(d.subtitles).toBe('sidecar');
    });
  });
});

describe('normalizeCodec', () => {
  test.each([
    ['DCA', 'dts'],
    ['libopus', 'opus'],
    ['AVC', 'h264'],
    ['hvc1', 'hevc'],
    [undefined, ''],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeCodec(input)).toBe(expected);
  });
});
