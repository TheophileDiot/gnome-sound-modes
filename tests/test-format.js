// ui/format.js is pure JS: no gi:// imports, no shell. Only
// String.prototype.format is missing outside the shell process.

import {effectsLine, headsetInCall, isolate, modeName, nameList, outputLine, statusLine} from '../ui/format.js';

if (!String.prototype.format) {
    Object.defineProperty(String.prototype, 'format', {
        value(...args) {
            let i = 0;
            return this.replace(/%[sd]/g, () => String(args[i++]));
        },
    });
}

function assert(cond, msg) {
    if (!cond)
        throw new Error(`assertion failed: ${msg}`);
}

const _ = s => s;
const ngettext = (single, plural, n) => (n === 1 ? single : plural);
const iso = t => `⁨${t}⁩`;

function status(extra = {}) {
    return {
        state: 'ok', modeName: 'Video Call', errorKind: null, reason: null,
        missing: [], output: null, effects: null, inCall: false, ...extra,
    };
}

// --- isolate / nameList -------------------------------------------------

assert(isolate('AirPods') === iso('AirPods'), 'isolate wraps in the bidi isolate pair');
assert(nameList(['A', 'B'], _) === `${iso('A')}, ${iso('B')}`, 'nameList isolates each name');
assert(nameList([], _) === '', 'an empty list formats to nothing');

// --- headsetInCall ------------------------------------------------------

assert(headsetInCall(status({reason: 'Headset profile in use by a call'})), 'the headset reason is recognised');
assert(!headsetInCall(status({reason: 'something else'})), 'any other reason is not');

// --- statusLine: applying and the headset case beat everything else -----

assert(statusLine(status({state: 'applying'}), _, ngettext) === 'Switching sound mode…',
    'applying wins over the rest');
assert(statusLine(status({state: 'failed', reason: 'Headset profile in use by a call'}), _, ngettext)
    === 'Headset is in a call. Audio quality is unchanged.',
    'the headset explanation wins over a failure');

// --- statusLine: every failure kind -------------------------------------

const failures = {
    'bt-connect': 'The Bluetooth device did not connect. Turn it on and try again.',
    'profile': 'Audio quality could not be changed. Close apps using the headset and try again.',
    'default-sink': 'The audio device could not be selected. Check its connection and try again.',
    'default-source': 'The audio device could not be selected. Check its connection and try again.',
    'effects-start': 'EasyEffects could not start. Open EasyEffects and try again.',
    'effects-preset': 'An effects preset could not be loaded. Check your presets in EasyEffects and try again.',
    'effects-process-all': 'Effects could not be applied to all audio. Check EasyEffects and try again.',
    'routing': 'Call audio could not be routed. Check your audio devices and try again.',
};
for (const [kind, expected] of Object.entries(failures)) {
    assert(statusLine(status({state: 'failed', errorKind: kind}), _, ngettext) === expected,
        `failure kind ${kind} has its own message`);
}
assert(statusLine(status({state: 'failed', errorKind: null}), _, ngettext)
    === 'Could not switch modes. Check your devices and try again.', 'an unknown failure falls back');
assert(statusLine(status({state: 'failed', errorKind: 'nonsense'}), _, ngettext)
    === 'Could not switch modes. Check your devices and try again.', 'so does an unrecognised kind');
assert(statusLine(status({state: 'failed', errorKind: 'routing'}), _, ngettext, 'bt-connect')
    === failures['bt-connect'], 'an explicit failureKind overrides status.errorKind');

// --- statusLine: missing devices use ngettext ---------------------------

assert(statusLine(status({state: 'missing', missing: [{slot: 'output'}]}), _, ngettext) === '1 device missing',
    'one missing device is singular');
assert(statusLine(status({state: 'missing', missing: [{slot: 'output'}, {slot: 'input'}]}), _, ngettext)
    === '2 devices missing', 'two missing devices use the plural form');
assert(statusLine(status({state: 'missing'}), _, ngettext) === 'A device is unavailable. Check its connection.',
    'a missing state with nothing listed falls back to prose');

// --- statusLine: degraded ------------------------------------------------

assert(statusLine(status({state: 'degraded', reason: 'Card is busy'}), _, ngettext) === iso('Card is busy'),
    'a degraded reason is shown, isolated');
assert(statusLine(status({state: 'degraded'}), _, ngettext) === 'Audio settings changed outside Sound Modes.',
    'degraded with no reason explains the drift');

// --- statusLine: the ok path describes the output ------------------------

assert(statusLine(status({output: {name: 'AirPods', profileLabel: 'A2DP'}}), _, ngettext)
    === `${iso('AirPods')} (${iso('A2DP')})`, 'a profile label is appended');
assert(statusLine(status({output: {name: 'AirPods', profileLabel: null}}), _, ngettext) === iso('AirPods'),
    'without a profile label only the name is shown');
assert(statusLine(status(), _, ngettext) === 'No output selected', 'no output at all says so');

// --- effectsLine ---------------------------------------------------------

assert(effectsLine(status(), _) === 'Off', 'no effects block is off');
assert(effectsLine(status({effects: {scope: null}}), _) === 'Off', 'a null scope is off too');
assert(effectsLine(status({effects: {scope: 'all', installed: false}}), _)
    === 'Not installed', 'a missing install is reported');
assert(effectsLine(status({effects: {scope: 'all', installed: true, running: false}}), _)
    === 'Not running', 'a stopped EasyEffects is reported');
assert(effectsLine(status({effects: {scope: 'calls', installed: true, running: true}}), _) === 'Calls only',
    'the calls scope is named');
assert(effectsLine(status({effects: {scope: 'all', installed: true, running: true}}), _) === 'All audio',
    'the all scope is named');

// --- outputLine ----------------------------------------------------------

assert(outputLine(status({output: {name: 'AirPods'}}), _) === iso('AirPods'), 'the output name is isolated');
assert(outputLine(status(), _) === 'None', 'no output reads None');

// --- modeName ------------------------------------------------------------

assert(modeName(status(), _) === iso('Video Call'), 'an active mode is named');
assert(modeName(status({state: 'custom'}), _) === 'Custom', 'the custom state is Custom');
assert(modeName(status({state: 'idle'}), _) === 'Custom', 'so is idle');
assert(modeName(status({modeName: null}), _) === 'Custom', 'and so is a state with no mode name');


for (const [installed, hint] of [
    [false, 'EasyEffects is not installed. Install it to use effects.'],
    [true, 'EasyEffects is not running. Open it to use effects.'],
]) {
    const effects = {scope: 'all', installed, running: false};
    assert(statusLine(status({state: 'degraded', effects}), _, ngettext) === hint,
        'degraded effects get an actionable header hint');
    assert(statusLine(status({effects}), _, ngettext) === 'No output selected',
        'healthy status does not show an effects hint');
    assert(statusLine(status({state: 'degraded', effects, reason: 'Card is busy'}), _, ngettext)
        === iso('Card is busy'), 'a specific degradation reason takes priority');
}

print('test-format: all checks passed');
