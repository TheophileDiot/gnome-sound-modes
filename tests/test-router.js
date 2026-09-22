import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {parseSnapshot} from '../lib/snapshot.js';
import {createMode} from '../lib/model.js';
import {SINK, SOURCE} from '../lib/easyeffects.js';
import {Router} from '../lib/router.js';

function assert(cond, msg) {
    if (!cond)
        throw new Error(`assertion failed: ${msg}`);
}

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const [, bytes] = Gio.File.new_for_path(`${here}/fixtures/pw-dump-airpods-tonor-discord.json`).load_contents(null);
const routed = parseSnapshot(JSON.parse(new TextDecoder().decode(bytes)));

const discordOut = routed.streams.find(s => s.appBinary === 'Discord' && s.direction === 'output');
const discordIn = routed.streams.find(s => s.appBinary === 'Discord' && s.direction === 'input');
const speech = routed.streams.find(s => s.appName === 'speech-dispatcher-dummy');

assert(discordOut.target === SINK && discordIn.target === SOURCE,
    'the fixture already has both Discord streams on the EasyEffects nodes');

function withTargets(snapshot, targets) {
    return {
        ...snapshot,
        streams: snapshot.streams.map(s => (s.id in targets ? {...s, target: targets[s.id]} : s)),
    };
}

function fakePipeWire() {
    const calls = [];
    return {
        calls,
        async setTarget(streamId, nodeName) {
            calls.push(['setTarget', streamId, nodeName]);
        },
        async clearTarget(streamId) {
            calls.push(['clearTarget', streamId]);
        },
    };
}

const callsMode = createMode({
    name: 'Calls',
    output: {match: {'device.name': 'whatever'}, profile: null},
    effects: {enabled: true, scope: 'calls', outputPreset: null, inputPreset: null},
});
const allMode = createMode({
    name: 'Music',
    output: {match: {'device.name': 'whatever'}, profile: null},
    effects: {enabled: true, scope: 'all', outputPreset: null, inputPreset: null},
});
const plainMode = createMode({
    name: 'Plain',
    output: {match: {'device.name': 'whatever'}, profile: null},
});

const loop = GLib.MainLoop.new(null, false);

async function main() {
    // --- already routed: nothing to do ---------------------------------

    {
        const pipewire = fakePipeWire();
        const result = await new Router(pipewire).sync(routed, callsMode, {});
        assert(pipewire.calls.length === 0, `an already matching snapshot issues no command, got ${pipewire.calls.length}`);
        assert(result.moved === 0 && result.cleared === 0, 'and reports no change');
    }

    // --- only the call streams are moved to EasyEffects -----------------

    {
        const unrouted = withTargets(routed, {[discordOut.id]: null, [discordIn.id]: null});
        const pipewire = fakePipeWire();
        const result = await new Router(pipewire).sync(unrouted, callsMode, {});

        assert(result.moved === 2 && result.cleared === 0, `both Discord streams moved, got ${JSON.stringify(result)}`);
        assert(pipewire.calls.length === 2, 'the untargeted playback stream is left alone');
        const byId = new Map(pipewire.calls.map(c => [c[1], c[2]]));
        assert(byId.get(discordOut.id) === SINK, 'the output stream goes to the EasyEffects sink');
        assert(byId.get(discordIn.id) === SOURCE, 'the input stream goes to the EasyEffects source');
        assert(!byId.has(speech.id), 'the speech-dispatcher stream is not a call and is not moved');
    }

    // --- a non-call stream sitting on EasyEffects is cleared ------------

    {
        const stray = withTargets(routed, {[speech.id]: SINK});
        const pipewire = fakePipeWire();
        const result = await new Router(pipewire).sync(stray, callsMode, {});

        assert(result.cleared === 1 && result.moved === 0, 'the stray stream is cleared');
        assert(pipewire.calls[0][0] === 'clearTarget' && pipewire.calls[0][1] === speech.id,
            'and it is the speech-dispatcher stream');
    }

    // --- overrides are honoured -----------------------------------------

    {
        const unrouted = withTargets(routed, {[discordOut.id]: null, [discordIn.id]: null});
        const pipewire = fakePipeWire();
        await new Router(pipewire).sync(unrouted, callsMode, {'com.discordapp.Discord': 'never'});
        assert(pipewire.calls.length === 0, 'an app marked "never" is not routed');
    }

    // --- scope "all" leaves every target alone --------------------------

    {
        const stray = withTargets(routed, {[speech.id]: SINK});
        const pipewire = fakePipeWire();
        const result = await new Router(pipewire).sync(stray, allMode, {});
        assert(pipewire.calls.length === 0, 'EasyEffects owns the targets in the "all" scope');
        assert(result.moved === 0 && result.cleared === 0, 'and nothing is reported');
    }

    // --- effects off, or no mode at all, clears our targets -------------

    {
        const pipewire = fakePipeWire();
        const result = await new Router(pipewire).sync(routed, plainMode, {});
        assert(result.cleared === 2, 'a mode without effects clears both Discord targets');
        assert(pipewire.calls.every(c => c[0] === 'clearTarget'), 'only clears, never moves');

        const none = fakePipeWire();
        assert((await new Router(none).sync(routed, null, {})).cleared === 2, 'no mode clears them too');
    }

    // --- calls scope with EasyEffects down also clears -------------------

    {
        const down = {...routed, endpoints: routed.endpoints.filter(e => !e.name.startsWith('easyeffects_'))};
        const pipewire = fakePipeWire();
        const result = await new Router(pipewire).sync(down, callsMode, {});
        assert(result.cleared === 2 && result.moved === 0,
            'streams are not left pointing at nodes that are gone');
    }

    // --- reset clears everything ----------------------------------------

    {
        const pipewire = fakePipeWire();
        const result = await new Router(pipewire).reset(routed);
        assert(result.cleared === 2, 'reset clears every EasyEffects target');
        assert(pipewire.calls.every(c => c[0] === 'clearTarget'), 'reset only clears');
    }

    print('test-router: all checks passed');
    loop.quit();
}

main().catch(e => {
    printerr(`test-router: FAILED: ${e.message}`);
    printerr(e.stack);
    loop.quit();
    imports.system.exit(1);
});
loop.run();
