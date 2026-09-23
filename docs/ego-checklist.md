## extensions.gnome.org submission checklist

Repo-specific checklist for submitting or updating Sound Modes on
extensions.gnome.org (EGO). Go through this before every upload.

### metadata.json

- [ ] `uuid` is `sound-modes@theophilediot.github.io` and matches the top-level folder
      name inside the packed zip (`gnome-extensions pack` handles this — don't rename the
      repo root without checking).
- [ ] `settings-schema` (`org.gnome.shell.extensions.sound-modes`) matches the `id`
      attribute in `schemas/org.gnome.shell.extensions.sound-modes.gschema.xml` exactly.
- [ ] `gettext-domain` (`sound-modes`) matches what `extension.gettext`/`ngettext` are
      bound to in `ui/indicator.js`, `ui/panelButton.js`, and the prefs pages.
- [ ] `shell-version` lists only shell versions actually tested on this cycle. Currently
      `["46", "47", "48", "49", "50"]` — trim or extend based on what you verified,
      not what you assume still works.
- [ ] `description` reads as plain, factual English (what it does, what it needs), no
      marketing language, no emoji. EGO reviewers reject listings that read as ad copy.
- [ ] `url` points at the real repo (`https://github.com/TheophileDiot/gnome-sound-modes`).
- [ ] No keys beyond the standard set (`name`, `description`, `uuid`,
      `settings-schema`, `gettext-domain`, `url`, `version-name`, `shell-version`). EGO's
      review tooling flags unrecognized keys.
- [ ] `version-name` bumped for this release (see "Version bump" below). Don't hand-set a
      `version` integer — EGO stamps that itself on each accepted upload.

### Schema

- [ ] `glib-compile-schemas --strict schemas` passes with no warnings (`make test` runs
      this as a dry-run; run it for real once before packing if you touched the schema).
- [ ] Every setting the UI reads (`modes`, `active-mode`, `call-app-overrides`,
      `call-mode`, `reapply-on-reconnect`, `show-indicator`, `debug`) has a sane default
      that doesn't crash a fresh install with no `~/.config` state — the defaults in the
      schema (`'[]'`, `''`, `{}`, `true`, `false`) already satisfy this; keep it that way
      if you add a key.

### Async / no sync I/O

- [ ] No `Gio.Subprocess`/`GLib.spawn_sync`, no synchronous `Gio.File` read/write, no
      blocking loop anywhere in `lib/` or `ui/`. All subprocess calls go through
      `lib/subprocess.js`'s `run()`/`spawnDetached()`, all directory reads through the
      async `Gio.File` enumerator (see `lib/easyeffects.js`'s `listPresets`).
  - Quick check: `grep -rn "spawn_sync\|_sync(" lib ui extension.js prefs.js` should come
    back empty.

### Cleanup on disable()

- [ ] `extension.js`'s `disable()` tears down, in order: panel button, indicator,
      controller, Gvc event source, Bluetooth backend, PipeWire backend, the `debug`
      settings signal — and nulls each reference. If you add a new long-lived object in
      `enable()`, add its teardown here too.
- [ ] Every `GObject.registerClass` widget with a `destroy()` (indicator, panel button)
      disconnects every signal it connected in its constructor, including the ones on
      `Main.sessionMode` and on the controller — not just the ones on itself.
- [ ] No `GLib.timeout_add`/`GLib.idle_add` source without a matching `GLib.source_remove`
      reachable from some `destroy()`. `ui/prefs/modeEditor.js`'s device-refresh timeout is
      the existing example of this pattern (`scope.add(() => GLib.source_remove(source))`).
- [ ] Enable/disable the extension a few times in a row in a nested Shell and check the
      journal for repeated warnings, growing signal counts, or leftover indicators — that
      usually means something above was missed.

### No monkeypatching, no bundled binaries

- [ ] No reassignment of anything under `Main.*` (`grep -rn "Main\.\w* ="` should be
      empty). The extension only calls existing `Main` functions and connects to existing
      signals.
- [ ] No binaries, prebuilt libraries, or vendored native code in the repo or the packed
      zip. Everything the extension needs at runtime (`pw-dump`, `pw-metadata`, `pactl`,
      `easyeffects`, `flatpak`) is a system tool it shells out to, never something it
      ships.

### Version bump

- [ ] `metadata.json`'s `version-name` updated to reflect this release.
- [ ] Anything user-visible worth a line (new mode capability, fixed bug) noted somewhere
      you're comfortable pointing a reviewer at if asked — this repo doesn't keep a
      separate changelog file today; a PR/release description is enough.

### Packing

- [ ] `make pack` succeeds and produces
      `dist/sound-modes@theophilediot.github.io.shell-extension.zip`
      (`gnome-extensions pack --force --out-dir=dist
      --schema=schemas/org.gnome.shell.extensions.sound-modes.gschema.xml
      --extra-source=lib --extra-source=ui --extra-source=icons --extra-source=LICENSE .`,
      per the `Makefile`'s `pack` target — it runs `make test` first).
- [ ] Unzip it somewhere and sanity-check the contents: the schema XML (the compiled
      `gschemas.compiled` is produced at install time, not by `pack`), `lib/`, `ui/`, `icons/`, `LICENSE`, plus `metadata.json`,
      `extension.js`, `prefs.js`, `stylesheet.css` at the root. No `tests/`, no `.git`,
      no `dist/` inside itself.
- [ ] Install the freshly packed zip (`gnome-extensions install --force
      dist/sound-modes@theophilediot.github.io.shell-extension.zip`), re-login or restart
      the Shell, and confirm it enables and `gnome-extensions prefs
      sound-modes@theophilediot.github.io` opens with no console errors — packing pulls in
      exactly what `--extra-source` lists, and it's easy for a new file under `lib/` or
      `ui/` to be missed if the Makefile's `SOURCES` variable wasn't updated.

### Screenshots to prepare

EGO's submission form wants at least one, and a browsing user decides from these before
reading anything else. Prepare, at native panel scale (no browser chrome, no desktop
clutter):

- [ ] Quick Settings menu open, showing the mode list with at least one active
      (checked) mode and one showing a status detail (missing device, "Will connect …",
      or an effects/call row).
- [ ] The mode editor dialog, with a real device and profile picked, effects section
      visible.
- [ ] The Modes page in preferences, showing two or three configured modes.
- [ ] Optional: the top-bar panel button, if you expect people to enable it.
