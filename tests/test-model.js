import {
    MODE_VERSION, createMode, validateMode, parseModes, serializeModes,
    duplicateMode, moveMode, ICONS,
} from '../lib/model.js';

function assert(cond, msg) {
    if (!cond)
        throw new Error(`assertion failed: ${msg}`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const mode = createMode({name: 'Video Call', output: {match: {'device.name': 'x'}, profile: null}});
assert(mode.version === MODE_VERSION, 'default version');
assert(UUID_RE.test(mode.id), 'generated uuid id');
assert(mode.name === 'Video Call', 'partial name kept');
assert(mode.icon && typeof mode.icon === 'string', 'default icon present');
assert(mode.input === null, 'default input null');
assert(mode.bluetooth.connectIfNeeded === true, 'default bluetooth.connectIfNeeded');
assert(mode.effects.enabled === false && mode.effects.scope === 'all', 'default effects');
assert(mode.effects.outputPreset === null && mode.effects.inputPreset === null, 'default presets null');
assert(mode.fallback.output === null && mode.fallback.input === null, 'default fallback');

const partialEffects = createMode({
    name: 'Music', output: {match: {}, profile: null}, effects: {enabled: true},
});
assert(partialEffects.effects.enabled === true && partialEffects.effects.scope === 'all',
    'partial effects merge onto defaults');

assert(createMode().id !== createMode().id, 'each mode gets a fresh id');

assert(validateMode(mode).length === 0, 'well-formed mode is valid');

const noName = createMode({output: {match: {'device.name': 'x'}, profile: null}, name: ''});
assert(validateMode(noName).length > 0, 'empty name is invalid');

const noSlots = createMode({name: 'Empty'});
assert(validateMode(noSlots).length > 0, 'mode with no output and no input is invalid');

const badScope = createMode({name: 'Bad', output: {match: {}, profile: null}, effects: {scope: 'sometimes'}});
assert(validateMode(badScope).some(e => /scope/i.test(e)), 'invalid scope reported');

const {modes: two, rejected: noRejected, warnings: noWarnings, changed: noChange} =
    parseModes(serializeModes([mode, partialEffects]));
assert(two.length === 2 && noWarnings.length === 0, 'round trip through serializeModes/parseModes');
assert(two[0].id === mode.id, 'round trip preserves id');
assert(noRejected.length === 0, 'nothing rejected for an already-valid round trip');
assert(noChange === false, 'an already-normalized round trip does not report changed');

// name '' + no slots at all has no sane default (there's nothing to fill
// a slot with), so it still can't be repaired and is set aside verbatim
const unrepairable = {version: 1, id: 'bad', name: '', output: null, input: null};
const mixedJson = JSON.stringify([mode, unrepairable]);
const {modes: kept, rejected: mixedRejected, warnings} = parseModes(mixedJson);
assert(kept.length === 1 && kept[0].id === mode.id, 'entries that cannot be repaired are excluded from modes');
assert(warnings.length === 1, 'a warning is recorded per rejected entry');
assert(mixedRejected.length === 1 && mixedRejected[0].id === 'bad',
    'the unrepairable entry is preserved verbatim in rejected');

// a slot saved without `profile` (or without `match`) is filled in, not dropped
const {modes: sparse, warnings: sparseWarnings} = parseModes(JSON.stringify([{
    id: 'sparse-mode', name: 'Sparse', output: {match: {'device.name': 'x'}},
}]));
assert(sparse.length === 1, `a slot without profile survives parsing, warnings: ${sparseWarnings}`);
assert(sparse[0].output.profile === null, 'the missing profile defaults to null');
assert(sparse[0].output.match['device.name'] === 'x', 'the match is kept as saved');
const {modes: noMatch} = parseModes(JSON.stringify([{
    id: 'no-match', name: 'No match', input: {profile: null},
}]));
assert(noMatch.length === 1 && Object.keys(noMatch[0].input.match).length === 0,
    'a slot without a match gets an empty one');

const {modes: fromGarbage, warnings: garbageWarnings} = parseModes('not json');
assert(fromGarbage.length === 0 && garbageWarnings.length === 1, 'malformed json yields empty modes and a warning');

// a blank name is repaired instead of dropping the whole mode (the bug:
// a mode with an empty name used to vanish silently after one reorder)
const {modes: blankName, warnings: blankWarnings} = parseModes(JSON.stringify([{
    id: 'blank-name', name: '', output: {match: {}, profile: null},
}]));
assert(blankName.length === 1 && blankName[0].name === 'Unnamed mode',
    'a blank name is repaired to "Unnamed mode" instead of being dropped');
assert(blankWarnings.length === 0, 'a repaired mode produces no warning');

// an entry with no sane repair (not even an object) is set aside verbatim
// and round-trips through serializeModes without being lost
const garbageEntry = 42;
const {modes: withGarbage, rejected: garbageRejected} = parseModes(JSON.stringify([mode, garbageEntry]));
assert(withGarbage.length === 1, 'the garbage entry is excluded from modes');
assert(garbageRejected.length === 1 && garbageRejected[0] === 42, 'the garbage entry is captured verbatim');
const roundTripped = JSON.parse(serializeModes(withGarbage, garbageRejected));
assert(roundTripped.length === 2 && roundTripped[1] === 42,
    'serializeModes appends rejected entries so a round trip never loses them');

// a stored mode without an id gets one minted, and that repair is
// reported via `changed` so a caller knows to write the list back once
const {modes: idMinted, changed: idChanged} = parseModes(JSON.stringify([{
    name: 'No Id', output: {match: {}, profile: null},
}]));
assert(idMinted.length === 1 && UUID_RE.test(idMinted[0].id), 'a missing id is minted');
assert(idChanged === true, 'minting an id (or any other repair) marks the result as changed');

const dup = duplicateMode(mode);
assert(dup.id !== mode.id, 'duplicate gets a new id');
assert(dup.name === `${mode.name} (copy)`, 'duplicate name suffixed');
assert(dup.output.match['device.name'] === 'x', 'duplicate keeps slot data');

const a = createMode({name: 'A', output: {match: {}, profile: null}});
const b = createMode({name: 'B', output: {match: {}, profile: null}});
const c = createMode({name: 'C', output: {match: {}, profile: null}});
const moved = moveMode([a, b, c], c.id, -1);
assert(moved.map(m => m.id).join() === [a.id, c.id, b.id].join(), 'moveMode swaps with previous entry');
const clampedUp = moveMode([a, b, c], a.id, -1);
assert(clampedUp.map(m => m.id).join() === [a.id, b.id, c.id].join(), 'moveMode clamps at the start');
const clampedDown = moveMode([a, b, c], c.id, 5);
assert(clampedDown.map(m => m.id).join() === [a.id, b.id, c.id].join(), 'moveMode clamps at the end');
const untouched = moveMode([a, b, c], 'missing-id', 1);
assert(untouched.map(m => m.id).join() === [a.id, b.id, c.id].join(), 'moveMode ignores unknown id');

for (const name of ['audio-headphones', 'audio-speakers', 'audio-input-microphone', 'camera-web',
    'phone', 'call-start', 'bluetooth-active', 'audio-card', 'multimedia-player', 'video-display']) {
    const icon = ICONS.find(i => i.name === name);
    assert(icon && typeof icon.label === 'string' && icon.label.length > 0, `ICONS has a labeled entry for ${name}`);
}

print('test-model: all checks passed');
