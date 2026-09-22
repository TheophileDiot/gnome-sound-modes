import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {run, spawnDetached, TimeoutError} from '../lib/subprocess.js';

function assert(cond, msg) {
    if (!cond)
        throw new Error(`assertion failed: ${msg}`);
}

const loop = GLib.MainLoop.new(null, false);

async function main() {
    const ok = await run(['true']);
    assert(ok.ok && ok.status === 0, 'true exits 0');

    const bad = await run(['false']);
    assert(!bad.ok && bad.status === 1, 'false exits 1');

    const echoed = await run(['cat'], {input: 'hello\n'});
    assert(echoed.stdout === 'hello\n', 'cat echoes stdin');

    const start = GLib.get_monotonic_time();
    let timedOut = false;
    try {
        await run(['sleep', '5'], {timeoutMs: 200});
    } catch (e) {
        timedOut = e instanceof TimeoutError;
    }
    const elapsedMs = (GLib.get_monotonic_time() - start) / 1000;
    assert(timedOut, 'timeout rejects with TimeoutError');
    assert(elapsedMs < 2000, `timeout fired promptly (${elapsedMs}ms)`);

    const cancellable = new Gio.Cancellable();
    const cancelled = run(['sleep', '5'], {cancellable});
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
        cancellable.cancel();
        return GLib.SOURCE_REMOVE;
    });
    let wasCancelled = false;
    try {
        await cancelled;
    } catch {
        wasCancelled = true;
    }
    assert(wasCancelled, 'cancellable aborts the process');

    let spawnFailed = false;
    try {
        await run(['/no/such/binary-sound-modes']);
    } catch {
        spawnFailed = true;
    }
    assert(spawnFailed, 'missing binary rejects');

    spawnDetached(['true']);

    print('test-subprocess: all checks passed');
    loop.quit();
}

main().catch(e => {
    printerr(`test-subprocess: FAILED: ${e.message}`);
    loop.quit();
    imports.system.exit(1);
});
loop.run();
