import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {PipeWire} from '../lib/pipewire.js';

function assert(cond, msg) {
    if (!cond)
        throw new Error(`assertion failed: ${msg}`);
}

function sleep(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

// Replaces the `pw-dump` call so the tests never touch a real PipeWire.
function stub(pipewire, {objects = [], delayMs = 0} = {}) {
    const state = {calls: 0, objects};
    pipewire._runTool = async () => {
        state.calls++;
        if (delayMs > 0)
            await sleep(delayMs);
        return {stdout: JSON.stringify(state.objects), stderr: '', status: 0, ok: true};
    };
    return state;
}

function within(ms, promise) {
    return Promise.race([
        promise.then(() => 'settled', e => e.message),
        sleep(ms).then(() => 'hung'),
    ]);
}

const loop = GLib.MainLoop.new(null, false);

async function main() {
    // --- cancelling a waitFor must not deadlock the main loop -----------

    {
        const pipewire = new PipeWire();
        stub(pipewire);
        const cancellable = new Gio.Cancellable();
        const waiting = pipewire.waitFor(() => false, 30000, cancellable);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            cancellable.cancel();
            return GLib.SOURCE_REMOVE;
        });

        const outcome = await within(1000, waiting);
        assert(outcome === 'cancelled', `cancelling waitFor rejects promptly, got "${outcome}"`);
        pipewire.destroy();
    }

    // --- an already cancelled cancellable rejects straight away ---------

    {
        const pipewire = new PipeWire();
        stub(pipewire);
        const cancellable = new Gio.Cancellable();
        cancellable.cancel();
        const outcome = await within(1000, pipewire.waitFor(() => false, 30000, cancellable));
        assert(outcome === 'cancelled', `a cancelled cancellable rejects, got "${outcome}"`);
        pipewire.destroy();
    }

    // --- destroy() rejects whatever is still waiting --------------------

    {
        const pipewire = new PipeWire();
        stub(pipewire);
        const waiting = pipewire.waitFor(() => false, 30000, null);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            pipewire.destroy();
            return GLib.SOURCE_REMOVE;
        });
        const outcome = await within(1000, waiting);
        assert(outcome.includes('destroyed'), `destroy() rejects pending waiters, got "${outcome}"`);
    }

    // --- bursts of refreshes share one pw-dump --------------------------

    {
        const pipewire = new PipeWire();
        const state = stub(pipewire, {delayMs: 60});
        const [first, second] = await Promise.all([pipewire.refresh(), pipewire.refresh()]);
        assert(state.calls === 1, `concurrent refreshes run pw-dump once, got ${state.calls}`);
        assert(first === second, 'and hand out the same snapshot');

        await pipewire.refresh();
        assert(state.calls === 2, 'a later refresh runs again');
        pipewire.destroy();
    }

    // --- waitFor polls instead of waiting for an outside event ----------

    {
        const pipewire = new PipeWire();
        const state = stub(pipewire);
        let seen = 0;
        const waiting = pipewire.waitFor(() => ++seen > 2, 5000, null);
        const outcome = await within(2000, waiting);
        assert(outcome === 'settled', `waitFor re-polls on its own, got "${outcome}"`);
        assert(state.calls > 1, 'which means it ran pw-dump more than once');
        pipewire.destroy();
    }

    // --- and backs its polling off instead of hammering pw-dump ---------

    {
        const pipewire = new PipeWire();
        const state = stub(pipewire);
        const waiting = pipewire.waitFor(() => false, 30000, null);
        await sleep(1900);
        // 250 + 500 + 1000 ms of backoff is 3 polls on top of the first dump;
        // a flat 250 ms interval would have run 7.
        assert(state.calls <= 5, `waitFor backs off, got ${state.calls} pw-dump runs in 1.9 s`);
        assert(state.calls >= 3, `but keeps polling, got ${state.calls}`);
        pipewire.destroy();
        await within(500, waiting);
    }

    print('test-pipewire: all checks passed');
    loop.quit();
}

main().catch(e => {
    printerr(`test-pipewire: FAILED: ${e.message}`);
    printerr(e.stack);
    loop.quit();
    imports.system.exit(1);
});
loop.run();
