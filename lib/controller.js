// Ties the backends together: keeps one snapshot of the current state,
// applies modes through the switcher, watches for drift and exposes a
// single status object for the Quick Settings UI.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {classifyStreams} from './calls.js';
import {friendlyName, profileLabel} from './matching.js';
import {parseModes} from './model.js';
import {buildPlan, evaluateMode} from './plan.js';
import {Router} from './router.js';
import {runPlan} from './switcher.js';
import {endpointsForDevice, findDeviceByName, findEndpointByName} from './snapshot.js';
import {debug, warn} from './log.js';

const CALL_OFF_HYSTERESIS_MS = 1500;
const REAPPLY_DEBOUNCE_MS = 1000;
const MAX_REAPPLY_ATTEMPTS = 3;

const DEFAULT_KINDS = new Set(['default-sink', 'default-source']);

const HEADSET_REASON = 'Headset profile in use by a call';

function describeMatch(match, bluetooth) {
    const address = match['api.bluez5.address'];
    const alias = address ? bluetooth?.find(address)?.alias : null;
    return match['device.description'] ?? alias ?? match['device.name'] ?? address ?? 'Unknown device';
}

function describe(device, endpoint) {
    if (!device && !endpoint)
        return null;
    const active = device?.profiles.find(p => p.name === device.activeProfile) ?? null;
    return {
        name: device ? friendlyName(device) : endpoint.description || endpoint.name,
        profileLabel: active ? profileLabel(active) : null,
        codec: endpoint?.bluez?.codec ?? null,
    };
}

function currentDefault(snapshot, direction) {
    const name = direction === 'output' ? snapshot.defaults.sink : snapshot.defaults.source;
    const endpoint = name ? findEndpointByName(snapshot, name) : null;
    if (!endpoint)
        return null;
    return describe(snapshot.devices.find(d => d.id === endpoint.deviceId) ?? null, endpoint);
}

/** Orchestrates snapshots, modes and the UI-facing status. */
export const Controller = GObject.registerClass({
    Signals: {'status-changed': {}, 'call-started': {}, 'call-ended': {}},
}, class Controller extends GObject.Object {
    constructor(settings, {pipewire, bluetooth, easyeffects, gvc}) {
        super();
        this._settings = settings;
        this._pipewire = pipewire;
        this._bluetooth = bluetooth;
        this._easyeffects = easyeffects;
        this._gvc = gvc;
        this._router = new Router(pipewire);

        this._handlers = [];
        this._modes = [];
        this._snapshot = null;
        this._eeInfo = {installed: false, canLoadPreset: false, canSetProcessAll: false, reason: null};
        this._state = 'idle';
        this._status = null;
        this._lastError = null;
        this._errorKind = null;
        this._reason = null;
        this._custom = false;
        this._callApps = [];
        this._inCall = false;
        this._callOffSource = 0;
        this._reapplySource = 0;
        this._reapplyAttempts = 0;
        this._wasMissing = false;
        // Seeded true so the first snapshot after enable sweeps EasyEffects
        // targets WirePlumber restored from a previous session.
        this._routingActive = true;
        this._modeBeforeCall = null;
        this._activeApply = null;
        this._defaultChangedByUser = false;
        this._statusJson = null;
        this._destroyed = false;
        // Cancels everything this controller spawned when the extension is
        // disabled, so no subprocess or its timeout outlives destroy().
        this._cancellable = new Gio.Cancellable();
    }

    /** Detect EasyEffects, connect every source of change and take a first snapshot. */
    async init() {
        try {
            this._eeInfo = await this._easyeffects.detect(this._cancellable);
        } catch (e) {
            warn(`EasyEffects detection failed: ${e.message}`);
            this._eeInfo = {installed: false, canLoadPreset: false, canSetProcessAll: false, reason: e.message};
        }
        // destroy() may have run while detection was in flight.
        if (this._destroyed)
            return;
        this._reloadModes();

        const connect = (object, signal, handler) =>
            this._handlers.push([object, object.connect(signal, handler)]);
        connect(this._gvc, 'changed', () => {
            // A mixer event outside an apply is the only evidence we get that
            // the user, and not this extension, moved the default device.
            if (!this._activeApply)
                this._defaultChangedByUser = true;
            this._pipewire.requestRefresh();
        });
        connect(this._bluetooth, 'changed', () => this._pipewire.requestRefresh());
        connect(this._pipewire, 'changed', (_o, snapshot) => this._onSnapshot(snapshot));
        connect(this._settings, 'changed::modes', () => {
            this._reloadModes();
            this._update();
        });
        connect(this._settings, 'changed::active-mode', () => this._update());
        connect(this._settings, 'changed::call-app-overrides', () => this._update());

        try {
            await this._pipewire.refresh();
        } catch (e) {
            if (this._destroyed)
                return;
            this._lastError = e.message;
            warn(`initial refresh failed: ${e.message}`);
            this._update();
        }
    }

    get settings() {
        return this._settings;
    }

    get modes() {
        return this._modes;
    }

    get activeMode() {
        const id = this._settings.get_string('active-mode');
        return id ? this._modes.find(m => m.id === id) ?? null : null;
    }

    get status() {
        return this._status;
    }

    get inCall() {
        return this._inCall;
    }

    /**
     * Switch to a mode, cancelling an apply already in flight.
     * @param {string} modeId
     * @returns {Promise<object>} the switcher result
     */
    async apply(modeId) {
        const mode = this._modes.find(m => m.id === modeId);
        if (!mode) {
            this._lastError = `unknown mode: ${modeId}`;
            this._state = 'failed';
            this._update();
            return {ok: false, error: new Error(this._lastError), warnings: [], stepsDone: [],
                failedStep: null, rolledBack: false, cancelled: false};
        }

        this._cancelApply({superseded: true});
        this._clearSource('_reapplySource');
        const run = {cancellable: new Gio.Cancellable(), superseded: false};
        this._activeApply = run;
        this._lastError = null;
        this._reason = null;
        this._defaultChangedByUser = false;
        this._update();

        let result;
        try {
            const snapshot = await this._pipewire.refresh(run.cancellable);
            const caps = this._caps(snapshot);
            const plan = buildPlan(mode, snapshot, caps);
            result = await runPlan(plan, {
                pipewire: this._pipewire,
                bluetooth: this._bluetooth,
                easyeffects: this._easyeffects,
                router: this._router,
                caps,
                mode,
                overrides: this._overrides(),
            }, {
                cancellable: run.cancellable,
                onStep: (step, phase) => debug(`${phase}: ${step.label}`),
                rollbackOnCancel: () => !run.superseded,
            });
        } catch (e) {
            result = {ok: false, error: e, warnings: [], stepsDone: [], failedStep: null,
                rolledBack: false, cancelled: run.cancellable.is_cancelled()};
        }

        if (this._activeApply !== run)
            return result;
        this._activeApply = null;

        if (result.ok) {
            this._custom = false;
            this._state = 'ok';
            this._settings.set_string('active-mode', mode.id);
            // _syncRouting() owns _routingActive: setting it here would make
            // it skip the pass that clears the previous mode's target pins.
            if (this._snapshot)
                this._syncRouting(this._snapshot);
        } else if (!result.cancelled) {
            this._lastError = result.error?.message ?? 'could not apply the mode';
            this._errorKind = result.failedStep?.kind ?? null;
            this._state = 'failed';
        }
        this._update();
        return result;
    }

    /** Forget the active mode and stop routing streams for it. */
    clearActive() {
        this._cancelApply();
        this._clearSource('_reapplySource');
        this._custom = true;
        this._state = 'custom';
        this._lastError = null;
        this._reason = null;
        if (this._snapshot && this._routingActive) {
            this._routingActive = false;
            this._router.sync(this._snapshot, null, this._overrides())
                .catch(e => warn(`could not clear stream targets: ${e.message}`));
        }
        this._settings.set_string('active-mode', '');
        this._update();
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();
        this._cancelApply();
        this._clearSource('_callOffSource');
        this._clearSource('_reapplySource');
        for (const [object, id] of this._handlers)
            object.disconnect(id);
        this._handlers = [];
        this._settings = null;
        this._pipewire = null;
        this._bluetooth = null;
        this._easyeffects = null;
        this._gvc = null;
        this._router = null;
        this._snapshot = null;
        this._status = null;
    }

    _reloadModes() {
        const {modes, warnings} = parseModes(this._settings.get_string('modes'));
        this._modes = modes;
        for (const message of warnings)
            warn(message);
    }

    _overrides() {
        return this._settings.get_value('call-app-overrides').deep_unpack();
    }

    _caps(snapshot) {
        return {
            easyeffects: {...this._eeInfo, running: this._easyeffects.isRunning(snapshot)},
            bluetooth: this._bluetooth.available,
        };
    }

    _cancelApply({superseded = false} = {}) {
        if (!this._activeApply)
            return;
        this._activeApply.superseded = superseded;
        this._activeApply.cancellable.cancel();
        this._activeApply = null;
    }

    _clearSource(key) {
        if (!this[key])
            return;
        GLib.source_remove(this[key]);
        this[key] = 0;
    }

    _onSnapshot(snapshot) {
        this._snapshot = snapshot;
        this._syncRouting(snapshot);
        this._updateCallState(snapshot);
        this._update();
    }

    _syncRouting(snapshot) {
        const mode = this.activeMode;
        const wanted = Boolean(mode?.effects.enabled && mode.effects.scope === 'calls');
        if (!wanted && !this._routingActive)
            return;
        this._routingActive = wanted;
        this._router.sync(snapshot, mode, this._overrides())
            .catch(e => warn(`routing failed: ${e.message}`));
    }

    _updateCallState(snapshot) {
        const {apps, inCall} = classifyStreams(snapshot.streams, this._overrides());
        this._callApps = apps.filter(a => a.isCall).map(a => ({key: a.key, name: a.name}));

        if (inCall) {
            this._clearSource('_callOffSource');
            if (!this._inCall) {
                this._inCall = true;
                this.emit('call-started');
                this._onCallStarted();
            }
            return;
        }
        if (!this._inCall || this._callOffSource)
            return;
        this._callOffSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CALL_OFF_HYSTERESIS_MS, () => {
            this._callOffSource = 0;
            this._inCall = false;
            this.emit('call-ended');
            this._onCallEnded();
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onCallStarted() {
        const callMode = this._settings.get_string('call-mode');
        if (!callMode || this._modeBeforeCall !== null)
            return;
        const active = this._settings.get_string('active-mode');
        if (active === callMode)
            return;
        this._modeBeforeCall = active;
        this.apply(callMode).catch(e => warn(`call mode failed: ${e.message}`));
    }

    _onCallEnded() {
        const previous = this._modeBeforeCall;
        if (previous === null)
            return;
        this._modeBeforeCall = null;
        // The user switching modes during the call wins over the restore.
        if (this._settings.get_string('active-mode') !== this._settings.get_string('call-mode'))
            return;
        if (previous)
            this.apply(previous).catch(e => warn(`restoring the previous mode failed: ${e.message}`));
        else
            this.clearActive();
    }

    _update() {
        const snapshot = this._snapshot;
        let mode = this.activeMode;
        let evaluation = snapshot && mode ? evaluateMode(mode, snapshot, this._caps(snapshot)) : null;

        if (this._activeApply) {
            this._state = 'applying';
        } else if (!mode) {
            // A failure with no mode to fall back on still has to be visible.
            this._state = this._lastError ? 'failed' : this._custom ? 'custom' : 'idle';
        } else if (evaluation) {
            // A failed apply stays visible until an evaluation comes out ok.
            const next = this._react(snapshot, mode, evaluation);
            this._state = this._state === 'failed' && next !== 'ok' ? 'failed' : next;
            if (this._state === 'ok')
                this._lastError = null;
        }

        // _react drops the active mode when the user changed the default.
        if (this.activeMode !== mode) {
            mode = this.activeMode;
            evaluation = null;
        }

        this._status = this._buildStatus(mode, evaluation);
        // The menu is rebuilt from scratch on every emission: only fire when
        // something the UI shows actually changed.
        const json = JSON.stringify(this._status);
        if (json === this._statusJson)
            return;
        this._statusJson = json;
        this.emit('status-changed');
    }

    _react(snapshot, mode, evaluation) {
        const drift = evaluation.driftSteps;

        if (evaluation.state === 'missing') {
            this._wasMissing = true;
            this._reapplyAttempts = 0;
            this._clearSource('_reapplySource');
            this._reason = null;
            return 'missing';
        }

        if (this._wasMissing) {
            this._wasMissing = false;
            this._reason = null;
            if (drift.length > 0)
                this._scheduleReapply();
            return evaluation.state;
        }

        if (drift.length === 0) {
            this._reapplyAttempts = 0;
            this._reason = null;
            return evaluation.state;
        }

        // Only the default device moved, a mixer event announced it outside
        // any apply of ours, and it now points at a device the mode does not
        // target: the user picked it, so stop claiming the mode is active
        // instead of fighting them for it.
        if (this._state !== 'failed' && this._defaultChangedByUser &&
            drift.every(step => DEFAULT_KINDS.has(step.kind)) &&
            this._userPickedAnotherDevice(snapshot, drift, evaluation)) {
            this._defaultChangedByUser = false;
            this.clearActive();
            return 'custom';
        }
        this._defaultChangedByUser = false;

        if (this._headsetInUse(snapshot, drift)) {
            this._reason = HEADSET_REASON;
            return 'degraded';
        }

        this._reason = null;
        this._scheduleReapply();
        return 'degraded';
    }

    _userPickedAnotherDevice(snapshot, drift, evaluation) {
        return drift.every(step => {
            const isSink = step.kind === 'default-sink';
            const configured = isSink ? snapshot.defaults.configuredSink : snapshot.defaults.configuredSource;
            const endpoint = configured ? findEndpointByName(snapshot, configured) : null;
            const wanted = isSink ? evaluation.resolved.output : evaluation.resolved.input;
            return Boolean(endpoint) && Boolean(wanted) && endpoint.deviceId !== wanted.device.id;
        });
    }

    // WirePlumber switches a Bluetooth card to HFP by itself while something
    // records from it. Re-applying A2DP under a live call would cut the mic.
    _headsetInUse(snapshot, drift) {
        for (const step of drift) {
            if (step.kind !== 'profile' || !step.args.deviceName)
                continue;
            const device = findDeviceByName(snapshot, step.args.deviceName);
            if (device?.api !== 'bluez5')
                continue;
            const sources = endpointsForDevice(snapshot, device, 'input').map(e => e.name);
            const capturing = snapshot.streams.some(stream =>
                stream.direction === 'input' && !stream.monitor &&
                sources.includes(stream.target ?? snapshot.defaults.source));
            if (capturing)
                return true;
        }
        return false;
    }

    _scheduleReapply() {
        if (!this._settings.get_boolean('reapply-on-reconnect'))
            return;
        if (this._reapplySource || this._reapplyAttempts >= MAX_REAPPLY_ATTEMPTS)
            return;
        const modeId = this._settings.get_string('active-mode');
        this._reapplyAttempts++;
        this._reapplySource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REAPPLY_DEBOUNCE_MS, () => {
            this._reapplySource = 0;
            this.apply(modeId).catch(e => warn(`re-apply failed: ${e.message}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    _buildStatus(mode, evaluation) {
        const snapshot = this._snapshot;
        const easyeffects = {...this._eeInfo, running: snapshot ? this._easyeffects.isRunning(snapshot) : false};
        const resolved = evaluation?.resolved ?? {output: null, input: null};
        const output = resolved.output
            ? describe(resolved.output.device, resolved.output.endpoint)
            : snapshot && this._describeCurrent('output');
        const input = resolved.input
            ? describe(resolved.input.device, resolved.input.endpoint)
            : snapshot && this._describeCurrent('input');
        const effects = mode ? {
            installed: easyeffects.installed,
            running: easyeffects.running,
            scope: mode.effects.enabled ? mode.effects.scope : null,
            outputPreset: mode.effects.enabled ? mode.effects.outputPreset : null,
            inputPreset: mode.effects.enabled ? mode.effects.inputPreset : null,
            reason: easyeffects.reason ?? null,
        } : null;

        return {
            activeModeId: mode?.id ?? null,
            modeName: mode?.name ?? null,
            state: this._state,
            output: output || null,
            input: input ? {name: input.name} : null,
            effects,
            inCall: this._inCall,
            callApps: this._callApps,
            missing: (evaluation?.missing ?? []).filter(entry => !entry.bluetooth).map(entry => ({
                slot: entry.slot,
                description: describeMatch(entry.match, this._bluetooth),
            })),
            connectable: (evaluation?.missing ?? []).filter(entry => entry.bluetooth).map(entry => ({
                slot: entry.slot,
                description: describeMatch(entry.match, this._bluetooth),
            })),
            lastError: this._lastError,
            errorKind: this._lastError ? this._errorKind : null,
            reason: this._reason,
            modes: this._modes.map(m => this._modeSummary(m)),
        };
    }

    _describeCurrent(direction) {
        return currentDefault(this._snapshot, direction);
    }

    _modeSummary(mode) {
        const snapshot = this._snapshot;
        const entries = snapshot ? evaluateMode(mode, snapshot, this._caps(snapshot)).missing : [];
        // A Bluetooth device the mode may connect is not missing, it is one
        // click away: the mode stays selectable.
        const label = entry => describeMatch(entry.match, this._bluetooth);
        const missing = entries.filter(entry => !entry.bluetooth).map(label);
        return {
            id: mode.id,
            name: mode.name,
            icon: `${mode.icon}-symbolic`,
            available: missing.length === 0,
            missing,
            connectable: entries.filter(entry => entry.bluetooth).map(label),
        };
    }
});
