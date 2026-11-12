import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  dialogueAssFile,
  dialogueOnlyAss,
  isDialogueEvent,
} from './assDialogue.ts';

const script = (events: string[]) =>
  [
    '[Script Info]',
    'ScriptType: v4.00+',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize',
    'Style: Default,Arial,48',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
  ].join('\n');

describe('isDialogueEvent', () => {
  test.each([
    ['Default', 'People die for all sorts of reasons.'],
    ['Default - Italics', '{\\i1}Who is that?{\\i0}'],
    ['Main', 'Oh.'],
    ['Default', '{\\an8}Top line, still dialogue'],
    ['Flashback', 'Let me go,\\Nplease.'],
  ])('keeps %s: %s', (style, text) => {
    expect(isDialogueEvent(style, text)).toBe(true);
  });

  test.each([
    ['Signs', 'TOKYO'],
    ['OP-R', 'kimi no koe'],
    ['ED-E2', 'the end of the world'],
    ['OP', 'romaji'],
    ['Karaoke', 'la la la'],
    ['Default', '{\\p1}m 0 0 l 1920 0 l 1920 1080 l 0 1080'],
    ['Default', '{\\k20}ki{\\k30}mi'],
    ['Default', '{\\fs130\\pos(1820,1000)}T'],
    ['Default', '  '],
  ])('drops %s: %s', (style, text) => {
    expect(isDialogueEvent(style, text)).toBe(false);
  });
});

describe('dialogueOnlyAss', () => {
  test('keeps headers and dialogue, drops typesetting, comments and drawings', () => {
    const { content, dialogueLines } = dialogueOnlyAss(
      script([
        'Dialogue: 0,0:00:03.10,0:00:05.00,Default,,0,0,0,,People die for all sorts of reasons.',
        'Dialogue: 0,0:22:19.56,0:22:22.98,Signs,,0,0,0,,{\\p1\\pos(960,540)}m 0 0 l 1920 0',
        'Dialogue: 0,0:00:07.98,0:00:08.81,Signs,,0,0,0,,t',
        'Comment: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,translator note',
        'Dialogue: 0,0:00:09.00,0:00:10.00,Default - Italics,,0,0,0,,{\\i1}Wait, what?{\\i0}',
      ]),
    );
    expect(dialogueLines).toBe(2);
    expect(content).toContain('[V4+ Styles]');
    expect(content).toContain('People die for all sorts of reasons.');
    expect(content).toContain('Wait, what?');
    expect(content).not.toContain('m 0 0 l 1920 0');
    expect(content).not.toContain('translator note');
  });

  test('a commas-in-text line keeps its whole text', () => {
    const { content } = dialogueOnlyAss(
      script([
        'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Well, yes, of course.',
      ]),
    );
    expect(content).toContain('Well, yes, of course.');
  });

  test('a signs-only track has no dialogue', () => {
    expect(
      dialogueOnlyAss(
        script([
          'Dialogue: 0,0:00:01.00,0:00:02.00,Signs,,0,0,0,,FIRE STATION 8',
          'Dialogue: 0,0:01:00.00,0:01:05.00,OP-R,,0,0,0,,{\\k12}in{\\k15}fer{\\k20}no',
        ]),
      ).dialogueLines,
    ).toBe(0);
  });
});

describe('dialogueAssFile', () => {
  test('writes the dialogue-only copy next to the source, and reuses it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ass-dialogue-'));
    try {
      const source = path.join(dir, 'track.ass');
      await fs.writeFile(
        source,
        '﻿' +
          script([
            'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello there.',
            'Dialogue: 0,0:00:01.00,0:00:02.00,Signs,,0,0,0,,SIGN',
          ]),
      );
      const first = await dialogueAssFile(source);
      expect(first).toEqual({
        path: `${source}.dialogue.ass`,
        dialogueLines: 1,
      });
      const written = await fs.readFile(first.path, 'utf-8');
      expect(written.startsWith('[Script Info]')).toBe(true);
      expect(written).not.toContain('SIGN');
      expect(await dialogueAssFile(source)).toEqual(first);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
