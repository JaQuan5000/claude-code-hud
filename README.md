# Automatic model routing and a quota HUD for Claude Code

`hud` is a Claude Code mod that does two things:

- **Routes each request to the cheapest capable model.** A typo fix goes to Haiku. Everyday work goes to Sonnet. A planning job goes to Opus. A whole-system brief goes to Fable. You stop spending frontier quota on one-line edits, and you stop under-powering the work that deserves the best model.
- **Shows where you stand, above the prompt.** Which model is in play, how full the context is, and how much of each rate-limit window is gone, with the reset time.

```
haiku      auto │ ctx ██████████  31% │ 5h ██████████  18% ↻ 14:20 │ 7d ██████████  42% ↻ Thu
```

Each bar is one block character throughout. The filled part is coloured and the rest is dimmed, so in a terminal you read the level at a glance - and in a plain code block like the one above, where there is no colour, it looks solid. That is deliberate: pairing a full block with a shade character makes the two halves match in some terminal fonts and not others, and a bar that looks like a broken staircase is worse than one that needs colour.

The moment you pick a model yourself with `/model`, routing stands down and the badge reads `pin`. It will not override your choice on the next message.

In a narrow window it loses detail before it loses data: the bars shrink to eight, six, five and four cells before any reading is dropped, and the reset times go before a whole window does. The model is never dropped. It never wraps.

## Install

```bash
claude plugin marketplace add OWNER/claude-code-hud
claude plugin install hud@hud-mods
```

Needs Claude Code CLI v2.1.287 or later, or Desktop v2.1.286 or later. Mods do not run in WSL sessions.

## How the routing decides

The tier comes from the words in your prompt, read with two patterns in [`hud/hooks/hud-route.js`](hud/hooks/hud-route.js). They are meant to be edited:

| Tier | Chosen when | Default model |
| :- | :- | :- |
| `top` | You ask for it ("use the best model", "think really hard", "no shortcuts"), **or** the prompt is planning-shaped *and* big: a whole system, codebase or schema; production, safety or data loss at stake; or a brief over 1200 characters. | `fable` |
| `deep` | The prompt mentions planning, design, a refactor, a migration, debugging, a root cause, or trade-offs. Also any prompt over 400 characters. | `opus` |
| `fast` | A short prompt about a typo, a rename, formatting, a comment, or a version bump. | `haiku` |
| `base` | Everything else. | `sonnet` |

Three deliberate biases:

- **Uncertain means `base`, never `fast`.** A real task sent to a small model wastes the whole turn and your time. A typo fix sent to a large one wastes a few cents.
- **An expensive signal beats a cheap one.** "Plan the rename of every field" is planning, not a rename.
- **The flagship takes two signals, not one.** Planning plus size, or a direct request. One signal on its own is not enough.

It reads words, not intent, so it will be wrong sometimes. `/model` overrides it permanently for that session, and `/hud off` turns routing off entirely while keeping the readout.

### Asking for a model in the prompt

You do not have to touch a setting or run `/model` to reach the flagship. Say so in the prompt and the mod takes you at your word - any of these in your message is enough on its own, whatever else the prompt says:

| What you type | What happens |
| :- | :- |
| `use the best model` | Routes this turn to `top_model` |
| `use fable` | Same |
| `flagship` or `frontier model` | Same |
| `think really hard` / `think very hard` | Same |
| `no shortcuts` | Same |

So `no shortcuts on this, plan the migration` goes to Fable, where `plan the migration` on its own goes to Opus. There is no phrase for forcing a model *down* - `/hud off` or `/model haiku` is clearer than hiding that in a prompt.

### Sparing the window you are about to hit

When the five-hour window is more than 85% used, routing stops reaching upward on its own. Saving quota is the point of the mod, so spending the last of it automatically would defeat it.

It steps down one rung rather than all the way: `top` becomes `deep`, and `deep` becomes `base`. Whole-system work is still whole-system work when the quota is thin. You can always choose any model by hand, and `spare_quota_above: 100` never holds back.

## Commands

| Command | What it does |
| :- | :- |
| `/hud` | Says what it is routing, why, and what the numbers are |
| `/hud off` | Stops routing. The readout stays. |
| `/hud auto` | Starts routing again, and clears a pin |

## Settings

Set these in `/config`, or when the plugin is enabled.

| Setting | Default | What it is |
| :- | :- | :- |
| `routing` | `true` | Turn off to keep only the readout |
| `fast_model` | `haiku` | Model for small work |
| `base_model` | `sonnet` | Model for everyday work |
| `deep_model` | `opus` | Model for planning and hard problems |
| `top_model` | `fable` | The flagship, for whole-system briefs. Empty to never route here. |
| `route_to_top` | `true` | Off leaves the flagship out of automatic routing |
| `spare_quota_above` | `85` | Percent of the five-hour window at which it stops routing up |
| `bar_cells` | `10` | Bar width. Ten gives a clean ten percent per block. |
| `ascii` | `false` | Draw with `#`, `|` and `~` for a terminal that is not in UTF-8 |

## What it costs to run

Nothing measurable, by design:

- **No polling and no timers.** The numbers come from `$.session.usage()`, read when Claude Code says a limit moved (`session.measure`) and once at session start.
- **No model call to classify.** The tier comes from a regular expression. Asking a model which model to use would spend a request to save a request.
- **Reset times are absolute, not counted down.** A countdown would need a redraw every second for ever.

### Choosing the models

Each model setting takes anything `/model` takes: an alias (`haiku`, `sonnet`, `opus`, `fable`, `best`) or a full id (`claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-1`).

`fable` resolves to Claude Fable 5.1, the flagship, at $10 / $50 per million tokens against Opus 5.5 at $4 / $20 - and on subscription plans Fable can bill to usage credits rather than your included allowance. That is why the `top` tier is harder to reach than the others: planning alone will not get you there, or every design question would go to the most expensive model available. It takes planning-shaped work **and** real size, or you asking for it in words.

Two ways to keep it out of the way entirely: `route_to_top: false`, or an empty `top_model`. Either makes `top` behave exactly as `deep`, and you can still choose the flagship yourself with `/model fable` whenever you want it.

## What it can reach

Mods are not sandboxed, so this is worth being able to check before you install one. The whole mod uses five calls:

```
$.command.register   $.session.model   $.session.usage   $.ui.invalidate   $.ui.resolve
```

No filesystem, no network, no subprocesses, no environment variables, no MCP. No `bin/` directory, no MCP servers and no monitors, so nothing runs at install time. `claude plugin validate ./hud` prints the calls it finds, so you can confirm that rather than taking it on trust.

## What it does not do

- **It cannot route a subagent.** Subagents resolve their own model, and routing the main conversation should not quietly downgrade a subagent somebody chose a model for. Requests with an `agentId` pass through untouched.
- **It needs a subscription to show quota.** `rate_limits` reaches a session only for claude.ai Pro and Max subscribers, or behind a Claude apps gateway, and only after the first API response. Without it the strip shows the model and the context and leaves the windows out.
- **Context is input tokens only.** That is what Claude Code reports: input, cache creation and cache read, with output excluded.

## Development

```bash
claude --plugin-dir ./hud     # load it for one session, reloading on save
claude plugin validate ./hud  # check the manifest and what Claude Code reads from the module
claude plugin test            # run the tests, from inside ./hud
```

The logic worth testing is in two files with no dependency on the mods API, so [`hud/tests/hud.test.ts`](hud/tests/hud.test.ts) covers classification, quota holdback, bar rendering, fixed-width padding, and fitting the strip to a narrow window without wrapping.

Tested against Claude Code v2.1.299. Mod events and methods change between releases, so trust the type declarations Claude Code writes into `hud/.claude-plugin/types/` over anything here.

## Licence

MIT
