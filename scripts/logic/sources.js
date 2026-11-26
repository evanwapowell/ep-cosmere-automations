/**
 * Sources: why a condition is on an actor. Pure functions, no Foundry globals.
 *
 * A condition effect carries a list of sources in its flags. A source is `{ key, label }`:
 * - `key: 'manual'` — someone applied it directly (HUD, sheet, API without a source);
 * - `key: 'effect:<effect id>'` — another condition on the same actor brought it (Prone → Slowed);
 * - `key: 'item:<item id>'` — an item on the same actor caused it (an injury, later).
 * The condition ends when its last source goes away.
 */

export const MANUAL = Object.freeze({ key: 'manual', label: 'manual' });

/**
 * Normalize a stored sources value. Missing or malformed data means "applied by hand".
 * @param {unknown} stored
 * @returns {{key: string, label: string}[]}
 */
export function readSources(stored) {
    if (!Array.isArray(stored)) return [{ ...MANUAL }];
    const valid = stored.filter((s) => s && typeof s.key === 'string' && s.key);
    return valid.length ? valid.map((s) => ({ key: s.key, label: String(s.label ?? s.key) })) : [{ ...MANUAL }];
}

/**
 * Add a source. Returns a new list; a source with the same key is not added twice.
 * @param {{key: string, label: string}[]} sources
 * @param {{key: string, label: string}} source
 */
export function addSource(sources, source) {
    if (sources.some((s) => s.key === source.key)) return [...sources];
    return [...sources, { key: source.key, label: source.label ?? source.key }];
}

/**
 * Remove a source by key.
 * @param {{key: string, label: string}[]} sources
 * @param {string} key
 * @returns {{sources: {key: string, label: string}[], changed: boolean, orphaned: boolean}}
 *   orphaned: no source is left, so the condition should end
 */
export function removeSource(sources, key) {
    const next = sources.filter((s) => s.key !== key);
    return { sources: next, changed: next.length !== sources.length, orphaned: next.length === 0 };
}

export const effectKey = (id) => `effect:${id}`;
export const itemKey = (id) => `item:${id}`;

/**
 * Whether a source no longer exists on the actor. Manual and unknown kinds never go away by themselves.
 * @param {string} key
 * @param {{effectIds: Set<string>, itemIds: Set<string>}} present
 */
export function isSourceGone(key, present) {
    if (key.startsWith('effect:')) return !present.effectIds.has(key.slice(7));
    if (key.startsWith('item:')) return !present.itemIds.has(key.slice(5));
    return false;
}

/**
 * Plan what happens to the effects on an actor after something ended: every source that no longer exists
 * is dropped, and an effect left without sources ends. Looking at what is gone (rather than at the one
 * thing that just ended) gives the same answer however many deletions happen at once.
 * @param {{id: string, sources: unknown}[]} effects effects with their stored sources (non-array = not ours)
 * @param {(key: string) => boolean} isGone
 * @returns {{id: string, action: 'delete' | 'update', sources: {key: string, label: string}[]}[]}
 */
export function planSourceRemoval(effects, isGone) {
    const plan = [];
    for (const effect of effects) {
        if (!Array.isArray(effect.sources)) continue; // never touched by the engine: leave it alone
        const current = readSources(effect.sources);
        const next = current.filter((s) => !isGone(s.key));
        if (next.length === current.length) continue;
        plan.push({ id: effect.id, action: next.length ? 'update' : 'delete', sources: next });
    }
    return plan;
}

/**
 * Readable list of non-manual sources ("from Prone, Shallow Injury"), or '' when applied by hand only.
 * @param {{key: string, label: string}[]} sources
 */
export function describeSources(sources) {
    const named = sources.filter((s) => s.key !== MANUAL.key).map((s) => s.label);
    return named.join(', ');
}
