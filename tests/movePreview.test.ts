import { describe, expect, it } from 'vitest';
import { getUnit } from '../src/core/battle';
import { previewAction, targetTiles } from '../src/core/combat';
import { movePreview } from '../src/core/movePreview';
import { swearVow } from '../src/core/vows';
import { battle, flatRows, unit } from './helpers';

describe('move preview (#21, UX §1)', () => {
  it('applies min and max range per ability, from the hovered tile', () => {
    const s = battle(flatRows(9, 1), [unit('w', 'player', 'bowhand', 0, 0, 'E'), unit('e', 'enemy', 'sellsword', 3, 0, 'W')]);
    const w = getUnit(s, 'w');
    // From (0,0) the enemy is 3 away: Shoot, Aimed Shot, Pinning Arrow and Volley all reach.
    expect(movePreview(s, w, { x: 0, y: 0 }).threats[0]!.abilities.map((a) => a.abilityId)).toEqual(['shoot', 'aimedShot', 'pinningArrow', 'volley']);
    // From (1,0) it is 2 away: Aimed Shot (3-6) is out; Volley can still splash it from a tile 3 away.
    const near = movePreview(s, w, { x: 1, y: 0 }).threats[0]!;
    expect(near.abilities.map((a) => a.abilityId)).toEqual(['shoot', 'pinningArrow', 'volley']);
    expect(near.abilities.find((a) => a.abilityId === 'volley')!.area).toBe(true);
    // From (2,0) it is adjacent: below every min range, and Volley's nearest aim (5,0) splashes only 4..6.
    expect(movePreview(s, w, { x: 2, y: 0 }).threats).toEqual([]);
    // The unit didn't actually move.
    expect(w.pos).toEqual({ x: 0, y: 0 });
  });

  it('leaves out abilities on cooldown and says why', () => {
    const s = battle(flatRows(9, 1), [unit('w', 'player', 'bowhand', 0, 0, 'E'), unit('e', 'enemy', 'sellsword', 3, 0, 'W')]);
    const w = getUnit(s, 'w');
    w.cooldowns.aimedShot = 2;
    const mp = movePreview(s, w, { x: 0, y: 0 });
    expect(mp.threats[0]!.abilities.map((a) => a.abilityId)).not.toContain('aimedShot');
    expect(mp.excluded).toEqual([{ abilityId: 'aimedShot', reason: 'cooldown', readyIn: 2 }]);
  });

  it('can-down and facing agree with the real attack preview', () => {
    const s = battle(flatRows(4, 1), [unit('a', 'player', 'sellsword', 0, 0, 'E'), unit('e', 'enemy', 'sellsword', 3, 0, 'W')]);
    const a = getUnit(s, 'a');
    getUnit(s, 'e').hp = 3;
    const mp = movePreview(s, a, { x: 2, y: 0 });
    const t = mp.threats[0]!;
    a.pos = { x: 2, y: 0 };
    const real = previewAction(s, a, 'strike', { x: 3, y: 0 }).victims[0]!;
    expect(t.side).toBe(real.side);
    expect(t.abilities.find((x) => x.abilityId === 'strike')!.canDown).toBe(real.downs);
    expect(targetTiles(s, a, 'strike').length).toBe(1);
  });

  it('flags a Lone Blade break when an ally is adjacent to the tile and a foe can be downed', () => {
    const s = battle(flatRows(5, 2), [unit('t', 'player', 'sellsword', 0, 0, 'E'), unit('m', 'player', 'sellsword', 2, 1), unit('e', 'enemy', 'sellsword', 3, 0, 'W')]);
    swearVow(s, 't', 'loneBlade');
    getUnit(s, 'e').hp = 1;
    expect(movePreview(s, getUnit(s, 't'), { x: 2, y: 0 }).breaksLoneBlade).toBe(true); // m is adjacent to (2,0)
    expect(movePreview(s, getUnit(s, 't'), { x: 1, y: 0 }).breaksLoneBlade).toBe(false); // nothing in reach to down
  });
});
