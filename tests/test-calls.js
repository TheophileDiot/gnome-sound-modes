import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {parseSnapshot} from '../lib/snapshot.js';
import {appKey, classifyStreams} from '../lib/calls.js';

function assert(cond, msg) {
    if (!cond)
        throw new Error(`assertion failed: ${msg}`);
}

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const [, bytes] = Gio.File.new_for_path(`${here}/fixtures/pw-dump-airpods-tonor-discord.json`).load_contents(null);
const snapshot = parseSnapshot(JSON.parse(new TextDecoder().decode(bytes)));

const discordOut = snapshot.streams.find(s => s.appBinary === 'Discord' && s.direction === 'output');
assert(appKey(discordOut) === 'com.discordapp.Discord', 'appKey prefers appId');

const noAppId = {appId: null, appBinary: 'foo', appName: 'Foo', pid: 42};
assert(appKey(noAppId) === 'foo', 'appKey falls back to appBinary');
assert(appKey({appId: null, appBinary: null, appName: 'Foo', pid: 42}) === 'Foo',
    'appKey falls back to appName');
assert(appKey({appId: null, appBinary: null, appName: null, pid: 42}) === 'pid:42',
    'appKey falls back to pid');

const {callStreams, apps, inCall} = classifyStreams(snapshot.streams);
assert(inCall === true, 'Discord streams put the session in a call');
const discordApp = apps.find(a => a.key === 'com.discordapp.Discord');
assert(discordApp.isCall, 'Discord app is flagged as a call');
assert(discordApp.reasons.includes('WebRTC audio engine'), 'flagged via the WEBRTC/VoiceEngine name rule');
assert(discordApp.reasons.includes('Microphone and speaker in use'), 'also flagged via the bidirectional rule');
assert(callStreams.some(s => s.id === discordOut.id), 'the discord output stream is in callStreams');
const discordIn = snapshot.streams.find(s => s.appBinary === 'Discord' && s.direction === 'input');
assert(callStreams.some(s => s.id === discordIn.id), 'the discord input stream is in callStreams');

const sd = snapshot.streams.find(s => s.appName === 'speech-dispatcher-dummy');
const sdApp = apps.find(a => a.key === appKey(sd));
assert(sdApp && !sdApp.isCall, 'a plain playback stream with no call signal is not a call');
assert(!callStreams.some(s => s.id === sd.id), 'its stream is excluded from callStreams');

// appBinary denylist: real desktop plumbing never shows up as an app at all
const plumbingStreams = [
    {id: 10, appId: null, appBinary: 'gnome-shell', appName: 'gnome-shell', pid: 5, role: null,
        isLive: true, monitor: false, direction: 'output'},
];
const plumbingResult = classifyStreams(plumbingStreams);
assert(plumbingResult.apps.length === 0, 'denylisted binaries are excluded from consideration entirely');

// role === 'Communication' rule
const roleStreams = [
    {id: 1, appId: 'com.example.softphone', appBinary: 'softphone', appName: 'Softphone',
        pid: 1, role: 'Communication', isLive: true, monitor: false, direction: 'output'},
];
const roleResult = classifyStreams(roleStreams);
assert(roleResult.apps[0].isCall && roleResult.apps[0].reasons.includes('Communication role'),
    'media.role Communication marks a call');

// bidirectional rule in isolation (no WEBRTC name)
const bidiStreams = [
    {id: 2, appId: 'app.a', appBinary: 'a', appName: 'App A', pid: 2, role: null,
        isLive: true, monitor: false, direction: 'output'},
    {id: 3, appId: 'app.a', appBinary: 'a', appName: 'App A', pid: 2, role: null,
        isLive: true, monitor: false, direction: 'input'},
];
const bidiResult = classifyStreams(bidiStreams);
assert(bidiResult.apps[0].isCall && bidiResult.apps[0].reasons.includes('Microphone and speaker in use'),
    'bidirectional live streams mark a call without a WEBRTC hint');

// monitor streams never count towards the bidirectional rule
const monitorStreams = [
    {id: 4, appId: 'app.b', appBinary: 'b', appName: 'App B', pid: 3, role: null,
        isLive: true, monitor: false, direction: 'output'},
    {id: 5, appId: 'app.b', appBinary: 'b', appName: 'App B', pid: 3, role: null,
        isLive: true, monitor: true, direction: 'input'},
];
const monitorResult = classifyStreams(monitorStreams);
assert(!monitorResult.apps[0].isCall, 'a monitor input stream does not make a bidirectional call');

// overrides: 'always' promotes, 'never' wins over every other rule
const overrideStreams = [
    {id: 6, appId: 'app.c', appBinary: 'c', appName: 'Plain Player', pid: 4, role: null,
        isLive: true, monitor: false, direction: 'output'},
];
const alwaysResult = classifyStreams(overrideStreams, {'app.c': 'always'});
assert(alwaysResult.apps[0].isCall && alwaysResult.apps[0].reasons.includes('Marked as call'),
    'override always forces a call classification');

const neverResult = classifyStreams(roleStreams, {'com.example.softphone': 'never'});
assert(!neverResult.apps[0].isCall, 'override never wins even over the Communication role rule');
assert(!neverResult.callStreams.some(s => s.id === 1), 'never-overridden app streams are excluded from callStreams');

print('test-calls: all checks passed');
