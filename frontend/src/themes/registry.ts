import {
  FOG_COLOR, FOG_DENSITY, HEADLAMP_COLOR,
  HEMISPHERE_SKY_COLOR, HEMISPHERE_GROUND_COLOR, HEMISPHERE_INTENSITY,
  SUN_COLOR, SUN_INTENSITY,
} from "../config.ts";

export type ThemeId = "nebula" | "library";
export interface VisualTheme {
  readonly id: ThemeId;
  readonly panorama?: string;
  readonly woodTexture?: string;
  readonly artworkNotice?: string;
  readonly fogColor: number;
  readonly fogDensity: number;
  readonly headlampColor: number;
  readonly hemisphere: readonly [number, number, number];
  readonly sun: readonly [number, number];
  readonly rim: readonly [number, number];
}

export const THEMES: Record<ThemeId, VisualTheme> = {
  nebula: {
    id: "nebula", fogColor: FOG_COLOR, fogDensity: FOG_DENSITY,
    headlampColor: HEADLAMP_COLOR,
    hemisphere: [HEMISPHERE_SKY_COLOR, HEMISPHERE_GROUND_COLOR, HEMISPHERE_INTENSITY],
    sun: [SUN_COLOR, SUN_INTENSITY], rim: [0x94cfff, .65],
  },
  library: {
    id: "library", panorama: "/themes/library/reading-room.png",
    woodTexture: "/themes/library/oak.png",
    artworkNotice: "The library interior and oak texture are AI-generated artwork, not a photograph or a reconstruction of a British Library building.",
    fogColor: 0x30271d, fogDensity: .008,
    headlampColor: 0xffebce,
    hemisphere: [0xfff0dc, 0x594331, 1.15],
    sun: [0xffebd0, 2.0], rim: [0xe3d4b9, .6],
  },
};

/** An A/B skin override is deliberately not written into the descriptor. */
export function resolveTheme(preferred?: ThemeId, override?: string | null): VisualTheme {
  return THEMES[override === "nebula" || override === "library" ? override : preferred ?? "nebula"];
}
