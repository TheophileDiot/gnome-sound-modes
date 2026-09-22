// Tiny logging wrapper so every module prefixes its messages the same way
// and debug output can be silenced without touching call sites.

const PREFIX = '[sound-modes]';

let debugEnabled = false;

/** Enable or disable `debug()` output. */
export function setDebug(enabled) {
    debugEnabled = Boolean(enabled);
}

/** Log a debug message, only when debug output is enabled. */
export function debug(...args) {
    if (debugEnabled)
        console.debug(PREFIX, ...args);
}

/** Log a recoverable problem (missing tool, unreachable service, stale state). */
export function warn(...args) {
    console.warn(PREFIX, ...args);
}

/** Log a bug: something the code should have prevented. */
export function error(...args) {
    console.error(PREFIX, ...args);
}
