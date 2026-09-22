import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import {captureMatch, classifyDevice, findDevice, friendlyName} from '../../lib/matching.js';

export function setupStyle(ctx) {
    const provider = new Gtk.CssProvider();
    provider.load_from_data(`
        .sound-modes-prefs .chip { border-radius: 99px; background: alpha(currentColor, .08); padding: 3px 9px; font-size: .85em; }
        .sound-modes-prefs .chip-missing { color: @error_color; background: alpha(@error_color, .12); }
        .sound-modes-prefs .active-pill { color: @accent_color; background: alpha(@accent_color, .12); }
        .sound-modes-prefs .mode-content { padding: 12px; }
    `, -1);
    const display = ctx.window.get_display();
    Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    ctx.window.add_css_class('sound-modes-prefs');
    ctx.scope.add(() => Gtk.StyleContext.remove_provider_for_display(display, provider));
}

export function buttonRow(parent, label, scope, callback, destructive = false) {
    const row = new Adw.PreferencesRow();
    const button = new Gtk.Button({label, hexpand: true, css_classes: ['flat']});
    if (destructive)
        button.add_css_class('destructive-action');
    row.child = button;
    if (parent instanceof Adw.ExpanderRow)
        parent.add_row(row);
    else
        parent.add(row);
    scope.connect(button, 'clicked', callback);
    return button;
}

export function undoToast(ctx, title, undo) {
    const scope = ctx.scope.child();
    const toast = new Adw.Toast({title, button_label: ctx.gettext('Undo'), timeout: 8});
    scope.connect(toast, 'button-clicked', () => {
        Promise.resolve().then(() => {
            if (!ctx.scope.destroyed) return undo();
        }).catch(error => ctx.notify(error.message));
    });
    scope.connect(toast, 'dismissed', () => scope.destroy());
    scope.add(() => toast.dismiss());
    ctx.window.add_toast(toast);
}

export function transport(device, _) {
    if (classifyDevice(device).wireless)
        return _('Bluetooth');
    if (device.absent)
        return null;
    if (device.props?.['device.bus'] === 'usb' || device.name?.includes('usb-'))
        return _('USB');
    return _('Built-in');
}

// Both entry points capture the live defaults, which can differ from saved defaults.
export function captureSetup(snapshot) {
    const slots = {output: null, input: null};
    if (!snapshot)
        return slots;
    for (const [direction, live, configured] of [['output', 'sink', 'configuredSink'], ['input', 'source', 'configuredSource']]) {
        const endpoint = snapshot.endpoints.find(item => item.name === snapshot.defaults[live]) ??
            snapshot.endpoints.find(item => item.name === snapshot.defaults[configured]);
        const device = snapshot.devices.find(item => item.id === endpoint?.deviceId);
        if (device)
            slots[direction] = {match: captureMatch(device), profile: device.api === 'bluez5' ? device.activeProfile : null};
    }
    return slots;
}

export function slotInfo(slot, snapshot, _) {
    const device = slot && snapshot && findDevice(slot.match, snapshot)?.device;
    return {
        device,
        missing: Boolean(slot && snapshot && !device),
        name: !slot ? _('None') : device ? friendlyName(device) :
            slot.match['device.description'] ?? slot.match['device.name'] ?? _('Unavailable device'),
    };
}
