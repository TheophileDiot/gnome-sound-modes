import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ICONS} from '../lib/model.js';
import {MODE_ICONS, gioIcon, iconForStatus, iconNameForMode} from '../ui/icons.js';

function assert(cond, msg) {
    if (!cond)
        throw new Error(`assertion failed: ${msg}`);
}

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const extensionPath = GLib.path_get_dirname(here);
const iconsDir = `${extensionPath}/icons`;

// -- every custom icon referenced from code exists in icons/ --------------

const referenced = new Set();
for (const {name} of MODE_ICONS) {
    if (name.startsWith('sound-modes-'))
        referenced.add(`${name}-symbolic`);
}
referenced.add('sound-modes-headphones-call-symbolic');
referenced.add('sound-modes-call-symbolic');
referenced.add('sound-modes-warning-symbolic');
referenced.add('sound-modes-custom-symbolic');

for (const name of referenced) {
    const file = Gio.File.new_for_path(`${iconsDir}/${name}.svg`);
    assert(file.query_exists(null), `${name}.svg exists in icons/`);
}

// -- every SVG in icons/ is a clean 16x16 symbolic, no strokes/gradients --

const enumerator = Gio.File.new_for_path(iconsDir).enumerate_children(
    'standard::name', Gio.FileQueryInfoFlags.NONE, null);
const svgNames = [];
let info;
while ((info = enumerator.next_file(null)) !== null) {
    if (info.get_name().endsWith('.svg'))
        svgNames.push(info.get_name());
}
assert(svgNames.length === 10, `10 custom icon files delivered, found ${svgNames.length}`);

for (const name of svgNames) {
    const [, bytes] = Gio.File.new_for_path(`${iconsDir}/${name}`).load_contents(null);
    const text = new TextDecoder().decode(bytes);

    // parses as XML: every opening tag has a matching, correctly nested close
    const stack = [];
    const tagRe = /<(\/?)([a-zA-Z][\w:-]*)\b[^>]*?(\/?)>/g;
    let m;
    while ((m = tagRe.exec(text)) !== null) {
        const [, closing, tag, selfClosing] = m;
        if (closing)
            assert(stack.pop() === tag, `${name} has a matching close for </${tag}>`);
        else if (!selfClosing)
            stack.push(tag);
    }
    assert(stack.length === 0, `${name} has every tag closed`);

    assert(/viewBox="0 0 16 16"/.test(text), `${name} has a 16x16 viewBox`);
    assert(!/\bstroke=/.test(text), `${name} has no stroke attribute`);
    assert(!/<linearGradient/.test(text), `${name} has no linearGradient`);
}

// -- MODE_ICONS is derived from lib/model.js ICONS, never a second list --

assert(MODE_ICONS.length === ICONS.length,
    `MODE_ICONS covers every ICONS entry, got ${MODE_ICONS.length} of ${ICONS.length}`);
for (const [i, entry] of MODE_ICONS.entries()) {
    assert(entry.label === ICONS[i].label,
        `MODE_ICONS[${i}] keeps the ICONS label, got "${entry.label}" vs "${ICONS[i].label}"`);
    assert(entry.name === iconNameForMode(ICONS[i].name).replace(/-symbolic$/, ''),
        `MODE_ICONS[${i}] maps through the same table as iconNameForMode`);
}

// -- every ICONS entry resolves to a glyph we ship or a real Adwaita icon --

const adwaitaRoot = '/usr/share/icons/Adwaita/symbolic';
const adwaitaNames = new Set();
const adwaitaDir = Gio.File.new_for_path(adwaitaRoot);
if (adwaitaDir.query_exists(null)) {
    const categories = adwaitaDir.enumerate_children(
        'standard::name', Gio.FileQueryInfoFlags.NONE, null);
    let category;
    while ((category = categories.next_file(null)) !== null) {
        let files;
        try {
            files = Gio.File.new_for_path(`${adwaitaRoot}/${category.get_name()}`).enumerate_children(
                'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        } catch {
            continue;
        }
        let file;
        while ((file = files.next_file(null)) !== null) {
            if (file.get_name().endsWith('.svg'))
                adwaitaNames.add(file.get_name().slice(0, -'.svg'.length));
        }
    }
}

for (const {name} of ICONS) {
    const resolved = iconNameForMode(name);
    if (resolved.startsWith('sound-modes-')) {
        assert(Gio.File.new_for_path(`${iconsDir}/${resolved}.svg`).query_exists(null),
            `${name} resolves to a delivered glyph (${resolved}.svg)`);
    } else if (adwaitaNames.size > 0) {
        // Skipped silently when the Adwaita theme is not installed.
        assert(adwaitaNames.has(resolved), `${name} resolves to an Adwaita icon (${resolved})`);
    }
}

// -- iconNameForMode ---------------------------------------------------

assert(iconNameForMode('audio-headphones') === 'sound-modes-headphones-symbolic', 'headphones mapped');
assert(iconNameForMode('bluetooth-active') === 'sound-modes-earbuds-symbolic', 'bluetooth-active mapped to earbuds');
assert(iconNameForMode('phone') === 'sound-modes-headset-symbolic', 'phone mapped to headset');
assert(iconNameForMode('call-start') === 'sound-modes-call-symbolic', 'call-start mapped to call');
assert(iconNameForMode('camera-web') === 'camera-web-symbolic', 'unmapped base falls back to Adwaita name');
// Controller._modeSummary hands out names that already carry the suffix.
assert(iconNameForMode('audio-headphones-symbolic') === 'sound-modes-headphones-symbolic',
    'a name that already ends in -symbolic is not suffixed twice');

// -- gioIcon --------------------------------------------------------------

const custom = gioIcon('sound-modes-headphones-symbolic', extensionPath);
assert(custom instanceof Gio.FileIcon, 'custom icon is a Gio.FileIcon');
assert(custom.get_file().get_path() === `${extensionPath}/icons/sound-modes-headphones-symbolic.svg`,
    'FileIcon points at icons/<name>.svg');

const themed = gioIcon('camera-web-symbolic', extensionPath);
assert(themed instanceof Gio.ThemedIcon, 'Adwaita name is a Gio.ThemedIcon');
assert(themed.get_names().includes('camera-web-symbolic'), 'ThemedIcon carries the requested name');

// -- iconForStatus ----------------------------------------------------

function filePathOf(icon) {
    assert(icon instanceof Gio.FileIcon, 'expected a custom file icon');
    return icon.get_file().get_path();
}

const headphonesMode = {id: 'm1', icon: 'audio-headphones'};
const speakersMode = {id: 'm2', icon: 'audio-speakers'};
const baseStatus = {modes: [headphonesMode, speakersMode], activeModeId: 'm1', inCall: false};

assert(filePathOf(iconForStatus({...baseStatus, state: 'ok'}, extensionPath))
    === `${extensionPath}/icons/sound-modes-headphones-symbolic.svg`, 'ok state shows the active mode icon');

assert(filePathOf(iconForStatus({...baseStatus, state: 'applying'}, extensionPath))
    === `${extensionPath}/icons/sound-modes-headphones-symbolic.svg`, 'applying shows the base icon');

assert(filePathOf(iconForStatus({...baseStatus, state: 'ok', inCall: true}, extensionPath))
    === `${extensionPath}/icons/sound-modes-headphones-call-symbolic.svg`,
    'in-call with a headphones base uses the headphones-call badge');

assert(filePathOf(iconForStatus({...baseStatus, state: 'ok', inCall: true, activeModeId: 'm2'}, extensionPath))
    === `${extensionPath}/icons/sound-modes-call-symbolic.svg`, 'in-call with a non-headphones base uses the call glyph');

assert(filePathOf(iconForStatus({...baseStatus, state: 'failed'}, extensionPath))
    === `${extensionPath}/icons/sound-modes-warning-symbolic.svg`, 'failed state shows the warning icon');

assert(filePathOf(iconForStatus({...baseStatus, state: 'missing'}, extensionPath))
    === `${extensionPath}/icons/sound-modes-warning-symbolic.svg`, 'missing state shows the warning icon');

assert(filePathOf(iconForStatus({...baseStatus, state: 'custom', activeModeId: null}, extensionPath))
    === `${extensionPath}/icons/sound-modes-custom-symbolic.svg`, 'custom state shows the custom icon');

assert(filePathOf(iconForStatus({...baseStatus, state: 'idle', activeModeId: null}, extensionPath))
    === `${extensionPath}/icons/sound-modes-custom-symbolic.svg`, 'idle state shows the custom icon');

const fallbackStatus = {
    modes: [{id: 'm3', icon: 'camera-web'}], activeModeId: 'm3', inCall: false, state: 'ok',
};
const fallbackIcon = iconForStatus(fallbackStatus, extensionPath);
assert(fallbackIcon instanceof Gio.ThemedIcon, 'a mode icon with no custom glyph falls back to a themed icon');
assert(fallbackIcon.get_names().includes('camera-web-symbolic'), 'fallback themed icon carries the Adwaita name');

print('test-icons: all checks passed');
