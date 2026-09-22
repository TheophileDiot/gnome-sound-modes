import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {parseSnapshot} from '../lib/snapshot.js';
import {
    captureMatch, scoreMatch, findDevice, resolveEndpoint, classifyDevice,
    friendlyName, endpointLabel, profileLabel, codecOfProfile, profilesForSlot,
} from '../lib/matching.js';

function assert(cond, msg) {
    if (!cond)
        throw new Error(`assertion failed: ${msg}`);
}

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const [, bytes] = Gio.File.new_for_path(`${here}/fixtures/pw-dump-airpods-tonor-discord.json`).load_contents(null);
const snapshot = parseSnapshot(JSON.parse(new TextDecoder().decode(bytes)));

const airpods = snapshot.devices.find(d => d.name === 'bluez_card.AA_BB_CC_DD_EE_FF');
const tonor = snapshot.devices.find(d => d.name.startsWith('alsa_card.usb-TONOR'));
const builtin = snapshot.devices.find(d => d.name === 'alsa_card.pci-0000_00_1f.3');

// captureMatch
const airpodsMatch = captureMatch(airpods);
assert(airpodsMatch['api.bluez5.address'] === 'AA:BB:CC:DD:EE:FF', 'captureMatch copies bluez address');
assert(airpodsMatch !== airpods.match, 'captureMatch returns a copy, not the same object');
const suffixed = {...tonor, name: `${tonor.name}.3`};
assert(captureMatch(suffixed)['device.name'] === tonor.name, 'captureMatch strips device.name suffix');

// scoreMatch: highest applicable rule wins, not a sum
assert(scoreMatch({'api.bluez5.address': 'AA:BB:CC:DD:EE:FF', 'device.name': 'wrong'}, airpods) === 100,
    'bluez address scores 100 even with a mismatching name');
assert(scoreMatch({'device.serial': tonor.deviceSerial}, tonor) === 90, 'device.serial scores 90');
assert(scoreMatch({'device.name': tonor.name}, tonor) === 80, 'an exact device.name scores 80');
assert(scoreMatch({'device.name': `${tonor.name}.7`}, tonor) === 70,
    'a device.name that only matches once suffixes are stripped scores lower');

// sibling PCI functions differ by what looks like a collision suffix: the
// exact name must win instead of both colliding at the same score
const siblings = {
    devices: [
        {id: 1, name: 'alsa_card.pci-0000_01_00.0', match: {}, profiles: []},
        {id: 2, name: 'alsa_card.pci-0000_01_00.1', match: {}, profiles: []},
    ],
};
const sibling = findDevice({'device.name': 'alsa_card.pci-0000_01_00.1'}, siblings);
assert(sibling.device.id === 2 && sibling.score === 80,
    'the device whose full name matches wins over its sibling function');
assert(scoreMatch({'device.vendor.id': tonor.vendorId, 'device.product.id': tonor.productId,
    'device.bus-path': tonor.busPath}, tonor) === 60, 'vendor+product+bus-path scores 60');
assert(scoreMatch({'device.vendor.id': tonor.vendorId, 'device.product.id': tonor.productId}, tonor) === 40,
    'vendor+product scores 40');
assert(scoreMatch({'device.description': tonor.description}, tonor) === 20, 'device.description scores 20');
assert(scoreMatch({'device.name': 'nope'}, tonor) === 0, 'no match scores 0');

// findDevice
const foundAirpods = findDevice({'api.bluez5.address': 'AA:BB:CC:DD:EE:FF', 'device.name': 'renamed-since'}, snapshot);
assert(foundAirpods.device.id === airpods.id && foundAirpods.score === 100,
    'AirPods found by address even though device.name changed');
const foundTonor = findDevice({'device.serial': tonor.deviceSerial}, snapshot);
assert(foundTonor.device.id === tonor.id, 'TONOR found by serial');
assert(findDevice({'device.name': 'totally-unknown-device'}, snapshot) === null,
    'no match below score 40 returns null');

// resolveEndpoint
const tonorInput = resolveEndpoint({match: {'device.serial': tonor.deviceSerial}, profile: null}, 'input', snapshot);
assert(tonorInput.endpoint.name.startsWith('alsa_input.usb-TONOR'), 'resolveEndpoint picks the TONOR input node');
const airpodsOutput = resolveEndpoint(
    {match: {'api.bluez5.address': airpods.bluezAddress}, profile: null}, 'output', snapshot);
assert(airpodsOutput.endpoint.name === 'bluez_output.AA_BB_CC_DD_EE_FF.1', 'resolveEndpoint picks the AirPods sink');
assert(resolveEndpoint({match: {'device.name': 'nope'}, profile: null}, 'output', snapshot) === null,
    'resolveEndpoint returns null when the device cannot be found');

// classifyDevice
const airpodsKind = classifyDevice(airpods);
assert(airpodsKind.kind === 'headset' && airpodsKind.wireless === true,
    'bluez device with both sink and source classes is a wireless headset');
assert(airpodsKind.hasOutput && airpodsKind.hasInput, 'headset exposes both directions');
const builtinKind = classifyDevice(builtin);
assert(builtinKind.kind === 'internal' && builtinKind.wireless === false, 'internal form-factor is used directly');
const hdmiCard = snapshot.devices.find(d => d.name === 'alsa_card.pci-0000_01_00.1');
assert(classifyDevice(hdmiCard).kind === 'hdmi', 'hdmi-only card is classified from its profile descriptions');

// friendlyName / endpointLabel
assert(friendlyName(airpods) === 'Example Airpods', 'friendlyName uses the device description');
const airpodsSink = snapshot.endpoints.find(e => e.name === 'bluez_output.AA_BB_CC_DD_EE_FF.1');
assert(endpointLabel(airpodsSink).includes('MSBC'), 'endpointLabel surfaces the active bluez codec');

// profileLabel / codecOfProfile
const sbcXq = airpods.profiles.find(p => p.name === 'a2dp-sink-sbc_xq');
assert(profileLabel(sbcXq) === 'A2DP · SBC-XQ', 'A2DP profile label shortened');
assert(codecOfProfile(sbcXq.name) === 'sbc_xq', 'codec extracted from the a2dp-sink profile name');
const msbc = airpods.profiles.find(p => p.name === 'headset-head-unit-msbc');
assert(profileLabel(msbc) === 'Headset (HFP) · mSBC', 'headset profile label shortened');
assert(codecOfProfile(msbc.name) === 'msbc', 'codec extracted from the headset profile name');
const hfp = airpods.profiles.find(p => p.name === 'headset-head-unit');
assert(profileLabel(hfp) === 'Headset (HFP)', 'headset profile with no codec has no trailing dot');
assert(codecOfProfile(hfp.name) === null, 'no codec on the plain headset profile');
const duplex = builtin.profiles.find(p => p.name === 'output:analog-stereo+input:analog-stereo');
assert(profileLabel(duplex) === 'Analogue Stereo Duplex', 'ALSA profile description is left unchanged');

// profilesForSlot
const airpodsOutputs = profilesForSlot(airpods, 'output');
assert(airpodsOutputs.every(p => p.name !== 'off'), 'off is excluded');
assert(airpodsOutputs.every(p => p.classes['Audio/Sink']), 'only sink-capable profiles for output slot');
for (let i = 1; i < airpodsOutputs.length; i++)
    assert(airpodsOutputs[i - 1].priority >= airpodsOutputs[i].priority, 'sorted by priority descending');
const hdmiOutputs = profilesForSlot(hdmiCard, 'output');
assert(hdmiOutputs.every(p => p.available !== 'no'), 'unavailable profiles are excluded');

{
    const {profileFamily, resolveProfile} = await import('../lib/matching.js');
    assert(profileFamily('a2dp-sink-ldac') === 'a2dp-sink' && profileFamily('headset-head-unit-msbc') === 'headset-head-unit'
        && profileFamily('a2dp-sink') === 'a2dp-sink' && profileFamily('output:analog-stereo') === 'output:analog-stereo', 'profileFamily');
    const card = snapshot.devices.find(d => d.api === 'bluez5');
    assert(resolveProfile(card, 'a2dp-sink-sbc_xq').exact === true, 'exact profile kept');
    const ldac = resolveProfile(card, 'a2dp-sink-ldac');
    assert(ldac && !ldac.exact && ldac.profile.name.startsWith('a2dp-sink'), 'missing codec falls back to same family');
    assert(resolveProfile(card, 'output:hdmi-stereo') === null, 'unknown family resolves to null');
}
print('test-matching: all checks passed');
