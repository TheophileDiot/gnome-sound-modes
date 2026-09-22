// Device/endpoint matching and human-facing labels, built on top of the
// snapshot shape from lib/snapshot.js. No shell imports: shared with prefs.

import {stripNodeSuffix, endpointsForDevice} from './snapshot.js';

const FORM_FACTOR_KIND = {
    headset: 'headset',
    headphone: 'headphones',
    headphones: 'headphones',
    speaker: 'speaker',
    microphone: 'microphone',
    webcam: 'webcam',
    internal: 'internal',
    hdmi: 'hdmi',
    handset: 'headset',
};

const ICON_FOR_KIND = {
    headset: 'audio-headphones',
    headphones: 'audio-headphones',
    speaker: 'audio-speakers',
    microphone: 'audio-input-microphone',
    webcam: 'camera-web',
    internal: 'audio-card',
    hdmi: 'video-display',
    unknown: 'audio-card',
};

/**
 * Copy the stable properties of a device into a match object, the way a
 * mode stores which device it targets.
 * @param {object} device
 * @returns {object} match
 */
export function captureMatch(device) {
    const match = {...device.match};
    if (match['device.name'])
        match['device.name'] = stripNodeSuffix(match['device.name']);
    return match;
}

/**
 * How well a stored match fits a live device. Highest applicable rule
 * wins; scores are never summed.
 * @param {object} match
 * @param {object} device
 * @returns {number}
 */
export function scoreMatch(match, device) {
    if (match['api.bluez5.address'] && match['api.bluez5.address'] === device.bluezAddress)
        return 100;
    if (match['device.serial'] && match['device.serial'] === device.deviceSerial)
        return 90;
    if (match['device.name'] && device.name) {
        if (match['device.name'] === device.name)
            return 80;
        // Sibling PCI functions (…_00.0 and …_00.1) only differ by what looks
        // like a collision suffix, so a stripped match is a weaker signal.
        if (stripNodeSuffix(match['device.name']) === stripNodeSuffix(device.name))
            return 70;
    }
    if (match['device.vendor.id'] && match['device.vendor.id'] === device.vendorId &&
        match['device.product.id'] && match['device.product.id'] === device.productId &&
        match['device.bus-path'] && match['device.bus-path'] === device.busPath)
        return 60;
    if (match['device.vendor.id'] && match['device.vendor.id'] === device.vendorId &&
        match['device.product.id'] && match['device.product.id'] === device.productId)
        return 40;
    if (match['device.description'] && match['device.description'] === device.description)
        return 20;
    return 0;
}

/**
 * Find the device in a snapshot that best fits a stored match.
 * @param {object} match
 * @param {object} snapshot
 * @returns {{device: object, score: number}|null}
 */
export function findDevice(match, snapshot) {
    let best = null;
    for (const device of snapshot.devices) {
        const score = scoreMatch(match, device);
        if (score < 40)
            continue;
        if (!best || score > best.score || (score === best.score && device.id < best.device.id))
            best = {device, score};
    }
    return best;
}

/**
 * Resolve a mode slot to a concrete device and endpoint.
 * @param {{match: object, profile: ?string}} slot
 * @param {'output'|'input'} direction
 * @param {object} snapshot
 * @returns {{device: object, endpoint: object, score: number}|null}
 */
export function resolveEndpoint(slot, direction, snapshot) {
    const found = findDevice(slot.match, snapshot);
    if (!found)
        return null;

    const candidates = endpointsForDevice(snapshot, found.device, direction).filter(e => !e.virtual);
    if (candidates.length === 0)
        return null;

    let pool = candidates;
    if (slot.profile) {
        const family = profileFamily(slot.profile);
        const matchingProfile = candidates.filter(e => e.bluez && profileFamily(e.bluez.profile) === family);
        if (matchingProfile.length > 0)
            pool = matchingProfile;
    }

    const endpoint = pool.reduce((best, current) => {
        const bestPriority = best.props['priority.session'] ?? 0;
        const currentPriority = current.props['priority.session'] ?? 0;
        return currentPriority > bestPriority ? current : best;
    }, pool[0]);

    return {device: found.device, endpoint, score: found.score};
}

function deviceClasses(device) {
    let sink = false;
    let source = false;
    for (const profile of device.profiles ?? []) {
        if (profile.available === 'no')
            continue;
        if (profile.classes['Audio/Sink'])
            sink = true;
        if (profile.classes['Audio/Source'])
            source = true;
    }
    return {sink, source};
}

function nameHint(device) {
    const text = [device.name, device.description, ...(device.profiles ?? []).map(p => p.description)]
        .filter(Boolean).join(' ').toLowerCase();
    if (text.includes('hdmi'))
        return 'hdmi';
    if (text.includes('webcam'))
        return 'webcam';
    return null;
}

/**
 * Guess what kind of device this is, for icons and grouping in the UI.
 * Never derived from vendor names.
 * @param {object} device
 * @returns {{kind: string, wireless: boolean, icon: string, hasOutput: boolean, hasInput: boolean}}
 */
export function classifyDevice(device) {
    const {sink, source} = deviceClasses(device);
    const wireless = device.api === 'bluez5';
    let kind;
    if (wireless) {
        // A bluez card exposing both directions is a communication headset,
        // regardless of what its (often generic) form-factor prop says.
        kind = sink && source
            ? 'headset'
            : FORM_FACTOR_KIND[device.formFactor] ?? (sink ? 'headphones' : source ? 'microphone' : 'unknown');
    } else {
        kind = FORM_FACTOR_KIND[device.formFactor] ?? nameHint(device) ??
            (sink && !source ? 'speaker' : !sink && source ? 'microphone' : 'unknown');
    }
    return {kind, wireless, icon: ICON_FOR_KIND[kind] ?? 'audio-card', hasOutput: sink, hasInput: source};
}

/**
 * @param {object} device
 * @returns {string} description without a collision suffix
 */
export function friendlyName(device) {
    return stripNodeSuffix(device.description || device.name || '').trim();
}

/**
 * @param {object} endpoint
 * @returns {string} description, with the bluez codec appended when known
 */
export function endpointLabel(endpoint) {
    const base = stripNodeSuffix(endpoint.description || endpoint.name || '').trim();
    return endpoint.bluez?.codec ? `${base} · ${endpoint.bluez.codec.toUpperCase()}` : base;
}

/**
 * Profile name without its codec suffix: "a2dp-sink-ldac" → "a2dp-sink".
 * @param {string} name
 * @returns {string}
 */
export function profileFamily(name) {
    if (typeof name !== 'string')
        return '';
    return name.replace(/^(a2dp-sink|headset-head-unit)-.+$/, '$1');
}

/**
 * Pick the profile to apply for a wanted name: the exact one when the card
 * offers it, else the best available profile of the same family (a Sony
 * headset asked for LDAC while only SBC is offered still ends up in A2DP),
 * else null.
 * @param {object} device
 * @param {string} wanted
 * @returns {{profile: object, exact: boolean}|null}
 */
export function resolveProfile(device, wanted) {
    const usable = (device.profiles ?? []).filter(p => p.available !== 'no');
    const exact = usable.find(p => p.name === wanted);
    if (exact)
        return {profile: exact, exact: true};
    const family = profileFamily(wanted);
    const sameFamily = usable
        .filter(p => profileFamily(p.name) === family)
        .sort((a, b) => b.priority - a.priority);
    return sameFamily.length > 0 ? {profile: sameFamily[0], exact: false} : null;
}

/**
 * @param {string} name profile.name, e.g. "a2dp-sink-sbc_xq"
 * @returns {?string} codec suffix, or null if the profile has none
 */
export function codecOfProfile(name) {
    if (typeof name !== 'string')
        return null;
    const match = name.match(/^(?:a2dp-sink|headset-head-unit)-(.+)$/);
    return match ? match[1] : null;
}

/**
 * Shorten a PipeWire profile description for display.
 * @param {object} profile
 * @returns {string}
 */
export function profileLabel(profile) {
    const description = profile?.description ?? '';
    let match = description.match(/^High Fidelity Playback \(A2DP Sink(?:, codec ([^)]+))?\)$/);
    if (match)
        return match[1] ? `A2DP · ${match[1]}` : 'A2DP';
    match = description.match(/^Headset Head Unit \(HSP\/HFP(?:, codec ([^)]+))?\)$/);
    if (match)
        return match[1] ? `Headset (HFP) · ${match[1]}` : 'Headset (HFP)';
    return description;
}

/**
 * Profiles usable for a slot's direction, best first.
 * @param {object} device
 * @param {'output'|'input'} direction
 * @returns {object[]}
 */
export function profilesForSlot(device, direction) {
    const classKey = direction === 'output' ? 'Audio/Sink' : 'Audio/Source';
    return device.profiles
        .filter(p => p.name !== 'off' && p.available !== 'no' && p.classes[classKey])
        .sort((a, b) => b.priority - a.priority);
}
