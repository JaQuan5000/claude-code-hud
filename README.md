# Automatic model routing and a quota HUD for Claude Code

`hud` is a Claude Code mod that does two things:

- **Routes each request to the cheapest capable model.** A typo fix goes to Haiku. Everyday work goes to Sonnet. A planning job goes to Opus. A whole-system brief goes to Fable. You stop spending frontier quota on one-line edits, and you stop under-powering the work that deserves the best model.
- **Shows where you stand, above the prompt.** Which model is in play, how full the context is, and each rate-limit window with how long until it resets.

```
sonnet 5.5 auto │ ctx [██▌·····]  31% │ session [█▌······]  18% ↻ 1h41m │ week [████▍···]  55% ↻ 3d,11h
```

In the **Desktop app** it draws the same readings as real vector gauges instead - rounded track, continuous fill, and a colour that slides from green through amber to red along its length - because the desktop can render SVG and there is no reason to make it imitate a terminal. The mod checks which app is drawing and picks the better of the two automatically.

The windows are named the way your usage panel names them: `session` for the five-hour window, `week` for the seven-day one, and `fable` for the separate weekly allowance Fable bills against. They were `5h` and `7d`, which was a mistake - beside a reset time, a label that is itself a duration reads as one, so `7d ... 55%` looked like seven days to reset rather than the weekly window at 55%. A window this list has never seen is shown under a tidied name rather than hidden, because a limit nobody tells you about is one you run out of; a spend limit is still left out, since a dollar cap is not a quota the readout can say anything useful about.

Three things are going on in the terminal bar, and each earned its place:

- **Brackets** give it edges, so it reads as a gauge with a known extent rather than as characters that happen to be blocks. Without them you cannot see where a nearly empty bar ends.
- **The fill is coloured by zone, not by reading.** Each cell takes the colour of the percentage it stands for, so a window at 91% runs green, then amber, then red. You see not only that you are in trouble but how much of the window went by before you got there.
- **A partial leading edge.** Ten whole cells can only draw 11 different bars, so 40% through 43% all look identical - and so do 77% through 81%, which is exactly where you want to see movement. With eighth-blocks the same ten columns draw 81.

The moment you pick a model yourself with `/model`, routing stands down and the badge reads `pin`. It will not override your choice on the next message.

In a narrow window it loses detail before it loses data: the bars shrink to eight, six, five and four cells before any reading is dropped, and the reset times go before a whole window does. The model is never dropped. It never wraps.

## Install

```bash
claude plugin marketplace add JaQuan5000/claude-code-hud
claude plugin install hud@hud-mods
```

To remove it:

```bash
claude plugin uninstall hud@hud-mods
claude plugin marketplace remove hud-mods
```

To turn it off without uninstalling, run `/plugin` and disable it there, or `/hud off` to keep the readout and stop only the routing.

Needs Claude Code CLI v2.1.287 or later, or Desktop v2.1.286 or later. Mods do not run in WSL sessions.

Once installed it loads on **every** session on that machine, CLI and Desktop alike, with no flag and nothing to run. Install it on each machine you want it on - installs are per user, not shared across your servers. To turn it off, use `/plugin`, or `/hud off` to keep the readout and stop only the routing. It is off entirely in a session started with `--safe-mode` or `--bare`, or where `disableAllHooks` or your organization's managed settings block mods.

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

Out of the box it never holds back: the tier a prompt earns is the tier it gets, even at 99% of the window. Set `spareAbove` below 100 to keep a reserve for work you pick by hand.

It steps down one rung at a time rather than all the way: `top` becomes `deep`, and `deep` becomes `base`. Whole-system work is still whole-system work when the quota is thin.

## Commands

| Command | What it does |
| :- | :- |
| `/hud` | Says what it is routing, why, and what the numbers are |
| `/hud off` | Stops routing. The readout stays. |
| `/hud auto` | Starts routing again, and clears a pin |
| `/hud models` | Lists every model a tier can be set to |
| `/hud set <tier> <model>` | Points one tier at a different model for this session |

## Settings

There is nothing to configure. Install it and it runs.

These were `userConfig` options once, which meant every install ended with a notice that nine settings were unfilled and a suggestion to run `/plugin configure`. A readout you have to set up before it will read anything is a bad trade for options most people never touch, so they are constants in [`hud/hooks/register.js`](hud/hooks/register.js) now. Edit `DEFAULTS` there to retune.

| Name | Default | What it is |
| :- | :- | :- |
| `fastModel` | `claude-haiku-5-5` | Model for small work |
| `baseModel` | `claude-sonnet-5-5` | Model for everyday work |
| `deepModel` | `claude-opus-5-5` | Model for planning and hard problems |
| `topModel` | `claude-fable-5-1` | The flagship, for whole-system briefs |
| `routeToTop` | `true` | Off leaves the flagship out of automatic routing |
| `spareAbove` | `100` | Percent of the five-hour window at which it stops routing up. 100 never holds back. |
| `barCells` | `10` | Bar width in columns, brackets included |
| `ascii` | `false` | Draw with `#`, `-`, `\|` and `~` for a terminal that is not in UTF-8 |

Every model must be a full id, for the reason given under [Choosing the models](#choosing-the-models). Routing itself is on at start and toggles at runtime with `/hud off` and `/hud auto`.

## What it costs to run

Nothing measurable, by design:

- **No polling and no timers.** The numbers come from `$.session.usage()`, read when Claude Code says a limit moved (`session.measure`) and once at session start.
- **No model call to classify.** The tier comes from a regular expression. Asking a model which model to use would spend a request to save a request.
- **One timer, for one reason.** The reset times are a countdown, which is wrong within a minute if nobody redraws it, so the strip redraws once a minute. That redraw reads numbers already in memory and makes no requests. Everything else is driven by events.

### Choosing the models

Each tier takes a **full model id**, such as `claude-sonnet-5-5`. The short aliases (`sonnet`, `opus`, `haiku`, `fable`) are resolved by the command line for `--model` and `/model`; they are **not** resolved on the request itself, which is what a mod sets. Passing one through gets you `There is an issue with the selected model (sonnet). It may not exist` and a silent fallback to something else.

`/hud models` lists everything a tier can be set to:

| Name | Id |
| :- | :- |
| fable 5.1 | `claude-fable-5-1` |
| fable 5 | `claude-fable-5` |
| opus 5.5 | `claude-opus-5-5` |
| opus 5 | `claude-opus-5` |
| opus 4.8, 4.7, 4.6 | `claude-opus-4-8` and so on |
| sonnet 5.5 | `claude-sonnet-5-5` |
| sonnet 5 | `claude-sonnet-5` |
| sonnet 4.6 | `claude-sonnet-4-6` |
| haiku 5.5 | `claude-haiku-5-5` |
| haiku 4.5 | `claude-haiku-4-5` |

`/hud set <tier> <model>` changes one for the session, and it is forgiving about the name: `/hud set deep opus` takes the newest Opus, `/hud set deep opus 4.8` takes that one, and a full id always works. A name it does not recognise is refused rather than guessed at, because a bad model fails on the next request rather than where you typed it.

The flagship is `fable 5.1` at $10/$50 per MTok against Opus 5.5 at $4/$20, and on subscription plans it can bill to usage credits. That is why the `top` tier takes two signals to reach, not one.

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
