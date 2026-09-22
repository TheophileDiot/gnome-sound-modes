/** Isolate names supplied by devices and users from surrounding translated text. */
export function isolate(text) {
    return `\u2068${text}\u2069`;
}

/** Format a list without mixing the direction of its names and punctuation. */
export function nameList(names, _) {
    return names.map(isolate).join(_(', '));
}

/** Whether a call is deliberately keeping the headset profile in use. */
export function headsetInCall(status) {
    return status.reason === 'Headset profile in use by a call';
}

/** Summarize a problem, or describe the current output. */
export function statusLine(status, _, ngettext, failureKind = status.errorKind) {
    if (status.state === 'applying')
        return _('Switching sound mode…');
    if (headsetInCall(status))
        return _('Headset is in a call. Audio quality is unchanged.');
    if (status.state === 'failed') {
        if (failureKind === 'bt-connect')
            return _('The Bluetooth device did not connect. Turn it on and try again.');
        if (failureKind === 'profile')
            return _('Audio quality could not be changed. Close apps using the headset and try again.');
        if (failureKind === 'default-sink' || failureKind === 'default-source')
            return _('The audio device could not be selected. Check its connection and try again.');
        if (failureKind === 'effects-start')
            return _('EasyEffects could not start. Open EasyEffects and try again.');
        if (failureKind === 'effects-preset')
            return _('An effects preset could not be loaded. Check your presets in EasyEffects and try again.');
        if (failureKind === 'effects-process-all')
            return _('Effects could not be applied to all audio. Check EasyEffects and try again.');
        if (failureKind === 'routing')
            return _('Call audio could not be routed. Check your audio devices and try again.');
        return _('Could not switch modes. Check your devices and try again.');
    }
    if (status.missing.length)
        return ngettext('%d device missing', '%d devices missing', status.missing.length).format(status.missing.length);
    if (status.state === 'missing')
        return _('A device is unavailable. Check its connection.');
    if (status.state === 'degraded') {
        if (status.reason)
            return isolate(status.reason);
        if (status.effects?.scope != null) {
            if (!status.effects.installed)
                return _('EasyEffects is not installed. Install it to use effects.');
            if (!status.effects.running)
                return _('EasyEffects is not running. Open it to use effects.');
        }
        return _('Audio settings changed outside Sound Modes.');
    }
    if (status.output?.profileLabel)
        return _('%s (%s)').format(isolate(status.output.name), isolate(status.output.profileLabel));
    return status.output ? isolate(status.output.name) : _('No output selected');
}

/** Describe effects without joining preset names into a single long line. */
export function effectsLine(status, _) {
    const effects = status.effects;
    if (!effects || effects.scope === null)
        return _('Off');
    if (!effects.installed)
        return _('Not installed');
    if (!effects.running)
        return _('Not running');
    return effects.scope === 'calls' ? _('Calls only') : _('All audio');
}

/** Format the selected output name; audio quality has its own row. */
export function outputLine(status, _) {
    return status.output ? isolate(status.output.name) : _('None');
}

/** Name the active mode, or the custom setup. */
export function modeName(status, _) {
    return status.state === 'custom' || status.state === 'idle' || !status.modeName
        ? _('Custom') : isolate(status.modeName);
}
