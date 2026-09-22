import GObject from 'gi://GObject';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {SoundModesMenu, statusIcon} from './menu.js';

/** Top-bar entry point for the shared menu. */
export const SoundModesPanelButton = GObject.registerClass(
class SoundModesPanelButton extends PanelMenu.Button {
    constructor(controller, extension) {
        super(0.0, extension.gettext('Sound Modes'));
        this._controller = controller;
        this._extension = extension;
        this._icon = new St.Icon({
            style_class: 'system-status-icon',
            gicon: statusIcon({state: 'idle'}, extension.path),
        });
        this.add_child(this._icon);
        this.menu.box.add_style_class_name('sound-modes-panel-menu');
        this._content = new SoundModesMenu(this.menu, controller, extension);
        this._statusId = controller.connect('status-changed', () => this._sync());
        this.connect('destroy', () => {
            this._controller.disconnect(this._statusId);
            this._content.destroy();
        });
        this._sync();
    }

    _sync() {
        const status = this._controller.status;
        this._content.sync(status);
        if (status)
            this._icon.gicon = statusIcon(status, this._extension.path);
    }

    destroy() {
        super.destroy();
    }
});
