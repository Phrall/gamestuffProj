// Core battle types. Nothing in src/core imports Phaser, so it can be unit tested in Node.
// Rules follow the Game Design prototype spec; section numbers (§) refer to it.

export type Team = 'player' | 'enemy';
export type Facing = 'N' | 'E' | 'S' | 'W';
export type Side = 'front' | 'side' | 'back';

export interface Point { x: number; y: number }

export type TileKind = 'ground' | 'ford' | 'water' | 'boulder';

export interface Tile {
  kind: TileKind;
  /** Height in levels, 0 to 3. */
  height: number;
  /** Drawn as a bridge (map code B); plays as ordinary ground. */
  bridge?: boolean;
}

export interface GridMap {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Row-major: tiles[y * width + x]. */
  tiles: Tile[];
}

export interface Stats {
  hp: number;
  atk: number;
  mag: number;
  def: number;
  res: number;
  spd: number;
  move: number;
  jump: number;
  eva: number;
  /** floor(DEX / 2), added to the base hit chance (§19). Absent on hand-written test stats. */
  hitBonus?: number;
}

export type AbilityType = 'phys' | 'magic' | 'heal' | 'buff' | 'self' | 'passive';
export type AreaShape = 'plus' | 'perpendicularLine3';
export type Expiry = 'ownNextTurn' | 'casterNextTurnStart' | 'targetNextTurnEnd';

export interface AbilityDef {
  id: string;
  type: AbilityType;
  power?: number;
  range?: [number, number];
  cd?: number;
  melee?: boolean;
  straightLine?: boolean;
  area?: AreaShape;
  hitsAllies?: boolean;
  hitBonus?: number;
  push?: number;
  blockedBonus?: number;
  fallBonus?: number;
  fallMinDrop?: number;
  revives?: boolean;
  oncePerBattle?: boolean;
  morale?: number;
  buff?: { def?: number; res?: number; allFront?: boolean; until: Expiry };
  debuff?: { move?: number; until: Expiry };
  /** Passive (Sure Footing). */
  jump?: number;
  freeClimb?: boolean;
}

export interface Modifier {
  def?: number;
  res?: number;
  move?: number;
  atk?: number;
  hit?: number;
  allFront?: boolean;
  /** When it ends: at the start or end of a given unit's turn, or at battle end (vow surges). */
  endsOn: 'turnStart' | 'turnEnd' | 'battleEnd';
  endsWithUnit: string;
  source: string;
}

export type VowId = 'bulwark' | 'loneBlade';
export type VowStatus = 'intact' | 'fulfilled' | 'broken' | 'lapsed';

export interface VowState {
  vowId: VowId;
  status: VowStatus;
  progress: number;
  goal: number;
  /** Downed while intact: no more progress or breaks; resolves at battle end (§13.3). */
  frozen: boolean;
}

export type UnitStatus = 'ok' | 'downed' | 'lost';

export interface Unit {
  id: string;
  name: string;
  team: Team;
  /** Player class id, or null for enemy stat blocks. */
  classId: string | null;
  leader: boolean;
  base: Stats;
  abilities: string[];
  hp: number;
  pos: Point;
  facing: Facing;
  ct: number;
  status: UnitStatus;
  reviveCounter: number;
  /** Turns left before each ability can be used again. */
  cooldowns: Record<string, number>;
  usedOnce: string[];
  modifiers: Modifier[];
  xp: number;
  defeats: number;
  /** Shaken's Move penalty, fixed at the start of the unit's turn (§13.5). */
  moraleMove: number;
  /** Data-file order (players, then enemies); breaks every tie (§13.2). */
  order: number;
  ai?: { holdUntilWithin?: number; prefersHeight?: number; healBelow?: number };
  /** Trait slot contents (job system §9.4). Passives here work like the class's own. */
  traits: string[];
}

export interface VictimPreview {
  unitId: string;
  /** Percent, 0 to 100. */
  hit: number;
  damage: number;
  heal: number;
  hpAfter: number;
  side: Side;
  /** Attacker height minus target height. */
  heightDiff: number;
  downs: boolean;
  revives: boolean;
  /** Shove: where the target ends up, if it moves. */
  pushedTo?: Point;
  /** A trait keeps the target standing (Hard to Kill: "survives at 1"). */
  survives?: string;
}

export interface ActionPreview {
  actorId: string;
  abilityId: string;
  from: Point;
  target: Point;
  victims: VictimPreview[];
  /** Bulwark Guard: the unit that takes the attack instead of the one targeted. */
  interceptedBy?: string;
  /** The actor's own vow would break if this action downs someone (Lone Blade). */
  breaksVow: boolean;
}

export type BattleEvent =
  | { type: 'turnStart'; unitId: string }
  | { type: 'move'; unitId: string; path: Point[] }
  | { type: 'ability'; unitId: string; abilityId: string; target: Point; preview: ActionPreview; results: VictimResult[] }
  | { type: 'downed'; unitId: string; by: string | null }
  | { type: 'revived'; unitId: string; by: string }
  | { type: 'lost'; unitId: string }
  | { type: 'reviveTick'; unitId: string; counter: number }
  | { type: 'morale'; team: Team; delta: number; value: number; reason: string }
  | { type: 'turnEnd'; unitId: string; facing: Facing; ct: number }
  | { type: 'vowSworn'; unitId: string; vowId: VowId }
  | { type: 'vowProgress'; unitId: string; vowId: VowId; progress: number; goal: number }
  | { type: 'vowFulfilled'; unitId: string; vowId: VowId }
  | { type: 'vowBroken'; unitId: string; vowId: VowId; cause: string }
  | { type: 'vowFrozen'; unitId: string; vowId: VowId }
  | { type: 'intercept'; unitId: string; protectedId: string; attackerId: string }
  | { type: 'trait'; unitId: string; traitId: string; heal?: number }
  | { type: 'twistAnnounce'; twistId: string; firesAtTurn: number; tiles: Point[] }
  | { type: 'twist'; twistId: string; spawned: string[] }
  | { type: 'battleEnd'; winner: Team };

export interface VictimResult {
  unitId: string;
  hit: boolean;
  damage: number;
  heal: number;
  hpAfter: number;
  pushedTo?: Point;
}

/** A scripted battle event at a fixed battle turn (slice spec §10). */
export interface TwistDef {
  id: string;
  /** Fires at the start of this battle turn (every unit's turn counts). */
  firesAtTurn: number;
  /** The announce event comes at the start of turn firesAtTurn - announceTurnsAhead. */
  announceTurnsAhead: number;
  effect: 'spawn';
}

export interface TwistState {
  def: TwistDef;
  announced: boolean;
  fired: boolean;
}
