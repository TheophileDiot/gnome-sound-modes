import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {parseSnapshot} from '../lib/snapshot.js';
import {createMode, serializeModes} from '../lib/model.js';
import {run} from '../lib/subprocess.js';
import {Controller} from '../lib/controller.js';

function assert(cond, msg) {
    if (!cond)
        throw new Error(`assertion failed: ${msg}`);
}

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const [, bytes] = Gio.File.new_for_path(`${here}/fixtures/pw-dump-airpods-tonor-discord.json`).load_contents(null);
const base = parseSnapshot(JSON.parse(new TextDecoder().decode(bytes)));

const airpods = base.devices.find(d => d.name === 'bluez_card.AA_BB_CC_DD_EE_FF');
const tonor = base.devices.find(d => d.name.startsWith('alsa_card.usb-TONOR'));
const tonorInput = base.endpoints.find(e => e.deviceId === tonor.id && e.direction === 'input');
const builtinSink = 'alsa_output.pci-0000_00_1f.3.analog-stereo';
const builtinSource = 'alsa_input.pci-0000_00_1f.3.analog-stereo';
const airpodsSink = 'bluez_output.AA_BB_CC_DD_EE_FF.1';

const quiet = base.streams.filter(s => s.appBinary !== 'Discord');

function snapshotWith({profile = 'headset-head-unit-msbc', sink = builtinSink, source = builtinSource,
    devices = base.devices, endpoints = base.endpoints, streams = quiet} = {}) {
    return {
        ...base,
        devices: devices.map(d => (d.id === airpods.id ? {...d, activeProfile: profile} : d)),
        endpoints,
        streams,
        defaults: {sink, source, configuredSink: sink, configuredSource: source},
    };
}

const onBuiltin = snapshotWith({});
const withoutAirpods = snapshotWith({
    devices: base.devices.filter(d => d.id !== airpods.id),
    endpoints: base.endpoints.filter(e => e.deviceId !== airpods.id),
    sink: builtinSink,
    source: tonorInput.name,
});

// --- fakes -------------------------------------------------------------

const FakePipeWire = GObject.registerClass({
    Signals: {'changed': {param_types: [GObject.TYPE_JSOBJECT]}},
}, class FakePipeWire extends GObject.Object {
    constructor(snapshot) {
        super();
        this.snapshot = snapshot;
        this.calls = [];
    }

    async refresh() {
        this.emit('changed', this.snapshot);
        return this.snapshot;
    }

    requestRefresh() {
        this.refresh().catch(() => {});
    }

    push(snapshot) {
        this.snapshot = snapshot;
        this.emit('changed', snapshot);
    }

    async setProfile(deviceName, profile) {
        this.calls.push(['setProfile', deviceName, profile]);
        this.snapshot = {
            ...this.snapshot,
            devices: this.snapshot.devices.map(d => (d.name === deviceName ? {...d, activeProfile: profile} : d)),
        };
    }

    async setDefaultSink(nodeName) {
        this.calls.push(['setDefaultSink', nodeName]);
        this.snapshot = {...this.snapshot,
            defaults: {...this.snapshot.defaults, sink: nodeName, configuredSink: nodeName}};
    }

    async setDefaultSource(nodeName) {
        this.calls.push(['setDefaultSource', nodeName]);
        this.snapshot = {...this.snapshot,
            defaults: {...this.snapshot.defaults, source: nodeName, configuredSource: nodeName}};
    }

    async setTarget(streamId, nodeName) {
        this.calls.push(['setTarget', streamId, nodeName]);
    }

    async clearTarget(streamId) {
        this.calls.push(['clearTarget', streamId]);
    }

    waitFor(predicate) {
        this.emit('changed', this.snapshot);
        return predicate(this.snapshot)
            ? Promise.resolve(this.snapshot)
            : Promise.reject(new Error('timed out waiting for PipeWire state'));
    }
});

const FakeSignaller = GObject.registerClass({
    Signals: {'changed': {}},
}, class FakeSignaller extends GObject.Object {
    get available() {
        return true;
    }

    find(address) {
        return address === airpods.bluezAddress ? {address, alias: 'AirPods 4'} : null;
    }
});

const easyeffects = {
    async detect() {
        return {installed: false, canLoadPreset: false, canSetProcessAll: false,
            reason: 'EasyEffects is not installed'};
    },
    isRunning() {
        return false;
    },
};

function sleep(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

async function waitUntil(condition, what, timeoutMs = 5000) {
    const deadline = GLib.get_monotonic_time() + timeoutMs * 1000;
    while (!condition()) {
        if (GLib.get_monotonic_time() > deadline)
            throw new Error(`timed out waiting for ${what}`);
        await sleep(25);
    }
}

let schemaSource = null;

function makeSettings(modes) {
    const schema = schemaSource.lookup('org.gnome.shell.extensions.sound-modes', false);
    const settings = Gio.Settings.new_full(schema, Gio.memory_settings_backend_new(), null);
    settings.set_string('modes', serializeModes(modes));
    return settings;
}

async function makeWorld(modes, snapshot) {
    const settings = makeSettings(modes);
    const pipewire = new FakePipeWire(snapshot);
    const bluetooth = new FakeSignaller();
    const gvc = new FakeSignaller();
    const controller = new Controller(settings, {pipewire, bluetooth, easyeffects, gvc});
    await controller.init();
    return {settings, pipewire, gvc, controller};
}

const builtinCard = builtinSink.replace('alsa_output', 'alsa_card');

// The fixture ships both Discord streams pinned to the EasyEffects nodes.
const pinned = snapshotWith({streams: base.streams});

function builtinMode(name, effects) {
    return createMode({
        name,
        output: {match: {'device.name': builtinCard}, profile: null},
        effects,
    });
}

function clearTargets(pipewire) {
    return pipewire.calls.filter(c => c[0] === 'clearTarget').length;
}

function videoCallMode() {
    return createMode({
        name: 'Video Call',
        icon: 'call-start',
        output: {match: {'api.bluez5.address': airpods.bluezAddress}, profile: 'a2dp-sink-sbc_xq'},
        input: {match: {'device.serial': tonor.deviceSerial}, profile: null},
    });
}

const loop = GLib.MainLoop.new(null, false);

async function main() {
    const tmp = GLib.dir_make_tmp('sound-modes-schemas-XXXXXX');
    const compiled = await run(['glib-compile-schemas', '--targetdir', tmp, `${here}/../schemas`]);
    assert(compiled.ok, `compiled the test schema: ${compiled.stderr}`);
    schemaSource = Gio.SettingsSchemaSource.new_from_directory(tmp, null, false);

    // --- applying a mode ------------------------------------------------

    {
        const mode = videoCallMode();
        const {settings, pipewire, controller} = await makeWorld([mode], onBuiltin);

        assert(controller.status.state === 'idle', 'no active mode means idle');
        assert(controller.status.modes.length === 1 && controller.status.modes[0].available,
            'the mode is listed and available');
        assert(controller.status.output.name.length > 0, 'the current default output is described');

        const result = await controller.apply(mode.id);
        assert(result.ok, `apply succeeded, error: ${result.error?.message}`);
        assert(settings.get_string('active-mode') === mode.id, 'the applied mode is stored');

        const status = controller.status;
        assert(status.state === 'ok', `state is ok after a clean apply, got ${status.state}`);
        assert(status.activeModeId === mode.id && status.modeName === 'Video Call', 'status names the active mode');
        assert(status.output.name === airpods.description, 'the output slot names the resolved device');
        assert(status.output.profileLabel === 'A2DP \u00b7 SBC-XQ',
            `output profile label, got ${status.output.profileLabel}`);
        assert(status.output.codec === 'msbc' || status.output.codec === null,
            'the codec comes from the endpoint');
        assert(status.input.name.length > 0 && status.input.profileLabel === undefined,
            'the input slot only carries a name');
        assert(status.effects === null || status.effects.installed === false, 'EasyEffects is reported as absent');
        assert(status.missing.length === 0 && status.lastError === null, 'nothing missing, no error');
        assert(pipewire.calls.map(c => c[0]).join(',') === 'setProfile,setDefaultSink,setDefaultSource',
            `the backend was driven in plan order, got ${pipewire.calls.map(c => c[0]).join(',')}`);

        controller.destroy();
        pipewire.push(onBuiltin);
        assert(settings.get_string('active-mode') === mode.id, 'a destroyed controller ignores further snapshots');
    }

    // --- the user picks another output in GNOME -------------------------

    {
        const mode = videoCallMode();
        const {settings, pipewire, gvc, controller} = await makeWorld([mode], onBuiltin);
        await controller.apply(mode.id);

        gvc.emit('changed');
        await sleep(10);
        pipewire.push(snapshotWith({profile: 'a2dp-sink-sbc_xq', sink: builtinSink, source: tonorInput.name}));
        assert(settings.get_string('active-mode') === '', 'the mode is dropped instead of being re-applied');
        assert(controller.status.state === 'custom', `state turns custom, got ${controller.status.state}`);
        assert(controller.status.activeModeId === null, 'no mode is active any more');
        controller.destroy();
    }

    // --- a default that moves with no mixer event is drift, not a choice --

    {
        const mode = videoCallMode();
        const {settings, pipewire, controller} = await makeWorld([mode], onBuiltin);
        await controller.apply(mode.id);
        const before = pipewire.calls.length;

        pipewire.push(snapshotWith({profile: 'a2dp-sink-sbc_xq', sink: builtinSink, source: tonorInput.name}));
        assert(settings.get_string('active-mode') === mode.id,
            'without evidence the user did it, the mode is kept');
        assert(controller.status.state === 'degraded', `state is degraded, got ${controller.status.state}`);
        await waitUntil(() => pipewire.calls.length > before, 'the default to be set again');
        controller.destroy();
    }

    // --- a failed apply recovers once the setup matches again -------------

    {
        const mode = videoCallMode();
        const {settings, pipewire, controller} = await makeWorld([mode], onBuiltin);
        settings.set_boolean('reapply-on-reconnect', false);
        await controller.apply(mode.id);

        pipewire.push(onBuiltin);
        const realSetDefaultSource = pipewire.setDefaultSource.bind(pipewire);
        pipewire.setDefaultSource = async () => {
            throw new Error('pactl refused');
        };

        const result = await controller.apply(mode.id);
        assert(result.ok === false, 'the apply failed');
        assert(controller.status.state === 'failed', `state is failed, got ${controller.status.state}`);
        assert(controller.status.lastError.includes('pactl refused'), 'the error is reported');

        pipewire.setDefaultSource = realSetDefaultSource;
        pipewire.push(snapshotWith({profile: 'a2dp-sink-sbc_xq', sink: airpodsSink, source: tonorInput.name}));
        assert(controller.status.state === 'ok', `the failure clears once the setup matches, got ${controller.status.state}`);
        assert(controller.status.lastError === null, 'and the error message goes with it');
        controller.destroy();
    }

    // --- destroy() during init() leaves nothing connected ------------------

    {
        const settings = makeSettings([videoCallMode()]);
        const pipewire = new FakePipeWire(onBuiltin);
        const controller = new Controller(settings, {
            pipewire, bluetooth: new FakeSignaller(), easyeffects, gvc: new FakeSignaller(),
        });
        const pending = controller.init();
        controller.destroy();
        await pending;
        pipewire.push(onBuiltin);
        assert(controller.status === null, 'a controller destroyed mid-init never starts');
    }

    // --- a device disappears, then comes back ---------------------------

    {
        const mode = videoCallMode();
        const {pipewire, controller} = await makeWorld([mode], onBuiltin);
        await controller.apply(mode.id);
        const before = pipewire.calls.length;

        pipewire.push(withoutAirpods);
        assert(controller.status.state === 'missing', `state is missing, got ${controller.status.state}`);
        assert(controller.status.connectable.length === 1 && controller.status.connectable[0].slot === 'output',
            'a disconnected bluetooth device is listed as connectable');
        assert(controller.status.connectable[0].description === 'AirPods 4',
            'and is named after its BlueZ alias');
        assert(controller.status.missing.length === 0, 'it is not counted as missing');
        assert(controller.status.modes[0].available === true,
            'the mode stays selectable: applying it connects the device');
        assert(controller.status.modes[0].connectable.join(',') === 'AirPods 4',
            'the mode summary names what would be connected');

        const nothingLeft = snapshotWith({
            devices: base.devices.filter(d => d.id !== airpods.id && d.id !== tonor.id),
            endpoints: base.endpoints.filter(e => e.deviceId !== airpods.id && e.deviceId !== tonor.id),
        });
        pipewire.push(nothingLeft);
        assert(controller.status.missing.length === 1 && controller.status.missing[0].slot === 'input',
            'a device with no way back is missing');
        assert(controller.status.missing.every(item => typeof item.description === 'string' &&
            item.description.length > 0), 'every missing slot carries a description');
        assert(controller.status.modes[0].available === false, 'and the mode is marked unavailable');

        pipewire.push(onBuiltin);
        assert(controller.status.state === 'degraded', 'a device that came back but needs work is degraded');
        await sleep(400);
        assert(pipewire.calls.length === before, 'the re-apply is debounced, not immediate');

        await waitUntil(() => pipewire.calls.length > before, 'the scheduled re-apply');
        await waitUntil(() => controller.status.state !== 'applying', 'the re-apply to finish');
        assert(controller.status.state === 'ok', `the re-apply fixed the setup, got ${controller.status.state}`);

        const afterReapply = pipewire.calls.length;
        await sleep(1300);
        assert(pipewire.calls.length === afterReapply, 'a successful re-apply is not repeated');
        controller.destroy();
    }

    // --- WirePlumber's headset autoswitch is left alone -----------------

    {
        const mode = videoCallMode();
        const {pipewire, controller} = await makeWorld([mode], onBuiltin);
        await controller.apply(mode.id);
        const before = pipewire.calls.length;

        const onCall = snapshotWith({
            profile: 'headset-head-unit-msbc',
            sink: airpodsSink,
            source: 'bluez_input.AA_BB_CC_DD_EE_FF.0',
            streams: [...quiet, {...base.streams.find(s => s.direction === 'input'),
                id: 9001, target: null, monitor: false, direction: 'input'}],
        });
        pipewire.push(onCall);

        assert(controller.status.state === 'degraded', 'the profile drift shows as degraded');
        assert(controller.status.reason === 'Headset profile in use by a call', 'and explains why it is left alone');
        await sleep(1300);
        assert(pipewire.calls.length === before, 'no re-apply fights the headset autoswitch');
        controller.destroy();
    }

    // --- calls: hysteresis, automatic switch and restore ----------------

    {
        const mode = videoCallMode();
        const callMode = createMode({
            name: 'Calls',
            icon: 'phone',
            output: {match: {'device.name': builtinSink.replace('alsa_output', 'alsa_card')}, profile: null},
            input: {match: {'device.serial': tonor.deviceSerial}, profile: null},
        });
        const {settings, pipewire, controller} = await makeWorld([mode, callMode], onBuiltin);
        await controller.apply(mode.id);

        const events = [];
        controller.connect('call-started', () => events.push('started'));
        controller.connect('call-ended', () => events.push('ended'));
        settings.set_string('call-mode', callMode.id);

        pipewire.push(snapshotWith({profile: 'a2dp-sink-sbc_xq', sink: airpodsSink, source: tonorInput.name,
            streams: base.streams}));
        assert(controller.status.inCall === true, 'the Discord streams put us in a call');
        assert(events.join(',') === 'started', 'call-started fired once');
        assert(controller.status.callApps.some(a => a.key === 'com.discordapp.Discord'), 'the calling app is listed');

        await waitUntil(() => settings.get_string('active-mode') === callMode.id, 'the call mode to be applied');

        pipewire.push(snapshotWith({profile: 'a2dp-sink-sbc_xq', sink: builtinSink, source: tonorInput.name}));
        await sleep(400);
        assert(controller.status.inCall === true, 'the call is held for the hysteresis window');
        assert(events.join(',') === 'started', 'call-ended has not fired yet');

        await waitUntil(() => events.includes('ended'), 'call-ended after the hysteresis window');
        assert(controller.status.inCall === false, 'the call is over');
        await waitUntil(() => settings.get_string('active-mode') === mode.id, 'the previous mode to be restored');
        controller.destroy();
    }

    // --- a fresh controller sweeps EasyEffects targets left behind -------

    {
        const {pipewire, controller} = await makeWorld([builtinMode('Plain')], pinned);
        await waitUntil(() => clearTargets(pipewire) === 2,
            'the stale EasyEffects pins to be cleared on the first snapshot');

        pipewire.push(pinned);
        await sleep(100);
        assert(clearTargets(pipewire) === 2, 'and cleared once, not on every snapshot');
        controller.destroy();
    }

    // --- replacing a calls-scope mode clears its target pins -------------

    {
        const calls = builtinMode('Calls', {enabled: true, scope: 'calls'});
        const off = builtinMode('Plain');
        const {pipewire, controller} = await makeWorld([calls, off], pinned);
        await waitUntil(() => clearTargets(pipewire) === 2, 'the initial sweep');

        assert((await controller.apply(calls.id)).ok, 'the calls-scope mode applies');
        pipewire.push(pinned);
        await sleep(100);
        assert(clearTargets(pipewire) === 2,
            'a calls-scope mode leaves the call streams on the EasyEffects nodes');

        assert((await controller.apply(off.id)).ok, 'the effects-off mode applies');
        await waitUntil(() => clearTargets(pipewire) === 4,
            'both pinned streams to be released when the calls-scope mode is replaced');
        controller.destroy();
    }

    // --- destroy() cancels whatever the backends still have running ------

    {
        let seen = null;
        const recording = {
            async detect(cancellable) {
                seen = cancellable;
                return {installed: false, canLoadPreset: false, canSetProcessAll: false, reason: 'absent'};
            },
            isRunning() {
                return false;
            },
        };
        const controller = new Controller(makeSettings([videoCallMode()]), {
            pipewire: new FakePipeWire(onBuiltin), bluetooth: new FakeSignaller(),
            easyeffects: recording, gvc: new FakeSignaller(),
        });
        await controller.init();
        assert(seen instanceof Gio.Cancellable, 'detect() is handed a cancellable');
        assert(!seen.is_cancelled(), 'which is live while the extension is enabled');
        controller.destroy();
        assert(seen.is_cancelled(), 'and cancelled by destroy(), so no subprocess outlives it');
    }

    // --- switching modes mid-call beats the post-call restore ------------

    {
        const mode = videoCallMode();
        const callMode = builtinMode('Calls');
        const {settings, pipewire, controller} = await makeWorld([mode, callMode], onBuiltin);
        settings.set_string('call-mode', callMode.id);

        pipewire.push(snapshotWith({profile: 'a2dp-sink-sbc_xq', sink: airpodsSink,
            source: tonorInput.name, streams: base.streams}));
        assert(controller.status.inCall === true, 'the Discord streams put us in a call');
        await waitUntil(() => settings.get_string('active-mode') === callMode.id, 'the call mode to be applied');

        assert((await controller.apply(mode.id)).ok, 'the user picks another mode during the call');
        assert(settings.get_string('active-mode') === mode.id, 'which becomes the active mode');

        pipewire.push(snapshotWith({profile: 'a2dp-sink-sbc_xq', sink: airpodsSink, source: tonorInput.name}));
        await waitUntil(() => controller.inCall === false, 'the call to end');
        await sleep(200);
        assert(settings.get_string('active-mode') === mode.id,
            `the mid-call choice survives the call ending, got "${settings.get_string('active-mode')}"`);
        controller.destroy();
    }

    Gio.File.new_for_path(`${tmp}/gschemas.compiled`).delete(null);
    Gio.File.new_for_path(tmp).delete(null);

    print('test-controller: all checks passed');
    loop.quit();
}

main().catch(e => {
    printerr(`test-controller: FAILED: ${e.message}`);
    printerr(e.stack);
    loop.quit();
    imports.system.exit(1);
});
loop.run();
