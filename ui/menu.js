import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Animation from 'resource:///org/gnome/shell/ui/animation.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {warn} from '../lib/log.js';

import {effectsLine, headsetInCall, isolate, modeName, nameList, outputLine, statusLine} from './format.js';
import {gioIcon, iconForStatus, iconNameForMode} from './icons.js';

// Both mounts observe the same UI-initiated switch. Controller status has no pending target.
const attempts = new WeakMap();

function vbox(props) {
    const params = {...props};
    let orientation = Object.prototype.hasOwnProperty.call(St.BoxLayout.prototype, 'orientation');
    try {
        orientation ||= Boolean(GObject.Object.find_property.call(St.BoxLayout.prototype, 'orientation'));
    } catch {
        // Older St versions expose only the vertical property.
    }
    if (orientation)
        params.orientation = Clutter.Orientation.VERTICAL;
    else
        params.vertical = true;
    return new St.BoxLayout(params);
}

function modeIcon(mode, path) {
    return gioIcon(iconNameForMode((mode.icon || 'audio-headphones').replace(/-symbolic$/, '')), path);
}

/** Preserve the active mode identity under call and warning emblems. */
export function statusIcon(status, path) {
    const active = status.modes?.find(mode => mode.id === status.activeModeId);
    if (active) {
        const base = modeIcon(active, path);
        const emblem = ['failed', 'missing'].includes(status.state)
            ? 'dialog-warning-symbolic' : status.inCall ? 'call-start-symbolic' : null;
        return emblem ? Gio.EmblemedIcon.new(base, Gio.Emblem.new(Gio.ThemedIcon.new(emblem))) : base;
    }
    return iconForStatus(status, path);
}

function ellipsize(label) {
    label.x_expand = true;
    label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    label.add_style_class_name('sound-modes-label');
    return label;
}

function label(text, style = '') {
    return ellipsize(new St.Label({text, style_class: style, y_align: Clutter.ActorAlign.CENTER}));
}

/** The same popup content and actions for both entry points. */
export class SoundModesMenu {
    constructor(menu, controller, extension) {
        this._controller = controller;
        this._extension = extension;
        this._ = extension.gettext.bind(extension);
        this.ngettext = extension.ngettext.bind(extension);
        if (!attempts.has(controller))
            attempts.set(controller, {pending: null, retry: null});
        this._attempt = attempts.get(controller);
        this._destroyed = false;
        this.section = new PopupMenu.PopupMenuSection();
        this.section.actor.add_style_class_name('sound-modes-menu');
        menu.addMenuItem(this.section);
        this._sessionId = Main.sessionMode.connect('updated', () => this._syncSettings());
        this.section.actor.connect('destroy', () => {
            this._destroyed = true;
            Main.sessionMode.disconnect(this._sessionId);
        });
    }

    _syncSettings() {
        for (const item of [this._settingsItem, this._createItem]) {
            if (item)
                item.visible = Main.sessionMode.allowSettings;
        }
    }

    _openPreferences() {
        if (Main.sessionMode.allowSettings)
            this._extension.openPreferences();
    }

    _clear() {
        this._settingsItem = this._createItem = null;
        this.section.removeAll();
    }

    _action(item, callback) {
        ellipsize(item.label);
        this.section.addMenuItem(item);
        item.connectObject('activate', callback, this);
        return item;
    }

    _spinner(item) {
        const spinner = new Animation.Spinner(16);
        spinner.y_align = Clutter.ActorAlign.CENTER;
        item.add_child(spinner);
        spinner.play();
    }

    async _applyMode(id) {
        if (!id || this._controller.status?.state === 'applying')
            return;
        this._attempt.pending = id;
        this._attempt.retry = id;
        try {
            await this._controller.apply(id);
        } catch (error) {
            warn(`Could not switch mode: ${error.message}`);
        } finally {
            if (this._attempt.pending === id)
                this._attempt.pending = null;
        }
    }

    _header(status) {
        const _ = this._;
        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        header.add_style_class_name('sound-modes-header');
        header.add_child(new St.Icon({gicon: statusIcon(status, this._extension.path), icon_size: 32}));
        const text = vbox({x_expand: true});
        text.add_child(label(modeName(status, _), 'sound-modes-title'));
        text.add_child(label(statusLine(status, _, this.ngettext), 'sound-modes-dim'));
        header.add_child(text);
        if (status.inCall) {
            const apps = nameList(status.callApps.map(app => app.name), _);
            const pill = label(apps || _('In a call'), 'sound-modes-call-pill');
            pill.x_expand = false;
            pill.x_align = Clutter.ActorAlign.END;
            pill.accessible_name = apps ? _('In call: %s').format(apps) : _('In a call');
            header.add_child(pill);
        }
        if (status.state === 'applying')
            this._spinner(header);
        this.section.addMenuItem(header);
    }

    _statusBlock(status) {
        const _ = this._;
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const block = vbox({x_expand: true, style_class: 'sound-modes-status-block'});
        const effects = status.effects;
        const presets = [effects?.outputPreset, effects?.inputPreset].filter(Boolean);
        const rows = [
            ['audio-speakers', outputLine(status, _), status.output?.profileLabel ? isolate(status.output.profileLabel) : '', _('Output')],
            ['audio-input-microphone', status.input?.name ? isolate(status.input.name) : _('None'), '', _('Input')],
            ['sound-modes-effects', effectsLine(status, _), effects?.running ? nameList(presets, _) : '', _('Effects')],
        ];
        for (const [icon, text, detail, accessibleName] of rows) {
            const row = new St.BoxLayout({x_expand: true, style_class: 'sound-modes-status-row'});
            row.add_child(new St.Icon({gicon: modeIcon({icon}, this._extension.path), icon_size: 16,
                accessible_name: accessibleName}));
            row.add_child(label(text));
            if (detail) {
                const detailLabel = label(detail, 'sound-modes-detail sound-modes-dim');
                detailLabel.x_expand = false;
                detailLabel.x_align = Clutter.ActorAlign.END;
                row.add_child(detailLabel);
            }
            block.add_child(row);
        }
        item.add_child(block);
        this.section.addMenuItem(item);
    }

    sync(status) {
        this._clear();
        if (!status) {
            const loading = new PopupMenu.PopupMenuItem(this._('Loading…'), {reactive: false, can_focus: false});
            ellipsize(loading.label);
            this.section.addMenuItem(loading);
            return;
        }
        const _ = this._;
        const applying = status.state === 'applying';
        if (!applying && status.state !== 'failed')
            this._attempt.retry = null;
        this._header(status);
        this._statusBlock(status);
        if (status.modes.length)
            this.section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const custom = this._action(new PopupMenu.PopupImageMenuItem(_('Custom (no mode)'),
            gioIcon('sound-modes-custom-symbolic', this._extension.path)),
            () => this._controller.clearActive());
        custom.setOrnament(!status.activeModeId ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        custom.accessible_role = Atk.Role.RADIO_MENU_ITEM;
        custom.setSensitive(!applying);
        custom.opacity = applying ? 160 : 255;
        for (const mode of status.modes) {
            const failed = status.state === 'failed' && mode.id === (this._attempt.retry ?? status.activeModeId);
            let icon = modeIcon(mode, this._extension.path);
            if (failed)
                icon = Gio.EmblemedIcon.new(icon, Gio.Emblem.new(Gio.ThemedIcon.new('dialog-warning-symbolic')));
            const item = new PopupMenu.PopupImageMenuItem(isolate(mode.name), icon);
            this._action(item, () => void this._applyMode(mode.id));
            item.setOrnament(mode.id === status.activeModeId ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            item.accessible_role = Atk.Role.RADIO_MENU_ITEM;
            const connectable = mode.connectable ?? [];
            item.setSensitive(!applying && (!mode.missing.length || connectable.length > 0));
            if (connectable.length || mode.missing.length || failed) {
                const text = vbox({x_expand: true});
                item.remove_child(item.label);
                text.add_child(item.label);
                const subtitle = failed ? _('Switch failed')
                    : connectable.length ? _('Switched off — will connect')
                        : this.ngettext('%d device missing', '%d devices missing', mode.missing.length).format(mode.missing.length);
                text.add_child(label(subtitle, failed ? 'sound-modes-error' : 'sound-modes-dim'));
                item.insert_child_at_index(text, 1);
            }
            if (applying) {
                if (mode.id === this._attempt.pending) {
                    item.setOrnament(PopupMenu.Ornament.HIDDEN);
                    this._spinner(item);
                } else {
                    item.opacity = 160;
                }
            }
        }
        if (!status.modes.length) {
            const empty = new PopupMenu.PopupMenuItem(_('No modes yet'), {reactive: false, can_focus: false});
            ellipsize(empty.label);
            this.section.addMenuItem(empty);
            this._createItem = this._action(new PopupMenu.PopupMenuItem(_('Create a mode…')), () => this._openPreferences());
        }
        const retryId = this._attempt.retry ?? status.activeModeId;
        if (status.state === 'failed' && status.modes.some(mode => mode.id === retryId))
            this._action(new PopupMenu.PopupMenuItem(_('Try again')), () => void this._applyMode(retryId));
        if (status.state === 'degraded' && status.activeModeId && !headsetInCall(status))
            this._action(new PopupMenu.PopupMenuItem(_('Reapply')), () => void this._applyMode(status.activeModeId));
        if (status.modes.length)
            this.section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._settingsItem = this._action(new PopupMenu.PopupMenuItem(_('Sound Modes Settings…')), () => this._openPreferences());
        this._syncSettings();
    }

    destroy() {
        if (this._destroyed)
            return;
        this._clear();
        this.section.destroy();
    }
}
