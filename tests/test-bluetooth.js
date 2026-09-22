import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {
    Bluetooth, hasAudioProfile, hasA2dpProfile, hasHfpProfile, normalizeAddress, buildDevice,
} from '../lib/bluetooth.js';

function assert(cond, msg) {
    if (!cond)
        throw new Error(`assertion failed: ${msg}`);
}

assert(hasAudioProfile(['0000110b-0000-1000-8000-00805f9b34fb']), 'A2DP AudioSink UUID is audio');
assert(hasAudioProfile(['0000111E-0000-1000-8000-00805F9B34FB']), 'HFP UUID matches case-insensitively');
assert(hasAudioProfile(['00001812-0000-1000-8000-00805f9b34fb', '0000110b-0000-1000-8000-00805f9b34fb']),
    'audio UUID among others still detected');
assert(!hasAudioProfile(['00001812-0000-1000-8000-00805f9b34fb']), 'HID-only device is not audio');
assert(!hasAudioProfile([]), 'no UUIDs is not audio');
assert(!hasAudioProfile(null), 'missing UUID list is not audio');

assert(hasA2dpProfile(['0000110b-0000-1000-8000-00805f9b34fb']), 'A2DP AudioSink UUID matches a2dp');
assert(!hasA2dpProfile(['0000111e-0000-1000-8000-00805f9b34fb']), 'handsfree UUID alone does not match a2dp');
assert(hasHfpProfile(['0000111e-0000-1000-8000-00805f9b34fb']), 'Handsfree UUID matches hfp');
assert(hasHfpProfile(['0000111F-0000-1000-8000-00805F9B34FB']), 'HandsfreeAG UUID matches hfp case-insensitively');
assert(!hasHfpProfile(['0000110b-0000-1000-8000-00805f9b34fb']), 'a2dp UUID alone does not match hfp');
assert(!hasA2dpProfile(null) && !hasHfpProfile(null), 'missing UUID list matches neither');

assert(normalizeAddress('AA:BB:CC:DD:EE:FF') === 'AA:BB:CC:DD:EE:FF', 'already-normalised address');
assert(normalizeAddress('aa:bb:cc:dd:ee:ff') === 'AA:BB:CC:DD:EE:FF', 'lowercase address uppercased');
assert(normalizeAddress('dev_AA_BB_CC_DD_EE_FF') === 'AA:BB:CC:DD:EE:FF', 'bare object path basename');
assert(normalizeAddress('/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF') === 'AA:BB:CC:DD:EE:FF',
    'full object path');

const airpods = buildDevice('/org/bluez/hci0/dev_10_2F_CA_C6_D4_9A', {
    Address: '10:2F:CA:C6:D4:9A',
    Alias: "Théophile's Airpods 4",
    Name: 'Airpods 4',
    Connected: true,
    Paired: true,
    UUIDs: ['0000110b-0000-1000-8000-00805f9b34fb', '0000111e-0000-1000-8000-00805f9b34fb'],
});
assert(airpods.path === '/org/bluez/hci0/dev_10_2F_CA_C6_D4_9A', 'device path kept as-is');
assert(airpods.address === '10:2F:CA:C6:D4:9A', 'device address normalised');
assert(airpods.alias === "Théophile's Airpods 4", 'alias preferred over name');
assert(airpods.connected === true && airpods.paired === true, 'connected/paired booleans');
assert(airpods.audio === true, 'airpods classified as audio device');
assert(airpods.a2dp === true, 'airpods advertise a2dp');
assert(airpods.hfp === true, 'airpods advertise hfp');

const mouse = buildDevice('/org/bluez/hci0/dev_D0_41_CB_4F_C5_B2', {
    Address: 'D0:41:CB:4F:C5:B2',
    Alias: null,
    Name: 'MX Master 3',
    Connected: true,
    Paired: true,
    UUIDs: ['00001812-0000-1000-8000-00805f9b34fb'],
});
assert(mouse.alias === 'MX Master 3', 'name used when alias missing');
assert(mouse.audio === false, 'mouse is not an audio device');
assert(mouse.a2dp === false && mouse.hfp === false, 'mouse has neither a2dp nor hfp');

const missingAddress = buildDevice('/org/bluez/hci0/dev_70_99_1C_39_6D_3F', {
    Alias: 'JBL GO 2',
    Connected: false,
    Paired: true,
    UUIDs: [],
});
assert(missingAddress.address === '70:99:1C:39:6D:3F', 'address falls back to path when property absent');
assert(missingAddress.connected === false, 'disconnected device reports false');
assert(missingAddress.a2dp === false && missingAddress.hfp === false, 'no UUIDs means neither a2dp nor hfp');

const hfpGatewayOnly = buildDevice('/org/bluez/hci0/dev_AA_AA_AA_AA_AA_AA', {
    Address: 'AA:AA:AA:AA:AA:AA',
    Alias: 'Car Kit',
    Connected: true,
    Paired: true,
    UUIDs: ['0000111f-0000-1000-8000-00805f9b34fb'],
});
assert(hfpGatewayOnly.hfp === true && hfpGatewayOnly.a2dp === false,
    'HandsfreeAG-only device is hfp but not a2dp');

function sleep(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

const loop = GLib.MainLoop.new(null, false);

async function main() {
    // Cancelling a pending connect must not tear the cancellable down from
    // inside its own handler: g_cancellable_disconnect() would block there
    // and take the whole main loop with it.
    const iface = {
        get_cached_property: () => null,
        connect: () => 1,
        disconnect: () => {},
    };
    const bluetooth = new Bluetooth();
    const cancellable = new Gio.Cancellable();
    const waiting = bluetooth._waitConnected(iface, cancellable);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
        cancellable.cancel();
        return GLib.SOURCE_REMOVE;
    });
    const outcome = await Promise.race([
        waiting.then(() => 'connected', e => e.message),
        sleep(1000).then(() => 'hung'),
    ]);
    assert(outcome === 'bluetooth connect cancelled', `cancelling rejects promptly, got "${outcome}"`);
    bluetooth.destroy();

    // destroy() during init() must not leave a watched manager behind
    const racing = new Bluetooth();
    const pending = racing.init();
    racing.destroy();
    await pending;
    assert(racing.available === false && racing.devices.length === 0,
        'a bluetooth backend destroyed mid-init stays inert');

    print('test-bluetooth: all checks passed');
    loop.quit();
}

main().catch(e => {
    printerr(`test-bluetooth: FAILED: ${e.message}`);
    printerr(e.stack);
    loop.quit();
    imports.system.exit(1);
});
loop.run();
