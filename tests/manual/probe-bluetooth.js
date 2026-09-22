// Manual probe for lib/bluetooth.js against the real system D-Bus. Not part
// of `make test`. Usage:
//   gjs -m tests/manual/probe-bluetooth.js               list devices, exit
//   gjs -m tests/manual/probe-bluetooth.js --watch        list, then print `changed` events
//   gjs -m tests/manual/probe-bluetooth.js --apply connect <address>
//   gjs -m tests/manual/probe-bluetooth.js --apply disconnect <address>

import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';

import {Bluetooth} from '../../lib/bluetooth.js';

const onChanged = (bt, callback) => bt.connect('changed', callback);

function formatDevice(device) {
    return `${device.address}  ${device.alias}  ` +
        `connected=${device.connected} paired=${device.paired} audio=${device.audio}`;
}

function listDevices(bt) {
    if (!bt.available) {
        print('BlueZ is not available on the system bus');
        return;
    }
    const devices = bt.devices;
    if (devices.length === 0)
        print('no devices');
    for (const device of devices)
        print(formatDevice(device));
}

function watch(bt) {
    listDevices(bt);
    if (!bt.available)
        return;

    print('\nwatching for changes, Ctrl-C to stop');
    onChanged(bt, () => {
        print('--- changed ---');
        listDevices(bt);
    });

    const loop = GLib.MainLoop.new(null, false);
    GLibUnix.signal_add_full(GLib.PRIORITY_DEFAULT, 2 /* SIGINT */, () => {
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
    loop.run();
}

async function apply(bt, action, address) {
    if (!address)
        throw new Error(`usage: --apply ${action ?? 'connect|disconnect'} <address>`);
    if (action === 'connect')
        await bt.connectDevice(address);
    else if (action === 'disconnect')
        await bt.disconnectDevice(address);
    else
        throw new Error(`unknown action: ${action}`);
    print(`${action} ok`);
}

async function main() {
    const bt = new Bluetooth();
    await bt.init();

    if (ARGV.includes('--apply')) {
        const i = ARGV.indexOf('--apply');
        await apply(bt, ARGV[i + 1], ARGV[i + 2]);
    } else if (ARGV.includes('--watch')) {
        watch(bt);
    } else {
        listDevices(bt);
    }

    bt.destroy();
}

await main().catch(e => {
    printerr(e.message);
    imports.system.exit(1);
});
