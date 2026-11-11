// KV does not order visibility of different keys across locations. Preserve
// recent per-file decisions in the index snapshot so a late older event or a
// mutually stale list/get pair cannot silently reverse an acknowledged delete.
const RETENTION_MS = 60 * 60 * 1000;
const MAX_STATES = 20000;

export function readKVMutationStates(metadata) {
    const states = new Map();
    for (const state of Array.isArray(metadata?.mutationStates) ? metadata.mutationStates : []) {
        if (typeof state?.id === 'string' && state.id && Number.isFinite(state.t)
            && typeof state.p === 'boolean' && Number.isFinite(state.at)) {
            states.set(state.id, state);
        }
    }
    return states;
}

export function shouldApplyKVMutation(states, id, timestamp, present) {
    const previous = states.get(id);
    return !previous || timestamp > previous.t
        || (timestamp === previous.t && !present && previous.p);
}

export function noteKVMutation(states, id, timestamp, present) {
    states.delete(id);
    states.set(id, { id, t: timestamp, p: present, at: Date.now() });
}

export function compactKVMutationStates(states) {
    const cutoff = Date.now() - RETENTION_MS;
    for (const [id, state] of states) if (state.at < cutoff) states.delete(id);
    if (states.size > MAX_STATES) throw new Error('KV index mutation history is full; migrate metadata to D1');
    return [...states.values()];
}

export function matchesKVMutationStates(files, states) {
    const ids = new Set(files.map(file => file.id));
    for (const state of states.values()) {
        if (state.at < Date.now() - RETENTION_MS) continue;
        if (ids.has(state.id) !== state.p) return false;
    }
    return true;
}
