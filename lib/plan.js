// Turns a mode plus a live snapshot into an ordered list of actions, and
// compares a mode's desired state against the snapshot. Pure: the switcher
// executes the steps this produces, it doesn't run anything itself.

import {findDevice, resolveEndpoint, resolveProfile} from './matching.js';

const SLOTS = [
    {name: 'output', direction: 'output', defaultKind: 'default-sink', configuredKey: 'configuredSink'},
    {name: 'input', direction: 'input', defaultKind: 'default-source', configuredKey: 'configuredSource'},
];

// Node names are compared as-is: the trailing `.N` of a bluez node is the
// profile index, not a collision suffix, and it changes with every A2DP/HFP
// switch. Only device.name matching strips suffixes.
function differs(nodeName, configured) {
    return nodeName !== (configured ?? '');
}

function resolveSlot(mode, snapshot, caps, slotDef, missing, warnings) {
    const slot = mode[slotDef.name];
    if (!slot)
        return null;

    const found = resolveEndpoint(slot, slotDef.direction, snapshot);
    if (found) {
        return {
            slotDef, device: found.device, endpoint: found.endpoint, profile: slot.profile,
            deferred: null,
        };
    }

    // The card is here but has no endpoint in this direction yet: a Bluetooth
    // headset in A2DP has no microphone until its profile changes. Switch the
    // profile first and resolve the endpoint afterwards.
    const present = findDevice(slot.match, snapshot);
    if (present && slot.profile) {
        return {
            slotDef, device: present.device, endpoint: null, profile: slot.profile,
            deferred: {match: slot.match, direction: slotDef.direction},
        };
    }
    if (present) {
        warnings.push(`${slotDef.name}: ${present.device.description} has no ${slotDef.direction} in its current profile`);
        missing.push({slot: slotDef.name, match: slot.match, bluetooth: false});
        return null;
    }

    const address = slot.match['api.bluez5.address'];
    if (address && mode.bluetooth.connectIfNeeded && caps.bluetooth) {
        missing.push({slot: slotDef.name, match: slot.match, bluetooth: true});
        return {
            slotDef, device: null, endpoint: null, profile: slot.profile, address,
            deferred: {match: slot.match, direction: slotDef.direction},
        };
    }

    const fallback = mode.fallback?.[slotDef.name];
    if (fallback) {
        const fallbackFound = resolveEndpoint({match: fallback.match, profile: null}, slotDef.direction, snapshot);
        if (fallbackFound) {
            warnings.push(`${slotDef.name}: primary device not found, using fallback`);
            return {
                slotDef, device: fallbackFound.device, endpoint: fallbackFound.endpoint,
                profile: null, fallbackUsed: true, deferred: null,
            };
        }
    }

    missing.push({slot: slotDef.name, match: slot.match, bluetooth: Boolean(address)});
    return null;
}

/**
 * Build the ordered list of actions needed to switch to a mode.
 * @param {object} mode
 * @param {object} snapshot
 * @param {{easyeffects: object, bluetooth: boolean}} caps
 * @returns {{steps: object[], resolved: object, missing: object[], warnings: string[]}}
 */
export function buildPlan(mode, snapshot, caps) {
    const missing = [];
    const warnings = [];
    const steps = [];
    let n = 0;
    const push = (kind, args, critical, timeoutMs, label) =>
        steps.push({id: `${kind}-${n++}`, kind, args, critical, timeoutMs, label});

    const states = SLOTS.map(slotDef => resolveSlot(mode, snapshot, caps, slotDef, missing, warnings));

    const connecting = new Set();
    for (const state of states) {
        if (state?.deferred && state.address && !connecting.has(state.address)) {
            connecting.add(state.address);
            push('bt-connect', {address: state.address}, true, 15000, `Connect Bluetooth device ${state.address}`);
        }
    }

    const switching = new Set();
    for (const state of states) {
        if (!state || state.profile == null)
            continue;
        if (state.deferred && !state.device) {
            const key = `${state.address}\n${state.profile}`;
            if (switching.has(key))
                continue;
            switching.add(key);
            push('profile', {profile: state.profile, deferred: state.deferred}, true, 5000,
                `Switch ${state.slotDef.name} profile to ${state.profile}`);
        } else if (switching.has(`${state.device.name}\n${state.profile}`)) {
            continue;
        } else {
            switching.add(`${state.device.name}\n${state.profile}`);
            const choice = resolveProfile(state.device, state.profile);
            if (!choice) {
                warnings.push(`${state.slotDef.name}: profile ${state.profile} not offered by ${state.device.description}`);
                continue;
            }
            if (!choice.exact)
                warnings.push(`${state.slotDef.name}: using ${choice.profile.name} instead of ${state.profile}`);
            if (state.device.activeProfile !== choice.profile.name) {
                push('profile', {deviceName: state.device.name, profile: choice.profile.name},
                    state.device.api === 'bluez5', 5000, `Switch ${state.device.name} to ${choice.profile.name}`);
            }
        }
    }

    for (const state of states) {
        if (!state)
            continue;
        const label = state.slotDef.name === 'output' ? 'default output' : 'default input';
        if (state.deferred) {
            push(state.slotDef.defaultKind, {nodeName: null, deferred: state.deferred}, true, 3000,
                `Set ${label} once connected`);
        } else if (differs(state.endpoint.name, snapshot.defaults[state.slotDef.configuredKey])) {
            push(state.slotDef.defaultKind, {nodeName: state.endpoint.name}, true, 3000,
                `Set ${label} to ${state.endpoint.name}`);
        }
    }

    const effects = mode.effects;
    if (effects.enabled) {
        const ee = caps.easyeffects ?? {};
        if (ee.installed && !ee.running)
            push('effects-start', {}, false, 8000, 'Start EasyEffects');
        if (ee.installed && ee.canLoadPreset) {
            if (effects.outputPreset)
                push('effects-preset', {kind: 'output', name: effects.outputPreset}, false, 5000,
                    `Load output preset "${effects.outputPreset}"`);
            if (effects.inputPreset)
                push('effects-preset', {kind: 'input', name: effects.inputPreset}, false, 5000,
                    `Load input preset "${effects.inputPreset}"`);
        }
        if (ee.installed && ee.canSetProcessAll) {
            push('effects-process-all', {outputs: effects.scope === 'all', inputs: effects.scope === 'all'},
                false, 3000, 'Apply EasyEffects to all streams');
        }
        push('routing', {scope: effects.scope}, false, 1000, `Route streams (${effects.scope})`);
    }

    const resolved = {output: null, input: null};
    for (const state of states) {
        if (!state || state.deferred)
            continue;
        resolved[state.slotDef.name] = {
            device: state.device, endpoint: state.endpoint, profile: state.profile,
            ...(state.fallbackUsed ? {fallbackUsed: true} : {}),
        };
    }

    return {steps, resolved, missing, warnings};
}

/** Step kinds that mean the live setup really differs from the mode. */
export const CRITICAL_KINDS = ['profile', 'default-sink', 'default-source', 'bt-connect'];

/**
 * Compare a mode's desired state against a snapshot.
 * @param {object} mode
 * @param {object} snapshot
 * @param {object} caps
 * @returns {{state: 'ok'|'degraded'|'missing', drift: string[], driftSteps: object[],
 *            missing: object[], resolved: object}}
 */
export function evaluateMode(mode, snapshot, caps) {
    const plan = buildPlan(mode, snapshot, caps);
    const driftSteps = plan.steps.filter(step => CRITICAL_KINDS.includes(step.kind));
    const state = plan.missing.length > 0
        ? 'missing'
        : plan.steps.some(s => s.critical) ? 'degraded' : 'ok';
    return {state, drift: driftSteps.map(step => step.kind), driftSteps,
        missing: plan.missing, resolved: plan.resolved};
}
