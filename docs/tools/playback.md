# Executor and sequence playback configuration (SB-01)

Three tools inspect and configure how a sequence plays from an executor. They use only the existing bridge
ops (`objects`, `object`, `children`, `set`); no Lua is generated, nothing needs `gma3_lua`, and they work with
the bridge's Lua execution disabled. Evidence: [the SB-01 probe record](../probes/sb-01-playback-macos-2.5.1.md).

| Tool | Changes | Owner of the settings |
| --- | --- | --- |
| `gma3_executor_settings` | nothing (read-only) | — |
| `gma3_configure_executor` | key, MA-key, fader and encoder functions, Fix, the executor's Lock | the executor (`Page <p>.<e>`) |
| `gma3_configure_sequence` | Wrap Around, priority, restart mode and the other playback options, the sequence's Lock | the sequence, so **every executor it is assigned to** |

Cue triggers and timing (what makes a chase run) are set with `gma3_set_cue_trigger` / `gma3_set_cue_timing`
([cues](cues.md)); assigning a sequence is `gma3_assign_to_executor` ([executors](executors.md)).

## The things to know first

- **The console silently ignores values it does not accept.** `Set` of `KeyPress "Bogus"`, `Fader "Highlight"`
  or `EncoderLeft "Flash"` returns without error and the property keeps its previous value. It also *accepts* key
  functions that make no sense for a sequence (`Call`, `LogIn`, `At`). So the tools validate every choice against
  their own lists first, and every `set` reply (the bridge reads the property back after writing) must show the
  requested value, otherwise the step fails.
- **Locks are per object.** The Page, the Executor and the Sequence each have their own `Lock` (it reads `UL` when
  locked, empty when not). Writes to a locked executor, to any executor on a locked page, or to a locked sequence
  are silently ignored; `Store` into a locked sequence answers "Cannot Create Object". A page or executor lock does
  not protect the sequence, and a sequence lock does not protect its executors. **Kill Protect** and **Swap
  Protect** are sequence settings that protect *playback* from the Kill and Swap actions; they do not stop editing.
  The console's `StructureLocked` / `SystemLocked` flags are read-only and always refused.
- **Configuration does not start playback.** None of the tools sends a playback keyword (Go, On, Off, Toggle, Flash,
  Press, ...), moves a fader or touches the selection or programmer. Each configure tool reads the sequence's
  `HasActivePlayback` before and after (`playback.activeBefore` / `activeAfter`) and warns if it changed.
- **A chase loops only with Wrap Around on and a trigger on its first cue.** With three cues all on a Time trigger
  and Wrap Around on, `Go+` runs 1→2→3→1→… until `Off`; with Wrap Around off it stops on the last cue and stays
  active. (Manual: Wrap Around is automatically disabled if the OffCue has a trigger.)
- Writing properties is not the same as `Assign <function> At Page p.e`: the manual notes that the command form
  clears the unpress function. The tools never use it.

## Shared behaviour of the two configure tools

- **Validation before anything is sent.** Unknown parameter values, functions not valid for that element of a
  sequence executor, and calls with nothing to configure are refused with `validationErrors`.
- **A value that could not be read is unknown, never a default.** The bridge leaves a property it cannot read out
  of its reply. Before planning, every value the plan depends on (the requested properties, the target's Lock, the
  page Lock for an executor, StructureLocked and SystemLocked) must have been read; otherwise the call is refused
  before anything is sent. A missing Lock is never taken as "unlocked", a missing function never as "Empty", and
  a requested value is "unchanged" only when its current value was actually read. A `set` reply without a value
  makes that step `unknown` (it confirms neither an unlock nor an `Empty` function), and a read-back missing a
  field does not verify.
- **Plan, then send only what changes.** The tool reads the current values and builds
  `intended.changes` (`key`, `property`, `from`, `to`); requested values that are already set are listed in
  `intended.unchanged` and never sent. Every requested value overwrites the current one; there is no merge.
  When nothing changes, the result is `succeeded` with `noop: true` and no request was sent.
- **`preview: true`** performs only the reads and returns the same plan, the lock state and (for sequences) the
  sharing executors. It does not take the mutation lock.
- **Locks.** A locked target is refused before anything is sent, naming the owner (`page`, `executor`,
  `sequence`). `unlock: true` unlocks the owning object(s), applies the changes and locks them again; relocking is
  attempted even when a change failed or its reply was lost, and a relock that cannot be confirmed is a warning
  ("may be left UNLOCKED"). With a locked page and executor, the page is unlocked first and relocked last (a locked
  page blocks the executor's own Lock write). `lock: true|false` sets the target's own Lock as part of the call;
  `lock: false` on a locked target is itself an explicit unlock (no relock). A page lock always needs `unlock: true`.
- **One `set` per value, in parameter order**, stopping at the first step that is not a confirmed success. A
  `set` whose reply shows a different value is `failed` (the console kept the old value); a lost reply is
  `unknown` and is never resent. Outcome follows the shared result model: `failed` when nothing was changed,
  `partial` after at least one confirmed change.
- **`verify`** (default true) reads every changed property and the final Lock back and compares them
  (`verification`). Not verified: anything not requested, and the effect of a function at playback time.
- **Serialisation caveat.** Mutations from this server run one at a time inside the mutation lock. The lock does not
  isolate anything from another operator, MCP server or macro: an object can change between the read and the write.

## gma3_executor_settings

| Parameter | Type | Meaning |
| --- | --- | --- |
| `page` | integer 1-9999 | Executor page. |
| `executor` | integer | 101-190, 201-290, 301-390, 401-490 (plus Xkeys 191-198, 291-298). |
| `references` | boolean, default true | Scan every page for executors that share the sequence. |

Requests: `objects Page <p>` (Lock), `objects Page <p>.<e>` (Object, as a handle), `objects Page <p>.<e>` (the
function properties, Fix, Lock, StructureLocked, SystemLocked); for a sequence: `object DataPool` (the current data
pool's address), `objects <sequence address>` (settings, Lock), `object <sequence address>` (HasActivePlayback), and
the reference scan (`children DataPool.Pages`, then
`children <page>` with `No` and `Object` for each page; at most 200 pages, otherwise `complete: false`).

Returns `pageInfo`, `empty`, `assigned` (`class`, `index`, `name`, `addr`), `executorSettings` (`functions`,
`fix`, `locked`, ...), `allowedFunctions`, `sequence` (`addr`, `dataPool`, `ref`, `settings`, `locked`, `active`),
`protection` (each lock and protect flag by owner), `references` and a warning when the sequence is shared. A value
that could not be read is `null` (never "unlocked" or "Empty") and its property is listed in `unreadable`. An
Sequence and Macro assignments have qualified function lists. Other assigned classes are reported without a qualified function list.

**Sequences from another data pool.** An executor can hold a sequence from another data pool (see the manual's
data pool topic), so the assigned sequence is always read by the address the executor reports, never rebuilt as
`Sequence <n>` (which would read the current pool's sequence of the same number). `sequence.dataPool` is
`current`, `other` or `unknown`; `sequence.ref` (`Sequence <n>`) is given only for the current pool, because
`gma3_configure_sequence` addresses sequences by number in its requested `data_pool` (or the current pool when omitted).
Pass that source pool explicitly to configure another pool’s sequence. The reference scan covers the requested pool’s pages.

## gma3_configure_executor

| Parameter | Property | Allowed values (sequence executor) |
| --- | --- | --- |
| `key_press`, `ma_key_press` | KeyPress, MAKeyPress | Empty, Go+, Go-, <<<, >>>, On, Off, Toggle, Top, Kill, Pause, Goto, Load, Select, SelectFixtures, Rate1, Speed1, Learn, LearnSpeed, HalfSpeed, DoubleSpeed, ReSync, FastSync, **Flash, Temp, Swap, Black, Time** (key-only) |
| `key_unpress`, `ma_key_unpress` | KeyUnpress, MAKeyUnpress | the list above without the key-only functions |
| `encoder_left`, `encoder_right` | EncoderLeft, EncoderRight | the list above without the key-only functions (the console refuses them) |
| `fader`, `encoder` | Fader, Encoder | Empty, Master, X, XA, XB, Temp, Rate, Speed, Time |
| `fix` | Fix | true / false |
| `lock`, `unlock`, `preview`, `verify` | | see above |

Names match case-insensitively and are sent in the console's spelling; `Empty` clears a function (reads back
empty). The executor must exist on an existing page and hold a Sequence or Macro. The authoring extension below
describes macro function choices, custom commands, MA encoder functions and sizing. Unsupported assignments are
refused before anything is sent. Executor settings belong to this executor only.

Requests in order: `objects Page <p>` (Lock), `objects Page <p>.<e>` (Object), `objects Page <p>.<e>` (current
values), `object <sequence address>` (playback before; the sequence the executor holds, also from another data
pool), then `set Page <p> Lock No` / `set Page <p>.<e> Lock No` (only
with `unlock`), one `set Page <p>.<e> <Property> <value>` per change, `set ... Lock Yes|No` (explicit `lock`),
the relocks, `objects Page <p>.<e>` (read-back) and `object <sequence address>` (playback after). The result names
the sequence (`sequence`, `sequenceAddr`).

## gma3_configure_sequence

| Parameter | Property | Values |
| --- | --- | --- |
| `wrap_around` | WrapAround | true / false |
| `priority` | Priority | super, swap, htp, highest, high, ltp, low, lowest |
| `restart_mode` | RestartMode | first_cue, current_cue, next_cue |
| `release_first_cue` | ReleaseFirstCue | true / false |
| `auto_start`, `auto_stop` | AutoStart, AutoStop | true / false |
| `master_go_mode` | MasterGoMode | none, go, on, top (applies only with Auto Stop off) |
| `auto_fix`, `auto_stomp`, `tracking`, `soft_ltp` | AutoFix, AutoStomp, Tracking, SoftLTP | true / false |
| `off_when_overridden` | OffWhenOverridden | true / false |
| `kill_protect`, `swap_protect` | KillProtect, SwapProtect | true / false (protect playback, not editing) |
| `use_executor_time`, `include_link_last_go` | UseExecutorTime, IncludeLinkLastGo | true / false |
| `xfade_mode`, `xfade_reload` | XFadeMode, XFadeReload | ab / split, true / false |
| `rate_master` (SB-06) | RateMaster | a speed master 1–16 or `"none"`: the cue timing runs at its effective BPM / 60 (60 BPM = 1:1) |
| `speed_master` (SB-06) | SpeedMaster | a speed master 1–16 or `"none"`: the phasers in the cues follow it |
| `rate_scale`, `speed_scale` (SB-06) | RateScale, SpeedScale | one, mul2 … mul256, div2 … div256 |
| `speed_from_rate` (SB-06) | SpeedFromRate | true / false: the rate also scales the stored speeds |
| `lock`, `unlock`, `preview`, `verify` | | see above |

Requests in order: `objects Sequence <n>` (settings, Lock), the reference scan, `object Sequence <n>` (playback
before), the `set` requests (unlock, one per change, explicit lock, relock), `objects Sequence <n>` (read-back),
`object Sequence <n>` (playback after). The result lists `references` (every executor of the current data pool
assigned this sequence) and warns when more than one executor shares it, or when the scan was incomplete; an
incomplete scan never blocks the change. Input/output filters are not part of the first release.

Masters are written by name, which the console requires (a number is silently ignored): a `resolve_masters` read step
(`children ShowData.Masters.Speed`) turns the number into the master's name first and refuses a master without a name
or one that shares its name with another. While a rate master is linked, the sequence's own rate fader is the shared
master. See [speed.md](speed.md) for the masters themselves.

### Batch form (SU-12)

`sequences: [1, "3 Thru 17", 20]` applies the same settings to each sequence (numbers and ranges, either direction, at
most 100 after expansion), each configured, checked and read back on its own with its own references. A sequence
that appears twice after expansion refuses the whole call; a missing one fails alone. See
[Batch forms](README.md#batch-forms-su-12).

## Not in the first release

Executor configuration saving and Cue Zero mode remain unsupported. Loading and recasting existing configurations
are described below.
The authoring extension below adds macro assignments, custom commands, sizing and MA encoder functions.
Speed and rate masters: [speed.md](speed.md) (SB-06).

## Live test procedure (`test/live/playback.live.ts`)

Not part of `npm test`. On a disposable show with an empty programmer:
`GMA3_LIVE=1 node --import tsx --test test/live/playback.live.ts` (about 13 s). It refuses to run when Sequence
905 exists or Page 90.210/90.211 are taken, and skips unless a complete programmer scan (coverage complete, no
channel errors or limitations) finds no values, then:

1. creates Page 90 if needed, Sequence 905 with three empty cues, assigns it to 90.210 and 90.211 and gives every
   cue a 0.5 s Time trigger (`gma3_set_cue_trigger`);
2. inspects 90.210 (both sharing executors listed), configures a Temp key and Temp fader and the sequence's
   settings (warning names 90.211), and checks that no playback started;
3. runs the chase with `Go+` (sent by the test) and checks at least two Cue 3 → Cue 1 wraps in 4.2 s, then with
   Wrap Around off checks 1→2→3 and no wrap;
4. configures Temp and then Flash keys and checks that `Press`/`Unpress Page 90.210` (sent by the test) make the
   sequence active only while pressed;
5. locks the executor and the sequence, checks both are refused without `unlock` (values unchanged), applied and
   relocked with `unlock: true`, and reported by owner, then unlocks them;
6. cleans up: Off, unlock, `Delete Page 90.21x`, `Delete Sequence 905`, and Page 90 if it created it. Nothing
   calls SaveShow.


## Executor authoring extension (macOS onPC 2.5.1.1)

`gma3_executor_settings` and `gma3_configure_executor` accept `data_pool` (integer 1-9999). It scopes every page
read/write and reference scan to that pool without selecting it on the console. Assigned sequences are still read
by their actual address. Their pool location is compared with the requested pool when one is supplied.

`gma3_configure_executor` now supports Sequence and Macro executors. Macro discrete functions are `Empty`, `<<<`,
`>>>`, `Call`, `Go+`, `Go-`, `Off`, `Pause`; macro fader/encoder functions accept only `Empty`. The current function
may be inherited from a previous configuration and is always read rather than inferred from the assigned class.
Unsupported assigned classes are refused. Functions are checked against the assigned class before any write.

Additional parameters:

| Parameter | Property / meaning |
| --- | --- |
| `ma_encoder` | `MAEncoder`, same choices as the ordinary encoder for the assigned class. |
| `ma_encoder_left`, `ma_encoder_right` | `MAEncoderLeft`, `MAEncoderRight`, discrete function choices. |
| `width` | Executor cells, integer 1-5; extends right, staying within column 90. |
| `height` | Executor rows, integer 1-4; extends toward higher executor row numbers, staying within row 4. |
| `custom_commands` | Object keyed by any of `key_press`, `key_unpress`, `ma_key_press`, `ma_key_unpress`, `encoder_left`, `encoder_right`, `ma_encoder_left`, `ma_encoder_right`. |

Each custom command value accepts `command` (one line, at most 4096 characters, empty clears), `enabled` and
`add_executor`. Supplying command text requires an explicit `enabled` flag: the console automatically enables
nonempty text, so the tool always writes the requested flag after the text, even when that flag initially matched. The property prefixes are `Key`, `KeyUnpress`, `MAKey`, `MAKeyUnpress`,
`EncoderLeft`, `EncoderRight`, `MAEncoderLeft`, `MAEncoderRight`; their suffixes are `Command`, `UseCustomCommand`,
`AddExecutor`. Text is stored first, then `AddExecutor`, then `UseCustomCommand`. A stored command is never run by
this tool. To use it on a future press, set `enabled: true` explicitly. `enabled: false` retains the saved text
while choosing the ordinary function. A flag-only change remains supported. Control characters and leading
or trailing whitespace are refused: the existing object reader trims edge whitespace, so it could not verify it.
Case, quotes and internal whitespace are preserved and compared exactly in immediate and final Edit-role read-back.
The default read role can append the executor address when Add Executor is enabled; it is not used to compare stored command text.

Continuous encoder functions and left/right discrete functions or enabled custom commands are mutually exclusive,
for both ordinary and MA encoders. Conflicting nonempty modes in one call are refused before reads or writes.
Choosing a continuous function clears both left/right functions and disables their custom-command flags; choosing
a nonempty discrete function or enabled custom command clears the continuous function. These console side effects
are listed in `intended.implicitModeClears` and verified. A command text setter also selects the discrete mode,
even if its enabled flag is later set false. Therefore storing disabled left/right command text against an active
continuous encoder is refused before mutation, unless the call explicitly clears that continuous mode. This avoids
silently changing an existing encoder while saving dormant text.

Changing a key or discrete encoder function leaves its custom command enabled when it was already enabled.
The ordinary function is then a stored fallback. The tool reads that flag back and warns when a changed function
remains masked by the enabled command; explicitly set that slot’s `enabled: false` to use the fallback.

For sizing, the tool reads `Width` and `Height` and then every page child’s `No`, `Width`, `Height` (at most 500).
An incomplete scan, unreadable size, another executor’s intersecting footprint or a foreign `Proxy` refuses the
whole call before any settings change. Existing expanded executors are checked from their entire rectangles;
`No` is used because the child index differs from the executor number. Its own covered proxies are ignored.
Xkeys remain 1x1. Shrinks run before growth so intermediate sizes stay within the checked rectangle. The checks
are preflight observations, not a transaction lock against another operator. Every size write is read back.

The inspector adds `executorSettings.custom_commands`, `width`, `height` and `configuration`, with unknown
values reported as `null`. Configuration read-back proves saved settings, not the effect of a future key press.
No selection, programmer, fader level or active playback is changed by these authoring operations.

`test/live/executor-authoring.live.ts` exercises the extension without triggering playback. The existing
`test/live/playback.live.ts` remains the sequence playback behaviour test. Both require explicit live opt-in.


## gma3_executor_configuration

Load an existing configuration, or plan and apply a recast. Saving a full executor configuration is unsupported:
`Store Page 91.201 At Configuration 970` returned `OK` in the disposable-show probe while Configuration 970 did not
exist afterwards. A blank `Store Configuration 970` creates a structurally locked object with 175 internal entries,
but ordinary `children` reads expose none of that function profile. The tool therefore does not invent a serializer.

| Parameter | Meaning |
| --- | --- |
| `action` | `load` or `recast`. |
| `configuration` | Existing configuration number. |
| `data_pool` | Pool of the configuration and, for load, the target page; default current pool. |
| `page`, `executor` | Required for load; omitted for recast. |
| `preview` | Read and plan only, default false. |
| `apply` | Recast is a read-only plan unless explicitly true. |
| `executors` | For recast apply: the exact fresh affected list, entries `{data_pool,page,executor}`. |

Load reads `Configuration <n>` for its address and dimensions, reads page/target protection and assignment, then
checks complete page occupancy against the configuration rectangle. It refuses missing, covered, locked,
unreadable or unsupported targets. It sends `Assign Configuration <n> At Page <p>.<e>` once and reads the target
back. This loads its functions and size, retaining the assigned Sequence or Macro. Unlock a protected page or
executor explicitly first; this tool does not automatically remove protection.

Recast lists `ShowData.DataPools` (maximum 64), resolves each pool’s Pages collection, then scans at most 200 pages
per pool and all executor references by `ExecutorConfiguration`. Every listing must be complete and free of
`enumerationError`, invalid objects and field errors. The plan lists every affected executor across pools. To apply,
send `apply: true` and exactly that list in `executors`; the tool scans again and refuses a changed list, missing
configuration handles, incomplete enumeration or any locked/unreadable affected page/executor. It sends
`Recast Configuration <n>` once. Existing executor Width/Height are preserved, as confirmed by a recast that reset
`KeyPress` while keeping a 2x2 assignment. Recast updates functions; it does not resize those executors.

Read-back verifies configuration address, unchanged assigned-object address and expected dimensions for each
executor. The result returns observed functions and custom commands, and explicitly reports that the complete
saved function profile is unavailable. `verification: matched` covers only those identity and dimension checks;
it does not claim that every saved function was reproduced. Lost read-back is unavailable; an uncertain command
is never resent. The tools do not trigger playback, run stored commands, change fixture selection or clear the
programmer. Mutations are serialized by this server only: another client/operator can still alter references
between the scan and command, so the preflight list is not a transaction lock.

The complete authoring live test passed **1/1** on **macOS grandMA3 onPC 2.5.1.1**, bridge **0.49.0**, in a
disposable show. It exercised macro assignments, stored custom commands, separate
continuous/discrete encoder modes, sizing/collision/proxy checks, configuration loading and an exact-list recast.
The recast retained the assigned object and a 2x2 size. It created and cleaned up Page 91 (only when missing),
Sequence 970, Macro 970 and Configuration 970. No playback, executor press or macro execution was sent, and the
test did not call `SaveShow` or write the original user show file. This qualifies the recorded settings and
read-back behaviour; execution of the stored command and the complete configuration profile remain unverified.
