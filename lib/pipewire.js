// PipeWire/WirePlumber backend: snapshots `pw-dump` and drives routing
// through `pw-metadata` and `pactl`. No shell imports — reused by prefs.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import {run, TimeoutError} from './subprocess.js';
import {parseSnapshot, parseDumpText} from './snapshot.js';
import {warn} from './log.js';

const REFRESH_DEBOUNCE_MS = 150;
const POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 1000;
const MISSING_TOOL_RE = /No such file or directory/;

function fingerprint(snapshot) {
    return JSON.stringify({
        devices: snapshot.devices.map(d => [d.id, d.activeProfile]),
        endpoints: snapshot.endpoints.map(e => e.id),
        streams: snapshot.streams.map(s => [s.id, s.target]),
        defaults: snapshot.defaults,
    });
}

/**
 * Live PipeWire state and the commands used to change it.
 * Emits `changed` with the new snapshot whenever it differs from the last one.
 */
export const PipeWire = GObject.registerClass({
    Signals: {'changed': {param_types: [GObject.TYPE_JSOBJECT]}},
}, class PipeWire extends GObject.Object {
    constructor() {
        super();
        this.snapshot = null;
        this._fingerprint = null;
        this._refreshSource = null;
        this._pending = null;
        this._waiters = new Set();
        this._cancellable = new Gio.Cancellable();
    }

    async _runTool(argv, {cancellable = null, timeoutMs = 10000, pkg = null} = {}) {
        let result;
        try {
            result = await run(argv, {cancellable: cancellable ?? this._cancellable, timeoutMs});
        } catch (e) {
            if (e instanceof TimeoutError)
                throw e;
            if (pkg && MISSING_TOOL_RE.test(e.message))
                throw new Error(`${argv[0]} not found — install ${pkg}`);
            throw e;
        }
        if (!result.ok)
            throw new Error(`${argv[0]} failed: ${result.stderr.trim() || `exit code ${result.status}`}`);
        return result;
    }

    /**
     * Re-run `pw-dump`, parse it, and emit `changed` if the state differs
     * from the last snapshot.
     * @returns {Promise<object>} the new snapshot
     */
    async refresh(cancellable = null) {
        if (this._pending)
            return this._pending;
        this._pending = this._dump(cancellable);
        try {
            return await this._pending;
        } finally {
            this._pending = null;
        }
    }

    async _dump(cancellable) {
        const {stdout} = await this._runTool(['pw-dump'], {cancellable, pkg: 'pipewire-bin'});
        let objects;
        try {
            objects = parseDumpText(stdout);
        } catch (e) {
            throw new Error(`pw-dump produced invalid JSON: ${e.message}`);
        }
        const snapshot = parseSnapshot(objects);
        this.snapshot = snapshot;
        const fp = fingerprint(snapshot);
        if (fp !== this._fingerprint) {
            this._fingerprint = fp;
            this.emit('changed', snapshot);
        }
        return snapshot;
    }

    /** Coalesce bursts of change notifications into a single refresh. */
    requestRefresh() {
        if (this._refreshSource !== null)
            return;
        this._refreshSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_DEBOUNCE_MS, () => {
            this._refreshSource = null;
            this.refresh().catch(e => warn(`refresh failed: ${e.message}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Point a stream at a node, by `node.name`. */
    async setTarget(streamId, nodeName) {
        await this._runTool(['pw-metadata', String(streamId), 'target.object', nodeName],
            {pkg: 'pipewire-bin', timeoutMs: 5000});
    }

    /** Remove a manual target so the stream follows the default node again. */
    async clearTarget(streamId) {
        await this._runTool(['pw-metadata', '-d', String(streamId), 'target.object'],
            {pkg: 'pipewire-bin', timeoutMs: 5000});
        await this._runTool(['pw-metadata', '-d', String(streamId), 'target.node'],
            {pkg: 'pipewire-bin', timeoutMs: 5000});
    }

    /** Switch a card (by `device.name`) to a different profile. */
    async setProfile(deviceName, profileName) {
        await this._runTool(['pactl', 'set-card-profile', deviceName, profileName],
            {pkg: 'pulseaudio-utils', timeoutMs: 5000});
    }

    async setDefaultSink(nodeName) {
        await this._runTool(['pactl', 'set-default-sink', nodeName],
            {pkg: 'pulseaudio-utils', timeoutMs: 3000});
    }

    async setDefaultSource(nodeName) {
        await this._runTool(['pactl', 'set-default-source', nodeName],
            {pkg: 'pulseaudio-utils', timeoutMs: 3000});
    }

    /**
     * Resolve once a refreshed snapshot satisfies `predicate`.
     * @param {(snapshot: object) => boolean} predicate
     * @param {number} timeoutMs
     * @param {Gio.Cancellable|null} cancellable
     * @returns {Promise<object>}
     */
    waitFor(predicate, timeoutMs = 10000, cancellable = null) {
        return new Promise((resolve, reject) => {
            let settled = false;
            let signalId = null;
            let timeoutSource = null;
            let pollSource = null;
            let cancelId = null;

            const cleanup = () => {
                if (signalId !== null) {
                    this.disconnect(signalId);
                    signalId = null;
                }
                if (timeoutSource !== null) {
                    GLib.source_remove(timeoutSource);
                    timeoutSource = null;
                }
                if (pollSource !== null) {
                    GLib.source_remove(pollSource);
                    pollSource = null;
                }
                if (cancelId !== null) {
                    cancellable.disconnect(cancelId);
                    cancelId = null;
                }
                this._waiters.delete(fail);
            };
            const finish = (fn, arg) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                fn(arg);
            };
            const fail = error => finish(reject, error);

            this._waiters.add(fail);

            signalId = this.connect('changed', (_obj, snapshot) => {
                if (predicate(snapshot))
                    finish(resolve, snapshot);
            });

            // Nothing guarantees a `changed` signal: the preferences process
            // has no mixer events, and a state that matches the previous
            // fingerprint never emits. Poll until the predicate holds, backing
            // off so a long timeout does not run pw-dump dozens of times.
            let pollDelay = POLL_INTERVAL_MS;
            const poll = () => {
                pollSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, pollDelay, () => {
                    pollSource = null;
                    pollDelay = Math.min(pollDelay * 2, MAX_POLL_INTERVAL_MS);
                    this.refresh().then(snapshot => {
                        if (predicate(snapshot))
                            finish(resolve, snapshot);
                    }).catch(() => {});
                    if (!settled)
                        poll();
                    return GLib.SOURCE_REMOVE;
                });
            };
            poll();

            if (timeoutMs > 0) {
                timeoutSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                    timeoutSource = null;
                    finish(reject, new Error('timed out waiting for PipeWire state'));
                    return GLib.SOURCE_REMOVE;
                });
            }

            if (cancellable) {
                if (cancellable.is_cancelled()) {
                    finish(reject, new Error('cancelled'));
                    return;
                }
                // g_cancellable_disconnect() blocks until the handler has
                // returned, so tearing down from inside it deadlocks the
                // main loop. Hand the teardown to the next idle instead.
                cancelId = cancellable.connect(() => {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        finish(reject, new Error('cancelled'));
                        return GLib.SOURCE_REMOVE;
                    });
                });
            }

            this.refresh(cancellable).then(snapshot => {
                if (predicate(snapshot))
                    finish(resolve, snapshot);
            }).catch(e => finish(reject, e));
        });
    }

    destroy() {
        if (this._refreshSource !== null) {
            GLib.source_remove(this._refreshSource);
            this._refreshSource = null;
        }
        this._cancellable.cancel();
        for (const fail of [...this._waiters])
            fail(new Error('PipeWire backend destroyed'));
        this._waiters.clear();
    }
});
