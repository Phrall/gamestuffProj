import Phaser from 'phaser';
import type { BattleState } from '../core/battle';
import { teamMorale } from '../core/stats';
import { reckonVows } from '../core/vows';
import { lookup, scene, t, vowName, vowParams } from '../data/strings';
import { playDialogue } from './dialogue';
import { FONT } from './theme';
import { playMusic, sfx } from '../audio';

// End screen: banner, Reckoning table (text from Writing's strings), then the post-battle scene.
// The fully styled Reckoning is issue #10.
export default class ResultsScene extends Phaser.Scene {
  constructor() { super('Results'); }

  create(data: { state: BattleState }): void {
    const s = data.state;
    const { width } = this.scale;
    const won = s.winner === 'player';
    this.add.text(width / 2, 70, (won ? t('ui.banner.victory') : t('ui.banner.defeat')).toUpperCase(), { fontFamily: FONT, fontSize: '52px', color: won ? '#f5c451' : '#f87171' }).setOrigin(0.5);
    this.add.text(width / 2, 122, `${t('ui.reckoning.title')} · ${t('ui.reckoning.subtitle')}`, { fontFamily: FONT, fontSize: '16px', color: '#e5e7eb' }).setOrigin(0.5);
    this.add.text(width / 2, 146, `Mill Ford · ${s.turnNumber} turns · seed ${s.seed}`, { fontFamily: FONT, fontSize: '13px', color: '#9ca3af' }).setOrigin(0.5);

    const vows = new Map(reckonVows(s).map((v) => [v.unitId, v]));
    const key = { fulfilled: 'kept', broken: 'broken', lapsed: 'lapsed', intact: 'lapsed' } as const;
    const rows: string[] = [];
    for (const u of s.units.filter((x) => x.team === 'player')) {
      const v = vows.get(u.id);
      const head = `${u.name.padEnd(7)} ${t(`ui.reckoning.status.${u.status === 'ok' ? 'standing' : u.status}`).padEnd(9)} ${t('ui.reckoning.columns.defeats')} ${u.defeats}   `;
      if (!v) { rows.push(`${head}${t('ui.reckoning.result.none')} · ${t('ui.reckoning.noneNote')}`); continue; }
      const k = key[v.status];
      const gains = [v.resolve ? `+${v.resolve} ${t('ui.reckoning.columns.resolve')}` : '', v.shadow ? `+${v.shadow} ${t('ui.reckoning.columns.shadow')}` : '', k === 'lapsed' ? t('ui.reckoning.lapsedNote') : ''].filter(Boolean).join(' · ');
      rows.push(`${head}${vowName(v.vowId)} ${t(`ui.reckoning.result.${k}`)}${gains ? ` · ${gains}` : ''}`);
      rows.push(`${''.padEnd(9)}${t(`ui.reckoning.detail.${v.vowId}.${k}`, vowParams(v.vowId, s.vows[u.id]!.progress))}`);
      // End-of-battle reaction (Bulwark's Kept and every Lapsed land here).
      // Writing's rule: a sworn unit that ended downed or lost says its 'lost' line instead.
      const line = lookup(`vows.${v.vowId}.reaction.${u.id}.${u.status === 'ok' ? k : 'lost'}`);
      if (typeof line === 'string') rows.push(`${''.padEnd(9)}"${line}"`);
    }
    const tier = teamMorale(s, 'player').name.toLowerCase();
    const change = s.morale.player - 50;
    rows.push('', t('ui.reckoning.morale', { value: s.morale.player, tier: t(`ui.morale.${tier}.name`), change: change >= 0 ? `+${change}` : String(change) }));
    this.add.text(width / 2, 170, rows.join('\n'), { fontFamily: FONT, fontSize: '16px', color: '#e5e7eb', lineSpacing: 6 }).setOrigin(0.5, 0);

    // Vow sounds for the Reckoning: kept (incl. Bulwark judged at battle end), then lapsed.
    const results = [...vows.values()].map((v) => v.status);
    if (results.includes('fulfilled')) this.time.delayedCall(500, () => sfx(this, 'vow_kept'));
    if (results.some((r) => r === 'lapsed' || r === 'intact')) this.time.delayedCall(results.includes('fulfilled') ? 2300 : 500, () => sfx(this, 'vow_lapsed'));
    // The victory/defeat sting (4.5 s) plays out first, then the camp loop.
    this.time.delayedCall(3600, () => playMusic(this, 'mus_camp_loop'));

    const again = () => { sfx(this, 'ui_click'); this.scene.start('Battle'); };
    const prompt = () => {
      this.add.text(width / 2, 640, `${t('ui.reckoning.retry')}: click or press SPACE`, { fontFamily: FONT, fontSize: '18px', color: '#9ca3af' }).setOrigin(0.5);
      this.input.keyboard?.once('keydown-SPACE', again);
      this.time.delayedCall(400, () => this.input.once('pointerdown', again));
    };
    this.time.delayedCall(300, () => playDialogue(this, scene(won ? 'millFord.post.win' : 'millFord.post.loss'), () => this.time.delayedCall(0, prompt)));
  }
}
