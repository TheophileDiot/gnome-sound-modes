// EasyEffects backend. Supports both the 7.x (GTK, GSettings-based) and the
// 8.x (Qt, JSON-db-based) rewrite, native or Flatpak. No shell imports.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {run, spawnDetached} from './subprocess.js';
import {warn} from './log.js';

export const SINK = 'easyeffects_sink';
export const SOURCE = 'easyeffects_source';
export const APP_ID = 'com.github.wwmm.easyeffects';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async', 'next_files_finish');

let cached = null;

function ensureCache() {
    if (!cached)
        throw new Error('easyeffects.detect() must be called before this');
    return cached;
}

/** Parse an `easyeffects --version` output like `7.1.6\n` (or empty). */
export function parseVersion(output) {
    const match = (output ?? '').match(/(\d+)\.(\d+)\.(\d+)/);
    return match ? {version: match[0], major: Number(match[1])} : {version: null, major: null};
}

/** Version line of `flatpak info <app>`, or null when it has none. */
export function parseFlatpakInfo(text) {
    const match = (text ?? '').match(/^[ \t]*Version:[ \t]*(\S+)/m);
    return match ? match[1] : null;
}

/**
 * Where presets live for a given install flavour and major version. Both
 * roots are returned, the flavour's own first: a machine that once had the
 * other packaging still has its presets, and listing skips what is absent.
 * @param {'native'|'flatpak'} flavour
 * @param {number} major
 * @param {string} home
 */
export function presetDirsFor(flavour, major, home) {
    const flatpakRoot = `${home}/.var/app/${APP_ID}`;
    const native = major >= 8 ? `${home}/.local/share/easyeffects` : `${home}/.config/easyeffects`;
    const flatpak = major >= 8 ? `${flatpakRoot}/data/easyeffects` : `${flatpakRoot}/config/easyeffects`;
    const roots = flavour === 'flatpak' ? [flatpak, native] : [native, flatpak];
    return {output: roots.map(root => `${root}/output`), input: roots.map(root => `${root}/input`)};
}

/**
 * Whether process-all routing can be toggled for this install, and why
 * not when it can't. Pure and separate from `detect()` so each branch is
 * directly testable without spawning anything.
 * @param {'native'|'flatpak'} flavour
 * @param {number|null} major
 * @returns {{reason: string|null, reasonCode: ('unknown-version'|'v8-no-process-all'|'flatpak-no-gsettings'|null)}}
 */
export function describeSupport(flavour, major) {
    if (major === 8) {
        return {
            reason: 'EasyEffects 8.x cannot toggle process-all routing from an extension yet',
            reasonCode: 'v8-no-process-all',
        };
    }
    if (major === null) {
        return {
            reason: 'EasyEffects version could not be determined; assuming a 7.x preset layout',
            reasonCode: 'unknown-version',
        };
    }
    if (flavour === 'flatpak') {
        return {
            reason: 'process-all can only be changed for a native install (needs GSettings)',
            reasonCode: 'flatpak-no-gsettings',
        };
    }
    return {reason: null, reasonCode: null};
}

/** `true` when both the EasyEffects sink and source nodes are present. */
export function isRunning(snapshot) {
    return snapshot.endpoints.some(e => e.name === SINK) &&
        snapshot.endpoints.some(e => e.name === SOURCE);
}

async function guessMajor(flavour, cancellable) {
    if (flavour === 'native') {
        const schema = Gio.SettingsSchemaSource.get_default()?.lookup(APP_ID, true);
        return schema ? 7 : 8;
    }
    // Flatpak has no host-visible schema; 8.x never touches dconf at all, so
    // a readable legacy key is decent evidence this is still a 7.x install.
    try {
        const path = `/${APP_ID.replaceAll('.', '/')}/last-used-output-preset`;
        const {ok, stdout} = await run(['dconf', 'read', path], {cancellable, timeoutMs: 3000});
        return ok && stdout.trim() ? 7 : 8;
    } catch {
        return null;
    }
}

function nativeSettings() {
    const schema = Gio.SettingsSchemaSource.get_default()?.lookup(APP_ID, true);
    return schema ? new Gio.Settings({settingsSchema: schema}) : null;
}

async function runTool(argv, timeoutMs, cancellable) {
    const result = await run(argv, {timeoutMs, cancellable});
    if (!result.ok)
        throw new Error(`${argv.join(' ')} failed: ${result.stderr.trim() || `exit code ${result.status}`}`);
    return result;
}

/**
 * Detect the installed EasyEffects, if any, and cache the result for the
 * other functions in this module.
 * @returns {Promise<object>} install info
 */
export async function detect(cancellable = null) {
    const home = GLib.get_home_dir();
    let flavour = null;
    let argv = null;

    let flatpakVersion = null;

    if (GLib.find_program_in_path('easyeffects')) {
        flavour = 'native';
        argv = ['easyeffects'];
    } else {
        try {
            const {ok, stdout} = await run(['flatpak', 'info', APP_ID], {cancellable, timeoutMs: 4000});
            if (ok) {
                flavour = 'flatpak';
                argv = ['flatpak', 'run', APP_ID];
                flatpakVersion = parseFlatpakInfo(stdout);
            }
        } catch {
            // flatpak missing, or the lookup itself failed: treat as absent
        }
    }

    if (!flavour) {
        cached = {
            installed: false, flavour: null, major: null, version: null, argv: null,
            presetDirs: {output: [], input: []}, canLoadPreset: false, canSetProcessAll: false,
            reason: 'EasyEffects is not installed', reasonCode: 'not-installed',
        };
        return cached;
    }

    // `flatpak info` already reported the version; running the app just to
    // ask again would start a sandbox for nothing.
    const versionOut = flavour === 'flatpak'
        ? flatpakVersion ?? ''
        : await run([...argv, '--version'], {cancellable, timeoutMs: 4000})
            .then(r => r.stdout).catch(() => '');
    let {version, major} = parseVersion(versionOut);
    if (major === null)
        major = await guessMajor(flavour, cancellable);

    const presetDirs = presetDirsFor(flavour, major ?? 7, home);
    const canSetProcessAll = flavour === 'native' && major === 7;
    const {reason, reasonCode} = describeSupport(flavour, major);

    cached = {
        installed: true, flavour, major, version, argv, presetDirs, canLoadPreset: true, canSetProcessAll,
        reason, reasonCode,
    };
    return cached;
}

/**
 * List preset names (without `.json`) for one direction.
 * @param {'output'|'input'} kind
 * @param {Gio.Cancellable|null} [cancellable]
 * @returns {Promise<string[]>}
 */
export async function listPresets(kind, cancellable = null) {
    const {presetDirs} = ensureCache();
    const names = new Set();
    for (const dir of presetDirs[kind] ?? []) {
        let enumerator;
        try {
            enumerator = await Gio.File.new_for_path(dir).enumerate_children_async(
                'standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
        } catch {
            continue;
        }
        for (;;) {
            const infos = await enumerator.next_files_async(100, GLib.PRIORITY_DEFAULT, cancellable);
            if (infos.length === 0)
                break;
            for (const info of infos) {
                const name = info.get_name();
                if (name.endsWith('.json'))
                    names.add(name.slice(0, -'.json'.length));
            }
        }
    }
    return [...names].sort();
}

/**
 * Load a preset by name. Warns (does not fail) when the name exists on both
 * sides, since `-l` only ever loads one of them.
 * @param {'output'|'input'} kind
 * @param {string} name
 */
export async function loadPreset(kind, name, cancellable = null) {
    const {argv} = ensureCache();
    const otherKind = kind === 'output' ? 'input' : 'output';
    const otherNames = await listPresets(otherKind, cancellable).catch(() => []);
    if (otherNames.includes(name)) {
        warn(`preset "${name}" exists in both output and input presets; loading it as ${kind}`);
    }
    await runTool([...argv, '-l', name], 8000, cancellable);
}

/** Start EasyEffects as a background service if its nodes aren't up yet. */
export async function ensureRunning(snapshot) {
    const {argv} = ensureCache();
    if (isRunning(snapshot))
        return;
    spawnDetached([...argv, '--gapplication-service']);
}

/** Enable or disable EasyEffects' global bypass. */
export async function setBypass(bypass, cancellable = null) {
    const {argv} = ensureCache();
    await runTool([...argv, '-b', bypass ? '1' : '2'], 5000, cancellable);
}

/** Current process-all-{outputs,inputs} state, or `null` when unreadable. */
export function getProcessAll() {
    const info = ensureCache();
    if (info.flavour !== 'native' || info.major !== 7)
        return null;
    const settings = nativeSettings();
    if (!settings)
        return null;
    return {
        outputs: settings.get_boolean('process-all-outputs'),
        inputs: settings.get_boolean('process-all-inputs'),
    };
}

/**
 * Change process-all-{outputs,inputs}. Only possible for a native 7.x
 * install; rejects with `info.reason` otherwise.
 * @param {{outputs?: boolean, inputs?: boolean}} state
 */
export async function setProcessAll({outputs, inputs} = {}) {
    const info = ensureCache();
    if (!info.canSetProcessAll)
        throw new Error(info.reason ?? 'process-all cannot be changed on this EasyEffects install');
    const settings = nativeSettings();
    if (!settings)
        throw new Error('EasyEffects GSettings schema not found');
    if (outputs !== undefined)
        settings.set_boolean('process-all-outputs', outputs);
    if (inputs !== undefined)
        settings.set_boolean('process-all-inputs', inputs);
}
