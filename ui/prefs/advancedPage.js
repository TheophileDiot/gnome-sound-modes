import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import {parseModes} from '../../lib/model.js';
import {SINK, SOURCE} from '../../lib/easyeffects.js';
import {buttonRow, undoToast} from './widgets.js';

export function advancedPage(ctx) {
    const {settings, pipewire, gettext: _} = ctx;
    const scope = ctx.scope.child();
    const page = new Adw.PreferencesPage({title: _('Advanced'), icon_name: 'preferences-system-symbolic'});
    const group = new Adw.PreferencesGroup({title: _('Behaviour')});
    page.add(group);
    for (const [key, title] of [
        ['reapply-on-reconnect', _('Reapply mode when devices reconnect')],
        ['show-indicator', _('Show a button in the top bar')],
        ['debug', _('Enable debug logging')],
    ]) {
        const row = new Adw.SwitchRow({title, subtitle: key === 'show-indicator' ? _('Switch modes without opening Quick Settings.') : null});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        scope.add(() => Gio.Settings.unbind(row, 'active'));
        group.add(row);
    }
    const callMode = new Adw.ComboRow({title: _('Switch to this mode when a call starts')});
    group.add(callMode);
    let modes = [];
    let updating = false;
    function refreshModes() {
        if (updating) return;
        updating = true;
        modes = parseModes(settings.get_string('modes')).modes;
        callMode.model = Gtk.StringList.new([_('Off'), ...modes.map(mode => mode.name)]);
        const selected = settings.get_string('call-mode');
        const index = modes.findIndex(mode => mode.id === selected);
        if (selected && index < 0) settings.reset('call-mode');
        callMode.selected = index + 1;
        callMode.subtitle = modes.length ? null : _('Create a mode on the Modes page to enable automatic switching.');
        callMode.sensitive = modes.length > 0;
        updating = false;
    }
    scope.connect(callMode, 'notify::selected', () => {
        if (!updating)
            settings.set_string('call-mode', modes[callMode.selected - 1]?.id ?? '');
    });
    scope.connect(settings, 'changed::modes', refreshModes);
    scope.connect(settings, 'changed::call-mode', refreshModes);
    refreshModes();
    const routing = new Adw.PreferencesGroup({
        title: _('Routing'), description: _('Remove stream targets pointing to EasyEffects so applications follow their default devices.'),
    });
    page.add(routing);
    const reset = buttonRow(routing, _('Reset routing'), scope, async () => {
        reset.sensitive = false;
        const cleared = [];
        let failed = false;
        try {
            const streams = pipewire.snapshot?.streams ?? [];
            for (const stream of streams) {
                if (scope.destroyed)
                    return;
                if ([stream.target, stream.targetNode].some(target => target === SINK || target === SOURCE)) {
                    await pipewire.clearTarget(stream.id);
                    cleared.push({...stream});
                }
            }
            if (!scope.destroyed)
                pipewire.requestRefresh();
        } catch (error) {
            failed = true;
            if (!scope.destroyed)
                ctx.notify(error.message);
        } finally {
            if (!scope.destroyed) {
                reset.sensitive = true;
                if (cleared.length) undoToast(ctx, _('Routing reset.'), async () => {
                    await pipewire.refresh();
                    for (const stream of cleared) {
                        if (scope.destroyed) return;
                        const live = pipewire.snapshot?.streams.find(item => item.id === stream.id && item.serial != null && item.serial === stream.serial);
                        if (live && !live.target && !live.targetNode)
                            await pipewire.setTarget(live.id, stream.target || stream.targetNode);
                    }
                    if (!scope.destroyed) pipewire.requestRefresh();
                });
                else if (!failed) ctx.notify(_('No EasyEffects routing to reset.'));
            }
        }
    }, true);
    return page;
}
