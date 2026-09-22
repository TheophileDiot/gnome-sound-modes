# Contributing

## Code layout

```
extension.js        wires backends + controller + UI together, enable()/disable()
prefs.js             preferences window entry point
lib/                 shell-agnostic logic — see rule below
  model.js           mode schema, defaults, validate(), parse/serialize
  matching.js        device/node matching, scoring, classification
  calls.js           call-stream classifier
  plan.js            (mode, snapshot, caps) → ordered switch steps
  subprocess.js      Gio.Subprocess wrapper: run(argv), spawnDetached(argv)
  snapshot.js        pure parser for `pw-dump` JSON
  pipewire.js         pw-dump/pw-metadata/pactl backend
  bluetooth.js        BlueZ ObjectManager backend
  easyeffects.js      EasyEffects detection + preset/bypass/process-all control
  gvc.js              [shell-only] wraps GNOME Shell's Gvc mixer control
  switcher.js         executes a plan's steps, verifies, rolls back on failure
  router.js           applies/clears call-stream routing to EasyEffects
  controller.js       ties it together: status object, drift, re-apply
  log.js              console.debug/warn/error with a prefix, gated by a debug flag
ui/
  indicator.js         Quick Settings toggle + menu
  panelButton.js        optional top-bar button, same menu content
  icons.js              symbolic icon resolution
  format.js              status text, kept separate from the widgets for testing
  prefs/                 Adw/Gtk preferences pages and the mode editor dialog
tests/                test-*.js (gjs -m, plain assert), manual/probe-*.js (live, read-only)
```

**Rule: `lib/*` (except `lib/gvc.js`) and `ui/prefs/*` never import
`resource:///org/gnome/shell/…`.** The preferences process is a separate GJS process
without the Shell's resources loaded, and it reuses `pipewire.js`, `bluetooth.js`,
`easyeffects.js`, `model.js`, and `matching.js` directly. `ui/indicator.js` and
`ui/panelButton.js` are Shell-only and import `resource:///org/gnome/shell/...` freely.

## Rules

- **Async only.** Subprocesses go through `lib/subprocess.js` (`Gio.Subprocess` +
  `communicate_utf8_async`), always with a timeout and a `Gio.Cancellable`. No
  `spawn_sync`, no synchronous file I/O — use the async `Gio.File` methods (see
  `easyeffects.js`'s `enumerate_children_async` for the pattern).
- **Clean up in `destroy()`.** Every object that connects a signal or adds a
  `GLib.timeout`/`GLib.idle` source removes it in `destroy()`. No polling loops — react
  to signals and debounce with a single source if needed. Check `extension.js`'s
  `disable()` and `ui/indicator.js`'s `destroy()` for the pattern before adding a new
  long-lived object.
- **No hard-coded device or app names.** Devices are matched on stable `pw-dump`
  properties (`device.serial`, `api.bluez5.address`, vendor/product IDs — see
  `lib/matching.js`); calls are recognized by the heuristics in `lib/calls.js`, not by
  checking for a specific app. If you need a new heuristic, generalize it — don't special
  case one app or one headset.
- **Tests run with `gjs -m`.** Each `lib/*.js` module with logic worth testing gets a
  `tests/test-<module>.js`, using the plain `assert(cond, msg)` helper already in use, and
  printing `test-<module>: all checks passed` at the end. Run the whole suite (plus the
  schema check) with:

  ```bash
  make test
  ```

  Run before every commit; CI (`.github/workflows/test.yml`) runs the same thing.

## Adding a backend capability

1. Add the logic to a new or existing module in `lib/`. If it needs to know about the
   live system, expose a `detect()`-style async function that returns a plain object
   describing what's available (see `easyeffects.detect()` for the shape: `installed`,
   capability flags, a `reason` string for anything unsupported).
2. If `plan.js` needs to act on it, add it to the `caps` object passed into
   `buildPlan()`/`evaluateMode()` and add the corresponding step kind(s).
3. Wire it into `extension.js` (`enable()`/`disable()`) and, if the preferences UI needs
   it, into `prefs.js`'s `ctx` object and the relevant `ui/prefs/*` page.
4. Add `tests/test-<module>.js` covering the pure logic.
5. If the module talks to the live system, add `tests/manual/probe-<module>.js`: a
   read-only dump by default, with a `--apply <op> <args...>` flag gating anything
   mutating. Follow `tests/manual/probe-pipewire.js` for the shape.

## Running a nested Shell

To try UI or controller changes without logging out:

```bash
make install
dbus-run-session -- gnome-shell --nested --wayland
```

Enable the extension inside the nested session the same way as normal
(`gnome-extensions enable sound-modes@theophilediot.github.io`), and watch its log with:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```
