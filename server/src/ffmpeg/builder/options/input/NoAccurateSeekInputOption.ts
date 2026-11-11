import type { InputSource } from '@/ffmpeg/builder/input/InputSource.js';
import type { MediaStream } from '@/ffmpeg/builder/MediaStream.js';
import { some } from 'lodash-es';
import { InputOption } from './InputOption.ts';

/**
 * With copied video, a seek can only start on a keyframe, at or before the
 * requested point. ffmpeg's default accurate seek still cuts decoded audio
 * exactly at the requested point, so the first segment starts with video and
 * no sound for up to a GOP (seconds on Blu-ray/HEVC sources). Without accurate
 * seek, audio starts from the same keyframe as the video.
 */
export class NoAccurateSeekInputOption extends InputOption {
  appliesToInput(input: InputSource<MediaStream>): boolean {
    if (!input.isVideo()) {
      return true;
    }
    return !some(input.streams, (stream) => stream.inputKind === 'stillimage');
  }

  options(): string[] {
    return ['-noaccurate_seek'];
  }
}
