import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import {classifyDevice, friendlyName, profileLabel} from '../../lib/matching.js';
import {normalizeAddress} from '../../lib/bluetooth.js';
import {buttonRow, transport} from './widgets.js';

export function devicesPage(ctx) {
    const {pipewire, bluetooth, gettext: _} = ctx;
    const kindLabels = {
        headset: _('Headset'), headphones: _('Headphones'), speaker: _('Speakers'),
        microphone: _('Microphone'), webcam: _('Webcam'), internal: _('Built-in audio'),
        hdmi: _('HDMI / DisplayPort'), unknown: _('Audio device'),
    };
    const scope = ctx.scope.child();
    const page = new Adw.PreferencesPage({title: _('Devices'), icon_name: 'audio-card-symbolic'});
    const connected = new Adw.PreferencesGroup({title: _('Connected audio devices')});
    const paired = new Adw.PreferencesGroup({title: _('Paired, not connected')});
    page.add(connected);
    page.add(paired);
    const refresh = new Gtk.Button({label: _('Refresh')});
    connected.header_suffix = refresh;
    scope.connect(refresh, 'clicked', () => pipewire.requestRefresh());
    let rows = [];
    const expanded = new Map();
    let rowScope = scope.child();
    let signature = null;
    function render() {
        const snapshot = pipewire.snapshot ?? {devices: [], endpoints: []};
        const next = JSON.stringify([snapshot.devices, snapshot.endpoints.map(({deviceId, direction, name}) =>
            [deviceId, direction, name]), bluetooth.devices]);
        if (next === signature) return;
        signature = next;
        rowScope.destroy();
        rowScope = scope.child();
        for (const [group, row] of rows)
            group.remove(row);
        rows = [];
        connected.description = snapshot.devices.length ? null : _('No devices found.');
        for (const device of snapshot.devices) {
            const kind = classifyDevice(device);
            const active = device.profiles.find(profile => profile.name === device.activeProfile);
            const row = new Adw.ExpanderRow({
                title: friendlyName(device), use_markup: false, expanded: expanded.get(device.id)?.main ?? false,
                subtitle: [kindLabels[kind.kind] ?? kindLabels.unknown, active ? profileLabel(active) : device.activeProfile].filter(Boolean).join(' · '),
            });
            row.add_prefix(new Gtk.Image({icon_name: `${kind.icon}-symbolic`}));
            const details = new Adw.ExpanderRow({title: _('Technical details'), expanded: expanded.get(device.id)?.technical ?? false});
            const remember = () => expanded.set(device.id, {main: row.expanded, technical: details.expanded});
            rowScope.connect(row, 'notify::expanded', remember);
            rowScope.connect(details, 'notify::expanded', remember);
            row.add_row(new Adw.ActionRow({title: _('Connection'), subtitle: transport(device, _)}));
            if (device.bluezAddress)
                row.add_row(new Adw.ActionRow({title: _('Address'), subtitle: device.bluezAddress, use_markup: false}));
            row.add_row(new Adw.ActionRow({title: _('Card'), subtitle: device.description || friendlyName(device), use_markup: false}));
            const report = [friendlyName(device)];
            for (const [key, value] of Object.entries(device.match)) {
                details.add_row(new Adw.ActionRow({title: key, subtitle: String(value), use_markup: false}));
                report.push(`${key}: ${value}`);
            }
            for (const endpoint of snapshot.endpoints.filter(item => item.deviceId === device.id)) {
                details.add_row(new Adw.ActionRow({
                    title: endpoint.direction === 'output' ? _('Output endpoint') : _('Input endpoint'),
                    subtitle: endpoint.name ?? '', use_markup: false,
                }));
                report.push(`${endpoint.direction}: ${endpoint.name}`);
            }
            row.add_row(details);
            buttonRow(row, _('Copy details'), rowScope, () => {
                ctx.window.get_clipboard().set(report.join('\n'));
                ctx.notify(_('Device details copied.'));
            });
            connected.add(row);
            rows.push([connected, row]);
        }
        const absent = bluetooth.devices.filter(device => device.paired && device.audio &&
            !snapshot.devices.some(live => live.bluezAddress && normalizeAddress(live.bluezAddress) === normalizeAddress(device.address)));
        paired.visible = absent.length > 0;
        for (const device of absent) {
            const row = new Adw.ActionRow({title: device.alias || device.address, subtitle: device.address, use_markup: false});
            row.add_prefix(new Gtk.Image({icon_name: 'bluetooth-active-symbolic'}));
            paired.add(row);
            rows.push([paired, row]);
        }
    }
    scope.connect(pipewire, 'changed', render);
    scope.connect(bluetooth, 'changed', render);
    render();
    return page;
}
