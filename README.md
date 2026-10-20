# hud - a Claude Code mod for automatic model routing and a quota status line

A **Claude Code mod** that cuts what a session costs and shows you where you stand. It installs as a Claude Code plugin and does two things:

- **Routes each request to the cheapest capable model.** A typo fix goes to Haiku. Everyday work goes to Sonnet. A planning job goes to Opus. A whole-system brief goes to Fable. You stop spending frontier quota on one-line edits, and you stop under-powering the work that deserves the best model.
- **Shows where you stand, above the prompt.** Which model is in play, how full the context is, and each rate-limit window with how long until it resets.
- **Warns you before you run dry.** It knows when each window resets, so it can tell whether 91% used is fine or a problem, and say how long you have at the rate you are going.
- **Offers what to do next.** After a turn, two or three follow-ups you can send with one key.
- **Shows what the subagents are doing**, while there are any, and nothing at all when there are not.
- **Measures a destructive command before it runs.** `rm -rf build` tells you it is 1,240 files first.

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

Both conditions have to hold, which is rare enough not to nag. It asks **once per window**: your answer is remembered until the window drops back under the line, which is what a reset does, so a long job at 95% is not stopped again at every prompt. `/hud confirm off` stops the question entirely, and the work simply goes to the model it was routed to. In a `claude -p` run, where there is nobody to ask, it carries on as chosen rather than silently downgrading.

## Follow-ups under the strip

After a turn, the mod offers two or three next steps, each a key press away:

```
1: Run the parser tests   2: Add a case for empty input   3: Update the README
```

They come from the cheap model reading the turn that just finished, so they are specific to the work rather than stock phrases: a few hundred tokens of Haiku per turn, with the request capped so a long turn cannot become a long bill. `/hud suggest off` stops it entirely.

It sends a trimmed slice of the prompt and the answer - the same conversation Claude already has, to the same place it already goes. Nothing about your conversation is stored or written to disk, and nothing reaches any third party.

## What the mod sends, in full

Two features make their own model requests, and both are **on by default**. Everything else in the mod is arithmetic on numbers Claude Code already has, and makes no requests at all.

| Feature | When it fires | What it sends | Turn it off |
|---|---|---|---|
| Follow-up suggestions | After a turn that produced an answer | A trimmed slice of your prompt and the answer | `/hud suggest off` |
| Heads-up | At most every few turns, and only after a substantial turn | The last ~2,400 characters of the conversation | `/hud know off` |

Both go to your own model on your own account - the same conversation, to the same place it already goes - and both are capped. Nothing about your conversation is stored, nothing reaches a third party, and no telemetry of any kind leaves your machine. With `suggest` and `know` both off, the mod makes no requests at all.

If you would rather it never spoke to a model without being asked, run `/hud suggest off` and `/hud know off` once. These four switches (`suggest`, `know`, `blast`, `confirm`) are saved and are still as you left them the next time Claude Code opens. Routing itself is not saved: `/hud off` is for the task in front of you, and it comes back on next session.

## Tuning the routing on real data

The routing is a pile of regular expressions, and when one gets a prompt wrong there is nothing to look at. `/hud log` shows what was decided and which words decided it:

```
fast  haiku 5.5   "fix the typo in the footer"        [typo]
deep  opus 5.5    "why does the sync layer deadlock"  [deadlock, why does]
base  sonnet 5.5  "add a column for last sync time"   [no signal]
```

`/hud tune` reads those same records back and says what they imply - a tier that never fires has patterns too narrow, a tier that catches everything has patterns too broad - and lists the words that keep turning up in middle-tier prompts, so you can promote the ones that mean something. It only suggests a word it has seen in more than one prompt, because a rule built from a single sample is a rule that overfits to whatever you did last.

## The progress bar

While Claude works through a multi-step job, a blue bar shows how far along it is:

```
▸ Wiring the panel  [████▒▒······]  4/12  33%
```

The solid blocks are tasks that are finished, and the lighter ones are the task in hand. It is blue on purpose: the green-amber-red bars measure how close you are to a limit, and progress is not a limit - a job at 90% is nearly done, not nearly in trouble.

The total comes from Claude's own task list, the plan it writes before it starts and updates as each step lands, so nothing in the bar is estimated. That is also why it only appears when there is a plan: two tasks or more, not one, and it goes the moment the last one is done. It reads both ways Claude keeps that list - the whole-list `TodoWrite` tool, and the `TaskCreate` and `TaskUpdate` tools an interactive session uses to add and tick off one task at a time. It never changes or delays a task call, and it sends nothing anywhere.

If you never see it, run `/hud plan`. It says how many task calls the mod has actually seen this session, whether a plan is being tracked, and which of the usual reasons applies: Claude is not keeping a task list for the job (`/tasks` shows whether it is), the mod was updated but Claude Code has not been restarted since, or the plan is under two tasks or already finished. A short question has no plan, so it has no bar.

## The desktop sidebar

In the Claude desktop app the whole HUD lives in a panel on the right, beside the conversation, as a stack of rounded cards in the same style as the app's own (Environment, Context, Outputs, Changes). Each has a title you can press to fold it.

| Card | What it holds |
|---|---|
| **Model** | The model on this turn, whether it is routed (`auto`), pinned or manual, and why it was chosen |
| **Usage** | Context, Session, Week and any other window, each with a gauge, the time it resets and a pace warning if you are outrunning it |
| **Progress** | The blue bar, then the task list item by item: the one in hand first, then what is waiting |
| **Agents** | Each running subagent by name, how long it has run and what it has used |
| **Routing** | Which model each tier points at, and the last few decisions. Folded to start with |

A card with nothing to say is left out rather than drawn empty, so with no plan and no agents you see two cards.

While the panel is showing, the strip above the prompt steps aside, since it would only say everything twice. It comes back by itself whenever the panel is not actually on screen, such as a window too narrow for it, or after you close it, so the numbers are never missing from both places at once. Follow-up suggestions and the heads-up note stay above the prompt, because they are things you press.

`/hud panel` opens it, and `/hud panel off` closes it and puts the strip back. If you close it with the panel's own close mark it stays closed until you ask for it.

**The terminal is never touched.** The panel is opened only for the desktop app, and the terminal strip, progress bar and agent row are drawn exactly as before.

## Watching the subagents

A subagent works out of sight: you see a spinner, then an answer some minutes later. Three of them run at once and you cannot tell which is stuck, which is spending your quota, or how long this has been going on. While any are alive, a row appears under the strip:

```
⟳ 2 agents │ explore [████▌···]  18s 4.1k │ review [██······]   5s 1.2k
```

When they finish it lingers a few seconds, then disappears completely. There is no row saying "no agents", and no timer running to draw one: the poll only reschedules itself while something is alive, so a session without subagents costs nothing at all.

**The bar is not progress, and does not pretend to be.** A progress bar needs a denominator and nothing knows how much work a subagent has left. Each bar is that agent's **share of the tokens spent across all of them** - a real number, answering the question you actually have: which of these is doing the heavy lifting. `/hud agents` lists every subagent the session has run, finished ones included.

## Measuring a destructive command

Claude Code already asks before `rm -rf`. What it cannot tell you is the size of what you are agreeing to - `rm -rf build` and `rm -rf .` look alike in a prompt and differ by your afternoon. This finds the shape of the command, measures it with a read-only counterpart, and puts a number in front of you:

> This deletes 1,240 files under build.
> `rm -rf build`
> **Run it** / **Cancel**

It recognises `rm -rf`, `git reset --hard`, `git clean -f`, force pushes, `DROP TABLE` and raw device writes. It measures with `find`, `git status --porcelain`, `git clean -nd` (git's own dry run) and `git log @{u}..HEAD`.

Three things it deliberately does not do:

- **It does not flag `--force-with-lease`.** That is the safe form, and interrupting it would train you to dismiss the box without reading it.
- **It does not guess at a command that builds its own arguments.** `rm -rf $(cat list)` is unreadable statically, so it says nothing rather than measure the wrong thing.
- **It does not fail closed.** If the measurement errors, the command carries on to Claude Code's usual permission prompt. A guard that blocks your work when it has a bug is worse than no guard.

`/hud blast off` turns it off.

### Why this one needs `$.process.run`

Measuring means running something, which is the only capability in this mod that can start a process. Three constraints make that safe, and they are the design rather than decoration:

- Every preview is built as an **argv array, never a shell string**, so a path cannot close a quote, open a subshell or chain a second command - whatever it contains.
- The verb and flags are **fixed by which pattern matched**. Nothing executable is ever taken from the command text; only the target travels, as one array element.
- It runs **only after a destructive pattern has already matched**, with a ten second timeout.

If you would rather the mod could not start processes at all, `/hud blast off` and nothing here ever runs.

## One thing you may have missed

After a substantial turn, Haiku rereads the recent conversation and looks for a single thing worth raising:

```
✦ Heads up · You changed the retry logic but the test still asserts the old timeout.   0: dismiss
```

Claude Code has this built in as `cc-plugin-you-should-know`, and the built-in is better: it reads your whole context with your session model. It also bills several thousand tokens of instructions plus a reply on **every** check, repeatedly, during exactly the long tasks where it fires most. In a mod whose purpose is to spend less, that is the wrong shape, so this is the cheap version and it is honest about the trade: it will catch less.

It only looks at turns big enough to hide a mistake in - several tool calls, or a long answer - and never more often than every third turn. It is asked for silence by default, and anything that comes back which is not a short concrete note is discarded unseen. `/hud know off` stops it, and then nothing calls a model on your behalf except the follow-ups.

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
| `/hud agents` | Every subagent this session has run, with status and spend |
| `/hud know on` / `off` | The heads-up check after a big turn |
| `/hud confirm on` / `off` | The question near the limit, asked once per window |
| `/hud panel` / `panel off` | The desktop sidebar: open it, or close it and put the strip back |
| `/hud plan` | What the progress bar has seen, and why it is or is not showing |
| `/hud blast on` / `off` | Measuring a destructive command before it runs |
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

Mods are not sandboxed, so this is worth being able to check before you install one. The whole mod uses eighteen calls:

```
$.agent.list        $.clock.after       $.command.register  $.model.complete
$.process.run       $.prompt.submit     $.session.messages  $.session.model
$.session.surfaces  $.session.usage     $.store.get         $.store.set
$.ui.ask            $.ui.close          $.ui.invalidate     $.ui.open
$.ui.panes          $.ui.resolve
```

No filesystem, no environment variables, no MCP. The only storage is `$.store`, which holds four on/off switches (`suggest`, `know`, `blast` and `confirm`) so they are still as you left them next session. It holds nothing about your prompts, your tasks or your usage. Two of these deserve a sentence each rather than a footnote: `$.process.run` exists only for the blast-radius measurement, under the constraints described above, and `$.model.complete` is the single request made on your behalf - the follow-ups and the heads-up check, both on the cheap model, both switchable off. No `bin/` directory, no MCP servers and no monitors, so nothing runs at install time. `claude plugin validate ./hud` prints the calls it finds, so you can confirm that rather than taking it on trust.

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
