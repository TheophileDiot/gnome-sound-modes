import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {warn} from './log.js';

const BLUEZ_NAME = 'org.bluez';
const DEVICE_IFACE = 'org.bluez.Device1';
const CONNECT_TIMEOUT_MS = 20000;

const A2DP_UUIDS = new Set([
    '0000110b-0000-1000-8000-00805f9b34fb', // AudioSink
]);
const HFP_UUIDS = new Set([
    '0000111e-0000-1000-8000-00805f9b34fb', // Handsfree
    '0000111f-0000-1000-8000-00805f9b34fb', // HandsfreeAG
]);

const DEVICE_PROPS = ['Address', 'Alias', 'Name', 'Connected', 'Paired', 'UUIDs'];
const RELEVANT_PROPS = new Set(DEVICE_PROPS);

Gio._promisify(Gio.DBusObjectManagerClient, 'new', 'new_finish');
Gio._promisify(Gio.DBusProxy.prototype, 'call', 'call_finish');

function matchesUuid(uuids, set) {
    return (uuids ?? []).some(uuid => set.has(String(uuid).toLowerCase()));
}

/** True when a device's UUID list advertises the A2DP AudioSink profile. */
export function hasA2dpProfile(uuids) {
    return matchesUuid(uuids, A2DP_UUIDS);
}

/** True when a device's UUID list advertises a Handsfree (HFP) profile. */
export function hasHfpProfile(uuids) {
    return matchesUuid(uuids, HFP_UUIDS);
}

/** True when a device's UUID list advertises an A2DP or HFP audio profile. */
export function hasAudioProfile(uuids) {
    return hasA2dpProfile(uuids) || hasHfpProfile(uuids);
}

/** Normalise a BlueZ address (`AA:BB:..`) or object path (`.../dev_AA_BB_..`) to `AA:BB:..`. */
export function normalizeAddress(value) {
    const basename = value.includes('/') ? value.slice(value.lastIndexOf('/') + 1) : value;
    const stripped = basename.startsWith('dev_') ? basename.slice(4) : basename;
    return stripped.replace(/_/g, ':').toUpperCase();
}

/** Build a device record from a plain props object (as returned by BlueZ's GetAll). */
export function buildDevice(path, props) {
    return {
        path,
        address: props.Address ? normalizeAddress(props.Address) : normalizeAddress(path),
        alias: props.Alias || props.Name || '',
        connected: props.Connected === true,
        paired: props.Paired === true,
        audio: hasAudioProfile(props.UUIDs),
        hfp: hasHfpProfile(props.UUIDs),
        a2dp: hasA2dpProfile(props.UUIDs),
    };
}

function proxyProps(iface) {
    const props = {};
    for (const key of DEVICE_PROPS)
        props[key] = iface.get_cached_property(key)?.deep_unpack() ?? null;
    return props;
}

/**
 * Watches BlueZ devices over the system bus. `available` stays false and
 * `devices` stays empty when BlueZ is not running, without throwing.
 */
export const Bluetooth = GObject.registerClass({
    Signals: {'changed': {}},
}, class Bluetooth extends GObject.Object {
    _init() {
        super._init();
        this._manager = null;
        this._handlerIds = [];
        this._destroyed = false;
    }

    /** Connects to the system bus and starts watching `org.bluez`. */
    async init() {
        let manager;
        try {
            manager = await Gio.DBusObjectManagerClient.new(
                Gio.DBus.system, Gio.DBusObjectManagerClientFlags.NONE,
                BLUEZ_NAME, '/', null, null);
        } catch (e) {
            warn('bluez unavailable:', e.message);
            this._manager = null;
            return;
        }

        // destroy() may have run while the bus call was in flight.
        if (this._destroyed)
            return;
        this._manager = manager;

        this._handlerIds = [
            this._manager.connect('interface-added',
                (manager, object, iface) => this._onInterfaceChanged(iface)),
            this._manager.connect('interface-removed',
                (manager, object, iface) => this._onInterfaceChanged(iface)),
            this._manager.connect('interface-proxy-properties-changed',
                (manager, object, iface, changed) => this._onPropertiesChanged(iface, changed)),
        ];
    }

    _onInterfaceChanged(iface) {
        if (iface.get_interface_name() === DEVICE_IFACE)
            this.emit('changed');
    }

    _onPropertiesChanged(iface, changed) {
        if (iface.get_interface_name() !== DEVICE_IFACE)
            return;
        const keys = Object.keys(changed.recursiveUnpack());
        if (keys.some(key => RELEVANT_PROPS.has(key)))
            this.emit('changed');
    }

    /** True once BlueZ owns its bus name; false when it is not installed or not running. */
    get available() {
        return this._manager !== null && this._manager.get_name_owner() !== null;
    }

    /** Current `org.bluez.Device1` devices, or `[]` when BlueZ is unavailable. */
    get devices() {
        if (!this._manager)
            return [];
        const devices = [];
        for (const object of this._manager.get_objects()) {
            const iface = object.get_interface(DEVICE_IFACE);
            if (iface)
                devices.push(buildDevice(object.get_object_path(), proxyProps(iface)));
        }
        return devices;
    }

    /** Look up a device by address (or BlueZ object path). */
    find(address) {
        const target = normalizeAddress(address);
        return this.devices.find(device => device.address === target) ?? null;
    }

    _findProxy(address) {
        if (!this._manager)
            return null;
        const target = normalizeAddress(address);
        for (const object of this._manager.get_objects()) {
            const iface = object.get_interface(DEVICE_IFACE);
            const addr = iface?.get_cached_property('Address')?.deep_unpack();
            if (addr && normalizeAddress(addr) === target)
                return iface;
        }
        return null;
    }

    /** Calls `Device1.Connect()` and resolves once `Connected` turns true (20s timeout). */
    async connectDevice(address, cancellable = null) {
        const iface = this._findProxy(address);
        if (!iface)
            throw new Error(`bluetooth device not found: ${address}`);
        if (iface.get_cached_property('Connected')?.deep_unpack() === true)
            return;
        await iface.call('Connect', null, Gio.DBusCallFlags.NONE, -1, cancellable);
        await this._waitConnected(iface, cancellable);
    }

    _waitConnected(iface, cancellable) {
        return new Promise((resolve, reject) => {
            if (iface.get_cached_property('Connected')?.deep_unpack() === true) {
                resolve();
                return;
            }
            if (cancellable?.is_cancelled()) {
                reject(new Error('bluetooth connect cancelled'));
                return;
            }

            let timeoutId = 0;
            let signalId = 0;
            let cancelId = 0;

            const cleanup = () => {
                if (timeoutId) {
                    GLib.source_remove(timeoutId);
                    timeoutId = 0;
                }
                if (signalId) {
                    iface.disconnect(signalId);
                    signalId = 0;
                }
                if (cancelId) {
                    cancellable.disconnect(cancelId);
                    cancelId = 0;
                }
            };

            signalId = iface.connect('g-properties-changed', (proxy, changedVariant) => {
                if (changedVariant.recursiveUnpack().Connected === true) {
                    cleanup();
                    resolve();
                }
            });

            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CONNECT_TIMEOUT_MS, () => {
                timeoutId = 0;
                cleanup();
                reject(new Error('timed out waiting for bluetooth connection'));
                return GLib.SOURCE_REMOVE;
            });

            if (cancellable) {
                // g_cancellable_disconnect() blocks until the handler has
                // returned, so the cleanup cannot run inside it.
                cancelId = cancellable.connect(() => {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        cleanup();
                        reject(new Error('bluetooth connect cancelled'));
                        return GLib.SOURCE_REMOVE;
                    });
                });
            }
        });
    }

    /** Calls `Device1.Disconnect()`. */
    async disconnectDevice(address) {
        const iface = this._findProxy(address);
        if (!iface)
            throw new Error(`bluetooth device not found: ${address}`);
        await iface.call('Disconnect', null, Gio.DBusCallFlags.NONE, -1, null);
    }

    destroy() {
        this._destroyed = true;
        for (const id of this._handlerIds)
            this._manager?.disconnect(id);
        this._handlerIds = [];
        this._manager = null;
    }
});
