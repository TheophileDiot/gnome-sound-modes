# Sound Modes — design and module contracts

Save a complete audio setup as a **mode** and switch it in one click from Quick Settings.
Target: GNOME Shell 46–51, PipeWire/WirePlumber, optional EasyEffects (7.x GTK and 8.x Qt).
License GPL-2.0-or-later. Published on extensions.gnome.org eventually.

## Ground rules (every module)

- ES modules, `gi://` imports only. `lib/*` (except `lib/gvc.js`) and `prefs.js` never import
  `resource:///org/gnome/shell/…`: the preferences process reuses the backend modules.
- No synchronous I/O or subprocesses outside `tests/`. Subprocesses go through `lib/subprocess.js`
  (`Gio.Subprocess` + `communicate_utf8_async`), always with a timeout and a `Gio.Cancellable`.
- No `GLib.timeout` that outlives `destroy()`. Every object with signals or sources has
  `destroy()` that removes them. No polling loops; react to signals, debounce with one source.
- Nothing hard-coded: no device names, MACs, app names beyond the documented heuristics.
- Style: plain, readable, human. Short JSDoc on exported functions. No commented-out code, no
  "AI-style" narration comments. `console.warn` for recoverable problems, `console.error` for bugs.
- Tests: `tests/test-<module>.js`, run with `gjs -m`, plain `assert(cond, msg)` helper, print
  `test-<module>: all checks passed`. Pure modules must be fully tested against
  `tests/fixtures/pw-dump-airpods-tonor-discord.json` (parsed via `lib/snapshot.js`) plus
  hand-built cases.

## Snapshot (`lib/snapshot.js`, done)

`parseSnapshot(pwDumpObjects)` →

```js
{
  devices: [{id, serial, name /*device.name*/, description, api /*'alsa'|'bluez5'|…*/, formFactor,
             vendorId, productId, deviceSerial, busPath, bluezAddress,
             profiles: [{index, name, description, priority, available /*'yes'|'no'|'unknown'*/,
                         classes: {'Audio/Sink': n, 'Audio/Source': n}}],
             activeProfile /*name|null*/, match /*subset of stable props*/, props}],
  endpoints: [{id, serial, name /*node.name*/, description, nick, mediaClass, direction /*'output'|'input'*/,
               deviceId, virtual, bluez: {profile, codec, address}|null, props}],
  streams: [{id, serial, name, description, mediaClass, direction, appName, appBinary, appId, pid,
             role, mediaName, category, isLive, monitor, target /*node.name|string|null*/, targetNode, props}],
  defaults: {sink, source, configuredSink, configuredSource /*node.name|null*/},
  metadataId
}
```
Helpers: `stripNodeSuffix(name)`, `findDeviceByName`, `findEndpointByName`,
`endpointsForDevice(snapshot, device, direction?)`.

## Mode (`lib/model.js`)

```js
export const MODE_VERSION = 1;
{ version: 1, id: string /*GLib.uuid_string_random()*/, name: string, icon: string /*symbolic icon name*/,
  output: {match: object, profile: string|null} | null,
  input:  {match: object, profile: string|null} | null,
  bluetooth: {connectIfNeeded: boolean},
  effects: {enabled: boolean, scope: 'all'|'calls', outputPreset: string|null, inputPreset: string|null},
  fallback: {output: {match: object}|null, input: {match: object}|null} }
```
API: `createMode(partial={}) → mode` (fills defaults, new id), `validateMode(mode) → string[]`
(empty = valid; checks types, non-empty name, at least one of output/input, scope enum),
`parseModes(jsonString) → {modes, warnings}` (tolerant: drops invalid entries with a warning,
migrates older `version`), `serializeModes(modes) → string`, `duplicateMode(mode) → mode`
(new id, name + " (copy)"), `moveMode(modes, id, delta) → modes`, `ICONS` (curated list of
symbolic icon names with labels for the picker: audio-headphones, audio-speakers,
audio-input-microphone, camera-web, phone, call-start, bluetooth-active, audio-card,
multimedia-player, video-display …).

## Matching (`lib/matching.js`)

- `captureMatch(device) → match` (copy of `device.match`; `device.name` suffix-stripped).
- `scoreMatch(match, device) → number`: `api.bluez5.address` equal 100; `device.serial` equal 90;
  `device.name` (suffix-stripped both sides) 80; vendor+product+bus-path 60; vendor+product 40;
  `device.description` 20; 0 otherwise. Take the highest applicable rule, not a sum.
- `findDevice(match, snapshot) → {device, score}|null` (best score ≥ 40; tie → lowest id).
- `resolveEndpoint(slot /*{match, profile}*/, direction, snapshot) → {device, endpoint, score}|null`
  picks the device then its endpoint of that direction (non-virtual; if the device has several,
  prefer the one whose profile matches `slot.profile`, else highest `priority.session` prop, else first).
- `classifyDevice(device, snapshot) → {kind, wireless, icon, hasOutput, hasInput}`; `kind` in
  `headset | headphones | speaker | microphone | webcam | internal | hdmi | unknown`, derived from
  `formFactor`, `api === 'bluez5'`, profiles' classes (both sink and source on a bluez card → headset),
  name hints (`hdmi`, `webcam`), never from vendor names.
- `friendlyName(device)` → description without redundant suffixes; `endpointLabel(endpoint)`.
- `profileLabel(profile) → string` human: from the PipeWire description, e.g.
  "High Fidelity Playback (A2DP Sink, codec LDAC)" → "A2DP · LDAC", "Headset Head Unit (HSP/HFP, codec mSBC)"
  → "Headset (HFP) · mSBC", ALSA "Analogue Stereo Duplex" unchanged. `codecOfProfile(name)` → 'ldac'|null.
- `profilesForSlot(device, direction) → profiles` with `available !== 'no'` and a class for that direction,
  sorted by priority desc, `off` excluded.

## Calls (`lib/calls.js`)

`appKey(stream) → string` = `appId ?? appBinary ?? appName ?? 'pid:'+pid`.
`classifyStreams(streams, overrides={}) → {callStreams: stream[], apps: [{key, name, isCall, reasons: string[]}], inCall}`
Rules (any → call): `role === 'Communication'`; `/WEBRTC|VoiceEngine/i.test(appName)`;
bidirectional — same key owns a live non-monitor input **and** output stream;
`overrides[key] === 'always'`. `overrides[key] === 'never'` wins over everything. Excluded from
consideration: `monitor` streams, streams whose `appName` is `easyeffects` or `name` starts
with `ee_`, `appBinary` in a tiny denylist of desktop plumbing (`speech-dispatcher`, `gnome-shell`,
`pipewire`, `wireplumber`) — reason strings are user-visible ("WebRTC audio engine",
"Microphone and speaker in use", "Marked as call", "Communication role").

## Plan (`lib/plan.js`, pure)

`buildPlan(mode, snapshot, caps) → {steps, resolved, missing, warnings}`
- `caps = {easyeffects: {installed, running, canLoadPreset, canSetProcessAll}, bluetooth: boolean}`
- `resolved = {output: {device, endpoint, profile}|null, input: {...}|null}` (uses fallback when primary missing; `fallbackUsed: true`).
- `missing = [{slot: 'output'|'input', match, bluetooth: boolean /*could connect*/}]`.
- `steps` ordered, each `{id, kind, args, critical, timeoutMs, label}`; kinds:
  `bt-connect {address}` (device absent, `api.bluez5.address` in match, `mode.bluetooth.connectIfNeeded`, caps.bluetooth) → critical, 15000;
  `profile {deviceName, profile}` when `slot.profile` set and `device.activeProfile !== profile` → critical for bluez, 5000;
  `default-sink {nodeName}` / `default-source {nodeName}` when differs from `defaults.configuredSink/Source` → critical, 3000;
  `effects-start {}` when effects enabled, installed, not running → non-critical, 8000;
  `effects-preset {kind:'output'|'input', name}` per non-null preset → non-critical, 5000;
  `effects-process-all {outputs: scope==='all', inputs: scope==='all'}` when canSetProcessAll → non-critical, 3000;
  `routing {scope}` always last when effects enabled → non-critical.
  After a `bt-connect` the endpoint is unknown yet: emit `profile`/`default-*` steps with
  `args.deferred = {match, direction}` so the switcher resolves them after re-snapshot.
- `evaluateMode(mode, snapshot, caps) → {state: 'ok'|'degraded'|'missing', drift: kind[], missing, resolved}`
  — `ok` when no critical step would be needed and nothing missing; `drift` lists step kinds
  that differ (used by the controller for re-apply).

## Subprocess (`lib/subprocess.js`)

`run(argv, {timeoutMs=10000, cancellable=null, input=null}) → Promise<{stdout, stderr, status, ok}>`
rejects only on spawn failure/timeout/cancel (timeout → `force_exit()` + reject with `TimeoutError`).
`spawnDetached(argv)` for `easyeffects --gapplication-service`-style launches (stdio to /dev/null).

## PipeWire backend (`lib/pipewire.js`)

`class PipeWire extends GObject.Object` signals `changed` (snapshot). Methods:
`refresh(cancellable?) → Promise<snapshot>` (`pw-dump`, parse, store `this.snapshot`, emit `changed`
only if changed — compare a cheap fingerprint: ids + defaults + targets + active profiles),
`requestRefresh()` debounced 150 ms (single source), `setTarget(streamId, nodeName)` →
`pw-metadata <id> target.object <nodeName>`; `clearTarget(streamId)` → `pw-metadata -d <id> target.object`
and `-d <id> target.node`; `setProfile(deviceName, profileName)` → `pactl set-card-profile`;
`setDefaultSink(nodeName)` / `setDefaultSource(nodeName)` → `pactl set-default-sink|source`;
`waitFor(predicate, timeoutMs, cancellable) → Promise<snapshot>` resolves on the first `changed`
snapshot satisfying predicate (refreshes once immediately), rejects on timeout. `destroy()`.
Errors: reject with `Error` whose message includes the tool's stderr; missing tool → clear message
naming the package (`pipewire-bin`, `pulseaudio-utils`).

## EasyEffects backend (`lib/easyeffects.js`)

Constants `SINK = 'easyeffects_sink'`, `SOURCE = 'easyeffects_source'`, `APP_ID = 'com.github.wwmm.easyeffects'`.
`detect() → Promise<info>` with `info = {installed, flavour: 'native'|'flatpak'|null, major: 7|8|null,
version, argv /*['easyeffects'] or ['flatpak','run',APP_ID]*/, presetDirs: {output: [paths], input: [paths]},
canLoadPreset, canSetProcessAll, reason /*user-visible when not fully supported*/}`.
Detection: `GLib.find_program_in_path('easyeffects')`, else `flatpak info APP_ID` (async);
version from `<argv> --version`; major 7 → GSettings if schema `com.github.wwmm.easyeffects`
exists in `Gio.SettingsSchemaSource.get_default()` (native) or via `dconf read` fallback (flatpak);
major 8 → JSON db under `~/.config/easyeffects` (read-only detection), `canSetProcessAll=false`
unless the local-socket protocol is implemented (out of scope now; leave a clear TODO-free
`reason`). Preset dirs: 7.x `~/.config/easyeffects/{output,input}` (+ flatpak `~/.var/app/APP_ID/config/easyeffects/…`);
8.x `~/.local/share/easyeffects/{output,input}` (+ flatpak `~/.var/app/APP_ID/data/easyeffects/…`).
`listPresets(kind) → Promise<string[]>` (async dir enumeration, `*.json` basenames, sorted),
`loadPreset(kind, name) → Promise` (`<argv> -l <name>`; warn when the same name exists in both kinds),
`ensureRunning(snapshot) → Promise` (nodes present → no-op; else `spawnDetached([...argv, '--gapplication-service'])`),
`isRunning(snapshot) → boolean` (both nodes present), `setBypass(bool)`, `getProcessAll() → {outputs, inputs}|null`,
`setProcessAll({outputs, inputs}) → Promise` (7.x GSettings, else reject with `reason`).

## Bluetooth backend (`lib/bluetooth.js`)

`class Bluetooth extends GObject.Object`, signals `changed`. `init() → Promise` creates
`Gio.DBusObjectManagerClient` on the **system** bus for `org.bluez` (absence → `available=false`,
no throw). `devices → [{path, address, alias, connected, paired, audio /*UUID 0000110b or 0000111e present*/}]`,
`find(address)`, `connectDevice(address, cancellable) → Promise` (`Device1.Connect`, then resolve when
`Connected` becomes true, 20 s timeout), `disconnectDevice(address)`. `destroy()`. (Not `connect`: it
would shadow `GObject.Object.connect`.)

## Gvc events (`lib/gvc.js`, shell only)

`class GvcEvents extends GObject.Object` signal `changed`; wraps `getMixerControl()` from
`resource:///org/gnome/shell/ui/status/volume.js`, connects `stream-added/removed/changed`,
`card-added/removed`, `default-sink-changed`, `default-source-changed`, `active-output-update`,
`active-input-update`; coalesces into one `changed` per 150 ms. `destroy()` disconnects all.

## Log (`lib/log.js`)

`setDebug(bool)`, `debug(...)` (only when enabled), `warn(...)`, `error(...)`; prefix `[sound-modes]`.

## Switcher (`lib/switcher.js`)

`runPlan(plan, ctx, {cancellable, onStep}) → Promise<result>` with
`ctx = {pipewire, bluetooth, easyeffects, router, caps}`.
Executes `plan.steps` in order. For each step: `onStep(step, 'running')`, perform the action
through the backend, then verify against a fresh snapshot with `pipewire.waitFor(pred, timeoutMs)`:
- `bt-connect` → `bluetooth.connectDevice(address)`; verify a device with that address exists in the snapshot
  and has at least one endpoint. Then resolve every deferred step (`args.deferred`) via
  `matching.resolveEndpoint` on the new snapshot; unresolvable deferred critical step → failure.
- `profile` → `pipewire.setProfile`; verify `device.activeProfile === profile`.
- `default-sink|source` → `pipewire.setDefaultSink|Source`; verify `defaults.configuredSink|Source === nodeName`.
- `effects-start` → `easyeffects.ensureRunning`; verify `easyeffects.isRunning(snapshot)`.
- `effects-preset` → `easyeffects.loadPreset`; no verify (CLI has no feedback), warn on non-zero exit.
- `effects-process-all` → `easyeffects.setProcessAll`.
- `routing` → `router.sync(snapshot, mode)`.
Before the first critical step, capture `before = {configuredSink, configuredSource, profiles: {deviceName: activeProfile}}`.
A critical failure stops execution, restores `before` (best effort, each restore awaited, errors logged),
and resolves `{ok: false, failedStep, error, stepsDone, rolledBack: true}`. Non-critical failures are
collected in `result.warnings` and execution continues. Cancellation (`Gio.Cancellable`) behaves like a
critical failure without rollback of steps already verified? No: cancellation rolls back too — a
half-applied mode is never left silently. Result: `{ok, warnings, failedStep, error, stepsDone, rolledBack}`.

## Router (`lib/router.js`)

`class Router` with `sync(snapshot, mode, overrides) → Promise<{moved: n, cleared: n}>`:
- `calls.classifyStreams(snapshot.streams, overrides)` → call streams.
- When `mode?.effects.enabled && mode.effects.scope === 'calls' && easyeffects.isRunning(snapshot)`:
  every call stream whose `target` is not the EasyEffects node of its direction → `pipewire.setTarget(id, SINK|SOURCE)`;
  every non-call stream whose `target` is an EasyEffects node → `pipewire.clearTarget(id)`.
- Otherwise (effects off, scope `all`, EasyEffects not running, no mode): every stream whose
  `target` is an EasyEffects node and that this router (or a previous session — see below) set →
  `clearTarget`. Streams the user pointed at EasyEffects manually cannot be told apart from ours,
  so `scope === 'all'` leaves targets alone (EasyEffects manages them itself) and only `calls`/off
  modes clear. Document this in a comment.
- Idempotent: never issues a command when the snapshot already shows the desired target.
- `reset(snapshot)` clears every EasyEffects target (Advanced page button).

## Controller (`lib/controller.js`, shell process)

`class Controller extends GObject.Object` signals: `status-changed`, `call-started`, `call-ended`.
Constructor `(settings, {pipewire, bluetooth, easyeffects, gvc})`. `init()` → detect EasyEffects,
initial refresh, connect: `gvc.changed`/`bluetooth.changed` → `pipewire.requestRefresh()`;
`pipewire.changed` → `_onSnapshot`; `settings changed::modes|active-mode|call-app-overrides`.
Properties: `modes` (parsed), `activeMode`, `status`:

```js
{ activeModeId, modeName, state: 'idle'|'applying'|'ok'|'degraded'|'missing'|'failed'|'custom',
  output: {name, profileLabel, codec}|null, input: {name}|null,
  effects: {installed, running, scope, outputPreset, inputPreset, reason}|null,
  inCall, callApps: [{key, name}], missing: [{slot, description}], lastError: string|null,
  modes: [{id, name, icon, available: boolean, missing: [description]}] }
```
`apply(modeId) → Promise<result>`: cancels a running apply, sets `state='applying'`, builds the plan,
runs the switcher, on success stores `active-mode`, on failure keeps the previous `active-mode` and
sets `lastError` + `state='failed'`. `clearActive()` → `active-mode=''`, router cleanup.
`_onSnapshot(snapshot)`: router.sync (only when a mode is active with effects scope `calls`, or to
clear after leaving such a mode); `calls.classifyStreams` → `inCall` with 1500 ms off-hysteresis
(single source) → signals; `plan.evaluateMode(activeMode, snapshot, caps)`:
- `missing` → state `missing` (list devices); when a previously missing device reappears and
  `reapply-on-reconnect` is on → schedule `apply(activeModeId)` after 1000 ms (single source), at
  most 3 attempts per appearance;
- `drift` non-empty → state `degraded`; if drift is only `default-*` and the user changed the default
  through GNOME (Gvc `default-*-changed` fired without our apply running) → `clearActive()` (state
  `custom`) instead of fighting; if drift is `profile` on a bluez device while any stream captures
  from that device's source → leave it (WirePlumber headset autoswitch), state `degraded` with reason
  "Headset profile in use by a call"; otherwise schedule re-apply as above.
`destroy()` removes every source and handler.
