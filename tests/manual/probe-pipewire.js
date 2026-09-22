#!/usr/bin/env -S gjs -m
// Manual probe: dumps the live PipeWire snapshot through lib/pipewire.js.
// Read-only unless --apply <op> <args...> is given.
//
// Usage:
//   gjs -m tests/manual/probe-pipewire.js
//   gjs -m tests/manual/probe-pipewire.js --apply set-target 144 easyeffects_sink
//   gjs -m tests/manual/probe-pipewire.js --apply clear-target 144
//   gjs -m tests/manual/probe-pipewire.js --apply set-profile bluez_card.AA_BB a2dp-sink
//   gjs -m tests/manual/probe-pipewire.js --apply default-sink some_node_name
//   gjs -m tests/manual/probe-pipewire.js --apply default-source some_node_name

import GLib from 'gi://GLib';
import {PipeWire} from '../../lib/pipewire.js';

function printSnapshot(snapshot) {
    print(`\n== devices (${snapshot.devices.length}) ==`);
    for (const device of snapshot.devices) {
        print(`[${device.id}] ${device.description} (${device.api ?? '?'}) ` +
            `active=${device.activeProfile ?? '-'}`);
        for (const profile of device.profiles) {
            const marker = profile.name === device.activeProfile ? '*' : ' ';
            print(`  ${marker} ${profile.name}  prio=${profile.priority} available=${profile.available}`);
        }
    }

    print(`\n== endpoints (${snapshot.endpoints.length}) ==`);
    for (const endpoint of snapshot.endpoints) {
        print(`[${endpoint.id}] ${endpoint.name}  dir=${endpoint.direction}  ` +
            `device=${endpoint.deviceId ?? '-'}  virtual=${endpoint.virtual}` +
            (endpoint.bluez ? `  bluez=${endpoint.bluez.profile}/${endpoint.bluez.codec}` : ''));
    }

    print(`\n== streams (${snapshot.streams.length}) ==`);
    for (const stream of snapshot.streams) {
        const app = stream.appName ?? stream.appBinary ?? `pid:${stream.pid}`;
        print(`[${stream.id}] ${app}  dir=${stream.direction}  role=${stream.role ?? '-'}  ` +
            `target=${stream.target ?? '-'}`);
    }

    print('\n== defaults ==');
    print(JSON.stringify(snapshot.defaults, null, 2));
}

async function apply(pw, op, args) {
    switch (op) {
    case 'set-target':
        return pw.setTarget(args[0], args[1]);
    case 'clear-target':
        return pw.clearTarget(args[0]);
    case 'set-profile':
        return pw.setProfile(args[0], args[1]);
    case 'default-sink':
        return pw.setDefaultSink(args[0]);
    case 'default-source':
        return pw.setDefaultSource(args[0]);
    default:
        throw new Error(`unknown --apply op "${op}"`);
    }
}

const loop = GLib.MainLoop.new(null, false);
const pw = new PipeWire();

async function main() {
    const snapshot = await pw.refresh();
    printSnapshot(snapshot);

    const applyIndex = ARGV.indexOf('--apply');
    if (applyIndex !== -1) {
        const op = ARGV[applyIndex + 1];
        const args = ARGV.slice(applyIndex + 2);
        print(`\n== applying: ${op} ${args.join(' ')} ==`);
        await apply(pw, op, args);
        printSnapshot(await pw.refresh());
    }
}

main()
    .catch(e => {
        printerr(`error: ${e.message}`);
        imports.system.exit(1);
    })
    .finally(() => {
        pw.destroy();
        loop.quit();
    });
loop.run();
