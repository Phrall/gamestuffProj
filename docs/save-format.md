# Save format and versioning (vertical slice)

Status: agreed plan, written before save/load is built (Dec 7–18). The code will follow this note. If the code has to differ, this file changes in the same PR.

Sources: the Director's slice rulings and UX boards 6–10 (save/load screen).

## When the game saves

- **At camp**, by hand, into one of 3 slots.
- **Autosave** right after each Reckoning, before camp opens, with a 2-second "Autosaved" toast.
- **No mid-battle saves.** A save always describes the campaign *between* battles. Loading one puts you at camp.

## Slots

| Slot | Written by | Overwrite | Delete |
|---|---|---|---|
| `auto` | the game, after every Reckoning | only by the next autosave | yes, from the load screen (confirm) |
| `1`, `2`, `3` | the player, at camp | yes; always confirms when occupied (old vs new shown, Cancel focused, Overwrite in red) | yes (confirm) |

Writing a slot is atomic. The game builds and validates the new save in memory, writes it under a temp key, then swaps it in. A failed write (quota, private mode) leaves the old save intact and shows an error toast.

## Where saves live

- **localStorage**, one key per slot: `oathbound.save.auto`, `oathbound.save.1` … `oathbound.save.3`. A whole save is a few KB, so IndexedDB isn't needed.
- Every key the game uses starts with `oathbound.` (saves, the temp write key `oathbound.save.tmp`, and the volume key `oathbound.volume`). GitHub Pages shares one localStorage across every repo under `phrall.github.io`, so the game never reads, lists or clears keys outside that prefix.
- The origin's quota is about 5 MB in total. A write that hits the quota throws; the game catches it, keeps the old save, removes the temp key, and shows "Couldn't save: browser storage is full". This gets a test.
- The load screen warns that saves are tied to this browser.
- **Export** downloads a slot as `oathbound-<slot>-<date>.json`, the same JSON as stored. **Import** reads such a file into a slot the player picks (1–3, never `auto`). It runs the same validation and migration as loading first, then uses the same overwrite confirm as saving when the slot is occupied.

## Shape (format version 1)

```jsonc
{
  "format": "oathbound-save",   // magic: anything else is not a save
  "version": 1,                 // schema version, an integer; bumped on any breaking change
  "gameVersion": "0.2.0",       // build that wrote it (info only)
  "savedAt": "2026-12-10T19:04:00Z",
  "slot": "auto",
  "debug": false,               // true if written with debug unlocks on (shown on the slot)
  "settings": { "permadeath": false },   // rule toggle; Jen decides on Mar 12
  "campaign": {
    "nextBattle": "ashfordGreen",         // battle id; must exist in data
    "completed": [ { "battle": "millFord", "winner": "player", "turns": 31 } ],
    "seed": 123456,                       // campaign seed
    "rngState": 987654321                 // mulberry32 state after the last battle
  },
  "morale": 55,
  "units": [
    {
      "id": "maren",                 // must exist in data
      "level": 3, "xp": 40,
      "classId": "sellsword",        // must be an unlocked class
      "secondary": "bowhand",        // or null; any unlocked class
      "weapon": "ironSword", "armor": "leather",   // item ids, or null
      "resolve": { "bulwark": 4, "loneBlade": 0, "mercy": 0 },
      "shadow":  { "bulwark": 0, "loneBlade": 2, "mercy": 0 },
      "unlocked": ["sellsword", "bowhand", "warden"],
      "status": "ok"                 // "ok" or "lost"; lost units return at camp while permadeath is off
    }
  ],
  "talks": { "seen": ["millFord.tobin.broken"] },   // camp conversations already played
  "inventory": { "ironSword": 1 }
}
```

HP is not saved. Units start each battle at full HP, so there is no HP field to go wrong.

## Versioning

- `version` is a single integer, starting at **1**.
- Loading runs **forward migrations** one step at a time (`migrate[1→2]`, `migrate[2→3]`, …) until the save reaches the current version. Each migration is a pure function with its own test.
- **Newer version than the game** (a save from a later build): refused with the message "This save is from a newer version of Oathbound." The slot is left untouched.
- **No `version`, or `format` isn't `"oathbound-save"`**: refused as "Not an Oathbound save." It is never guessed at.
- Migrations run on a copy. The stored save is only rewritten when the player saves again.

## Validation: refuse, don't clamp

Every load (slot or import) is validated after migration, before any game state is touched. **Any failure refuses the whole save**, with a short reason, and the slot stays visible as "Damaged save" so it can be exported or deleted. Nothing is silently clamped, because a clamped save hides the bug that broke it.

| Case | Result |
|---|---|
| Unknown unit, class, item, battle or vow id | refused: "Unknown class 'x'" |
| A class in `classId`/`secondary` that isn't in `unlocked` | refused |
| Missing required field, wrong type | refused, naming the field |
| `NaN`, `Infinity`, negative or non-integer where an integer ≥ 0 is expected (level, xp, resolve, shadow, morale, counts) | refused |
| Number outside its range (table below) | refused |
| Raw JSON over **256 KB**, or any string field over 200 chars | refused before parsing the rest |
| Invalid JSON | refused: "Damaged save" |
| Extra unknown fields | ignored, and dropped on the next save |

### Field ranges (v1)

All numbers are integers. A value on the edge loads; one past it is refused. So 99 Resolve loads and level 999 is refused.

| Field | Min | Max |
|---|---|---|
| `version` | 1 | current game version |
| `units[].level` | 1 | 20 |
| `units[].xp` | 0 | 99 (resets at each level) |
| `units[].resolve.<vow>`, `units[].shadow.<vow>` | 0 | 99 |
| `morale` | 0 | 100 |
| `campaign.seed`, `campaign.rngState` | 0 | 4294967295 (uint32) |
| `campaign.completed[].turns` | 1 | 999 |
| `inventory.<item>` | 0 | 99 |
| `units` length | 1 | 12 |
| `campaign.completed` length | 0 | 50 |
| `talks.seen` length | 0 | 500 |
| any string | 1 char | 200 chars |
| whole file | | 256 KB |

## Determinism

The campaign seed and the RNG state are saved, so loading a save and playing the next battle gives the same rolls as continuing without the reload, given the same choices. `?seed=` still overrides for testing.

## Debug unlocks (QA)

URL parameters, also listed in the debug overlay (`D`):

- `?unlock=all` unlocks every class for every unit.
- `?resolve=N&shadow=N` sets every unit's Resolve and Shadow on every vow path.
- `?battle=<id>` jumps to a battle with the current squad.

Any save written while one of these is on gets `"debug": true` and a "Debug" tag on its slot.

## Tests

- `tests/fixtures/saves/v1-*.json` has one valid fixture per format version: a fresh campaign, mid-campaign with unlocks, and one with a lost unit. CI loads each one through migration and validation.
- One bad fixture per row of the validation table must be refused with the expected reason.
- A round trip (save, then load, then save) gives byte-identical JSON.
- When `version` goes up, the old version's fixtures stay in place. That is how old-save loading stays covered.
