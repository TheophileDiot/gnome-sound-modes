import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import {captureMatch, findDevice, friendlyName, profileLabel, profilesForSlot} from '../../lib/matching.js';
import {normalizeAddress} from '../../lib/bluetooth.js';
import {transport} from './widgets.js';

export function devicePicker(ctx, scope, parent, owner, direction, changed, fallback = false) {
    const {pipewire, bluetooth, gettext: _} = ctx;
    const add = row => parent instanceof Adw.ExpanderRow ? parent.add_row(row) : parent.add(row);
    const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
    const wrapper = new Adw.PreferencesRow({child: list});
    add(wrapper);
    const profileRow = fallback ? null : new Adw.ComboRow({title: _('Audio quality')});
    if (profileRow) add(profileRow);
    let profiles = [];
    let updating = false;
    let signature = null;
    let rowScope = scope.child();
    function updateProfiles(device) {
        if (!profileRow) return;
        updating = true;
        profiles = device ? profilesForSlot(device, direction) : [];
        const current = owner[direction]?.profile;
        if (current && !profiles.some(profile => profile.name === current))
            profiles.push({name: current, description: current});
        profileRow.model = Gtk.StringList.new([_('Keep current'), ...profiles.map(profileLabel)]);
        profileRow.selected = current ? profiles.findIndex(profile => profile.name === current) + 1 : 0;
        profileRow.visible = profiles.length > 1 || Boolean(current);
        profileRow.subtitle = current?.startsWith('a2dp')
            ? _('Best for music; the Bluetooth microphone is off.')
            : current?.includes('headset') || current?.includes('handsfree')
                ? _('Enables the Bluetooth microphone with lower playback quality.')
                : _('A2DP offers better music quality; HFP enables the Bluetooth microphone.');
        updating = false;
    }
    if (profileRow) scope.connect(profileRow, 'notify::selected', () => {
        if (!updating && owner[direction]) {
            owner[direction].profile = profiles[profileRow.selected - 1]?.name ?? null;
            signature = null;
            refresh();
            changed();
        }
    });
    function refresh() {
        const snapshot = pipewire.snapshot ?? {devices: [], endpoints: []};
        const devices = snapshot.devices.filter(device => snapshot.endpoints.some(endpoint =>
            endpoint.deviceId === device.id && endpoint.direction === direction && !endpoint.virtual));
        for (const paired of bluetooth.devices.filter(device => device.paired && device.audio &&
            (direction === 'input' ? device.hfp : device.a2dp || device.hfp))) {
            if (devices.some(device => device.bluezAddress && normalizeAddress(device.bluezAddress) === normalizeAddress(paired.address)))
                continue;
            const live = snapshot.devices.find(device => device.bluezAddress && normalizeAddress(device.bluezAddress) === normalizeAddress(paired.address));
            if (live) continue; // Live cards must pass the endpoint direction filter above.
            devices.push({
                description: paired.alias || paired.address, api: 'bluez5', profiles: [], absent: true,
                bluezAddress: paired.address,
                match: {'api.bluez5.address': paired.address, 'device.description': paired.alias || paired.address},
            });
        }
        const slot = owner[direction];
        let selected = slot ? findDevice(slot.match, {devices})?.device : null;
        if (slot && !selected) {
            selected = {
                name: slot.match['device.name'],
                description: slot.match['device.description'] ?? slot.match['device.name'] ?? _('Unavailable device'),
                api: slot.match['api.bluez5.address'] ? 'bluez5' : slot.match['device.api'],
                profiles: [], match: slot.match, absent: true,
            };
            devices.push(selected);
        }
        const next = JSON.stringify([devices.map(device => [device.id, device.description, device.match, device.absent, device.profiles, device.activeProfile]), slot]);
        if (next === signature) return;
        signature = next;
        updateProfiles(selected);
        rowScope.destroy();
        rowScope = scope.child();
        while (list.get_first_child()) list.remove(list.get_first_child());
        let first = null;
        for (const device of [null, ...devices]) {
            const radio = new Gtk.CheckButton({valign: Gtk.Align.CENTER});
            radio.update_property([Gtk.AccessibleProperty.LABEL], [device ? friendlyName(device) : _('None')]);
            if (first) radio.group = first;
            else first = radio;
            radio.active = device === selected;
            const row = new Adw.ActionRow({
                title: device ? friendlyName(device) : _('None'), use_markup: false,
                subtitle: device ? [transport(device, _), (device.absent
                    ? device.api === 'bluez5' ? _('Switched off, will be connected') : _('Unavailable')
                    : _('Available'))].filter(Boolean).join(' · ') : _('Keep the current device'),
                activatable_widget: radio,
            });
            row.add_prefix(radio);
            if (device?.absent && device.api === 'bluez5')
                row.add_suffix(new Gtk.Label({label: _('Paired'), css_classes: ['chip'], valign: Gtk.Align.CENTER}));
            list.append(row);
            rowScope.connect(radio, 'toggled', () => {
                if (!radio.active) return;
                owner[direction] = device ? (fallback ? {match: captureMatch(device)} : {match: captureMatch(device), profile: null}) : null;
                updateProfiles(device);
                changed();
            });
        }
    }
    refresh();
    return refresh;
}
