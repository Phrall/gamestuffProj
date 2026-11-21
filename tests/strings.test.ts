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
