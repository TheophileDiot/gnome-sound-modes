// Thin wrapper around Gio.Subprocess for the handful of CLI tools the
// backends shell out to (pw-dump, pw-metadata, pactl, easyeffects, flatpak).
// No shell imports here: this file is loaded by the preferences process too.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

export class TimeoutError extends Error {
    constructor(argv) {
        super(`timed out: ${argv.join(' ')}`);
        this.name = 'TimeoutError';
    }
}

/**
 * Run a command to completion and collect its output.
 * @param {string[]} argv
 * @param {{timeoutMs?: number, cancellable?: Gio.Cancellable|null, input?: string|null}} [opts]
 * @returns {Promise<{stdout: string, stderr: string, status: number, ok: boolean}>}
 */
export function run(argv, {timeoutMs = 10000, cancellable = null, input = null} = {}) {
    if (cancellable?.is_cancelled())
        return Promise.reject(new Error('cancelled'));

    let proc;
    try {
        proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE |
            (input !== null ? Gio.SubprocessFlags.STDIN_PIPE : 0));
    } catch (e) {
        return Promise.reject(new Error(`failed to spawn ${argv[0]}: ${e.message}`));
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        let timeoutSource = null;
        const innerCancellable = new Gio.Cancellable();
        const externalId = cancellable
            ? cancellable.connect(() => innerCancellable.cancel())
            : null;

        const cleanup = () => {
            if (timeoutSource !== null) {
                GLib.source_remove(timeoutSource);
                timeoutSource = null;
            }
            if (externalId !== null)
                cancellable.disconnect(externalId);
        };

        if (timeoutMs > 0) {
            timeoutSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                timeoutSource = null;
                if (settled)
                    return GLib.SOURCE_REMOVE;
                settled = true;
                proc.force_exit();
                cleanup();
                reject(new TimeoutError(argv));
                return GLib.SOURCE_REMOVE;
            });
        }

        proc.communicate_utf8_async(input, innerCancellable).then(([stdout, stderr]) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            const status = proc.get_exit_status();
            resolve({stdout, stderr, status, ok: status === 0});
        }).catch(e => {
            if (settled)
                return;
            settled = true;
            cleanup();
            reject(new Error(`${argv[0]} failed: ${e.message}`));
        });
    });
}

/**
 * Launch a background process (e.g. `easyeffects --gapplication-service`)
 * with no pipes, detached from this process's lifetime.
 * @param {string[]} argv
 */
export function spawnDetached(argv) {
    const flags = Gio.SubprocessFlags.STDIN_SILENCE |
        Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE;
    Gio.Subprocess.new(argv, flags);
}
