import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import {createMode, duplicateMode, moveMode, parseModes, serializeModes} from '../../lib/model.js';
import {profileLabel} from '../../lib/matching.js';
import {openModeEditor} from './modeEditor.js';
import {gioIcon, iconNameForMode} from '../icons.js';
import {buttonRow, captureSetup, slotInfo, undoToast} from './widgets.js';

export function modesPage(ctx) {
    const {settings, pipewire, window, extensionPath, gettext: _} = ctx;
    const scope = ctx.scope.child();
    const page = new Adw.PreferencesPage({title: _('Modes'), icon_name: 'audio-headphones-symbolic'});
    const group = new Adw.PreferencesGroup({title: _('Saved modes'), description: _('Drag to reorder')});
    page.add(group);
    const empty = new Adw.StatusPage({title: _('No modes yet'), description: _('Save an audio setup to switch back to it later.'), icon_name: 'audio-headphones-symbolic'});
    group.add(empty);
    const emptyAdd = new Gtk.Button({label: _('New mode'), halign: Gtk.Align.CENTER, css_classes: ['suggested-action']});
    empty.child = emptyAdd;
    scope.connect(emptyAdd, 'clicked', () => edit(createMode(), true));
    const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
    group.add(list);
    const addGroup = {add: row => list.append(row)};
    const add = buttonRow(addGroup, _('New mode'), scope, () => edit(createMode(), true));
    const addRow = add.get_parent();
    const shownWarnings = new Set();
    let rejected = [];
    const read = () => {
        const {modes, warnings, rejected: invalid, changed} = parseModes(settings.get_string('modes'));
        rejected = invalid;
        const unseen = warnings.filter(warning => !shownWarnings.has(warning));
        for (const warning of unseen)
            shownWarnings.add(warning);
        if (unseen.length)
            ctx.notify(unseen.join('; '));
        if (changed)
            write(modes);
        return modes;
    };
    const write = modes => settings.set_string('modes', serializeModes(modes, rejected));
    function edit(mode, isNew = false) {
        openModeEditor(ctx, mode, saved => {
            const modes = read();
            const index = modes.findIndex(item => item.id === saved.id);
            if (isNew)
                modes.push(saved);
            else if (index >= 0)
                modes[index] = saved;
            else {
                ctx.notify(_('This mode has been deleted.'));
                return;
            }
            write(modes);
        }, isNew);
    }
    function menu(ownerScope, actions, title) {
        const button = new Gtk.MenuButton({icon_name: 'view-more-symbolic', tooltip_text: title, valign: Gtk.Align.CENTER, css_classes: ['flat']});
        const popover = new Gtk.Popover();
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 2});
        popover.child = box;
        button.popover = popover;
        for (const [label, callback] of actions) {
            const action = new Gtk.Button({label, css_classes: ['flat']});
            box.append(action);
            ownerScope.connect(action, 'clicked', () => { popover.popdown(); callback(); });
        }
        return button;
    }
    function transfer(exporting) {
        const chooser = new Gtk.FileChooserNative({
            title: exporting ? _('Export modes') : _('Import modes'), transient_for: window,
            action: exporting ? Gtk.FileChooserAction.SAVE : Gtk.FileChooserAction.OPEN,
            accept_label: exporting ? _('Export') : _('Import'), cancel_label: _('Cancel'),
        });
        const fileScope = scope.child();
        const cancellable = new Gio.Cancellable();
        fileScope.add(() => cancellable.cancel());
        if (exporting)
            chooser.set_current_name('sound-modes.json');
        fileScope.connect(chooser, 'response', (_chooser, response) => {
            if (response !== Gtk.ResponseType.ACCEPT) {
                fileScope.destroy();
                return;
            }
            const file = chooser.get_file();
            chooser.hide();
            const done = (source, result) => {
                try {
                    if (exporting) {
                        source.replace_contents_finish(result);
                    } else {
                        const [, bytes] = source.load_contents_finish(result);
                        const imported = parseModes(new TextDecoder().decode(bytes));
                        if (imported.warnings.length)
                            throw new Error(_('Could not import modes.') + ' ' + imported.warnings.join('; '));
                        if (imported.modes.some(mode => typeof mode.icon !== 'string' ||
                            [mode.effects.outputPreset, mode.effects.inputPreset].some(value => value !== null && typeof value !== 'string') ||
                            [mode.output, mode.input, mode.fallback.output, mode.fallback.input].some(slot => slot &&
                                (!slot.match || Array.isArray(slot.match) || Object.values(slot.match).some(value =>
                                    !['string', 'number', 'boolean'].includes(typeof value))))))
                            throw new Error(_('Could not import modes. Invalid device or effects settings.'));
                        if (!fileScope.destroyed)
                            write([...read(), ...imported.modes.map(mode => createMode(mode))]);
                    }
                } catch (error) {
                    if (!fileScope.destroyed)
                        ctx.notify(error.message);
                } finally {
                    fileScope.destroy();
                }
            };
            if (exporting)
                file.replace_contents_bytes_async(new GLib.Bytes(new TextEncoder().encode(serializeModes(read(), rejected))), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable, done);
            else
                file.load_contents_async(cancellable, done);
        });
        // Disconnect the response handler before disposing the native dialog.
        fileScope.add(() => chooser.destroy());
        chooser.show();
    }
    group.header_suffix = menu(scope, [
        [_('Use current setup'), () => edit(createMode(captureSetup(pipewire.snapshot)), true)],
        [_('Import'), () => transfer(false)], [_('Export'), () => transfer(true)],
    ], _('Mode actions'));
    const rows = new Map();
    function reorder(id, delta) {
        write(moveMode(read(), id, delta));
        rows.get(id)?.row.grab_focus();
    }
    function remove(mode) {
        const dialog = new Adw.AlertDialog({heading: _('Delete mode?'), body: mode.name, default_response: 'cancel', close_response: 'cancel'});
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('delete', _('Delete'));
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        const dialogScope = scope.child();
        dialogScope.add(() => dialog.force_close());
        dialogScope.connect(dialog, 'response', (_dialog, response) => {
            if (response === 'delete') {
                const modes = read();
                const index = modes.findIndex(item => item.id === mode.id);
                const deleted = modes[index];
                write(modes.filter(item => item.id !== mode.id));
                if (deleted)
                    undoToast(ctx, _('Mode deleted'), () => {
                        const current = read();
                        if (!current.some(item => item.id === deleted.id)) {
                            current.splice(Math.min(index, current.length), 0, deleted);
                            write(current);
                        }
                    });
            }
            dialogScope.destroy();
        });
        dialog.present(window);
    }
    function makeRow(mode) {
        const rowScope = scope.child();
        const row = new Adw.PreferencesRow({activatable: true, use_markup: false});
        const box = new Gtk.Box({spacing: 12, css_classes: ['mode-content']});
        row.child = box;
        const handle = new Gtk.Image({icon_name: 'list-drag-handle-symbolic', tooltip_text: _('Drag to reorder')});
        box.append(handle);
        const icon = new Gtk.Image({pixel_size: 24});
        box.append(icon);
        const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6, hexpand: true});
        const heading = new Gtk.Box({spacing: 8});
        const name = new Gtk.Label({xalign: 0, ellipsize: 3, hexpand: true});
        const active = new Gtk.Label({label: _('Active now'), css_classes: ['chip', 'active-pill']});
        heading.append(name);
        heading.append(active);
        content.append(heading);
        const chips = new Gtk.Box({spacing: 5});
        content.append(chips);
        box.append(content);
        const current = () => read().find(item => item.id === mode.id);
        box.append(menu(rowScope, [
            [_('Edit'), () => { const item = current(); if (item) edit(item); }],
            [_('Duplicate'), () => {
                const item = current();
                if (!item) return;
                const copy = duplicateMode(item);
                copy.name = _('%s (copy)').replace('%s', item.name);
                write([...read(), copy]);
            }],
            [_('Move up'), () => reorder(mode.id, -1)],
            [_('Move down'), () => reorder(mode.id, 1)],
            [_('Delete'), () => { const item = current(); if (item) remove(item); }],
        ], _('Mode actions')));
        rowScope.connect(row, 'activate', () => { const item = current(); if (item) edit(item); });
        const drag = new Gtk.DragSource({actions: Gdk.DragAction.MOVE});
        rowScope.connect(drag, 'prepare', () => Gdk.ContentProvider.new_for_value(mode.id));
        handle.add_controller(drag);
        const drop = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);
        rowScope.connect(drop, 'drop', (_drop, id) => {
            const modes = read();
            const from = modes.findIndex(item => item.id === id);
            const to = modes.findIndex(item => item.id === mode.id);
            if (from < 0 || to < 0) return false;
            reorder(id, to - from);
            return true;
        });
        row.add_controller(drop);
        return {row, scope: rowScope, handle, icon, name, active, chips, signature: null};
    }
    function render() {
        const modes = read();
        empty.visible = modes.length === 0;
        list.visible = modes.length > 0;
        group.description = modes.length > 1 ? _('Drag to reorder') : null;
        for (const [id, item] of rows) {
            if (!modes.some(mode => mode.id === id)) {
                item.scope.destroy();
                list.remove(item.row);
                rows.delete(id);
            }
        }
        modes.forEach((mode, index) => {
            if (!rows.has(mode.id)) rows.set(mode.id, makeRow(mode));
            const item = rows.get(mode.id);
            if (item.row.get_parent() && item.row.get_index() !== index)
                list.remove(item.row);
            if (!item.row.get_parent()) list.insert(item.row, index);
            item.row.title = mode.name;
            item.name.label = mode.name;
            item.handle.visible = modes.length > 1;
            item.icon.gicon = gioIcon(iconNameForMode(mode.icon), extensionPath);
            item.active.visible = settings.get_string('active-mode') === mode.id;
            const output = slotInfo(mode.output, pipewire.snapshot, _);
            const input = slotInfo(mode.input, pipewire.snapshot, _);
            const profile = output.device?.profiles.find(profile => profile.name === mode.output?.profile);
            const values = [
                [output.name, output.missing, _('Output:') + ' ' + output.name],
                [profile ? profileLabel(profile) : profileLabel(mode.output?.profile ?? ''), false, null],
                [input.name, input.missing, _('Input:') + ' ' + input.name],
                [mode.effects.enabled ? (mode.effects.scope === 'calls' ? _('Call effects') : _('All effects')) : _('Effects off'), false, null],
            ].filter(([text]) => text);
            const signature = JSON.stringify(values);
            if (signature !== item.signature) {
                while (item.chips.get_first_child()) item.chips.remove(item.chips.get_first_child());
                for (const [label, missing, tooltip] of values) {
                    const chip = new Gtk.Label({label, ellipsize: 3, max_width_chars: 18, tooltip_text: tooltip ?? label, css_classes: ['chip']});
                    if (missing) chip.add_css_class('chip-missing');
                    item.chips.append(chip);
                }
                item.signature = signature;
            }
        });
        if (addRow.get_index() !== modes.length) {
            list.remove(addRow);
            list.append(addRow);
        }
    }
    scope.connect(settings, 'changed::modes', render);
    scope.connect(settings, 'changed::active-mode', render);
    scope.connect(pipewire, 'changed', render);
    render();
    return page;
}
