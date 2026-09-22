// Heuristics to spot which running apps are in a voice/video call, so a
// mode's "calls" effects scope knows which streams to route.

const WEBRTC_NAME = /webrtc|voiceengine/i;
const PLUMBING_BINARIES = new Set(['speech-dispatcher', 'gnome-shell', 'pipewire', 'wireplumber']);

/**
 * @param {object} stream
 * @returns {string} stable key identifying the owning app
 */
export function appKey(stream) {
    return stream.appId ?? stream.appBinary ?? stream.appName ?? `pid:${stream.pid}`;
}

function isConsidered(stream) {
    if (stream.monitor)
        return false;
    if (stream.appName === 'easyeffects' || stream.name?.startsWith('ee_'))
        return false;
    if (stream.appBinary && PLUMBING_BINARIES.has(stream.appBinary))
        return false;
    return true;
}

/**
 * Classify running streams into apps, flagging the ones in a call.
 * @param {object[]} streams
 * @param {Object<string, 'always'|'never'>} [overrides]
 * @returns {{callStreams: object[], apps: {key: string, name: string, isCall: boolean, reasons: string[]}[], inCall: boolean}}
 */
export function classifyStreams(streams, overrides = {}) {
    const considered = streams.filter(isConsidered);
    const byKey = new Map();

    for (const stream of considered) {
        const key = appKey(stream);
        if (!byKey.has(key))
            byKey.set(key, {key, name: stream.appName ?? key, streams: [], reasons: new Set()});
        byKey.get(key).streams.push(stream);
    }

    for (const app of byKey.values()) {
        for (const stream of app.streams) {
            if (stream.role === 'Communication')
                app.reasons.add('Communication role');
            if (WEBRTC_NAME.test(stream.appName ?? ''))
                app.reasons.add('WebRTC audio engine');
        }
        const hasLiveOutput = app.streams.some(s => s.direction === 'output' && s.isLive && !s.monitor);
        const hasLiveInput = app.streams.some(s => s.direction === 'input' && s.isLive && !s.monitor);
        if (hasLiveOutput && hasLiveInput)
            app.reasons.add('Microphone and speaker in use');
        if (overrides[app.key] === 'always')
            app.reasons.add('Marked as call');
    }

    const apps = [];
    const callStreams = [];
    for (const app of byKey.values()) {
        const isCall = overrides[app.key] === 'never' ? false : app.reasons.size > 0;
        apps.push({key: app.key, name: app.name, isCall, reasons: [...app.reasons]});
        if (isCall)
            callStreams.push(...app.streams);
    }

    return {callStreams, apps, inCall: apps.some(a => a.isCall)};
}
