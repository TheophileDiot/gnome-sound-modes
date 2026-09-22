import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {parseSnapshot} from '../lib/snapshot.js';
import {parseVersion, parseFlatpakInfo, presetDirsFor, isRunning, describeSupport, APP_ID} from '../lib/easyeffects.js';

function assert(cond, msg) {
    if (!cond)
        throw new Error(`assertion failed: ${msg}`);
}

assert(parseVersion('7.1.6\n').version === '7.1.6', 'parses native version string');
assert(parseVersion('7.1.6\n').major === 7, 'extracts major from version string');
assert(parseVersion('EasyEffects 8.2.9').major === 8, 'parses major 8');
assert(parseVersion('').major === null && parseVersion('').version === null, 'empty output means unknown');
assert(parseVersion(null).major === null, 'null output does not throw');
assert(parseVersion('garbage').major === null, 'non-numeric output means unknown');

const home = '/home/fixture-user';

const nativeSeven = presetDirsFor('native', 7, home);
assert(nativeSeven.output[0] === `${home}/.config/easyeffects/output`, 'native 7.x output dir');
assert(nativeSeven.input[0] === `${home}/.config/easyeffects/input`, 'native 7.x input dir');

const nativeEight = presetDirsFor('native', 8, home);
assert(nativeEight.output[0] === `${home}/.local/share/easyeffects/output`, 'native 8.x output dir');
assert(nativeEight.input[0] === `${home}/.local/share/easyeffects/input`, 'native 8.x input dir');

const flatpakSeven = presetDirsFor('flatpak', 7, home);
assert(flatpakSeven.output[0] === `${home}/.var/app/${APP_ID}/config/easyeffects/output`, 'flatpak 7.x output dir');
assert(flatpakSeven.input[0] === `${home}/.var/app/${APP_ID}/config/easyeffects/input`, 'flatpak 7.x input dir');

const flatpakEight = presetDirsFor('flatpak', 8, home);
assert(flatpakEight.output[0] === `${home}/.var/app/${APP_ID}/data/easyeffects/output`, 'flatpak 8.x output dir');
assert(flatpakEight.input[0] === `${home}/.var/app/${APP_ID}/data/easyeffects/input`, 'flatpak 8.x input dir');

assert(parseFlatpakInfo('        ID: com.github.wwmm.easyeffects\n   Version: 7.1.6\n') === '7.1.6',
    'the flatpak info version line is parsed');
assert(parseVersion(parseFlatpakInfo('Version: 8.2.9')).major === 8, 'and feeds parseVersion');
assert(parseFlatpakInfo('Ref: app/com.github.wwmm.easyeffects') === null, 'no version line means null');
assert(parseFlatpakInfo(null) === null, 'missing output does not throw');

// both packagings' preset roots are offered, the flavour's own first
assert(nativeSeven.output.includes(`${home}/.var/app/${APP_ID}/config/easyeffects/output`),
    'a native install still sees flatpak presets');
assert(flatpakSeven.output[1] === `${home}/.config/easyeffects/output`,
    'and a flatpak install still sees native ones');

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const [, bytes] = Gio.File.new_for_path(`${here}/fixtures/pw-dump-airpods-tonor-discord.json`).load_contents(null);
const snapshot = parseSnapshot(JSON.parse(new TextDecoder().decode(bytes)));

assert(isRunning(snapshot), 'fixture has both easyeffects nodes running');

const withoutSource = {...snapshot, endpoints: snapshot.endpoints.filter(e => e.name !== 'easyeffects_source')};
assert(!isRunning(withoutSource), 'missing source node means not running');

const neither = {...snapshot, endpoints: snapshot.endpoints.filter(e => !e.name.startsWith('easyeffects_'))};
assert(!isRunning(neither), 'no easyeffects nodes means not running');

// describeSupport: one reasonCode per unsupported branch, null when fully
// supported. `detect()` itself covers 'not-installed' (no flavour at all).
assert(describeSupport('native', 8).reasonCode === 'v8-no-process-all', 'native 8.x -> v8-no-process-all');
assert(describeSupport('flatpak', 8).reasonCode === 'v8-no-process-all', 'flatpak 8.x -> v8-no-process-all too');
assert(describeSupport('native', null).reasonCode === 'unknown-version', 'unknown major -> unknown-version');
assert(describeSupport('flatpak', 7).reasonCode === 'flatpak-no-gsettings', 'flatpak 7.x -> flatpak-no-gsettings');
assert(describeSupport('native', 7).reasonCode === null, 'native 7.x is fully supported, no reasonCode');
assert(describeSupport('native', 7).reason === null, 'native 7.x is fully supported, no reason string');
for (const [flavour, major] of [['native', 8], ['flatpak', 8], ['native', null], ['flatpak', 7]]) {
    const {reason, reasonCode} = describeSupport(flavour, major);
    assert(typeof reason === 'string' && reason.length > 0, `${flavour}/${major} keeps its human-readable reason`);
    assert(typeof reasonCode === 'string', `${flavour}/${major} has a reasonCode alongside the reason`);
}

print('test-easyeffects: all checks passed');
