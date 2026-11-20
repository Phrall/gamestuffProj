import { describe, expect, it } from 'vitest';
import { endTurn, moveUnit, startNextTurn, useAbility } from '../src/core/battle';
import { forecast } from '../src/core/timeline';
import { battle, flatRows, unit } from './helpers';

describe('CT timeline (§2)', () => {
  it('fastest unit acts first; ties break by Spd then data order', () => {
    const s = battle(flatRows(6, 1), [
      unit('mage', 'player', 'hedgeMage', 0, 0), // Spd 5
      unit('bow', 'player', 'bowhand', 1, 0), // Spd 7
      unit('sw', 'enemy', 'sellsword', 5, 0), // Spd 6
    ]);
    expect(startNextTurn(s)?.id).toBe('bow');
  });

  it('CT after the turn: 0 full, 20 one action, 40 wait', () => {
    const s = battle(flatRows(6, 1), [unit('a', 'player', 'sellsword', 0, 0), unit('e', 'enemy', 'sellsword', 2, 0, 'W', { stats: { hp: 30, atk: 8, mag: 2, def: 4, res: 2, spd: 1, move: 4, jump: 2, eva: 10 } })]);
    const a = startNextTurn(s)!;
    endTurn(s);
    expect(a.ct).toBe(40);
    startNextTurn(s);
    moveUnit(s, 'a', { x: 1, y: 0 });
    endTurn(s);
    expect(a.ct).toBe(20);
    startNextTurn(s);
    useAbility(s, 'a', 'strike', { x: 2, y: 0 });
    endTurn(s);
    expect(a.ct).toBe(20);
  });

  it('waiting brings the next turn sooner in the forecast', () => {
    const s = battle(flatRows(6, 1), [unit('a', 'player', 'sellsword', 0, 0), unit('b', 'enemy', 'sellsword', 5, 0)]);
    startNextTurn(s);
    const f = forecast(s.units, 8, 'a').map((e) => e.unitId);
    expect(f).toHaveLength(8);
    expect(f[0]).toBe('a');
    expect(f.slice(0, 4)).toEqual(['a', 'b', 'a', 'b']);
  });
});
