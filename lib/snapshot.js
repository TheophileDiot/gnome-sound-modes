// Pure parser for `pw-dump` JSON. No GNOME Shell imports: shared by the
// extension, the preferences process and the unit tests.

const DEVICE = 'PipeWire:Interface:Device';
const NODE = 'PipeWire:Interface:Node';
const METADATA = 'PipeWire:Interface:Metadata';

const DEVICE_MATCH_KEYS = [
    'device.name', 'device.description', 'device.api', 'device.form-factor',
    'device.vendor.id', 'device.product.id', 'device.serial', 'device.bus-path',
    'api.bluez5.address',
];

/**
 * Parse raw `pw-dump` output. When the graph changes while pw-dump runs it
 * prints several top-level JSON arrays back to back, so a plain JSON.parse
 * fails; each array is parsed on its own and later entries win by id.
 * @param {string} text
 * @returns {Array}
 */
export function parseDumpText(text) {
    try {
        return JSON.parse(text);
    } catch {
        // fall through to the chunked parse
    }
    const byId = new Map();
    let depth = 0;
    let inString = false;
    let escaped = false;
    let start = -1;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (c === '\\')
                escaped = true;
            else if (c === '"')
                inString = false;
            continue;
        }
        if (c === '"') {
            inString = true;
        } else if (c === '[' || c === '{') {
            if (depth === 0)
                start = i;
            depth++;
        } else if (c === ']' || c === '}') {
            depth--;
            if (depth === 0 && start >= 0) {
                const chunk = JSON.parse(text.slice(start, i + 1));
                for (const obj of Array.isArray(chunk) ? chunk : [chunk]) {
                    if (obj && typeof obj.id === 'number')
                        byId.set(obj.id, obj);
                }
                start = -1;
            }
        }
    }
    return [...byId.values()];
}

/** Strip the `.N` suffix PipeWire appends when a node name collides. */
export function stripNodeSuffix(name) {
    return typeof name === 'string' ? name.replace(/\.\d+$/, '') : name;
}

function profileClasses(classes) {
    // ALSA: [count, ["Audio/Sink", 1, ...], ...]; bluez5: [["Audio/Sink", 1, ...], ...]
    const out = {};
    for (const entry of classes ?? []) {
        if (Array.isArray(entry) && typeof entry[0] === 'string')
            out[entry[0]] = entry[1] ?? 0;
    }
    return out;
}

function parseProfile(raw) {
    return {
        index: raw.index,
        name: raw.name,
        description: raw.description ?? raw.name,
        priority: raw.priority ?? 0,
        available: raw.available ?? 'unknown',
        classes: profileClasses(raw.classes),
    };
}

function parseDevice(obj) {
    const props = obj.info?.props ?? {};
    const params = obj.info?.params ?? {};
    const profiles = (params.EnumProfile ?? []).map(parseProfile);
    const active = params.Profile?.[0]?.name ?? null;
    const match = {};
    for (const key of DEVICE_MATCH_KEYS) {
        if (props[key] !== undefined)
            match[key] = props[key];
    }
    return {
        id: obj.id,
        serial: props['object.serial'] ?? null,
        name: props['device.name'] ?? null,
        description: props['device.description'] ?? props['device.nick'] ?? props['device.name'] ?? '',
        api: props['device.api'] ?? null,
        formFactor: props['device.form-factor'] ?? null,
        vendorId: props['device.vendor.id'] ?? null,
        productId: props['device.product.id'] ?? null,
        deviceSerial: props['device.serial'] ?? null,
        busPath: props['device.bus-path'] ?? null,
        bluezAddress: props['api.bluez5.address'] ?? null,
        profiles,
        activeProfile: active,
        match,
        props,
    };
}

function parseNode(obj) {
    const props = obj.info?.props ?? {};
    const mediaClass = props['media.class'] ?? '';
    const base = {
        id: obj.id,
        serial: props['object.serial'] ?? null,
        name: props['node.name'] ?? null,
        description: props['node.description'] ?? props['node.nick'] ?? props['node.name'] ?? '',
        nick: props['node.nick'] ?? null,
        mediaClass,
        props,
    };
    const isSink = mediaClass === 'Audio/Sink' || mediaClass.startsWith('Audio/Sink/');
    const isSource = mediaClass === 'Audio/Source' || mediaClass.startsWith('Audio/Source/');
    if (isSink || isSource) {
        return {
            ...base,
            kind: 'endpoint',
            direction: isSink ? 'output' : 'input',
            deviceId: props['device.id'] ?? null,
            virtual: props['node.virtual'] === true || mediaClass.endsWith('/Virtual'),
            bluez: props['api.bluez5.profile'] ? {
                profile: props['api.bluez5.profile'],
                codec: props['api.bluez5.codec'] ?? null,
                address: props['api.bluez5.address'] ?? null,
            } : null,
        };
    }
    if (mediaClass.startsWith('Stream/')) {
        return {
            ...base,
            kind: 'stream',
            direction: mediaClass.startsWith('Stream/Output') ? 'output' : 'input',
            appName: props['application.name'] ?? null,
            appBinary: props['application.process.binary'] ?? null,
            appId: props['pipewire.access.portal.app_id'] ?? props['application.id'] ?? null,
            pid: props['application.process.id'] ?? null,
            role: props['media.role'] ?? null,
            mediaName: props['media.name'] ?? null,
            category: props['media.category'] ?? null,
            isLive: props['stream.is-live'] === true,
            monitor: props['stream.monitor'] === true || props['node.passive'] === true,
            target: null,
            targetNode: null,
        };
    }
    return null;
}

function metadataValue(entry) {
    const v = entry.value;
    if (v && typeof v === 'object' && 'name' in v)
        return v.name;
    return v ?? null;
}

/**
 * Parse the output of `pw-dump` (already JSON.parse'd) into a snapshot.
 * @param {Array} objects
 * @returns {{devices: Array, endpoints: Array, streams: Array, defaults: object, metadataId: number|null}}
 */
export function parseSnapshot(objects) {
    const devices = [];
    const endpoints = [];
    const streams = [];
    const defaults = {sink: null, source: null, configuredSink: null, configuredSource: null};
    let metadataId = null;
    const targets = new Map();

    for (const obj of objects ?? []) {
        if (obj.type === DEVICE) {
            devices.push(parseDevice(obj));
        } else if (obj.type === NODE) {
            const node = parseNode(obj);
            if (node?.kind === 'endpoint')
                endpoints.push(node);
            else if (node?.kind === 'stream')
                streams.push(node);
        } else if (obj.type === METADATA && obj.props?.['metadata.name'] === 'default') {
            metadataId = obj.id;
            for (const entry of obj.metadata ?? []) {
                const value = metadataValue(entry);
                if (entry.subject === 0) {
                    if (entry.key === 'default.audio.sink') defaults.sink = value;
                    else if (entry.key === 'default.audio.source') defaults.source = value;
                    else if (entry.key === 'default.configured.audio.sink') defaults.configuredSink = value;
                    else if (entry.key === 'default.configured.audio.source') defaults.configuredSource = value;
                } else if (entry.key === 'target.object' || entry.key === 'target.node') {
                    const t = targets.get(entry.subject) ?? {};
                    t[entry.key] = value;
                    targets.set(entry.subject, t);
                }
            }
        }
    }

    const bySerial = new Map(endpoints.map(e => [String(e.serial), e]));
    const byId = new Map(endpoints.map(e => [e.id, e]));
    for (const stream of streams) {
        const t = targets.get(stream.id);
        if (!t)
            continue;
        const raw = t['target.object'];
        if (raw !== undefined && raw !== null) {
            // target.object is a serial (number) or a node.name (string)
            const ep = bySerial.get(String(raw));
            stream.target = ep ? ep.name : String(raw);
        } else if (t['target.node'] !== undefined && t['target.node'] !== null) {
            const ep = byId.get(Number(t['target.node']));
            stream.targetNode = ep ? ep.name : null;
            stream.target = stream.target ?? stream.targetNode;
        }
    }

    return {devices, endpoints, streams, defaults, metadataId};
}

export function findDeviceByName(snapshot, name) {
    return snapshot.devices.find(d => d.name === name) ?? null;
}

export function findEndpointByName(snapshot, name) {
    return snapshot.endpoints.find(e => e.name === name) ?? null;
}

export function endpointsForDevice(snapshot, device, direction = null) {
    return snapshot.endpoints.filter(e =>
        e.deviceId === device.id && (direction === null || e.direction === direction));
}
