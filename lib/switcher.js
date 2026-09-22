// Runs the steps a plan produced, verifying each one against a fresh
// snapshot and putting the previous setup back when a critical step fails.

import {findDevice, resolveEndpoint} from './matching.js';
import {findDeviceByName} from './snapshot.js';
import {debug, warn} from './log.js';

function bluetoothReady(snapshot, address) {
    const device = snapshot.devices.find(d => d.bluezAddress === address);
    return Boolean(device) && snapshot.endpoints.some(e => e.deviceId === device.id);
}

/**
 * Apply a plan built by `lib/plan.js`.
 * @param {{steps: object[]}} plan
 * @param {{pipewire: object, bluetooth: object, easyeffects: object, router: object,
 *          caps: object, mode: ?object, overrides: ?object}} ctx
 * @param {{cancellable: ?object, onStep: ?function, rollbackOnCancel: ?function}} [options]
 * @returns {Promise<{ok: boolean, warnings: string[], failedStep: ?object, error: ?Error,
 *                    stepsDone: string[], rolledBack: boolean, cancelled: boolean}>}
 */
export async function runPlan(plan, ctx, {cancellable = null, onStep = null,
    rollbackOnCancel = () => true} = {}) {
    const {pipewire} = ctx;
    const result = {
        ok: true, warnings: [], failedStep: null, error: null,
        stepsDone: [], rolledBack: false, cancelled: false,
    };

    const resolved = new Map();
    const argsOf = step => resolved.get(step.id) ?? step.args;

    let snapshot = pipewire.snapshot ?? null;
    let before = null;
    const touched = {sink: false, source: false};

    const captureBefore = () => {
        if (before)
            return;
        before = {
            configuredSink: snapshot?.defaults.configuredSink ?? null,
            configuredSource: snapshot?.defaults.configuredSource ?? null,
            profiles: {},
        };
    };

    const rememberProfile = deviceName => {
        if (!before || deviceName in before.profiles)
            return;
        before.profiles[deviceName] = findDeviceByName(snapshot, deviceName)?.activeProfile ?? null;
    };

    const resolveDeferred = current => {
        for (const step of plan.steps) {
            const deferred = step.args.deferred;
            if (!deferred || resolved.has(step.id))
                continue;
            if (step.kind === 'profile') {
                const found = findDevice(deferred.match, current);
                if (found)
                    resolved.set(step.id, {...step.args, deviceName: found.device.name});
                continue;
            }
            const slot = {match: deferred.match, profile: null};
            const found = resolveEndpoint(slot, deferred.direction, current);
            if (found)
                resolved.set(step.id, {...step.args, nodeName: found.endpoint.name});
        }
    };

    const perform = async step => {
        const args = argsOf(step);
        switch (step.kind) {
        case 'bt-connect': {
            await ctx.bluetooth.connectDevice(args.address, cancellable);
            const connected = await pipewire.waitFor(
                s => bluetoothReady(s, args.address), step.timeoutMs, cancellable);
            resolveDeferred(connected);
            return connected;
        }
        case 'profile': {
            if (!args.deviceName)
                throw new Error('device did not appear, cannot set its profile');
            rememberProfile(args.deviceName);
            await pipewire.setProfile(args.deviceName, args.profile);
            const switched = await pipewire.waitFor(
                s => findDeviceByName(s, args.deviceName)?.activeProfile === args.profile,
                step.timeoutMs, cancellable);
            resolveDeferred(switched);
            return switched;
        }
        case 'default-sink':
        case 'default-source': {
            if (!args.nodeName)
                throw new Error('device did not appear, cannot make it the default');
            const isSink = step.kind === 'default-sink';
            touched[isSink ? 'sink' : 'source'] = true;
            if (isSink)
                await pipewire.setDefaultSink(args.nodeName);
            else
                await pipewire.setDefaultSource(args.nodeName);
            const key = isSink ? 'configuredSink' : 'configuredSource';
            return pipewire.waitFor(
                s => s.defaults[key] === args.nodeName, step.timeoutMs, cancellable);
        }
        case 'effects-start':
            await ctx.easyeffects.ensureRunning(snapshot);
            return pipewire.waitFor(s => ctx.easyeffects.isRunning(s), step.timeoutMs, cancellable);
        case 'effects-preset':
            await ctx.easyeffects.loadPreset(args.kind, args.name, cancellable);
            return null;
        case 'effects-process-all':
            await ctx.easyeffects.setProcessAll({outputs: args.outputs, inputs: args.inputs});
            return null;
        case 'routing':
            await ctx.router.sync(snapshot, ctx.mode, ctx.overrides);
            return null;
        default:
            throw new Error(`unknown step kind: ${step.kind}`);
        }
    };

    const rollback = async () => {
        if (!before)
            return false;
        for (const [deviceName, profile] of Object.entries(before.profiles)) {
            if (!profile)
                continue;
            try {
                await pipewire.setProfile(deviceName, profile);
            } catch (e) {
                warn(`could not restore profile of ${deviceName}: ${e.message}`);
            }
        }
        if (touched.sink && before.configuredSink) {
            try {
                await pipewire.setDefaultSink(before.configuredSink);
            } catch (e) {
                warn(`could not restore the default output: ${e.message}`);
            }
        }
        if (touched.source && before.configuredSource) {
            try {
                await pipewire.setDefaultSource(before.configuredSource);
            } catch (e) {
                warn(`could not restore the default input: ${e.message}`);
            }
        }
        return true;
    };

    const abort = async (step, error, wasCancelled) => {
        result.ok = false;
        result.failedStep = step;
        result.error = error;
        result.cancelled = wasCancelled;
        // A run cancelled because a newer one took over must not undo what
        // that newer run has already written.
        result.rolledBack = !wasCancelled || rollbackOnCancel() ? await rollback() : false;
        return result;
    };

    for (const step of plan.steps) {
        if (cancellable?.is_cancelled())
            return abort(step, new Error('cancelled'), true);
        if (step.critical)
            captureBefore();

        onStep?.(step, 'running');
        try {
            const next = await perform(step);
            if (next)
                snapshot = next;
            result.stepsDone.push(step.id);
            onStep?.(step, 'done');
            debug(`step ${step.id} done`);
        } catch (e) {
            onStep?.(step, 'failed');
            if (cancellable?.is_cancelled())
                return abort(step, e, true);
            if (!step.critical) {
                result.warnings.push(`${step.label}: ${e.message}`);
                warn(`${step.label}: ${e.message}`);
                continue;
            }
            return abort(step, e, false);
        }
    }

    return result;
}
