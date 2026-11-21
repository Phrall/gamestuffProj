import { describe, expect, it } from 'vitest';
import { attributesAt, CLASSES, deriveStats, millFordSetup, RAW_DATA } from '../src/data';
import { createBattle, getUnit } from '../src/core/battle';
import { previewAction } from '../src/core/combat';

const pick = (s: Record<string, number | undefined>) => ({ hp: s.hp, atk: s.atk, mag: s.mag, def: s.def, res: s.res, spd: s.spd, move: s.move, jump: s.jump, eva: s.eva });

describe('stats from class, level, attributes and gear (§19)', () => {
  it('attributes grow by floor(growth × (L − 1))', () => {
    expect(attributesAt('sellsword', 1)).toEqual({ str: 5, vit: 8, dex: 7, agi: 7, int: 2, wil: 4 });
    expect(attributesAt('sellsword', 3)).toEqual({ str: 6, vit: 10, dex: 8, agi: 8, int: 2, wil: 4 });
  });

  it("every Mill Ford unit's derived stats match Design's written blocks", () => {
    for (const p of RAW_DATA.playerUnits) {
      const d = deriveStats(p.class, p.level);
      expect(pick(d as never), p.id).toEqual(pick(CLASSES[p.class]!.stats as never));
      expect(d, p.id).toEqual(p.derivedPreview);
      expect(d.hitBonus, p.id).toBe(p.hitBonus);
    }
    for (const e of RAW_DATA.enemyUnits) {
      const d = deriveStats(e.statClass, e.level);
      expect(pick(d as never), e.id).toEqual(pick(e.stats as never));
      expect(d.hitBonus, e.id).toBe(e.hitBonus);
    }
  });

  it('battle start uses the derived stats', () => {
    const s = createBattle(millFordSetup(), 1);
    expect(getUnit(s, 'spearB').hp).toBe(24);
    expect(getUnit(s, 'spearA').hp).toBe(26);
    expect(getUnit(s, 'archerA').base.eva).toBe(15);
    expect(getUnit(s, 'calla').base.eva).toBe(6);
  });

  it('hit uses 86 melee / 80 ranged plus the unit hit bonus', () => {
    const s = createBattle(millFordSetup(), 1);
    const spear = getUnit(s, 'spearA');
    const maren = getUnit(s, 'maren');
    // Stand the spearman behind Maren on level ground: back attack ignores Eva, so hit = 86 + 2.
    spear.pos = { x: 4, y: 9 };
    maren.pos = { x: 4, y: 8 };
    maren.facing = 'N';
    const v = previewAction(s, spear, 'thrust', maren.pos).victims.find((x) => x.unitId === 'maren')!;
    expect(v.side).toBe('back');
    expect(v.heightDiff).toBe(0);
    expect(v.hit).toBe(86 + 2);
  });
});
