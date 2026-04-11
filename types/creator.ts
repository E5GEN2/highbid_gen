/**
 * Shared types for the Video Generator / Creator pipeline.
 */

export interface StoryBulb {
  title: string;
  runtime_sec: number;
  tone: string;
  narration_pov: string;
  target_viewer: string;
  premise: string;
  protagonist: string;
  goal: string;
  stakes: string;
  setting: string;
  constraint: string;
  twist: string;
  call_to_action: string;
  visual_style: string;
  action_emphasis: string;
  domino_sequences: string[];
  setups_payoffs: { setup: string; payoff: string }[];
  escalation_points: string[];
  plot_threads: {
    act1: { turning_point: string; consequence: string };
    act2: { turning_point: string; consequence: string };
    act3: { turning_point: string; consequence: string };
  };
  target_scene_count: number;
}

export interface StoryboardScene {
  scene_id: number;
  start_ms: number;
  end_ms: number;
  beat: string;
  vo_text: string;
  scene_twist: string;
  caused_by: string;
  leads_to: string;
  callback_to: string;
  vo_emphasis: string;
  read_speed_wps: number;
  visual_prompt: {
    setting: string;
    characters: string;
    action: string;
    props: string;
    mood: string;
    lighting: string;
    color_palette: string;
    camera: string;
    composition: string;
    aspect_ratio: string;
    style_tags: string;
    negative_tags: string;
    model_hint: string;
    seed: number;
  };
  text_overlay: {
    content: string;
    position: string;
    weight: string;
  };
  transition_in: string;
  transition_out: string;
  music_cue: string;
}
