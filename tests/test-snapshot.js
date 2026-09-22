import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {parseSnapshot, parseDumpText, stripNodeSuffix, endpointsForDevice, findDeviceByName} from '../lib/snapshot.js';

function assert(cond, msg) {
    if (!cond)
        throw new Error(`assertion failed: ${msg}`);
}

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const [, bytes] = Gio.File.new_for_path(`${here}/fixtures/pw-dump-airpods-tonor-discord.json`).load_contents(null);
const snapshot = parseSnapshot(JSON.parse(new TextDecoder().decode(bytes)));

assert(snapshot.metadataId === 36, 'default metadata id');
assert(snapshot.defaults.sink === 'bluez_output.AA_BB_CC_DD_EE_FF.1', 'default sink');
assert(snapshot.defaults.configuredSource === 'bluez_input.AA_BB_CC_DD_EE_FF.0', 'configured source');

const airpods = findDeviceByName(snapshot, 'bluez_card.AA_BB_CC_DD_EE_FF');
assert(airpods && airpods.api === 'bluez5', 'bluez device parsed');
assert(airpods.bluezAddress === 'AA:BB:CC:DD:EE:FF', 'bluez address');
assert(airpods.activeProfile === 'headset-head-unit-msbc', 'active profile');
const names = airpods.profiles.map(p => p.name);
assert(names.includes('a2dp-sink-sbc_xq') && names.includes('headset-head-unit-msbc'), 'codec profiles listed');
const hfp = airpods.profiles.find(p => p.name === 'headset-head-unit');
assert(hfp.classes['Audio/Sink'] === 1 && hfp.classes['Audio/Source'] === 1, 'bluez classes without count prefix');
assert(airpods.match['api.bluez5.address'] === 'AA:BB:CC:DD:EE:FF' && !('object.serial' in airpods.match), 'match keys subset');

const tonor = snapshot.devices.find(d => d.name.startsWith('alsa_card.usb-TONOR'));
assert(tonor.formFactor === null && tonor.vendorId === '0x31b2', 'alsa usb props');
const duplex = tonor.profiles.find(p => p.name === 'output:analog-stereo+input:analog-stereo');
assert(duplex.classes['Audio/Sink'] === 1, 'alsa classes with count prefix');
const tonorInputs = endpointsForDevice(snapshot, tonor, 'input');
assert(tonorInputs.length === 1 && tonorInputs[0].name.endsWith('.iec958-stereo.2'), 'device → source node');
assert(stripNodeSuffix(tonorInputs[0].name).endsWith('.iec958-stereo'), 'suffix stripped');

const btSink = snapshot.endpoints.find(e => e.name === 'bluez_output.AA_BB_CC_DD_EE_FF.1');
assert(btSink.bluez.profile === 'headset-head-unit' && btSink.bluez.codec === 'msbc', 'node bluez profile/codec');
const ee = snapshot.endpoints.find(e => e.name === 'easyeffects_sink');
assert(ee && ee.virtual && ee.deviceId === null, 'easyeffects virtual sink');
const eeSrc = snapshot.endpoints.find(e => e.name === 'easyeffects_source');
assert(eeSrc && eeSrc.direction === 'input' && eeSrc.virtual, 'Audio/Source/Virtual is an input endpoint');

const discordOut = snapshot.streams.find(s => s.appBinary === 'Discord' && s.direction === 'output');
const discordIn = snapshot.streams.find(s => s.appBinary === 'Discord' && s.direction === 'input');
assert(discordOut.appName === 'WEBRTC VoiceEngine' && discordOut.appId === 'com.discordapp.Discord', 'stream app props');
assert(discordOut.target === 'easyeffects_sink', 'target.object serial resolved to node name');
assert(discordIn.target === 'easyeffects_source', 'target.node id resolved to node name');
const sd = snapshot.streams.find(s => s.appName === 'speech-dispatcher-dummy');
assert(sd.target === null, 'untargeted stream');

assert(parseSnapshot([]).devices.length === 0, 'empty dump');

const raw = new TextDecoder().decode(bytes);
assert(parseDumpText(raw).length === JSON.parse(raw).length, 'single array parses as usual');
const first = JSON.parse(raw);
const patched = JSON.parse(JSON.stringify(first.slice(0, 2)));
patched[0].info.props['device.description'] = 'Renamed "quoted] device';
const concatenated = `${raw}\n[\n${JSON.stringify(patched[0])}\n]\n${JSON.stringify([patched[1]])}\n`;
const merged = parseDumpText(concatenated);
assert(merged.length === first.length, 'concatenated arrays merged by id');
assert(merged.find(o => o.id === patched[0].id).info.props['device.description'] === 'Renamed "quoted] device',
    'later array wins and strings with brackets survive');
print('test-snapshot: all checks passed');
