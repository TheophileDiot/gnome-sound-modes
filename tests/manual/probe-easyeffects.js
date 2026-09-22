#!/usr/bin/env -S gjs -m
// Manual probe: runs lib/easyeffects.js detection against the live system
// and lists presets. Read-only unless --apply <op> <args...> is given.
//
// Usage:
//   gjs -m tests/manual/probe-easyeffects.js
//   gjs -m tests/manual/probe-easyeffects.js --apply load-preset output Music
//   gjs -m tests/manual/probe-easyeffects.js --apply ensure-running
//   gjs -m tests/manual/probe-easyeffects.js --apply bypass 1
//   gjs -m tests/manual/probe-easyeffects.js --apply set-process-all true false

import GLib from 'gi://GLib';
import * as EasyEffects from '../../lib/easyeffects.js';
import {PipeWire} from '../../lib/pipewire.js';

async function apply(op, args) {
    switch (op) {
    case 'load-preset':
        return EasyEffects.loadPreset(args[0], args[1]);
    case 'ensure-running': {
        const pw = new PipeWire();
        const snapshot = await pw.refresh();
        await EasyEffects.ensureRunning(snapshot);
        pw.destroy();
        return undefined;
    }
    case 'bypass':
        return EasyEffects.setBypass(args[0] === '1' || args[0] === 'true');
    case 'set-process-all':
        return EasyEffects.setProcessAll({
            outputs: args[0] === undefined ? undefined : args[0] === 'true',
            inputs: args[1] === undefined ? undefined : args[1] === 'true',
        });
    default:
        throw new Error(`unknown --apply op "${op}"`);
    }
}

const loop = GLib.MainLoop.new(null, false);

async function main() {
    const pw = new PipeWire();
    const snapshot = await pw.refresh();
    pw.destroy();

    const info = await EasyEffects.detect();
    print('== detect ==');
    print(JSON.stringify(info, null, 2));
    print(`\nisRunning: ${EasyEffects.isRunning(snapshot)}`);

    if (info.installed) {
        print('\n== output presets ==');
        print((await EasyEffects.listPresets('output')).join('\n') || '(none)');
        print('\n== input presets ==');
        print((await EasyEffects.listPresets('input')).join('\n') || '(none)');
        print(`\nprocess-all: ${JSON.stringify(EasyEffects.getProcessAll())}`);
    }

    const applyIndex = ARGV.indexOf('--apply');
    if (applyIndex !== -1) {
        const op = ARGV[applyIndex + 1];
        const args = ARGV.slice(applyIndex + 2);
        print(`\n== applying: ${op} ${args.join(' ')} ==`);
        await apply(op, args);
        print('done');
    }
}

main()
    .catch(e => {
        printerr(`error: ${e.message}`);
        imports.system.exit(1);
    })
    .finally(() => loop.quit());
loop.run();
