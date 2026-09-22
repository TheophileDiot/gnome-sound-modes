import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
import {classifyStreams} from '../../lib/calls.js';

export function callsPage(ctx) {
    const {settings, pipewire, gettext: _} = ctx;
    const reasonLabels = {
        'WebRTC audio engine': _('WebRTC audio engine'),
        'Communication role': _('Communication role'),
        'Microphone and speaker in use': _('Microphone and speaker in use'),
        'Marked as call': _('Marked as call'),
    };
    const scope = ctx.scope.child();
    const page = new Adw.PreferencesPage({title: _('Calls'), icon_name: 'call-start-symbolic'});
    const detected = new Adw.PreferencesGroup({
        title: _('Detected now'),
        description: _('Calls are detected by a WebRTC audio engine, a communication role, or a microphone and speaker in use by the same application.'),
    });
    const saved = new Adw.PreferencesGroup({title: _('Overrides for other applications')});
    page.add(detected);
    page.add(saved);
    const names = new Map();
    const read = () => settings.get_value('call-app-overrides').deep_unpack();
    function change(key, value) {
        if (value && key.startsWith('pid:')) return;
        const overrides = read();
        const savedNames = settings.get_value('call-app-names').deep_unpack();
        if (value) {
            overrides[key] = value;
            savedNames[key] = names.get(key) ?? savedNames[key] ?? key;
        } else {
            delete overrides[key];
            delete savedNames[key];
        }
        settings.set_value('call-app-names', new GLib.Variant('a{ss}', savedNames));
        settings.set_value('call-app-overrides', new GLib.Variant('a{ss}', overrides));
    }
    let rows = [];
    let rowScope = scope.child();
    function render() {
        rowScope.destroy();
        rowScope = scope.child();
        for (const [group, row] of rows)
            group.remove(row);
        rows = [];
        const overrides = read();
        const savedNames = settings.get_value('call-app-names').deep_unpack();
        const {apps} = classifyStreams(pipewire.snapshot?.streams ?? [], overrides);
        detected.description = apps.length
            ? _('Calls are detected by a WebRTC audio engine, a communication role, or a microphone and speaker in use by the same application.')
            : _('No applications detected. Applications appear here when they play or record audio.');
        for (const app of apps) {
            names.set(app.key, app.name);
            const row = new Adw.ActionRow({
                title: app.name, use_markup: false,
                subtitle: app.reasons.map(reason => reasonLabels[reason] ?? reason).join(' · ') || _('No call detected'),
            });
            const select = new Gtk.DropDown({
                model: Gtk.StringList.new([_('Auto'), _('Always a call'), _('Never a call')]),
                selected: overrides[app.key] === 'always' ? 1 : overrides[app.key] === 'never' ? 2 : 0,
                valign: Gtk.Align.CENTER, tooltip_text: app.key.startsWith('pid:')
                    ? _('This application has no stable identity; an override cannot be saved.') : _('Call detection'),
                sensitive: !app.key.startsWith('pid:'),
            });
            row.add_suffix(select);
            row.activatable_widget = select;
            rowScope.connect(select, 'notify::selected', () => change(app.key, [null, 'always', 'never'][select.selected]));
            detected.add(row);
            rows.push([detected, row]);
        }
        const absent = Object.entries(overrides).filter(([key]) => !apps.some(app => app.key === key));
        saved.visible = absent.length > 0;
        for (const [key, value] of absent) {
            const row = new Adw.ActionRow({title: savedNames[key] ?? names.get(key) ?? key, subtitle: value === 'always' ? _('Always a call') : _('Never a call'), use_markup: false});
            const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', tooltip_text: _('Remove override'), valign: Gtk.Align.CENTER});
            remove.add_css_class('flat');
            row.add_suffix(remove);
            rowScope.connect(remove, 'clicked', () => change(key, null));
            saved.add(row);
            rows.push([saved, row]);
        }
    }
    let pendingRender = 0;
    function queueRender() {
        if (pendingRender) return;
        pendingRender = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            pendingRender = 0;
            render();
            return GLib.SOURCE_REMOVE;
        });
    }
    scope.add(() => { if (pendingRender) GLib.source_remove(pendingRender); });
    scope.connect(pipewire, 'changed', queueRender);
    scope.connect(settings, 'changed::call-app-overrides', queueRender);
    scope.connect(settings, 'changed::call-app-names', queueRender);
    render();
    return page;
}
