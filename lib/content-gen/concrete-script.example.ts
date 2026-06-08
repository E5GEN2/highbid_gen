/**
 * Hand-authored EXAMPLE of one slot in concrete-script form.
 *
 * This is the target shape the LLM script-writer must produce. Used as:
 *   1. Reference for the Gemini system-prompt's "here's a valid output" block.
 *   2. Schema-validation smoke test (importable in unit tests).
 *
 * Scenario: NoFL channel, beat `channel_proof_1` for niche 1.
 * Narration: "This channel already has more than 14 thousand subscribers."
 * Visual:    channel_page screenshot, sharpie circle around the "14.3K
 *            subscribers" text in the channel header.
 * Audio:     whoosh_on_load + ding_on_circle_reveal SFX.
 */

import type { ConcreteScript } from './concrete-script';

export const EXAMPLE_SLOT_CHANNEL_PROOF_1: ConcreteScript = {
  schema_version: '1',
  context: {
    channelId: 'UCM6UaLvydAAnhWP-g_Ra9yw',
    channel_name: 'NoFL',
    niche_index: 1,
    video_id: 'example-1',
  },
  slots: [
    {
      slot_id: 'niche_1_channel_proof_1',
      beat_id: 'channel_proof_1',
      narration: 'This channel already has more than 14 thousand subscribers.',
      gems: [
        {
          id: 'narr',
          tool: 'tts',
          args: {
            text: 'This channel already has more than 14 thousand subscribers.',
            voice: 'money_groot',
          },
        },
        {
          id: 'main',
          tool: 'yt_capture',
          args: {
            channelId: 'UCM6UaLvydAAnhWP-g_Ra9yw',
            kind: 'channel_page',
            annotate_element: 'subscriber_count',
            annotate_kind: 'composite',
            annotate_shape: 'sharpie_circle',
          },
        },
        {
          id: 'sfx',
          tool: 'sfx_render',
          args: {
            tokens: ['whoosh_on_load', 'ding_on_circle_reveal'],
            // Fit the SFX track to the narration length so the ding lands
            // before the cut to the next slot.
            fit_duration_s: 1.8,
          },
        },
      ],
      compose: {
        bg: 'dark_gray',
        // hold_s LOCKED to TTS duration — producer resolves this after the
        // tts gem runs. The skeleton's default 1.8 is a placeholder before
        // we measure.
        hold_s: '{{narr.duration_s}}',
        layers: [
          // The annotated screenshot fills the frame, with a gentle 8% zoom-in
          { from: 'main', channel: 'video', fit: 'contain', ken_burns: 'zoom_in_8pct' },
          // The narration plays as the voice track
          { from: 'narr', channel: 'voice' },
          // SFX track
          { from: 'sfx',  channel: 'fx' },
        ],
      },
    },
  ],
  final: {
    tool: 'video_compose',
    args: {
      slot_order: ['niche_1_channel_proof_1'],
      default_bg: 'dark_gray',
      width: 1080,
      height: 1920,
      fps: 30,
    },
  },
};
