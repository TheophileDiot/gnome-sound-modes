import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {ICONS, validateMode} from '../../lib/model.js';
import {devicePicker} from './devicePicker.js';
import {profileLabel} from '../../lib/matching.js';
import {buttonRow, captureSetup, slotInfo} from './widgets.js';
import * as easyeffects from '../../lib/easyeffects.js';
import {spawnDetached} from '../../lib/subprocess.js';
import {gioIcon, iconNameForMode} from '../icons.js';

export function openModeEditor(ctx, original, onSave, isNew = false) {
    const {gettext: _, pipewire, bluetooth, extensionPath} = ctx;
    const scope = ctx.scope.child();
    const mode = JSON.parse(JSON.stringify(original));
    const dialog = new Adw.Dialog({title: isNew ? _('New mode') : _('Edit mode'), content_width: 660, css_classes: ['sound-modes-prefs']});
    const toolbar = new Adw.ToolbarView();
    const header = new Adw.HeaderBar({show_end_title_buttons: false, show_start_title_buttons: false});
    const cancel = new Gtk.Button({label: _('Cancel')});
    const save = new Gtk.Button({label: _('Save')});
    save.add_css_class('suggested-action');
    header.pack_start(cancel);
    header.pack_end(save);
    toolbar.add_top_bar(header);
    const banner = new Adw.Banner({revealed: false});
    toolbar.add_top_bar(banner);
    const page = new Adw.PreferencesPage();
    toolbar.content = page;
    dialog.child = toolbar;
    scope.connect(dialog, 'closed', () => scope.destroy());
    scope.add(() => dialog.force_close());
    let initial = JSON.stringify(mode);
    let discardDialog = null;
    scope.connect(cancel, 'clicked', () => dialog.close());
    scope.connect(dialog, 'close-attempt', () => {
        if (discardDialog) return;
        discardDialog = new Adw.AlertDialog({heading: _('Discard changes?'), body: _('Your changes have not been saved.'), default_response: 'keep', close_response: 'keep'});
        discardDialog.add_response('keep', _('Keep editing'));
        discardDialog.add_response('discard', _('Discard'));
        discardDialog.set_response_appearance('discard', Adw.ResponseAppearance.DESTRUCTIVE);
        const confirmScope = scope.child();
        confirmScope.add(() => discardDialog?.force_close());
        confirmScope.connect(discardDialog, 'response', (_dialog, response) => {
            discardDialog = null;
            confirmScope.destroy();
            if (response === 'discard') dialog.force_close();
        });
        discardDialog.present(dialog);
    });
    scope.connect(save, 'clicked', () => {
        mode.name = name.text.trim();
        const errors = validateMode(mode);
        if (errors.length) {
            banner.title = errors.map(error => validationMessages[error] ?? _('Invalid mode')).join('; ');
            banner.revealed = true;
            return;
        }
        onSave(mode);
        dialog.force_close();
    });
    function group(title, description = null) {
        const widget = new Adw.PreferencesGroup({title, description});
        page.add(widget);
        return widget;
    }
    function combo(parent, title, labels, selected, changed, subtitle = null) {
        const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(labels), selected});
        if (parent instanceof Adw.ExpanderRow) parent.add_row(row);
        else parent.add(row);
        scope.connect(row, 'notify::selected', () => { changed(row.selected); validate(); });
        return row;
    }
    const playing = group(_('Playing right now'));
    const nowOutput = new Adw.ActionRow({title: _('Output'), use_markup: false});
    const nowInput = new Adw.ActionRow({title: _('Input'), use_markup: false});
    playing.add(nowOutput);
    playing.add(nowInput);
    const useSetup = buttonRow(playing, _('Use this setup'), scope, () => {
        Object.assign(mode, captureSetup(pipewire.snapshot));
        pickers.forEach(refresh => refresh());
        validate();
    });
    function refreshPlaying() {
        const slots = captureSetup(pipewire.snapshot);
        const output = slotInfo(slots.output, pipewire.snapshot, _);
        const profile = output.device?.profiles.find(item => item.name === slots.output?.profile);
        nowOutput.subtitle = [output.name, profile ? profileLabel(profile) : slots.output?.profile].filter(Boolean).join(' · ');
        nowInput.subtitle = slotInfo(slots.input, pipewire.snapshot, _).name;
        useSetup.sensitive = Boolean(slots.output || slots.input);
    }
    refreshPlaying();
    const identity = group(_('Mode'));
    const name = new Adw.EntryRow({title: _('Name'), text: mode.name});
    identity.add(name);
    const icons = [...ICONS];
    const iconLabels = {
        'audio-headphones': _('Headphones'), 'audio-speakers': _('Speakers'),
        'audio-input-microphone': _('Microphone'), 'camera-web': _('Webcam'),
        phone: _('Headset'), 'call-start': _('Call'), 'bluetooth-active': _('Earbuds'),
        'sound-modes-effects': _('Effects'),
        'audio-card': _('Sound card'), 'multimedia-player': _('Media player'), 'video-display': _('Display'),
    };
    if (!icons.some(icon => icon.name === mode.icon))
        icons.push({name: mode.icon, label: mode.icon});
    const image = new Gtk.Image({gicon: gioIcon(iconNameForMode(mode.icon), extensionPath)});
    const iconRow = combo(identity, _('Icon'), icons.map(icon => iconLabels[icon.name] ?? icon.label),
        icons.findIndex(icon => icon.name === mode.icon), index => {
            mode.icon = icons[index].name;
            image.gicon = gioIcon(iconNameForMode(mode.icon), extensionPath);
        });
    iconRow.add_prefix(image);

    const pickers = [];
    pickers.push(devicePicker(ctx, scope, group(_('Output')), mode, 'output', validate));
    pickers.push(devicePicker(ctx, scope, group(_('Input')), mode, 'input', validate));
    const bt = group(_('Bluetooth'));
    const connect = new Adw.SwitchRow({title: _('Connect Bluetooth device automatically'), active: mode.bluetooth.connectIfNeeded});
    bt.add(connect);
    scope.connect(connect, 'notify::active', () => { mode.bluetooth.connectIfNeeded = connect.active; validate(); });

    const effects = new Adw.ExpanderRow({title: _('Effects'), subtitle: _('Checking EasyEffects…')});
    group('').add(effects);
    effects.sensitive = false;
    const enabled = new Adw.SwitchRow({title: _('Enable EasyEffects'), active: mode.effects.enabled});
    effects.add_row(enabled);
    let effectsInfo = null;
    const effectReasons = {
        'not-installed': _('EasyEffects is not installed'),
        'unknown-version': _('EasyEffects version could not be detected'),
        'v8-no-process-all': _('EasyEffects 8 cannot be switched to process all apps automatically; set it in EasyEffects'),
        'flatpak-no-gsettings': _("The Flatpak EasyEffects cannot be configured automatically; set 'process all outputs' in EasyEffects"),
    };
    const effectReason = () => effectReasons[effectsInfo?.reasonCode] ?? effectsInfo?.reason;
    const callsHelp = _('Calls only routes detected call audio through EasyEffects; other applications keep their normal routing.');
    function scopeSubtitle() {
        effectScope.subtitle = mode.effects.scope === 'all' && effectsInfo && !effectsInfo.canSetProcessAll
            ? [effectReason(), _('Set EasyEffects to process all outputs manually.')].filter(Boolean).join(' ')
            : callsHelp;
    }
    const effectScope = combo(effects, _('Apply effects to'), [_('All applications'), _('Calls only')],
        mode.effects.scope === 'calls' ? 1 : 0, index => {
            mode.effects.scope = index ? 'calls' : 'all';
            scopeSubtitle();
            effectsSummary();
        }, callsHelp);
    const presetNames = [[], []];
    const presetRows = ['output', 'input'].map((direction, index) =>
        combo(effects, direction === 'output' ? _('Output preset') : _('Input preset'),
            [_('None'), ...(mode.effects[`${direction}Preset`] ? [mode.effects[`${direction}Preset`]] : [])],
            mode.effects[`${direction}Preset`] ? 1 : 0,
            selected => { mode.effects[`${direction}Preset`] = presetNames[index][selected - 1] ?? null; }));
    buttonRow(effects, _('Open EasyEffects'), scope, () => {
        try {
            const app = Gio.DesktopAppInfo.new(`${easyeffects.APP_ID}.desktop`);
            if (app) app.launch([], null);
            else {
                if (!effectsInfo?.argv) return;
                spawnDetached(effectsInfo.argv);
            }
        } catch (error) {
            banner.title = error.message;
            banner.revealed = true;
        }
    });
    function effectsSummary() {
        effects.subtitle = !effectsInfo ? _('Checking EasyEffects…') : !effectsInfo.installed
            ? effectReason() ?? _('EasyEffects is not installed')
            : !mode.effects.enabled ? _('Off') : mode.effects.scope === 'calls' ? _('Calls only') : _('All applications');
    }
    function sensitivity() {
        effectScope.sensitive = enabled.active;
        for (const row of presetRows)
            row.sensitive = enabled.active && Boolean(effectsInfo?.canLoadPreset);
    }
    scope.connect(enabled, 'notify::active', () => {
        mode.effects.enabled = enabled.active;
        sensitivity();
        effectsSummary();
        validate();
    });
    ctx.effects.then(async info => {
        if (scope.destroyed)
            return;
        effectsInfo = info;
        if (!info.installed) {
            effectsSummary();
            return;
        }
        effects.subtitle = null;
        effects.sensitive = true;
        if (isNew && !info.canSetProcessAll) {
            const untouched = JSON.stringify(mode) === initial;
            mode.effects.scope = 'calls';
            effectScope.selected = 1;
            if (untouched) initial = JSON.stringify(mode);
        }
        scopeSubtitle();
        sensitivity();
        const presets = info.canLoadPreset
            ? await Promise.all(['output', 'input'].map(direction => easyeffects.listPresets(direction)))
            : [[], []];
        if (scope.destroyed)
            return;
        for (const [index, direction] of ['output', 'input'].entries()) {
            const key = `${direction}Preset`;
            const names = presets[index];
            if (mode.effects[key] && !names.includes(mode.effects[key]))
                names.push(mode.effects[key]);
            presetNames[index] = names;
            const saved = mode.effects[key];
            presetRows[index].model = Gtk.StringList.new([_('None'), ...names]);
            presetRows[index].selected = saved ? names.indexOf(saved) + 1 : 0;
            mode.effects[key] = saved;
        }
        effectsSummary();
        sensitivity();
        validate();
    }).catch(error => {
        if (!scope.destroyed) {
            effectsInfo = {installed: false, reason: error.message, reasonCode: null};
            effects.sensitive = false;
            effectsSummary();
            banner.title = error.message;
            banner.revealed = true;
        }
    });
    const fallback = new Adw.ExpanderRow({title: _('If those devices are unavailable'), subtitle: _('Choose fallback devices'), expanded: false});
    group('').add(fallback);
    for (const [direction, title] of [['output', _('Output')], ['input', _('Input')]]) {
        const section = new Adw.ExpanderRow({title});
        fallback.add_row(section);
        pickers.push(devicePicker(ctx, scope, section, mode.fallback, direction, validate, true));
    }
    const validationMessages = {
        'mode is not an object': _('Invalid mode'),
        'name must be a non-empty string': _('Enter a name.'),
        'output slot is malformed': _('Choose a valid output device.'),
        'input slot is malformed': _('Choose a valid input device.'),
        'mode needs at least one of output or input': _('Choose an output or input device.'),
        'bluetooth.connectIfNeeded must be a boolean': _('Choose a valid Bluetooth setting.'),
        'effects.enabled must be a boolean': _('Choose a valid effects setting.'),
        'effects.scope must be "all" or "calls"': _('Choose which applications use effects.'),
        'fallback slots are malformed': _('Choose valid fallback devices.'),
    };
    const validation = new Gtk.Label({wrap: true, xalign: 0, css_classes: ['error'], margin_top: 6});
    identity.add(validation);
    function validate() {
        mode.name = name.text.trim();
        const errors = validateMode(mode);
        validation.label = errors.map(error => validationMessages[error] ?? _('Invalid mode')).join(' ');
        validation.visible = errors.length > 0;
        save.sensitive = errors.length === 0;
        if (!mode.name) name.add_css_class('error');
        else name.remove_css_class('error');
        dialog.can_close = JSON.stringify(mode) === initial;
    }
    scope.connect(name, 'changed', validate);
    scope.connect(pipewire, 'changed', () => { refreshPlaying(); pickers.forEach(refresh => refresh()); });
    scope.connect(bluetooth, 'changed', () => pickers.forEach(refresh => refresh()));
    validate();
    dialog.present(ctx.window);
    pipewire.requestRefresh();
    const source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
        pipewire.requestRefresh();
        return GLib.SOURCE_CONTINUE;
    });
    scope.add(() => GLib.source_remove(source));
    return dialog;
}
