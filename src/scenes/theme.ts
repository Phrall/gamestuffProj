// Gray-box palette. Oath magic is warm gold, shadow magic cold violet (concept brief).
export const COLORS = {
  bg: 0x1d1f27,
  tileTop: [0x6b7280, 0x7c8492, 0x8e96a3, 0xa1a8b4],
  tileLeft: 0x4b5160,
  tileRight: 0x3c4150,
  water: 0x2b4c6f,
  ford: 0x557189,
  boulder: 0x3a3a3a,
  move: 0x3b82f6,
  range: 0xef4444,
  target: 0xf59e0b,
  area: 0xfbbf24,
  hover: 0xffffff,
  player: 0x38bdf8,
  enemy: 0xf87171,
  downed: 0x6b7280,
  gold: 0xf5c451,
  violet: 0x8b5cf6,
  panel: 0x111318,
  panelEdge: 0x2f3442,
  text: '#e5e7eb',
  textDim: '#9ca3af',
  textWarn: '#f87171',
};

export const FONT = 'monospace';

/** Faction cue (Director): one ring colour per side, darker than the move and attack highlights. */
export const FACTION = { squad: 0x3b6a96, squadHex: '#3b6a96', court: 0xa3333d, courtHex: '#a3333d', edge: 0x2a2420, badgeText: '#ede6d3' } as const;
