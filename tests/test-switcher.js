import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {parseSnapshot} from '../lib/snapshot.js';
import {createMode} from '../lib/model.js';
import {buildPlan} from '../lib/plan.js';
import {runPlan} from '../lib/switcher.js';

function assert(cond, msg) {
    if (!cond)
        throw new Error(`assertion failed: ${msg}`);
}

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const [, bytes] = Gio.File.new_for_path(`${here}/fixtures/pw-dump-airpods-tonor-discord.json`).load_contents(null);
const fixture = JSON.parse(new TextDecoder().decode(bytes));
const base = parseSnapshot(fixture);

const airpods = base.devices.find(d => d.name === 'bluez_card.AA_BB_CC_DD_EE_FF');
const tonor = base.devices.find(d => d.name.startsWith('alsa_card.usb-TONOR'));
const tonorInput = base.endpoints.find(e => e.deviceId === tonor.id && e.direction === 'input');

const onBuiltin = {
    ...base,
    defaults: {
        sink: 'alsa_output.pci-0000_00_1f.3.analog-stereo',
        source: 'alsa_input.pci-0000_00_1f.3.analog-stereo',
        configuredSink: 'alsa_output.pci-0000_00_1f.3.analog-stereo',
        configuredSource: 'alsa_input.pci-0000_00_1f.3.analog-stereo',
    },
};

const videoCall = createMode({
    name: 'Video Call',
    output: {match: {'api.bluez5.address': airpods.bluezAddress}, profile: 'a2dp-sink-sbc_xq'},
    input: {match: {'device.serial': tonor.deviceSerial}, profile: null},
    effects: {enabled: true, scope: 'calls', outputPreset: 'Calls Output', inputPreset: 'Calls Input'},
});

const caps = {
    easyeffects: {installed: true, running: false, canLoadPreset: true, canSetProcessAll: true},
    bluetooth: true,
};

// --- fakes -------------------------------------------------------------

class FakePipeWire {
    constructor(snapshot, calls) {
        this.snapshot = snapshot;
        this.calls = calls;
        this.fail = new Set();
        this.onCall = null;
    }

    _record(name, ...args) {
        this.calls.push([name, ...args]);
        this.onCall?.(name, ...args);
        if (this.fail.has(name))
            return Promise.reject(new Error(`${name} refused`));
        return Promise.resolve();
    }

    setProfile(deviceName, profile) {
        const promise = this._record('setProfile', deviceName, profile);
        this.snapshot = {
            ...this.snapshot,
            devices: this.snapshot.devices.map(d =>
                d.name === deviceName ? {...d, activeProfile: profile} : d),
        };
        return promise;
    }

    setDefaultSink(nodeName) {
        const promise = this._record('setDefaultSink', nodeName);
        this.snapshot = {...this.snapshot, defaults: {...this.snapshot.defaults, configuredSink: nodeName}};
        return promise;
    }

    setDefaultSource(nodeName) {
        const promise = this._record('setDefaultSource', nodeName);
        this.snapshot = {...this.snapshot, defaults: {...this.snapshot.defaults, configuredSource: nodeName}};
        return promise;
    }

    setTarget(streamId, nodeName) {
        return this._record('setTarget', streamId, nodeName);
    }

    clearTarget(streamId) {
        return this._record('clearTarget', streamId);
    }

    waitFor(predicate, _timeoutMs, cancellable) {
        if (cancellable?.is_cancelled())
            return Promise.reject(new Error('cancelled'));
        if (!predicate(this.snapshot))
            return Promise.reject(new Error('timed out waiting for PipeWire state'));
        return Promise.resolve(this.snapshot);
    }
}

function fakeEasyEffects(calls) {
    return {
        running: false,
        isRunning() {
            return this.running;
        },
        async ensureRunning() {
            calls.push(['ensureRunning']);
            this.running = true;
        },
        async loadPreset(kind, name, cancellable) {
            calls.push(['loadPreset', kind, name, cancellable]);
        },
        async setProcessAll(state) {
            calls.push(['setProcessAll', state.outputs, state.inputs]);
        },
    };
}

function makeCtx(snapshot, {connect = null} = {}) {
    const calls = [];
    const pipewire = new FakePipeWire(snapshot, calls);
    const easyeffects = fakeEasyEffects(calls);
    const ctx = {
        pipewire,
        easyeffects,
        bluetooth: {
            async connectDevice(address) {
                calls.push(['connectDevice', address]);
                if (connect)
                    pipewire.snapshot = connect;
            },
        },
        router: {
            async sync(_snapshot, mode) {
                calls.push(['router.sync', mode?.name ?? null]);
                return {moved: 0, cleared: 0};
            },
        },
        caps,
        mode: videoCall,
        overrides: {},
    };
    return {ctx, calls, pipewire};
}

const loop = GLib.MainLoop.new(null, false);

async function main() {
    // --- the whole Video Call plan, in order ---------------------------

    {
        const {ctx, calls} = makeCtx(onBuiltin);
        const plan = buildPlan(videoCall, onBuiltin, caps);
        const seen = [];
        const result = await runPlan(plan, ctx, {onStep: (step, phase) => seen.push(`${step.kind}:${phase}`)});

        assert(result.ok, `plan succeeded, error: ${result.error?.message}`);
        assert(result.warnings.length === 0, 'no warnings on a clean run');
        assert(result.rolledBack === false, 'nothing to roll back');
        assert(result.stepsDone.join(',') === plan.steps.map(s => s.id).join(','), 'every step ran, in order');
        assert(calls.map(c => c[0]).join(',') === [
            'setProfile', 'setDefaultSink', 'setDefaultSource',
            'ensureRunning', 'loadPreset', 'loadPreset', 'setProcessAll', 'router.sync',
        ].join(','), `backend calls in plan order, got: ${calls.map(c => c[0]).join(',')}`);
        assert(calls[0][1] === airpods.name && calls[0][2] === 'a2dp-sink-sbc_xq', 'profile call targets the AirPods');
        assert(calls[1][1] === 'bluez_output.AA_BB_CC_DD_EE_FF.1', 'default sink is the AirPods sink');
        assert(calls[2][1] === tonorInput.name, 'default source is the TONOR mic');
        assert(calls[4][1] === 'output' && calls[4][2] === 'Calls Output', 'output preset loaded');
        assert(calls[7][1] === 'Video Call', 'routing step hands the mode to the router');
        assert(seen[0] === 'profile:running' && seen[1] === 'profile:done', 'onStep reports both phases');
    }

    // --- easyeffects subprocesses run under the run's cancellable -------

    {
        const cancellable = new Gio.Cancellable();
        const {ctx, calls} = makeCtx(onBuiltin);
        const plan = buildPlan(videoCall, onBuiltin, caps);
        const result = await runPlan(plan, ctx, {cancellable});

        assert(result.ok, `plan succeeded, error: ${result.error?.message}`);
        const presets = calls.filter(c => c[0] === 'loadPreset');
        assert(presets.length === 2 && presets.every(c => c[3] === cancellable),
            'every preset load is handed the run cancellable so it dies with disable()');
    }

    // --- a critical failure rolls the previous setup back ---------------

    {
        const {ctx, calls, pipewire} = makeCtx(onBuiltin);
        pipewire.fail.add('setDefaultSource');
        const plan = buildPlan(videoCall, onBuiltin, caps);
        const result = await runPlan(plan, ctx, {});

        assert(result.ok === false, 'a failing critical step fails the run');
        assert(result.rolledBack === true, 'the run reports a rollback');
        assert(result.cancelled === false, 'a failure is not a cancellation');
        assert(result.failedStep.kind === 'default-source', 'the failed step is reported');
        assert(!calls.some(c => c[0] === 'ensureRunning'), 'execution stopped at the failure');

        const restore = calls.slice(calls.findIndex(c => c[0] === 'setDefaultSource') + 1);
        assert(restore[0][0] === 'setProfile' && restore[0][1] === airpods.name &&
            restore[0][2] === 'headset-head-unit-msbc', 'the previous card profile is restored');
        assert(restore.some(c => c[0] === 'setDefaultSink' &&
            c[1] === 'alsa_output.pci-0000_00_1f.3.analog-stereo'), 'the previous default sink is restored');
        assert(restore.some(c => c[0] === 'setDefaultSource' &&
            c[1] === 'alsa_input.pci-0000_00_1f.3.analog-stereo'), 'the previous default source is restored');
    }

    // --- a non-critical failure only warns ------------------------------

    {
        const {ctx, calls} = makeCtx(onBuiltin);
        ctx.easyeffects.loadPreset = async () => {
            throw new Error('no such preset');
        };
        const plan = buildPlan(videoCall, onBuiltin, caps);
        const result = await runPlan(plan, ctx, {});

        assert(result.ok === true, 'a failing preset does not fail the mode');
        assert(result.warnings.length === 2, `both preset failures are warnings, got ${result.warnings.length}`);
        assert(result.warnings[0].includes('no such preset'), 'the warning carries the backend message');
        assert(calls.some(c => c[0] === 'router.sync'), 'later steps still run');
    }

    // --- cancellation rolls back too ------------------------------------

    {
        const cancellable = new Gio.Cancellable();
        const {ctx, calls, pipewire} = makeCtx(onBuiltin);
        pipewire.onCall = name => {
            if (name === 'setDefaultSink')
                cancellable.cancel();
        };
        const plan = buildPlan(videoCall, onBuiltin, caps);
        const result = await runPlan(plan, ctx, {cancellable});

        assert(result.ok === false && result.cancelled === true, 'cancelling stops the run');
        assert(result.rolledBack === true, 'cancelling rolls the previous setup back');
        assert(calls.filter(c => c[0] === 'setProfile').length === 2, 'the card profile is restored after a cancel');
        assert(calls.at(-1)[0] === 'setDefaultSink' &&
            calls.at(-1)[1] === 'alsa_output.pci-0000_00_1f.3.analog-stereo', 'the default sink is restored');
    }

    // --- a superseded run does not undo the run that replaced it --------

    {
        const cancellable = new Gio.Cancellable();
        const {ctx, calls, pipewire} = makeCtx(onBuiltin);
        pipewire.onCall = name => {
            if (name === 'setDefaultSink')
                cancellable.cancel();
        };
        const plan = buildPlan(videoCall, onBuiltin, caps);
        const result = await runPlan(plan, ctx, {cancellable, rollbackOnCancel: () => false});

        assert(result.cancelled === true, 'the run still reports the cancellation');
        assert(result.rolledBack === false, 'but nothing is rolled back');
        assert(calls.filter(c => c[0] === 'setProfile').length === 1, 'the card profile is left as it is');
        assert(!calls.some(c => c[0] === 'setDefaultSink' &&
            c[1] === 'alsa_output.pci-0000_00_1f.3.analog-stereo'), 'the old default is not restored');
    }

    // --- deferred steps are resolved after the bluetooth connect --------

    {
        const withoutAirpods = {
            ...onBuiltin,
            devices: onBuiltin.devices.filter(d => d.id !== airpods.id),
            endpoints: onBuiltin.endpoints.filter(e => e.deviceId !== airpods.id),
        };
        const btMode = createMode({
            name: 'Headset',
            output: {match: {'api.bluez5.address': airpods.bluezAddress}, profile: 'a2dp-sink-sbc_xq'},
        });
        const plan = buildPlan(btMode, withoutAirpods, caps);
        assert(plan.steps.map(s => s.kind).join(',') === 'bt-connect,profile,default-sink',
            'the plan defers the profile and default steps');

        const {ctx, calls} = makeCtx(withoutAirpods, {connect: onBuiltin});
        const result = await runPlan(plan, ctx, {});

        assert(result.ok, `the deferred plan succeeded, error: ${result.error?.message}`);
        assert(calls[0][0] === 'connectDevice' && calls[0][1] === airpods.bluezAddress, 'the device is connected first');
        assert(calls[1][0] === 'setProfile' && calls[1][1] === airpods.name,
            'the deferred profile step learned the device name');
        assert(calls[2][0] === 'setDefaultSink' && calls[2][1] === 'bluez_output.AA_BB_CC_DD_EE_FF.1',
            'the deferred default-sink step learned the endpoint name');
        assert(plan.steps[1].args.deviceName === undefined, 'the plan itself is left untouched');
    }

    // --- a deferred step that never resolves is a critical failure -------

    {
        const withoutAirpods = {
            ...onBuiltin,
            devices: onBuiltin.devices.filter(d => d.id !== airpods.id),
            endpoints: onBuiltin.endpoints.filter(e => e.deviceId !== airpods.id),
        };
        const btMode = createMode({
            name: 'Headset',
            output: {match: {'api.bluez5.address': airpods.bluezAddress}, profile: 'a2dp-sink-sbc_xq'},
        });
        const plan = buildPlan(btMode, withoutAirpods, caps);
        const {ctx} = makeCtx(withoutAirpods);
        const result = await runPlan(plan, ctx, {});

        assert(result.ok === false, 'a device that never shows up fails the run');
        assert(result.failedStep.kind === 'bt-connect', 'the bluetooth step is where it fails');
    }

    print('test-switcher: all checks passed');
    loop.quit();
}

main().catch(e => {
    printerr(`test-switcher: FAILED: ${e.message}`);
    printerr(e.stack);
    loop.quit();
    imports.system.exit(1);
});
loop.run();
