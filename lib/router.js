// Decides which streams should go through EasyEffects and moves them there
// with per-stream targets. Idempotent: it only issues a command when the
// snapshot does not already show the wanted target.

import {classifyStreams} from './calls.js';
import {SINK, SOURCE, isRunning} from './easyeffects.js';

function isEffectsNode(name) {
    return name === SINK || name === SOURCE;
}

// EasyEffects' own meter/spectrum streams must never be re-targeted.
function routable(streams) {
    return streams.filter(s =>
        !s.monitor && s.appName !== 'easyeffects' && !s.name?.startsWith('ee_'));
}

/** Per-stream routing to the EasyEffects nodes. */
export class Router {
    constructor(pipewire) {
        this._pipewire = pipewire;
    }

    /**
     * Bring stream targets in line with a mode's effects scope.
     * @param {object} snapshot
     * @param {?object} mode active mode, or null when none is
     * @param {Object<string, 'always'|'never'>} [overrides] call detection overrides
     * @returns {Promise<{moved: number, cleared: number}>}
     */
    async sync(snapshot, mode, overrides = {}) {
        const effects = mode?.effects;

        // In the "all" scope EasyEffects moves every stream itself through its
        // process-all switch, and a target it set is indistinguishable from one
        // the user set by hand — so leave every target alone there.
        if (effects?.enabled && effects.scope === 'all')
            return {moved: 0, cleared: 0};

        const routing = Boolean(effects?.enabled && effects.scope === 'calls' && isRunning(snapshot));
        const callIds = routing
            ? new Set(classifyStreams(snapshot.streams, overrides).callStreams.map(s => s.id))
            : new Set();

        let moved = 0;
        let cleared = 0;
        for (const stream of routable(snapshot.streams)) {
            const node = stream.direction === 'output' ? SINK : SOURCE;
            if (callIds.has(stream.id)) {
                if (stream.target === node)
                    continue;
                await this._pipewire.setTarget(stream.id, node);
                moved++;
            } else if (isEffectsNode(stream.target)) {
                await this._pipewire.clearTarget(stream.id);
                cleared++;
            }
        }
        return {moved, cleared};
    }

    /**
     * Drop every EasyEffects target, whoever set it.
     * @param {object} snapshot
     * @returns {Promise<{moved: number, cleared: number}>}
     */
    async reset(snapshot) {
        let cleared = 0;
        for (const stream of routable(snapshot.streams)) {
            if (!isEffectsNode(stream.target))
                continue;
            await this._pipewire.clearTarget(stream.id);
            cleared++;
        }
        return {moved: 0, cleared};
    }
}
