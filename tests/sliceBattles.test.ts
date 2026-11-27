import { describe, expect, it } from 'vitest';
import { createBattle, endTurn, getUnit, moveUnit, startNextTurn, useAbility } from '../src/core/battle';
import { planTurn } from '../src/core/ai';
import { previewAction } from '../src/core/combat';
import { tileAt } from '../src/core/grid';
import { reachableTiles } from '../src/core/pathfinding';
import { planSquadTurn, newSquadMemory } from '../src/core/squadAi';
import { effectiveStats } from '../src/core/stats';
import { resolveVowsAtEnd, swearVow } from '../src/core/vows';
import { RULES, deriveStats, parseMap, sliceSetup, type BattleSetup } from '../src/data';
import { simulate } from '../scripts/sim';
import { battle, flatRows, unit } from './helpers';

const sturdy = (over: Partial<ReturnType<typeof deriveStats>> = {}) => ({ stats: { hp: 99, atk: 1, mag: 1, def: 0, res: 0, spd: 1, move: 4, jump: 2, eva: 0, ...over } });

describe('slice maps (§5-6)', () => {
  it('Ashford Green (tune v2): fences, cottage walls and the well rim, with Writer terrain ids', () => {
    const { map, units } = sliceSetup('ashfordGreen');
    expect(tileAt(map, { x: 4, y: 2 })).toEqual({ kind: 'fence', height: 0 });
    expect(tileAt(map, { x: 1, y: 1 })).toEqual({ kind: 'wall', height: 0, terrain: 'cottageWall' });
    expect(tileAt(map, { x: 4, y: 4 })).toEqual({ kind: 'ground', height: 2, terrain: 'wellRim' });
    expect(tileAt(map, { x: 0, y: 0 })).toEqual({ kind: 'ground', height: 1 });
    expect(units.filter((u) => u.civilian).length).toBe(4);
    const r = units.find((u) => u.id === 'raiderA')!;
    expect(r.stats).toMatchObject({ hp: 18, atk: 7, def: 0, res: 1, spd: 7, move: 5, eva: 14, hitBonus: 3 });
    expect(units.find((u) => u.id === 'dunmore')!.stats).toMatchObject({ hp: 36, atk: 11, def: 3, res: 4, spd: 7, eva: 16, hitBonus: 5 });
    expect(units.find((u) => u.id === 'villagerA')!.stats).toMatchObject({ hp: 16, def: 0, res: 1, spd: 4, move: 3, eva: 5 });
  });

  it('Saltmarsh Chapel (tune v2): marsh, chapel walls, doors, bell stairs, the wave twist, and roster stats', () => {
    const { map, units, twists } = sliceSetup('saltmarshChapel');
    expect(tileAt(map, { x: 0, y: 0 })).toEqual({ kind: 'marsh', height: 0 });
    expect(tileAt(map, { x: 3, y: 4 })).toEqual({ kind: 'ground', height: 1, terrain: 'chapelDoor' });
    expect(tileAt(map, { x: 7, y: 5 })).toEqual({ kind: 'ground', height: 3, terrain: 'bellStairs' });
    expect(tileAt(map, { x: 6, y: 4 })).toMatchObject({ kind: 'wall', terrain: 'chapelWall' });
    expect(twists![0]).toMatchObject({ id: 'secondWave', firesAtTurn: 30 });
    expect(units.find((u) => u.id === 'slingerB')!.stats).toMatchObject({ hp: 20, atk: 6, eva: 15, hitBonus: 5 });
    expect(units.find((u) => u.id === 'selka')!.stats).toMatchObject({ hp: 32, atk: 10, def: 3, res: 4, spd: 7, eva: 14, hitBonus: 4 });
    expect(units.find((u) => u.id === 'maren')!.stats).toEqual(deriveStats('sellsword', 4));
  });

  it('fences and walls are impassable; marsh costs 2 to enter', () => {
    const s = battle(['0 0 0', '0 0 0'], [unit('a', 'player', 'sellsword', 0, 0, 'E')]);
    s.map = parseMap({ id: 't', name: 't', width: 3, height: 2, rows: ['0 M F', '0 0 X'], codes: { M: { kind: 'marsh', height: 0 }, F: { kind: 'fence', height: 0 }, X: { kind: 'wall', height: 0 } } });
    const reach = new Map(reachableTiles(s, getUnit(s, 'a')).map((n) => [`${n.pos.x},${n.pos.y}`, n.cost]));
    expect(reach.get('1,0')).toBe(2);
    expect(reach.has('2,0')).toBe(false);
    expect(reach.has('2,1')).toBe(false);
  });

  it('a Shove into a fence is blocked for the bonus', () => {
    const s = battle(['0 0 0'], [unit('a', 'player', 'sellsword', 0, 0, 'E'), unit('e', 'enemy', 'sellsword', 1, 0, 'W', sturdy())]);
    s.map = parseMap({ id: 't', name: 't', width: 3, height: 1, rows: ['0 0 F'], codes: { F: { kind: 'fence', height: 0 } } });
    const plain = battle(['0 0 0'], [unit('a', 'player', 'sellsword', 0, 0, 'E'), unit('e', 'enemy', 'sellsword', 1, 0, 'W', sturdy())]);
    const fence = previewAction(s, getUnit(s, 'a'), 'shove', { x: 1, y: 0 }).victims[0]!;
    const open = previewAction(plain, getUnit(plain, 'a'), 'shove', { x: 1, y: 0 }).victims[0]!;
    expect(fence.pushedTo).toBeUndefined();
    expect(fence.damage - open.damage).toBe(3);
  });
});

function yieldSetup(): BattleSetup {
  return {
    map: parseMap({ id: 't', name: 't', width: 6, height: 3, rows: flatRows(6, 3) }),
    units: [
      unit('c', 'player', 'hedgeMage', 2, 1, 'E', { stats: { ...deriveStats('hedgeMage', 3), spd: 9 } }),
      unit('r', 'enemy', 'sellsword', 3, 1, 'W', { ...sturdy({ hp: 18, spd: 5 }), abilities: ['strike'], yieldBelow: 0.25 }),
      unit('x', 'enemy', 'sellsword', 5, 2, 'W', { ...sturdy({ spd: 1 }), abilities: [] }),
    ],
  };
}

describe('Yield and Mercy (§4, §8)', () => {
  it('yields at turn start at floor(25%) HP, makes no attack, flees off an edge and counts as spared', () => {
    const s = createBattle(yieldSetup(), 1);
    swearVow(s, 'c', 'mercy');
    getUnit(s, 'r').hp = 4;
    const morale = s.morale.enemy;
    let r = startNextTurn(s)!;
    while (r.id !== 'r') { endTurn(s); r = startNextTurn(s)!; }
    expect(r.yielding).toBe(true);
    const plan = planTurn(s, r);
    expect(plan.action).toBeNull();
    moveUnit(s, r.id, plan.moveTo);
    endTurn(s, plan.facing);
    expect(r).toMatchObject({ status: 'lost', fled: true });
    expect(s.morale.enemy).toBe(morale - 3);
    expect(s.vows.c).toMatchObject({ progress: 1, status: 'intact' }); // Held: resolves at the end
  });

  it('5 HP of 18 does not yield (floor(4.5) = 4)', () => {
    const s = createBattle(yieldSetup(), 1);
    getUnit(s, 'r').hp = 5;
    let u = startNextTurn(s)!;
    while (u.id !== 'r') { endTurn(s); u = startNextTurn(s)!; }
    expect(u.yielding).toBe(false);
  });

  it('Mercy: +2 Res while sworn; striking a yielding foe previews and breaks it, with the surge', () => {
    const s = createBattle(yieldSetup(), 1);
    const c = getUnit(s, 'c');
    const res = effectiveStats(s, c).res;
    swearVow(s, 'c', 'mercy');
    expect(effectiveStats(s, c).res).toBe(res + 2);
    getUnit(s, 'r').yielding = true;
    startNextTurn(s);
    expect(s.activeId).toBe('c');
    expect(previewAction(s, c, 'spark', { x: 3, y: 1 }).breaksVow).toBe(true);
    useAbility(s, 'c', 'spark', { x: 3, y: 1 });
    expect(s.vows.c!.status).toBe('broken');
    expect(c.modifiers.some((m) => m.source === 'mercySurge' && m.atk === 3)).toBe(true);
  });

  it('a yielding foe alive at battle end counts as spared, so Mercy is kept', () => {
    const s = createBattle(yieldSetup(), 1);
    swearVow(s, 'c', 'mercy');
    getUnit(s, 'r').yielding = true;
    resolveVowsAtEnd(s);
    expect(s.vows.c).toMatchObject({ status: 'fulfilled', progress: 1 });
  });

  it('the Mercy-sworn squad AI never targets a yielding foe', () => {
    const s = createBattle(yieldSetup(), 1);
    swearVow(s, 'c', 'mercy');
    getUnit(s, 'r').yielding = true;
    getUnit(s, 'x').pos = { x: 0, y: 0 };
    startNextTurn(s);
    const plan = planSquadTurn(s, getUnit(s, 'c'), newSquadMemory(s, { millFord: false }));
    expect(plan.action?.target).not.toEqual({ x: 3, y: 1 });
  });
});

describe('villagers (§5)', () => {
  it('escape off their edge, and the squad wins or loses without them', () => {
    const s = createBattle({
      map: parseMap({ id: 't', name: 't', width: 3, height: 4, rows: flatRows(3, 4) }),
      units: [
        unit('p', 'player', 'sellsword', 0, 0, 'S', sturdy({ spd: 1 })),
        unit('v', 'player', 'sellsword', 1, 1, 'S', { ...sturdy({ spd: 9, move: 3 }), abilities: [], civilian: true, escapeEdge: 'S' }),
        unit('e', 'enemy', 'sellsword', 2, 0, 'S', sturdy({ spd: 1 })),
      ],
    }, 1);
    const v = startNextTurn(s)!;
    expect(v.id).toBe('v');
    const plan = planTurn(s, v);
    expect(plan.moveTo).toEqual({ x: 1, y: 3 });
    moveUnit(s, 'v', plan.moveTo);
    endTurn(s);
    expect(v).toMatchObject({ status: 'lost', fled: true });
    expect(s.events.some((e) => e.type === 'fled' && e.civilian)).toBe(true);
    expect(s.winner).toBeNull();
    getUnit(s, 'p').status = 'lost';
    startNextTurn(s);
    expect(s.winner).toBe('enemy');
  });

  it('a villager falling breaks no Bulwark and is no ally for Lone Blade; Guard still covers villagers', () => {
    const st = (o: object) => ({ stats: { hp: 99, atk: 1, mag: 1, def: 0, res: 0, spd: 1, move: 4, jump: 2, eva: 0, ...o } });
    const villager = (x: number) => unit('v', 'player', 'sellsword', x, 0, 'S', { ...st({ hp: 1 }), abilities: [], civilian: true, escapeEdge: 'S' });
    // Bulwark: villager 3 tiles from Maren (break radius, outside Guard reach) is downed.
    const a = battle(flatRows(5, 1), [unit('m', 'player', 'sellsword', 0, 0, 'E', st({})), villager(3), unit('e', 'enemy', 'sellsword', 4, 0, 'W', st({ spd: 9, atk: 30, hitBonus: 200 }))]);
    swearVow(a, 'm', 'bulwark');
    startNextTurn(a);
    useAbility(a, 'e', 'strike', { x: 3, y: 0 });
    expect(getUnit(a, 'v').status).toBe('lost');
    expect(a.vows.m!.status).toBe('intact');
    // Lone Blade: a defeat with only a villager beside counts as alone.
    const b = battle(flatRows(3, 1), [villager(0), unit('t', 'player', 'sellsword', 1, 0, 'E', st({ spd: 9, atk: 30, hitBonus: 200 })), unit('x', 'enemy', 'sellsword', 2, 0, 'W', st({ hp: 5 }))]);
    swearVow(b, 't', 'loneBlade');
    startNextTurn(b);
    useAbility(b, 't', 'strike', { x: 2, y: 0 });
    expect(b.vows.t!.status).toBe('fulfilled');
    // Guard: Maren still takes an attack aimed at an adjacent villager.
    const c = battle(flatRows(3, 1), [unit('m', 'player', 'sellsword', 0, 0, 'E', st({})), villager(1), unit('e', 'enemy', 'sellsword', 2, 0, 'W', st({}))]);
    swearVow(c, 'm', 'bulwark');
    expect(previewAction(c, getUnit(c, 'e'), 'strike', { x: 1, y: 0 }).interceptedBy).toBe('m');
  });

  it('Torch: the target\'s next Wait gives only the one-action CT', () => {
    const s = battle(flatRows(3, 1), [
      unit('r', 'enemy', 'sellsword', 0, 0, 'E', { ...sturdy({ spd: 9 }), abilities: ['torch'] }),
      unit('p', 'player', 'sellsword', 1, 0, 'W', sturdy({ spd: 5 })),
    ]);
    startNextTurn(s);
    useAbility(s, 'r', 'torch', { x: 1, y: 0 });
    endTurn(s);
    while (startNextTurn(s)!.id !== 'p') endTurn(s);
    endTurn(s);
    expect(getUnit(s, 'p').ct).toBe(RULES.ctAfterTurn.oneOnly);
  });
});

describe('slice sims', () => {
  it('both battles finish on every seed, deterministically', () => {
    for (const battleId of ['ashfordGreen', 'saltmarshChapel'] as const) {
      const a = simulate(8, 'scripted', { battle: battleId });
      expect(simulate(8, 'scripted', { battle: battleId })).toEqual(a);
    }
    expect(simulate(8, 'scripted', { battle: 'saltmarshChapel' }).slice.twistFired).toBe(8);
  });
});
