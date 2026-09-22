import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {parseSnapshot} from '../lib/snapshot.js';
import {createMode} from '../lib/model.js';
import {buildPlan, evaluateMode} from '../lib/plan.js';
import {captureMatch} from '../lib/matching.js';

function assert(cond, msg) {
    if (!cond)
        throw new Error(`assertion failed: ${msg}`);
}

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const [, bytes] = Gio.File.new_for_path(`${here}/fixtures/pw-dump-airpods-tonor-discord.json`).load_contents(null);
const fixture = JSON.parse(new TextDecoder().decode(bytes));
const snapshot = parseSnapshot(fixture);

const airpods = snapshot.devices.find(d => d.name === 'bluez_card.AA_BB_CC_DD_EE_FF');
const tonor = snapshot.devices.find(d => d.name.startsWith('alsa_card.usb-TONOR'));
const builtin = snapshot.devices.find(d => d.name === 'alsa_card.pci-0000_00_1f.3');

const fullCaps = {
    easyeffects: {installed: true, running: false, canLoadPreset: true, canSetProcessAll: true},
    bluetooth: true,
};

// --- "Video Call" mode: AirPods a2dp-sink-sbc_xq output + TONOR input + calls-scope effects ---

const videoCallSnapshot = {
    ...snapshot,
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

const noEffectsCapsEarly = {
    easyeffects: {installed: false, running: false, canLoadPreset: false, canSetProcessAll: false},
    bluetooth: true,
};

const plan = buildPlan(videoCall, videoCallSnapshot, fullCaps);

assert(plan.missing.length === 0, 'both slots resolve, nothing missing');
assert(plan.resolved.output.device.id === airpods.id, 'output resolves to the AirPods device');
assert(plan.resolved.output.endpoint.name === 'bluez_output.AA_BB_CC_DD_EE_FF.1', 'output endpoint is the bluez sink');
assert(plan.resolved.input.device.id === tonor.id, 'input resolves to the TONOR device');
assert(plan.resolved.input.endpoint.name.startsWith('alsa_input.usb-TONOR'), 'input endpoint is the TONOR mic');

const kinds = plan.steps.map(s => s.kind);
assert(kinds.join(',') === [
    'profile', 'default-sink', 'default-source',
    'effects-start', 'effects-preset', 'effects-preset', 'effects-process-all', 'routing',
].join(','), `steps are in the right order, got: ${kinds.join(',')}`);

const [profileStep, sinkStep, sourceStep, startStep, presetA, presetB, processAllStep, routingStep] = plan.steps;
assert(profileStep.args.deviceName === airpods.name && profileStep.args.profile === 'a2dp-sink-sbc_xq',
    'profile step targets the AirPods device');
assert(profileStep.critical === true, 'profile step is critical on a bluez device');
assert(sinkStep.args.nodeName === 'bluez_output.AA_BB_CC_DD_EE_FF.1' && sinkStep.critical === true,
    'default-sink step is critical and targets the resolved endpoint');
assert(sourceStep.args.nodeName.startsWith('alsa_input.usb-TONOR') && sourceStep.critical === true,
    'default-source step is critical and targets the resolved endpoint');
assert(startStep.critical === false && startStep.timeoutMs === 8000, 'effects-start is non-critical');
assert(presetA.args.kind === 'output' && presetA.args.name === 'Calls Output' && presetA.critical === false,
    'output preset step');
assert(presetB.args.kind === 'input' && presetB.args.name === 'Calls Input' && presetB.critical === false,
    'input preset step');
assert(processAllStep.args.outputs === false && processAllStep.args.inputs === false,
    'process-all reflects the calls scope, not all');
assert(routingStep.args.scope === 'calls' && routingStep.critical === false, 'routing step is last and non-critical');
for (const step of plan.steps)
    assert(typeof step.label === 'string' && step.label.length > 0, `step ${step.kind} has a label`);

// --- Bluetooth device absent: bt-connect plus deferred profile/default steps ---

const missingBtMode = createMode({
    name: 'Missing Headset',
    output: {match: {'api.bluez5.address': '11:22:33:44:55:66'}, profile: 'a2dp-sink'},
});

const btPlan = buildPlan(missingBtMode, snapshot, fullCaps);
assert(btPlan.resolved.output === null, 'output stays unresolved until the device reconnects');
assert(btPlan.missing.length === 1 && btPlan.missing[0].slot === 'output' && btPlan.missing[0].bluetooth === true,
    'missing entry flags that a bluetooth connect is possible');
assert(btPlan.steps.map(s => s.kind).join(',') === 'bt-connect,profile,default-sink',
    'bt-connect is followed by deferred profile and default-sink steps');
assert(btPlan.steps[0].args.address === '11:22:33:44:55:66' && btPlan.steps[0].critical === true &&
    btPlan.steps[0].timeoutMs === 15000, 'bt-connect step carries the address and is critical');
assert(btPlan.steps[1].args.deferred.match['api.bluez5.address'] === '11:22:33:44:55:66',
    'deferred profile step carries the original match for later resolution');
assert(btPlan.steps[2].args.deferred.direction === 'output', 'deferred default-sink step records the direction');

// without bluetooth capability, there is no bt-connect step and the slot is simply missing;
// the match still names a bluez address, so "could connect" stays true for the UI's benefit
const noBtPlan = buildPlan(missingBtMode, snapshot, {...fullCaps, bluetooth: false});
assert(noBtPlan.steps.length === 0, 'no steps are queued when bluetooth is unavailable');
assert(noBtPlan.missing[0].bluetooth === true, 'missing entry still reports the match as bluetooth-capable');

// a non-bluetooth match that cannot be found at all is missing with bluetooth: false
const missingAlsaMode = createMode({
    name: 'Missing Mic', input: {match: {'device.serial': 'does-not-exist'}, profile: null},
});
const missingAlsaPlan = buildPlan(missingAlsaMode, snapshot, fullCaps);
assert(missingAlsaPlan.steps.length === 0, 'no steps for an unresolvable, non-bluetooth slot');
assert(missingAlsaPlan.missing[0].bluetooth === false, 'missing entry reports no bluetooth path for a plain device');

// fallback device is used when the primary cannot be resolved and bluetooth does not apply
const fallbackMode = createMode({
    name: 'Fallback',
    output: {match: {'device.serial': 'does-not-exist'}, profile: null},
    fallback: {output: {match: {'device.name': builtin.name}}},
});
const fallbackPlan = buildPlan(fallbackMode, videoCallSnapshot, fullCaps);
assert(fallbackPlan.missing.length === 0, 'fallback resolution means the slot is not missing');
assert(fallbackPlan.resolved.output.device.id === builtin.id && fallbackPlan.resolved.output.fallbackUsed === true,
    'resolved output uses the fallback device and is flagged as such');
assert(!fallbackPlan.steps.some(s => s.kind === 'profile'), 'fallback slots never carry a profile step');

// --- a bluez node's trailing index is part of its name, not a collision suffix ---

// After an A2DP <-> HFP switch the sink node comes back as .0 instead of .1,
// so the default must be set again even though the names only differ by index.
const afterProfileSwitch = {
    ...snapshot,
    endpoints: snapshot.endpoints.map(e =>
        (e.name === 'bluez_output.AA_BB_CC_DD_EE_FF.1' ? {...e, name: 'bluez_output.AA_BB_CC_DD_EE_FF.0'} : e)),
    defaults: {...snapshot.defaults, configuredSink: 'bluez_output.AA_BB_CC_DD_EE_FF.1'},
};
const reindexed = buildPlan(createMode({
    name: 'AirPods',
    output: {match: {'api.bluez5.address': airpods.bluezAddress}, profile: null},
}), afterProfileSwitch, noEffectsCapsEarly);
const sinkSteps = reindexed.steps.filter(s => s.kind === 'default-sink');
assert(sinkSteps.length === 1, 'a node index change still needs a default-sink step');
assert(sinkSteps[0].args.nodeName === 'bluez_output.AA_BB_CC_DD_EE_FF.0',
    'the step targets the node as it is named now');

// --- evaluateMode: already matching snapshot is "ok" ---

const alreadySet = createMode({
    name: 'Already Set',
    output: {match: {'api.bluez5.address': airpods.bluezAddress}, profile: airpods.activeProfile},
});
const noEffectsCaps = {
    easyeffects: {installed: false, running: false, canLoadPreset: false, canSetProcessAll: false},
    bluetooth: true,
};
const evalOk = evaluateMode(alreadySet, snapshot, noEffectsCaps);
assert(evalOk.state === 'ok', 'a mode that already matches the snapshot evaluates to ok');
assert(evalOk.drift.length === 0, 'no drift when nothing needs to change');
assert(evalOk.missing.length === 0, 'nothing missing');

const driftMode = createMode({
    name: 'Needs Profile Switch',
    output: {match: {'api.bluez5.address': airpods.bluezAddress}, profile: 'a2dp-sink-sbc_xq'},
});
const evalDegraded = evaluateMode(driftMode, snapshot, noEffectsCaps);
assert(evalDegraded.state === 'degraded', 'a needed critical step evaluates to degraded');
assert(evalDegraded.drift.includes('profile'), 'drift names the profile kind');

const evalMissing = evaluateMode(missingBtMode, snapshot, {...fullCaps, bluetooth: false});
assert(evalMissing.state === 'missing', 'an unresolvable slot evaluates to missing');

// --- Present headset without a microphone endpoint: profile first, no bt-connect
{
    const card = snapshot.devices.find(d => d.api === 'bluez5');
    const a2dpCard = {...card, activeProfile: 'a2dp-sink'};
    const noSource = {
        ...snapshot,
        devices: snapshot.devices.map(d => (d === card ? a2dpCard : d)),
        endpoints: snapshot.endpoints.filter(e => !(e.deviceId === card.id && e.direction === 'input')),
    };
    const callMode = createMode({name: 'Headset', output: {match: captureMatch(card), profile: 'headset-head-unit-msbc'},
        input: {match: captureMatch(card), profile: 'headset-head-unit-msbc'}});
    const p = buildPlan(callMode, noSource, fullCaps);
    const kinds = p.steps.map(s => s.kind);
    assert(!kinds.includes('bt-connect'), 'a present card never triggers bt-connect');
    assert(kinds.filter(k => k === 'profile').length === 1, 'one profile step for both slots of the same card');
    assert(p.steps.find(s => s.kind === 'profile').args.deviceName === card.name, 'profile step targets the present card');
    const src = p.steps.find(s => s.kind === 'default-source');
    assert(src && src.args.nodeName === null && src.args.deferred.direction === 'input', 'default-source deferred until the profile switch');
    assert(p.missing.length === 0, 'nothing reported missing');
}
print('test-plan: all checks passed');
