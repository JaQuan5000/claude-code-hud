# hud - a Claude Code mod for automatic model routing and a quota status line

A **Claude Code mod** that cuts what a session costs and shows you where you stand. It installs as a Claude Code plugin and does two things:

- **Routes each request to the cheapest capable model.** A typo fix goes to Haiku. Everyday work goes to Sonnet. A planning job goes to Opus. A whole-system brief goes to Fable. You stop spending frontier quota on one-line edits, and you stop under-powering the work that deserves the best model.
- **Shows where you stand, above the prompt.** Which model is in play, how full the context is, and each rate-limit window with how long until it resets.
- **Warns you before you run dry.** It knows when each window resets, so it can tell whether 91% used is fine or a problem, and say how long you have at the rate you are going.
- **Offers what to do next.** After a turn, two or three follow-ups you can send with one key.

```
sonnet 5.5 auto │ Ctx [██▌·····]  31% │ Session [█▌······]  18% ↻ 1h41m │ Week [████▍···]  55% ↻ 3d,11h
```

In the **Desktop app** it draws the same readings as real vector gauges instead - rounded track, continuous fill, and a colour that slides from green through amber to red along its length - because the desktop can render SVG and there is no reason to make it imitate a terminal. The mod checks which app is drawing and picks the better of the two automatically.

The windows are named the way your usage panel names them: `Session` for the five-hour window, `Week` for the seven-day one, and `Fable` for the separate weekly allowance Fable bills against. They were `5h` and `7d`, which was a mistake - beside a reset time, a label that is itself a duration reads as one, so `7d … 55%` looked like seven days to reset rather than the weekly window at 55%. A window this list has never seen is shown under a tidied name rather than hidden, because a limit nobody tells you about is one you run out of; a spend limit is still left out, since a dollar cap is not a quota the readout can say anything useful about.

Three things are going on in the terminal bar, and each earned its place:

- **Brackets** give it edges, so it reads as a gauge with a known extent rather than as characters that happen to be blocks. Without them you cannot see where a nearly empty bar ends.
- **The fill is coloured by zone, not by reading.** Each cell takes the colour of the percentage it stands for, so a window at 91% runs green, then amber, then red. You see not only that you are in trouble but how much of the window went by before you got there.
- **A partial leading edge.** Ten whole cells can only draw 11 different bars, so 40% through 43% all look identical - and so do 77% through 81%, which is exactly where you want to see movement. With eighth-blocks the same ten columns draw 81.

The moment you pick a model yourself with `/model`, routing stands down and the badge reads `pin`. It will not override your choice on the next message.

In a narrow window it loses detail before it loses data: the bars shrink to eight, six, five and four cells before any reading is dropped, and the reset times go before a whole window does. The model is never dropped. It never wraps.

## Install

Run these at your **shell** prompt, not inside Claude Code - they are shell commands, and Claude Code's prompt is not a shell.

```bash
claude plugin marketplace add JaQuan5000/claude-code-hud
claude plugin install hud@hud-mods
```

### Update

```bash
claude plugin marketplace update hud-mods
claude plugin update hud@hud-mods
```

Restart Claude Code afterwards. An installed plugin is cached by version, so an update only takes once the version has changed.

### Uninstall

```bash
claude plugin uninstall hud@hud-mods
claude plugin marketplace remove hud-mods
```

To turn it off without uninstalling, run `/plugin` and disable it there, or `/hud off` to keep the readout and stop only the routing.

Needs Claude Code CLI v2.1.287 or later, or Desktop v2.1.286 or later. Mods do not run in WSL sessions.

Once installed it loads on **every** session on that machine, CLI and Desktop alike, with no flag and nothing to run. Install it on each machine you want it on - installs are per user, not shared across your servers. To turn it off, use `/plugin`, or `/hud off` to keep the readout and stop only the routing. It is off entirely in a session started with `--safe-mode` or `--bare`, or where `disableAllHooks` or your organization's managed settings block mods.

## What is a Claude Code mod?

A **mod** is a Claude Code plugin that runs JavaScript against Claude Code's own events, rather than shelling out to a script. Settings hooks can watch a tool call and block it; a mod can change what Claude Code draws, add commands, and - the reason this one exists - redirect a request to a different model before it is sent.

Mods need Claude Code CLI v2.1.287 or Desktop v2.1.286 and newer. They are a different thing from:

- **A status line**, which is a script that prints one line and cannot change behaviour. This mod draws its own readout instead, so it works in the Desktop app as well as the terminal.
- **A skill**, which is instructions Claude reads. A mod is code Claude Code runs.
- **An MCP server**, which gives Claude new tools. A mod changes Claude Code itself.

If you are looking for a Claude Code status line, a Claude Code token usage or rate limit display, or automatic model switching to cut your Claude usage, this is a mod that does all three at once.

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

## Pacing: will you run dry before the reset?

A window at 91% is fine with twenty minutes left and a disaster with four hours left, and the percentage alone cannot tell you which. Each reading carries a reset time, and each window has a known length, so the mod works out how far through the clock you are and compares it with how far through the quota you are.

```
Session [██████▌╎·]  91% ↻ 3h41m · 3.5x pace, dry in 8m
Session [████╎···]  50% ↻ 2h30m
```

The `╎` is where the fill would be if you were spending evenly. Fill past it means you are ahead of the clock. It says nothing at all below 1.5x, because a readout that comments on every mild overspend stops being read, and nothing when a window is simply nearly over - 91% used with twenty minutes left is what a spent window is supposed to look like.

## A confirmation you will rarely see

Routing never holds back by default: the tier a prompt earns is the tier it gets. The failure that leaves is spending the last of a window on something you would happily have run cheaper. So when the five-hour window is past 85% **and** the prompt earned an expensive tier, it asks:

> The five-hour window is 91% used, and this reads as top work. Which model should it go to?
> Use fable 5.1 / Use opus 5.5 instead / Cancel this prompt

Both conditions have to hold, which is rare enough not to nag. In a `claude -p` run, where there is nobody to ask, it carries on as chosen rather than silently downgrading.

## Follow-ups under the strip

After a turn, the mod offers two or three next steps, each a key press away:

```
1: Run the parser tests   2: Add a case for empty input   3: Update the README
```

They come from the cheap model reading the turn that just finished, so they are specific to the work rather than stock phrases. This is the one place the mod spends anything: a few hundred tokens of Haiku per turn, with the request capped so a long turn cannot become a long bill. `/hud suggest off` stops it entirely, and nothing else in the mod calls a model.

It sends a trimmed slice of the prompt and the answer - the same conversation Claude already has, to the same place it already goes. Nothing is stored, nothing is written to disk, and nothing reaches any third party. With suggestions off, the mod makes no requests at all.

## Tuning the routing on real data

The routing is a pile of regular expressions, and when one gets a prompt wrong there is nothing to look at. `/hud log` shows what was decided and which words decided it:

```
fast  haiku 5.5   "fix the typo in the footer"        [typo]
deep  opus 5.5    "why does the sync layer deadlock"  [deadlock, why does]
base  sonnet 5.5  "add a column for last sync time"   [no signal]
```

`/hud tune` reads those same records back and says what they imply - a tier that never fires has patterns too narrow, a tier that catches everything has patterns too broad - and lists the words that keep turning up in middle-tier prompts, so you can promote the ones that mean something. It only suggests a word it has seen in more than one prompt, because a rule built from a single sample is a rule that overfits to whatever you did last.

## Commands

| Command | What it does |
| :- | :- |
| `/hud` | Says what it is routing, why, and what the numbers are |
| `/hud off` | Stops routing. The readout stays. |
| `/hud auto` | Starts routing again, and clears a pin |
| `/hud models` | Lists every model a tier can be set to |
| `/hud log` | What was routed where, and which words decided it |
| `/hud tune` | What the log says about your patterns |
| `/hud suggest on` / `off` | Follow-up suggestions under the strip |
| `/hud raw` | What `usage()` reported, if a reading is missing from the strip |
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

Almost nothing, and the one thing that does cost is named here rather than buried:

- **No polling.** The numbers come from `$.session.usage()`, read when Claude Code says a limit moved (`session.measure`) and once at session start.
- **No model call to route.** The tier comes from a regular expression. Asking a model which model to use would spend a request to save a request, which is the joke this mod would become.
- **One timer, for one reason.** The reset times are a countdown, which is wrong within a minute if nobody redraws it, so the strip redraws once a minute. That redraw reads numbers already in memory and makes no requests.
- **One model call, and only for follow-ups.** The suggestions under the strip are written by the cheap model reading the turn that just ended: a few hundred input tokens and a ceiling of 120 out, on Haiku, once per turn. At Haiku's rates that is a fraction of a cent, and it is the only request the mod ever makes on your behalf. `/hud suggest off` removes it entirely.

The arithmetic that matters: routing one planning turn from Opus to Haiku saves far more than every suggestion in a long session costs. If you would rather it spent nothing at all, turn suggestions off and it spends nothing at all.

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
$.clock.every   $.command.register   $.model.complete   $.prompt.submit
$.session.model   $.session.usage   $.ui.ask   $.ui.invalidate   $.ui.resolve
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
