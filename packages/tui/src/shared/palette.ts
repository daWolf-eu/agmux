// Catppuccin Mocha. Hue carries meaning (status) only; everything else — chrome,
// labels, secondary columns — is drawn from the neutral text/overlay/surface ramp,
// brightest first. Hard-coded for now; a future theming feature (light/dark,
// user palettes) is expected to swap this table out.
export const MOCHA = {
  text: "#cdd6f4",
  subtext1: "#bac2de",
  subtext0: "#a6adc8",
  overlay2: "#9399b2",
  overlay1: "#7f849c",
  overlay0: "#6c7086",
  surface2: "#585b70",
  surface1: "#45475a",
  surface0: "#313244",

  pink: "#f5c2e7",
  mauve: "#cba6f7",
  lavender: "#b4befe",
  blue: "#89b4fa",
  sky: "#89dceb",
  teal: "#94e2d5",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  red: "#f38ba8",
} as const;

// Scrollbars are chrome: a faint thumb on no track.
export const FAINT_SCROLLBAR = {
  trackOptions: { foregroundColor: MOCHA.surface1, backgroundColor: "transparent" },
};
