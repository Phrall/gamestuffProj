import { describe, expect, it } from 'vitest';
import { createBattle, endTurn, getUnit, startNextTurn, useAbility } from '../src/core/battle';
import { HARD_TO_KILL_MIN_PCT, previewAction } from '../src/core/combat';
import { abilitiesAtRank, battleClassXp, eligibleTraits, rankFor, unlockedClasses } from '../src/core/jobs';
import { effectiveStats } from '../src/core/stats';
import { parseMap, type BattleSetup } from '../src/data';
import { battle, flatRows, unit } from './helpers';

const weak = { hp: 10, atk: 30, mag: 1, def: 0, res: 0, spd: 9, move: 4, jump: 2, eva: 0, hitBonus: 200 };
const slow = (hp: number) => ({ stats: { hp, atk: 1, mag: 1, def: 0, res: 0, spd: 1, move: 4, jump: 2, eva: 0 } });

describe('Hard to Kill (§9.4)', () => {
  it('previews "survives at 1", leaves 1 HP, then works only once', () => {
    const s = battle(flatRows(3, 1), [
      unit('e', 'enemy', 'sellsword', 0, 0, 'E', { stats: weak }),
      unit('m', 'player', 'sellsword', 1, 0, 'W', { ...slow(20), traits: ['hardToKill'] }),
    ]);
    startNextTurn(s);
    const p = previewAction(s, getUnit(s, 'e'), 'strike', { x: 1, y: 0 });
    expect(p.victims[0]).toMatchObject({ hpAfter: 1, downs: false, survives: 'hardToKill' });
    useAbility(s, 'e', 'strike', { x: 1, y: 0 });
    expect(getUnit(s, 'm')).toMatchObject({ hp: 1, status: 'ok' });
    expect(s.events.some((e) => e.type === 'trait' && e.traitId === 'hardToKill')).toBe(true);
    const again = previewAction(s, getUnit(s, 'e'), 'strike', { x: 1, y: 0 });
    expect(again.victims[0]).toMatchObject({ hpAfter: 0, downs: true });
    expect(again.victims[0]!.survives).toBeUndefined();
  });
});

describe('Hard to Kill v3 (tune v2)', () => {
  it('saves only from at least minPct (20%) of max HP', () => {
    const at = (hp: number) => {
      const s = battle(flatRows(3, 1), [
        unit('e', 'enemy', 'sellsword', 0, 0, 'E', { stats: weak }),
        unit('m', 'player', 'sellsword', 1, 0, 'W', { ...slow(20), traits: ['hardToKill'] }),
      ]);
      getUnit(s, 'm').hp = hp;
      return previewAction(s, getUnit(s, 'e'), 'strike', { x: 1, y: 0 }).victims[0]!;
    };
    expect(HARD_TO_KILL_MIN_PCT).toBe(20);
    expect(at(4)).toMatchObject({ survives: 'hardToKill', hpAfter: 1 }); // 4/20 = 20%
    expect(at(3).survives).toBeUndefined();
    expect(at(3).downs).toBe(true);
  });
});

describe('Hedge Lore (§9.4)', () => {
  it('heals 2 at turn start with no foe adjacent, and not with one', () => {
    const s = battle(flatRows(6, 1), [
      unit('c', 'player', 'hedgeMage', 0, 0, 'E', { traits: ['hedgeLore'] }),
      unit('e', 'enemy', 'sellsword', 5, 0, 'W', slow(20)),
    ]);
    const c = getUnit(s, 'c');
    c.hp -= 5;
    startNextTurn(s);
    expect(c.hp).toBe(c.base.hp - 3);
    endTurn(s);
    getUnit(s, 'e').pos = { x: 1, y: 0 };
    while (startNextTurn(s)!.id !== 'c') endTurn(s);
    expect(c.hp).toBe(c.base.hp - 3);
  });

  it('a trait passive works like the class one, without stacking (Sure Footing)', () => {
    const s = battle(flatRows(2, 1), [unit('w', 'player', 'bowhand', 0, 0, 'E', { traits: ['sureFooting'] })]);
    const w = getUnit(s, 'w');
    expect(effectiveStats(s, w).jump).toBe(w.base.jump + 1);
  });
});

describe('spawn twist (§10)', () => {
  const setup = (): BattleSetup => ({
    map: parseMap({ id: 't', name: 't', width: 5, height: 5, rows: flatRows(5, 5) }),
    units: [
      unit('p', 'player', 'sellsword', 2, 2, 'N', slow(99)),
      unit('e', 'enemy', 'sellsword', 0, 4, 'N', slow(99)),
    ],
    twists: [{ id: 'secondWave', firesAtTurn: 4, announceTurnsAhead: 1, effect: 'spawn', units: [
      unit('r1', 'enemy', 'sellsword', 0, 4, 'N', slow(5)),
      unit('r2', 'enemy', 'sellsword', 4, 4, 'N', slow(5)),
    ] }],
  });

  it('announces the turn before, then spawns at turn start, moving off a taken tile', () => {
    const s = createBattle(setup(), 1);
    for (let n = 1; n <= 4; n++) { startNextTurn(s); if (n < 4) endTurn(s); }
    const ann = s.events.findIndex((e) => e.type === 'twistAnnounce');
    const fire = s.events.findIndex((e) => e.type === 'twist');
    expect(ann).toBeGreaterThanOrEqual(0);
    expect(s.events.filter((e) => e.type === 'turnStart').length).toBe(4);
    expect(fire).toBeGreaterThan(ann);
    const announced = s.events[ann] as { tiles: { x: number; y: number }[] };
    expect(announced.tiles).toEqual([{ x: 0, y: 3 }, { x: 4, y: 4 }]); // (0,4) is taken by e
    expect(getUnit(s, 'r1').pos).toEqual({ x: 0, y: 3 });
    expect(getUnit(s, 'r2')).toMatchObject({ pos: { x: 4, y: 4 }, status: 'ok', ct: 0 });
  });

  it('the battle is not won while a wave is still to come; an early clear pulls the wave forward', () => {
    const t = setup();
    t.twists![0]!.firesAtTurn = 30;
    const s = createBattle(t, 1);
    getUnit(s, 'e').status = 'lost'; // cleared before turn 1
    expect(startNextTurn(s)).not.toBeNull(); // turn 1: banner, wave pulled to turn 2
    expect(s.winner).toBeNull();
    expect(s.events.some((e) => e.type === 'twistAnnounce' && e.firesAtTurn === 2)).toBe(true);
    expect(s.events.some((e) => e.type === 'twist')).toBe(false);
    endTurn(s);
    startNextTurn(s); // turn 2: arrival
    expect(s.events.some((e) => e.type === 'twist')).toBe(true);
    expect(getUnit(s, 'r1').status).toBe('ok');
  });
});

describe('class XP and ranks (§9.1-9.3)', () => {
  it('counts deployed, actions, support, defeats and intercepts', () => {
    const s = battle(flatRows(3, 1), [
      unit('m', 'player', 'hedgeMage', 0, 0, 'E', { stats: weak }),
      unit('e', 'enemy', 'sellsword', 1, 0, 'W', slow(5)),
      unit('x', 'enemy', 'sellsword', 2, 0, 'W', slow(99)),
    ]);
    s.events.push({ type: 'ability', unitId: 'm', abilityId: 'mend', target: { x: 0, y: 0 }, preview: { actorId: 'm', abilityId: 'mend', from: { x: 0, y: 0 }, target: { x: 0, y: 0 }, victims: [], breaksVow: false }, results: [] });
    s.events.push({ type: 'intercept', unitId: 'm', protectedId: 'q', attackerId: 'x' });
    startNextTurn(s);
    useAbility(s, 'm', 'spark', { x: 1, y: 0 });
    expect(getUnit(s, 'e').status).not.toBe('ok');
    expect(battleClassXp(s, 'm')).toEqual({ deployed: 30, actions: 10, support: 5, defeats: 10, intercepts: 5, total: 60 });
    expect(battleClassXp(s, 'nobody').total).toBe(0);
  });

  it('ranks follow 50/120/240/400, capped at 3 in Act 1', () => {
    expect([0, 49, 50, 119, 120, 500].map((x) => rankFor(x))).toEqual([1, 1, 2, 2, 3, 3]);
    expect(rankFor(400, 5)).toBe(5);
    expect(abilitiesAtRank('sellsword', 1)).toEqual(['strike', 'cleave', 'shove', 'brace', 'rallyCry']);
    expect(abilitiesAtRank('sellsword', 3)).toEqual(['strike', 'cleave', 'shove', 'brace', 'rallyCry', 'hamstring', 'hardToKill']);
  });

  it('traits come from rank 3 in a class other than the primary', () => {
    expect(eligibleTraits({ sellsword: 130, hedgeMage: 40 }, 'warden')).toEqual(['hardToKill']);
    expect(eligibleTraits({ sellsword: 130 }, 'sellsword')).toEqual([]);
  });

  it('unlocks need 4 Resolve and rank 2 in a fitting base class; shadow classes stay out of the slice', () => {
    const p = { resolve: { bulwark: 4, loneBlade: 2 }, shadow: { bulwark: 4 }, classXp: { sellsword: 50 } };
    expect(unlockedClasses(p)).toEqual(['warden']);
    expect(unlockedClasses({ ...p, classXp: { sellsword: 49 } })).toEqual([]);
    expect(unlockedClasses(p, true)).toEqual(['warden', 'forsworn']);
  });
});
