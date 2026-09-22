import GObject from 'gi://GObject';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {modeName} from './format.js';
import {SoundModesMenu, statusIcon} from './menu.js';

/** Quick Settings entry point for the shared menu. */
export const SoundModesIndicator = GObject.registerClass(
class SoundModesIndicator extends QuickSettings.SystemIndicator {
    constructor(controller, extension) {
        super();
        this._controller = controller;
        this._extension = extension;
        this._toggle = new QuickSettings.QuickMenuToggle({
            title: extension.gettext('Sound Modes'),
            gicon: statusIcon({state: 'idle'}, extension.path),
            toggleMode: false,
        });
        this.quickSettingsItems.push(this._toggle);
        this._clickedId = this._toggle.connect('clicked', () => this._toggle.menu.open());
        this._content = new SoundModesMenu(this._toggle.menu, controller, extension);
        this._statusId = controller.connect('status-changed', () => this._sync());
        // The shell may tear the toggle down before this indicator (session
        // shutdown); once it is gone there is nothing left to clean up on it.
        this._toggle.connect('destroy', () => {
            this._toggle = null;
        });
        this.connect('destroy', () => {
            this._controller.disconnect(this._statusId);
            this._content.destroy();
            if (!this._toggle)
                return;
            this._toggle.disconnect(this._clickedId);
            // GNOME 46 parents this menu in the overlay, outside the toggle.
            this._toggle.menu.destroy();
            this._toggle.destroy();
        });
        this._sync();
    }

    _sync() {
        const status = this._controller.status;
        this._content.sync(status);
        if (!status || !this._toggle)
            return;
        this._toggle.gicon = statusIcon(status, this._extension.path);
        this._toggle.subtitle = modeName(status, this._extension.gettext.bind(this._extension));
        this._toggle.checked = Boolean(status.activeModeId);
    }

    destroy() {
        super.destroy();
    }
});
