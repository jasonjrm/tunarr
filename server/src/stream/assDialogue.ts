import fs from 'node:fs/promises';

/**
 * Dialogue-only ASS for the WebVTT sidecar.
 *
 * Fansub ASS tracks carry typesetting next to the dialogue: signs, karaoke
 * openings and endings, vector drawings. WebVTT has no positioning or drawing,
 * so ffmpeg's conversion turns those into junk on screen (one cue per letter of
 * an animated sign, "m 0 0 l 1920 0 …" drawing commands). The sidecar shows
 * plain dialogue only, so everything else is dropped before conversion.
 */

/** Style names used for signs, songs and other typesetting rather than dialogue. */
const TypesettingStyle =
  /(sign|song|kara|lyric|romaji|kanji|title|logo|typeset|insert|eyecatch|note|^(op|ed)(\b|[-_ \d]))/i;
/** Vector drawing mode (\p1 and up). */
const DrawingTag = /\\p[1-9]/;
/** Karaoke timing (\k, \kf, \ko, \K). */
const KaraokeTag = /\\[kK][fo]?\d/;
const OverrideBlock = /\{[^}]*\}/g;

export type DialogueAss = { content: string; dialogueLines: number };

function visibleText(text: string): string {
  return text
    .replace(OverrideBlock, '')
    .replace(/\\[Nnh]/g, ' ')
    .trim();
}

/** Whether one Dialogue event is spoken dialogue (vs. typesetting). */
export function isDialogueEvent(style: string, text: string): boolean {
  if (TypesettingStyle.test(style.trim())) return false;
  if (DrawingTag.test(text) || KaraokeTag.test(text)) return false;
  // Animated signs are often split into one event per letter.
  return visibleText(text).length >= 2;
}

/**
 * The same script with only its dialogue events. Headers and styles stay, so
 * ffmpeg still parses it; Comment events are dropped.
 */
export function dialogueOnlyAss(content: string): DialogueAss {
  let dialogueLines = 0;
  const kept = content.split(/\r?\n/).filter((line) => {
    if (line.startsWith('Comment:')) return false;
    if (!line.startsWith('Dialogue:')) return true;
    // Dialogue: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
    const fields = line.slice('Dialogue:'.length).split(',');
    if (fields.length < 10) return false;
    const keep = isDialogueEvent(fields[3]!, fields.slice(9).join(','));
    if (keep) dialogueLines++;
    return keep;
  });
  return { content: kept.join('\n'), dialogueLines };
}

const counts = new Map<string, number>();

/**
 * Write `<path>.dialogue.ass` next to an extracted ASS file (once) and return
 * its path with the number of dialogue lines it kept.
 */
export async function dialogueAssFile(
  path: string,
): Promise<{ path: string; dialogueLines: number }> {
  const out = `${path}.dialogue.ass`;
  const known = counts.get(out);
  if (known !== undefined) {
    try {
      // Fresh mtime on every use, so the subtitle cache sweep (which removes
      // unreferenced files past an age) never deletes one about to be read.
      const now = new Date();
      await fs.utimes(out, now, now);
      return { path: out, dialogueLines: known };
    } catch {
      counts.delete(out);
    }
  }
  const source = await fs.readFile(path, 'utf-8');
  const { content, dialogueLines } = dialogueOnlyAss(source.replace(/^﻿/, ''));
  // Written aside and renamed into place: two sessions may build the same
  // file at once, and ffmpeg must never read a half-written one.
  const tmp = `${out}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, out);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
  counts.set(out, dialogueLines);
  return { path: out, dialogueLines };
}
