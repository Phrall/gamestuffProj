import { describe, expect, it } from 'vitest';
import { endTurn, getUnit, startNextTurn, useAbility } from '../src/core/battle';
import { planTurn } from '../src/core/ai';
import { hitChance, previewAction, targetTiles } from '../src/core/combat';
import { guardianFor, swearVow } from '../src/core/vows';
import { ABILITIES, CLASSES, deriveStats } from '../src/data';
import { abilitiesAtRank } from '../src/core/jobs';
import { battle, flatRows, unit } from './helpers';

const dummy = (over = {}) => ({ stats: { hp: 40, atk: 1, mag: 1, def: 0, res: 0, spd: 1, move: 4, jump: 2, eva: 0, ...over } });
const fast = { spd: 12 };

describe('slice class kits (§2-3)', () => {
  it('Warden and Duelist derive stats from class and level, with their rank 1 kits', () => {
    expect(deriveStats('warden', 5)).toMatchObject({ hp: 40, atk: 9, def: 6, res: 4, spd: 5, move: 3, jump: 2, eva: 8, hitBonus: 3 });
    expect(deriveStats('duelist', 5)).toMatchObject({ hp: 30, atk: 11, def: 3, res: 3, spd: 8, move: 4, jump: 3, eva: 18, hitBonus: 6 });
    expect(CLASSES.warden!.abilities).toEqual(abilitiesAtRank('warden', 1));
    expect(CLASSES.duelist!.abilities).toEqual(abilitiesAtRank('duelist', 1));
    for (const id of ['hamstring', 'pointBlank', 'ember', 'shieldBash', 'holdTheLine', 'challenge', 'lunge', 'measuredCut', 'feint']) expect(ABILITIES[id], id).toBeDefined();
  });
});

describe('slice abilities', () => {
  it('Hamstring: Move −2 until the end of the target\'s next turn', () => {
    const s = battle(flatRows(3, 1), [unit('a', 'player', 'sellsword', 0, 0, 'E', { stats: { ...deriveStats('sellsword', 3), ...fast, hitBonus: 200 }, abilities: ['hamstring'] }), unit('e', 'enemy', 'sellsword', 1, 0, 'W', dummy())]);
    startNextTurn(s);
    useAbility(s, 'a', 'hamstring', { x: 1, y: 0 });
    expect(getUnit(s, 'e').modifiers.find((m) => m.source === 'hamstring')).toMatchObject({ move: -2, endsOn: 'turnEnd', endsWithUnit: 'e' });
  });

  it('Point Blank uses the ranged base hit at range 1', () => {
    const s = battle(flatRows(3, 1), [unit('w', 'player', 'bowhand', 0, 0, 'E', { abilities: ['pointBlank', 'strike'] }), unit('e', 'enemy', 'sellsword', 1, 0, 'W', dummy({ eva: 10 }))]);
    const w = getUnit(s, 'w'), e = getUnit(s, 'e');
    expect(targetTiles(s, w, 'pointBlank')).toEqual([{ x: 1, y: 0 }]);
    expect(hitChance(s, w, ABILITIES.pointBlank!, w.pos, e, 'front')).not.toBe(hitChance(s, w, ABILITIES.strike!, w.pos, e, 'front'));
  });

  it('Ember: hits, then 2 damage at the start of the target\'s next 2 turns; a tick can down it', () => {
    const s = battle(flatRows(4, 1), [unit('c', 'player', 'hedgeMage', 0, 0, 'E', { stats: { ...deriveStats('hedgeMage', 3), ...fast }, abilities: ['ember'] }), unit('e', 'enemy', 'sellsword', 2, 0, 'W', dummy({ spd: 6 }))]);
    startNextTurn(s);
    const hit = useAbility(s, 'c', 'ember', { x: 2, y: 0 })[0]!;
    endTurn(s);
    const e = getUnit(s, 'e');
    const hp0 = e.hp;
    expect(hit.damage).toBeGreaterThan(0);
    let ticks = 0;
    for (let i = 0; i < 12; i++) { const u = startNextTurn(s); if (!u) break; if (u.id === 'e') ticks++; endTurn(s); }
    expect(ticks).toBeGreaterThanOrEqual(3);
    expect(e.hp).toBe(hp0 - 4);
    expect(s.events.filter((x) => x.type === 'dot').length).toBe(2);
  });

  it('an Ember tick that downs the unit skips its turn', () => {
    const s = battle(flatRows(4, 1), [unit('c', 'player', 'hedgeMage', 0, 0, 'E', { stats: { ...deriveStats('hedgeMage', 3), ...fast }, abilities: ['ember'] }), unit('e', 'enemy', 'sellsword', 2, 0, 'W', dummy({ spd: 6 })), unit('x', 'enemy', 'sellsword', 3, 0, 'W', dummy())]);
    startNextTurn(s);
    useAbility(s, 'c', 'ember', { x: 2, y: 0 });
    endTurn(s);
    getUnit(s, 'e').hp = 2;
    for (let i = 0; i < 6; i++) { const u = startNextTurn(s)!; expect(u.id).not.toBe('e'); endTurn(s); if (getUnit(s, 'e').status !== 'ok') break; }
    expect(getUnit(s, 'e').status).toBe('lost');
    expect(getUnit(s, 'c').defeats).toBe(1);
  });

  it('Ember ends when its target starts Yielding, so it never breaks Mercy on its own', () => {
    const s = battle(flatRows(4, 1), [unit('c', 'player', 'hedgeMage', 0, 0, 'E', { stats: { ...deriveStats('hedgeMage', 3), ...fast }, abilities: ['ember'] }), unit('e', 'enemy', 'sellsword', 2, 0, 'W', { ...dummy({ spd: 6 }), yieldBelow: 0.25 })]);
    swearVow(s, 'c', 'mercy');
    startNextTurn(s);
    useAbility(s, 'c', 'ember', { x: 2, y: 0 });
    endTurn(s);
    const e = getUnit(s, 'e');
    e.hp = 12; // the next tick (2) leaves 10 = floor(40 x 0.25): it yields after the tick
    let u = startNextTurn(s)!;
    while (u.id !== 'e') { endTurn(s); u = startNextTurn(s)!; }
    expect(e.yielding).toBe(true);
    expect(e.modifiers.some((m) => m.dot)).toBe(false);
    endTurn(s);
    for (let i = 0; i < 6; i++) { const n = startNextTurn(s); if (!n) break; endTurn(s); }
    expect(s.events.filter((x) => x.type === 'dot').length).toBe(1);
    expect(s.vows.c!.status).not.toBe('broken');
  });

  it('Shield Bash: Shove-style push with +3 if blocked, and the target loses its Wait bonus', () => {
    const s = battle(flatRows(3, 1), [unit('m', 'player', 'warden', 1, 0, 'E', { stats: { ...deriveStats('warden', 3), ...fast, hitBonus: 200 } }), unit('e', 'enemy', 'sellsword', 2, 0, 'W', dummy())]);
    startNextTurn(s);
    const v = previewAction(s, getUnit(s, 'm'), 'shieldBash', { x: 2, y: 0 }).victims[0]!;
    expect(v.pushedTo).toBeUndefined(); // the map edge blocks it
    useAbility(s, 'm', 'shieldBash', { x: 2, y: 0 });
    expect(getUnit(s, 'e').modifiers.some((m) => m.noWaitBonus)).toBe(true);
  });

  it('Hold the Line: +2 Def and Guard reach +1 for a Bulwark guardian', () => {
    const s = battle(flatRows(5, 1), [
      unit('m', 'player', 'warden', 0, 0, 'E', { stats: { ...deriveStats('warden', 3), ...fast } }),
      unit('w', 'player', 'bowhand', 3, 0, 'E', dummy()),
      unit('e', 'enemy', 'sellsword', 4, 0, 'W', dummy()),
    ]);
    swearVow(s, 'm', 'bulwark');
    const atk = getUnit(s, 'e'), w = getUnit(s, 'w');
    expect(guardianFor(s, atk, w)).toBeUndefined(); // 3 tiles away, reach 2
    startNextTurn(s);
    useAbility(s, 'm', 'holdTheLine', { x: 0, y: 0 });
    expect(guardianFor(s, atk, w)?.id).toBe('m');
  });

  it('Challenge: the target must attack the Warden next turn if it can', () => {
    const s = battle(flatRows(5, 1), [
      unit('m', 'player', 'warden', 1, 0, 'E', { stats: { ...deriveStats('warden', 3), ...fast }, abilities: abilitiesAtRank('warden', 2) }),
      unit('w', 'player', 'hedgeMage', 3, 0, 'W', dummy({ hp: 5 })),
      unit('e', 'enemy', 'sellsword', 2, 0, 'W', { ...dummy({ spd: 6, atk: 8 }), abilities: ['strike'] }),
    ]);
    startNextTurn(s);
    expect(planTurn(s, getUnit(s, 'e')).action?.target).toEqual({ x: 3, y: 0 }); // would hit the weak mage
    useAbility(s, 'm', 'challenge', { x: 2, y: 0 });
    endTurn(s);
    let u = startNextTurn(s)!;
    while (u.id !== 'e') { endTurn(s); u = startNextTurn(s)!; }
    expect(planTurn(s, u).action?.target).toEqual({ x: 1, y: 0 });
  });

  it('Lunge: steps 1 tile toward the target, needs that tile free, and strikes from it', () => {
    const s = battle(flatRows(4, 1), [unit('d', 'player', 'duelist', 0, 0, 'E', { stats: { ...deriveStats('duelist', 3), ...fast, hitBonus: 200 } }), unit('e', 'enemy', 'sellsword', 2, 0, 'W', dummy())]);
    const d = getUnit(s, 'd');
    expect(targetTiles(s, d, 'lunge')).toEqual([{ x: 2, y: 0 }]);
    startNextTurn(s);
    useAbility(s, 'd', 'lunge', { x: 2, y: 0 });
    expect(d.pos).toEqual({ x: 1, y: 0 });
    const blocked = battle(flatRows(4, 1), [unit('d', 'player', 'duelist', 0, 0, 'E'), unit('x', 'player', 'sellsword', 1, 0, 'E', dummy()), unit('e', 'enemy', 'sellsword', 2, 0, 'W', dummy())]);
    expect(targetTiles(blocked, getUnit(blocked, 'd'), 'lunge')).toEqual([]);
  });

  it('Measured Cut: +10 hit with no ally adjacent', () => {
    const solo = battle(flatRows(3, 2), [unit('d', 'player', 'duelist', 0, 0, 'E'), unit('e', 'enemy', 'sellsword', 1, 0, 'W', dummy({ eva: 30 }))]);
    const pair = battle(flatRows(3, 2), [unit('d', 'player', 'duelist', 0, 0, 'E'), unit('a', 'player', 'sellsword', 0, 1, 'E', dummy()), unit('e', 'enemy', 'sellsword', 1, 0, 'W', dummy({ eva: 30 }))]);
    const h = (s: typeof solo) => previewAction(s, getUnit(s, 'd'), 'measuredCut', { x: 1, y: 0 }).victims[0]!.hit;
    expect(h(solo) - h(pair)).toBe(10);
  });

  it('Feint: on a hit the target turns its back to the Duelist', () => {
    const s = battle(flatRows(3, 1), [unit('d', 'player', 'duelist', 0, 0, 'E', { stats: { ...deriveStats('duelist', 3), ...fast, hitBonus: 200 }, abilities: abilitiesAtRank('duelist', 2) }), unit('e', 'enemy', 'sellsword', 1, 0, 'W', dummy())]);
    startNextTurn(s);
    useAbility(s, 'd', 'feint', { x: 1, y: 0 });
    expect(getUnit(s, 'e').facing).toBe('E');
    expect(previewAction(s, getUnit(s, 'd'), 'strike', { x: 1, y: 0 }).victims[0]!.side).toBe('back');
  });
});
