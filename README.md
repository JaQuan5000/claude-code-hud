# Automatic model routing and a quota HUD for Claude Code

`hud` is a Claude Code mod that does two things:

- **Routes each request to the cheapest capable model.** A typo fix goes to Haiku. A planning job goes to Opus. Everything else goes to Sonnet. You stop spending frontier quota on one-line edits.
- **Shows where you stand, above the prompt.** Which model is in play, how full the context is, and how much of each rate-limit window is gone, with the reset time.

```
haiku      auto │ ctx ███░░░░░░░  31% │ 5h ██░░░░░░░░  18% ↻ 14:20 │ 7d ████░░░░░░  42% ↻ Thu
```

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
| `deep` | The prompt mentions planning, design, a refactor, a migration, debugging, a root cause, or trade-offs. Also any prompt over 400 characters. | `opus` |
| `fast` | A short prompt about a typo, a rename, formatting, a comment, or a version bump. | `haiku` |
| `base` | Everything else. | `sonnet` |

Two deliberate biases:

- **Uncertain means `base`, never `fast`.** A real task sent to a small model wastes the whole turn and your time. A typo fix sent to a large one wastes a few cents.
- **An expensive signal beats a cheap one.** "Plan the rename of every field" is planning, not a rename.

It reads words, not intent, so it will be wrong sometimes. `/model` overrides it permanently for that session, and `/hud off` turns routing off entirely while keeping the readout.

### Sparing the window you are about to hit

When the five-hour window is more than 85% used, routing stops reaching for the deep model on its own and holds at the everyday one. Saving quota is the point of the mod, so spending the last of it automatically would defeat it. You can still choose the deep model by hand. Set `spare_quota_above` to 100 to never hold back.

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
| `spare_quota_above` | `85` | Percent of the five-hour window at which it stops routing up |
| `bar_cells` | `10` | Bar width. Ten gives a clean ten percent per block. |
| `ascii` | `false` | Draw with `#`, `.`, `|` and `~` for a terminal that is not in UTF-8 |

## What it costs to run

Nothing measurable, by design:

- **No polling and no timers.** The numbers come from `$.session.usage()`, read when Claude Code says a limit moved (`session.measure`) and once at session start.
- **No model call to classify.** The tier comes from a regular expression. Asking a model which model to use would spend a request to save a request.
- **Reset times are absolute, not counted down.** A countdown would need a redraw every second for ever.

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
