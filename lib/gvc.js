// Shell-only: wraps the GNOME Shell volume mixer singleton. Never imported
// by lib/*.js modules used from the preferences process.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

const COALESCE_MS = 150;

const CONTROL_SIGNALS = [
    'stream-added', 'stream-removed', 'stream-changed',
    'card-added', 'card-removed',
    'default-sink-changed', 'default-source-changed',
    'active-output-update', 'active-input-update',
];

/**
 * Coalesces the mixer control's chatty signal set into one `changed` signal
 * at most every 150ms.
 */
export const GvcEvents = GObject.registerClass({
    Signals: {'changed': {}},
}, class GvcEvents extends GObject.Object {
    _init() {
        super._init();
        this._control = getMixerControl();
        this._sourceId = 0;
        this._handlerIds = CONTROL_SIGNALS.map(signal =>
            this._control.connect(signal, () => this._scheduleChanged()));
    }

    _scheduleChanged() {
        if (this._sourceId)
            return;
        this._sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COALESCE_MS, () => {
            this._sourceId = 0;
            this.emit('changed');
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._sourceId) {
            GLib.source_remove(this._sourceId);
            this._sourceId = 0;
        }
        for (const id of this._handlerIds)
            this._control.disconnect(id);
        this._handlerIds = [];
        this._control = null;
    }
});
