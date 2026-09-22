import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as easyeffects from './lib/easyeffects.js';
import * as log from './lib/log.js';
import {Bluetooth} from './lib/bluetooth.js';
import {Controller} from './lib/controller.js';
import {GvcEvents} from './lib/gvc.js';
import {PipeWire} from './lib/pipewire.js';
import {SoundModesIndicator} from './ui/indicator.js';
import {SoundModesPanelButton} from './ui/panelButton.js';

export default class SoundModesExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        log.setDebug(this._settings.get_boolean('debug'));
        this._debugHandler = this._settings.connect('changed::debug',
            () => log.setDebug(this._settings.get_boolean('debug')));

        this._pipewire = new PipeWire();
        this._bluetooth = new Bluetooth();
        this._bluetooth.init().catch(e => log.warn(`bluetooth unavailable: ${e.message}`));
        this._gvc = new GvcEvents();

        this._controller = new Controller(this._settings, {
            pipewire: this._pipewire,
            bluetooth: this._bluetooth,
            easyeffects,
            gvc: this._gvc,
        });
        this._controller.init().catch(e => log.error(`could not start: ${e.message}`));

        this._indicator = new SoundModesIndicator(this._controller, this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator, 2);
        this._panelButtonHandler = this._settings.connect('changed::show-indicator',
            () => this._syncPanelButton());
        this._syncPanelButton();
    }

    _syncPanelButton() {
        if (!this._settings.get_boolean('show-indicator')) {
            this._panelButton?.destroy();
            this._panelButton = null;
        } else if (!this._panelButton) {
            this._panelButton = new SoundModesPanelButton(this._controller, this);
            Main.panel.addToStatusArea(this.uuid, this._panelButton, 0, 'right');
        }
    }

    disable() {
        if (this._panelButtonHandler) {
            this._settings.disconnect(this._panelButtonHandler);
            this._panelButtonHandler = 0;
        }
        this._panelButton?.destroy();
        this._panelButton = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._controller?.destroy();
        this._controller = null;

        this._gvc?.destroy();
        this._gvc = null;

        this._bluetooth?.destroy();
        this._bluetooth = null;

        this._pipewire?.destroy();
        this._pipewire = null;

        if (this._debugHandler) {
            this._settings.disconnect(this._debugHandler);
            this._debugHandler = 0;
        }
        log.setDebug(false);
        this._settings = null;
    }
}
