// "What can I hit from here" (UX move-preview-and-camera v1.1 §1). Pure data; the scene draws it.
import { ABILITIES } from '../data';
import type { BattleState } from './battle';
import { abilityReady, previewAction, targetTiles } from './combat';
import { manhattan } from './grid';
import { adjacentAllies } from './vows';
import type { Point, Side, Unit } from './types';

export interface ThreatAbility {
  abilityId: string;
  /** Area ability (Volley, Thornsnare): drawn with a dashed icon. */
  area: boolean;
  /** Some legal aim of this ability downs the enemy. */
  canDown: boolean;
  /** Some legal aim of this ability that covers the enemy also catches an ally. */
  hitsAlly: boolean;
}

export interface Threat {
  unitId: string;
  distance: number;
  /** Abilities that can hit this enemy, in action-grid order. */
  abilities: ThreatAbility[];
  side: Side;
  /** Target is Braced (all hits count as front). */
  braced: boolean;
  canDown: boolean;
}

export interface MovePreview {
  from: Point;
  /** Sorted by distance, then unit order. */
  threats: Threat[];
  /** Usable-type abilities left out this turn, with why. */
  excluded: { abilityId: string; reason: 'cooldown' | 'used'; readyIn?: number }[];
  /** Lone Blade intact, an ally adjacent to `from`, and some target can be downed. */
  breaksLoneBlade: boolean;
}

/**
 * Enemies that `actor` could hit if it stood on `from`, for every ability it can use this
 * turn. Uses the real previewAction, so damage, facing and downs match the actual attack.
 */
export function movePreview(state: BattleState, actor: Unit, from: Point): MovePreview {
  const order = actor.abilities.filter((id) => {
    const a = ABILITIES[id];
    return a && a.type !== 'passive' && a.type !== 'self' && a.type !== 'heal' && a.type !== 'buff';
  });
  const excluded: MovePreview['excluded'] = [];
  const threats = new Map<string, Threat>();
  const start = actor.pos;
  actor.pos = { ...from }; // stand on the tile so every rule sees the post-move board
  try {
    for (const id of order) {
      if (!abilityReady(actor, id)) {
        const cd = actor.cooldowns[id] ?? 0;
        excluded.push(cd > 0 ? { abilityId: id, reason: 'cooldown', readyIn: cd } : { abilityId: id, reason: 'used' });
        continue;
      }
      const a = ABILITIES[id]!;
      const area = !!a.area;
      for (const t of targetTiles(state, actor, id, from)) {
        const p = previewAction(state, actor, id, t, from);
        const allyHit = p.victims.some((v) => unitById(state, v.unitId).team === actor.team);
        for (const v of p.victims) {
          const u = unitById(state, v.unitId);
          if (u.team === actor.team || u.status !== 'ok') continue;
          let th = threats.get(u.id);
          if (!th) {
            th = {
              unitId: u.id, distance: manhattan(from, u.pos), abilities: [], side: v.side,
              braced: u.modifiers.some((m) => m.allFront), canDown: false,
            };
            threats.set(u.id, th);
          }
          let ta = th.abilities.find((x) => x.abilityId === id);
          if (!ta) { ta = { abilityId: id, area, canDown: false, hitsAlly: false }; th.abilities.push(ta); }
          ta.canDown ||= v.downs;
          ta.hitsAlly ||= allyHit;
          th.canDown ||= v.downs;
        }
      }
    }
  } finally {
    actor.pos = start;
  }
  const list = [...threats.values()].sort((a, b) => a.distance - b.distance || unitById(state, a.unitId).order - unitById(state, b.unitId).order);
  const v = state.vows[actor.id];
  const lone = !!v && v.vowId === 'loneBlade' && v.status === 'intact' && !v.frozen;
  const breaksLoneBlade = lone && list.some((t) => t.canDown) && adjacentAllies(state, actor, from).length > 0;
  return { from: { ...from }, threats: list, excluded, breaksLoneBlade };
}

function unitById(state: BattleState, id: string): Unit {
  return state.units.find((u) => u.id === id)!;
}
