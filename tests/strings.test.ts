import { describe, expect, it } from 'vitest';
import { ABILITIES, RAW_DATA } from '../src/data';
import { bark, format, lookup, scene, t } from '../src/data/strings';

const unitIds = [...RAW_DATA.playerUnits, ...RAW_DATA.enemyUnits].map((u) => u.id);

describe('strings (Writing hand-off)', () => {
  it('ids line up with the data file', () => {
    for (const sp of Object.keys(lookup('speakers') as object)) if (sp !== 'narrator') expect(unitIds, sp).toContain(sp);
    for (const u of Object.keys(lookup('barks') as object)) expect(unitIds, u).toContain(u);
    for (const id of Object.keys(lookup('ui.abilities') as object)) expect(Object.keys(ABILITIES), id).toContain(id);
    for (const v of Object.keys(lookup('vows') as object)) expect(Object.keys(RAW_DATA.vows), v).toContain(v);
  });

  it('every scene line has an id and a known speaker', () => {
    const speakers = Object.keys(lookup('speakers') as object);
    const ids = new Set<string>();
    for (const sc of ['millFord.pre', 'millFord.post.win', 'millFord.post.loss']) {
      const lines = scene(sc);
      expect(lines.length, sc).toBeGreaterThan(0);
      for (const l of lines) {
        expect(speakers, l.id).toContain(l.speaker);
        expect(ids.has(l.id), l.id).toBe(false);
        ids.add(l.id);
      }
    }
  });

  it('formats placeholders and leaves unknown ones visible', () => {
    expect(format('{n}/{goal} guarded', { n: 1, goal: 1 })).toBe('1/1 guarded');
    expect(format('{n}/{goal}', { n: 0 })).toBe('0/{goal}');
    expect(t('no.such.key')).toBe('no.such.key');
    expect(t('ui.vows.bulwark.progress', { n: 1, goal: RAW_DATA.vows.bulwark.goal })).toBe('1/1 guarded');
  });

  it('barks pick one of three lines', () => {
    const line = bark('maren', 'attack', () => 0.99);
    expect((lookup('barks.maren.attack') as string[])).toContain(line);
  });
});

describe('strings: every ui placeholder fills from data (QA S2/S3)', () => {
  it('vow, ability and morale texts have no raw {placeholders} left', async () => {
    const { abilityParams, moraleParams, vowParams } = await import('../src/data/strings');
    const leftovers: string[] = [];
    const check = (path: string, params: Record<string, string | number>) => {
      const s = t(path, params);
      if (/\{\w+\}/.test(s) || s === path) leftovers.push(`${path}: ${s}`);
    };
    for (const v of ['bulwark', 'loneBlade']) {
      for (const k of ['summary', 'whileSworn', 'kept', 'breaks', 'broken', 'progress']) check(`ui.vows.${v}.${k}`, vowParams(v, 1));
      for (const r of ['kept', 'broken', 'lapsed']) check(`ui.reckoning.detail.${v}.${r}`, vowParams(v, 0));
    }
    for (const id of Object.keys(lookup('ui.abilities') as object)) check(`ui.abilities.${id}.tooltip`, abilityParams(id, 8));
    for (const tier of ['shaken', 'steady', 'inspired']) check(`ui.morale.${tier}.tooltip`, moraleParams(tier));
    expect(leftovers).toEqual([]);
    expect(t('ui.vows.bulwark.summary', vowParams('bulwark'))).toBe('Guard an ally from 1 attack, and let no ally within 3 tiles fall.');
    expect(t('ui.abilities.mend.tooltip', abilityParams('mend', 8))).toContain('for 8 HP');
    expect(t('ui.abilities.pinningArrow.tooltip', abilityParams('pinningArrow'))).toContain('loses 2 Move');
  });
});
