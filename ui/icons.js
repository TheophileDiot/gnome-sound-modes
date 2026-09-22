// Symbolic icon resolution for the panel button and Quick Settings toggle.
// Pure module (only gi://Gio) so it can be exercised with `gjs -m` outside
// the shell process.

import Gio from 'gi://Gio';

import {ICONS} from '../lib/model.js';

/**
 * Maps a base icon name from lib/model.js ICONS to a hand-drawn sound-modes
 * glyph, for the entries a custom icon exists for. Anything absent falls
 * back to the matching Adwaita icon name.
 */
const CUSTOM_ICON = {
    'audio-headphones': 'sound-modes-headphones',
    'audio-speakers': 'sound-modes-speakers',
    'audio-input-microphone': 'sound-modes-microphone',
    'bluetooth-active': 'sound-modes-earbuds',
    'phone': 'sound-modes-headset',
    'call-start': 'sound-modes-call',
    };

const HEADPHONES_ICON = 'sound-modes-headphones-symbolic';
const HEADPHONES_CALL_ICON = 'sound-modes-headphones-call-symbolic';
const CALL_ICON = 'sound-modes-call-symbolic';
const WARNING_ICON = 'sound-modes-warning-symbolic';
const CUSTOM_STATE_ICON = 'sound-modes-custom-symbolic';

/**
 * lib/model.js ICONS with the names mapped to the custom glyphs above where
 * one exists. Derived, never copied: a second list drifts.
 */
export const MODE_ICONS = ICONS.map(({name, label}) => ({name: CUSTOM_ICON[name] ?? name, label}));

/**
 * Resolve a mode's stored icon base name (an entry from lib/model.js
 * ICONS) to the symbolic icon name to display: a custom sound-modes glyph
 * when one exists, else the matching Adwaita icon. A name that already ends
 * in `-symbolic` (as Controller status entries do) resolves to itself.
 * @param {string} iconBase
 * @returns {string} symbolic icon name, e.g. "sound-modes-headphones-symbolic"
 */
export function iconNameForMode(iconBase) {
    const base = iconBase.replace(/-symbolic$/, '');
    return `${CUSTOM_ICON[base] ?? base}-symbolic`;
}

/**
 * Build a Gio.Icon for a symbolic icon name: a custom sound-modes glyph is
 * loaded as a file from the extension's icons/ directory, anything else
 * resolves through the system icon theme.
 * @param {string} name symbolic icon name, e.g. "sound-modes-call-symbolic"
 * @param {string} extensionPath
 * @returns {Gio.Icon}
 */
export function gioIcon(name, extensionPath) {
    if (name.startsWith('sound-modes-'))
        return Gio.FileIcon.new(Gio.File.new_for_path(`${extensionPath}/icons/${name}.svg`));
    return Gio.ThemedIcon.new(name);
}

/**
 * Pick the icon representing the controller's current status: the active
 * mode's icon while applying or steady, a call badge while a call is in
 * progress, a warning badge when a device failed or is missing, and a
 * neutral icon when no mode is active.
 * @param {object} status Controller status (see docs/superpowers/specs/2026-09-22-sound-modes-design.md)
 * @param {string} extensionPath
 * @returns {Gio.Icon}
 */
export function iconForStatus(status, extensionPath) {
    const active = status.modes?.find(mode => mode.id === status.activeModeId);
    const baseName = iconNameForMode(active?.icon ?? 'audio-headphones');

    if (status.state === 'applying')
        return gioIcon(baseName, extensionPath);
    if (status.inCall)
        return gioIcon(baseName === HEADPHONES_ICON ? HEADPHONES_CALL_ICON : CALL_ICON, extensionPath);
    if (status.state === 'failed' || status.state === 'missing')
        return gioIcon(WARNING_ICON, extensionPath);
    if (status.state === 'custom' || status.state === 'idle')
        return gioIcon(CUSTOM_STATE_ICON, extensionPath);
    return gioIcon(baseName, extensionPath);
}
