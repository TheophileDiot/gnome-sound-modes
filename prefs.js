import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {PipeWire} from './lib/pipewire.js';
import {Bluetooth} from './lib/bluetooth.js';
import * as easyeffects from './lib/easyeffects.js';
import {modesPage} from './ui/prefs/modesPage.js';
import {devicesPage} from './ui/prefs/devicesPage.js';
import {callsPage} from './ui/prefs/callsPage.js';
import {advancedPage} from './ui/prefs/advancedPage.js';
import {setupStyle} from './ui/prefs/widgets.js';

// Rows and dialogs have shorter lifetimes than the preferences window.
function signalScope(parent = null) {
    const cleanups = new Set();
    const scope = {
        destroyed: false,
        add(cleanup) { cleanups.add(cleanup); },
        connect(object, signal, callback) {
            const id = object.connect(signal, (...args) => {
                if (!scope.destroyed)
                    return callback(...args);
                return undefined;
            });
            scope.add(() => object.disconnect(id));
        },
        child() { return signalScope(scope); },
        destroy() {
            if (scope.destroyed)
                return;
            scope.destroyed = true;
            for (const cleanup of cleanups)
                cleanup();
            cleanups.clear();
            parent?._forget(scope.destroy);
        },
        _forget(cleanup) { cleanups.delete(cleanup); },
    };
    parent?.add(scope.destroy);
    return scope;
}

export default class SoundModesPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const scope = signalScope();
        const pipewire = new PipeWire();
        const bluetooth = new Bluetooth();
        const cancellable = new Gio.Cancellable();
        const gettext = this.gettext.bind(this);
        const ctx = {
            window, scope, pipewire, bluetooth, gettext,
            extensionPath: this.path,
            settings: this.getSettings(),
            effects: easyeffects.detect(cancellable).catch(error => ({
                installed: false, reason: error.message, reasonCode: null,
            })),
            notify(message) {
                if (!scope.destroyed)
                    window.add_toast(new Adw.Toast({title: message}));
            },
        };
        window.search_enabled = true;
        window.set_default_size(820, 720);
        setupStyle(ctx);
        for (const build of [modesPage, devicesPage, callsPage, advancedPage])
            window.add(build(ctx));
        scope.connect(window, 'close-request', () => {
            scope.destroy();
            return false;
        });
        scope.connect(window, 'destroy', () => scope.destroy());
        scope.add(() => cancellable.cancel());
        scope.add(() => pipewire.destroy());
        scope.add(() => bluetooth.destroy());
        scope.connect(bluetooth, 'changed', () => pipewire.requestRefresh());
        bluetooth.init().then(() => {
            if (scope.destroyed)
                bluetooth.destroy();
            else
                bluetooth.emit('changed');
        }).catch(error => ctx.notify(error.message));
        pipewire.refresh(cancellable).catch(error => ctx.notify(error.message));
    }
}
