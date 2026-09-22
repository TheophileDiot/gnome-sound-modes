// Mode data structure: creation, validation and persistence. Pure data,
// no GNOME Shell imports, shared by the extension and the prefs process.

import GLib from 'gi://GLib';

export const MODE_VERSION = 1;

/** Curated symbolic icons offered in the mode picker. */
export const ICONS = [
    {name: 'audio-headphones', label: 'Headphones'},
    {name: 'audio-speakers', label: 'Speakers'},
    {name: 'audio-input-microphone', label: 'Microphone'},
    {name: 'camera-web', label: 'Webcam'},
    {name: 'phone', label: 'Headset'},
    {name: 'call-start', label: 'Call'},
    {name: 'bluetooth-active', label: 'Earbuds'},
    {name: 'sound-modes-effects', label: 'Effects'},
    {name: 'audio-card', label: 'Sound card'},
    {name: 'multimedia-player', label: 'Media player'},
    {name: 'video-display', label: 'Display'},
];

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function defaultBluetooth(partial) {
    return {connectIfNeeded: true, ...(isPlainObject(partial) ? partial : {})};
}

function defaultEffects(partial) {
    return {
        enabled: false, scope: 'all', outputPreset: null, inputPreset: null,
        ...(isPlainObject(partial) ? partial : {}),
    };
}

function defaultFallback(partial) {
    return {output: null, input: null, ...(isPlainObject(partial) ? partial : {})};
}

/**
 * Build a mode from a partial description, filling in defaults. Always
 * gets a freshly generated id, even if `partial.id` is set.
 * @param {object} [partial]
 * @returns {object} mode
 */
export function createMode(partial = {}) {
    return {
        version: MODE_VERSION,
        id: GLib.uuid_string_random(),
        name: partial.name ?? '',
        icon: partial.icon ?? 'audio-headphones',
        output: partial.output ?? null,
        input: partial.input ?? null,
        bluetooth: defaultBluetooth(partial.bluetooth),
        effects: defaultEffects(partial.effects),
        fallback: defaultFallback(partial.fallback),
    };
}

// A slot saved by an older version (or by hand) may leave `profile` out;
// fill it in rather than dropping the whole mode over it.
function normalizeSlot(slot) {
    if (!slot || typeof slot !== 'object')
        return null;
    return {...slot, match: slot.match ?? {}, profile: slot.profile ?? null};
}

// Repair a stored mode instead of rejecting it wherever a sane default
// exists (blank name, missing icon, missing bluetooth/effects/fallback,
// malformed slot). Returns null only when `raw` isn't even an object -
// there's nothing to repair. `changed` tells the caller whether the
// result differs from what was on disk (id minted, any field repaired),
// so it knows whether the normalized list needs writing back.
function normalizeMode(raw) {
    if (!isPlainObject(raw))
        return null;

    let changed = false;
    const diff = (before, after) => {
        if (JSON.stringify(before) !== JSON.stringify(after))
            changed = true;
        return after;
    };

    const id = typeof raw.id === 'string' && raw.id ? raw.id : GLib.uuid_string_random();
    if (id !== raw.id)
        changed = true;

    const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name : 'Unnamed mode';
    if (name !== raw.name)
        changed = true;

    const icon = typeof raw.icon === 'string' && raw.icon ? raw.icon : 'audio-headphones';
    if (icon !== raw.icon)
        changed = true;

    const output = diff(raw.output ?? null, normalizeSlot(raw.output));
    const input = diff(raw.input ?? null, normalizeSlot(raw.input));
    const bluetooth = diff(raw.bluetooth, defaultBluetooth(raw.bluetooth));
    const effects = diff(raw.effects, defaultEffects(raw.effects));
    const fallback = diff(raw.fallback, defaultFallback(raw.fallback));

    return {
        mode: {version: MODE_VERSION, id, name, icon, output, input, bluetooth, effects, fallback},
        changed,
    };
}

function isSlot(slot) {
    return slot === null ||
        (typeof slot === 'object' && typeof slot.match === 'object' &&
         (slot.profile === null || typeof slot.profile === 'string'));
}

function isFallbackSlot(slot) {
    return slot === null || (typeof slot === 'object' && typeof slot.match === 'object');
}

/**
 * Check a mode against the contract. Empty array means valid.
 * @param {object} mode
 * @returns {string[]} human-readable problems, empty when valid
 */
export function validateMode(mode) {
    const errors = [];
    if (!mode || typeof mode !== 'object') {
        errors.push('mode is not an object');
        return errors;
    }
    if (typeof mode.name !== 'string' || mode.name.trim() === '')
        errors.push('name must be a non-empty string');
    if (!isSlot(mode.output))
        errors.push('output slot is malformed');
    if (!isSlot(mode.input))
        errors.push('input slot is malformed');
    if (mode.output == null && mode.input == null)
        errors.push('mode needs at least one of output or input');
    if (!mode.bluetooth || typeof mode.bluetooth.connectIfNeeded !== 'boolean')
        errors.push('bluetooth.connectIfNeeded must be a boolean');
    if (!mode.effects || typeof mode.effects.enabled !== 'boolean')
        errors.push('effects.enabled must be a boolean');
    if (mode.effects && mode.effects.scope !== 'all' && mode.effects.scope !== 'calls')
        errors.push('effects.scope must be "all" or "calls"');
    if (!mode.fallback || !isFallbackSlot(mode.fallback.output) || !isFallbackSlot(mode.fallback.input))
        errors.push('fallback slots are malformed');
    return errors;
}

/**
 * Parse a modes list from disk. Anything repairable (blank name, missing
 * icon/bluetooth/effects/fallback, malformed slot) is fixed up rather than
 * dropped. Only entries that still fail validation after repair are set
 * aside in `rejected`, verbatim, so a later `serializeModes` round-trip
 * never loses them.
 * @param {string} jsonString
 * @returns {{modes: object[], rejected: *[], warnings: string[], changed: boolean}}
 */
export function parseModes(jsonString) {
    let raw;
    try {
        raw = JSON.parse(jsonString);
    } catch (e) {
        return {modes: [], rejected: [], warnings: [`could not parse modes: ${e.message}`], changed: false};
    }
    if (!Array.isArray(raw))
        return {modes: [], rejected: [], warnings: ['modes file did not contain a list'], changed: false};

    const modes = [];
    const rejected = [];
    const warnings = [];
    let changed = false;
    for (const entry of raw) {
        const normalized = normalizeMode(entry);
        const errors = normalized ? validateMode(normalized.mode) : ['entry is not an object'];
        if (errors.length > 0) {
            rejected.push(entry);
            warnings.push(`could not repair mode "${entry?.name ?? '?'}": ${errors.join('; ')}`);
        } else {
            modes.push(normalized.mode);
            if (normalized.changed)
                changed = true;
        }
    }
    return {modes, rejected, warnings, changed};
}

/**
 * @param {object[]} modes
 * @param {*[]} [rejected] raw entries that could not be repaired, kept
 *   verbatim so they aren't lost on the next save.
 * @returns {string}
 */
export function serializeModes(modes, rejected = []) {
    return JSON.stringify([...modes, ...rejected], null, 2);
}

/**
 * @param {object} mode
 * @returns {object} deep copy with a new id and "(copy)" appended to the name
 */
export function duplicateMode(mode) {
    const copy = JSON.parse(JSON.stringify(mode));
    copy.id = GLib.uuid_string_random();
    copy.name = `${mode.name} (copy)`;
    return copy;
}

/**
 * Reorder a mode within the list by `delta` positions, clamped to the ends.
 * @param {object[]} modes
 * @param {string} id
 * @param {number} delta
 * @returns {object[]} new array
 */
export function moveMode(modes, id, delta) {
    const from = modes.findIndex(m => m.id === id);
    if (from === -1)
        return modes.slice();
    const to = Math.max(0, Math.min(modes.length - 1, from + delta));
    if (to === from)
        return modes.slice();
    const next = modes.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
}
