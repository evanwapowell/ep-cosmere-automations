/**
 * Sources: why a condition is on an actor. Pure functions, no Foundry globals.
 *
 * A condition effect carries a list of sources in its flags. A source is `{ key, label }`:
 * - `key: 'manual'` — someone applied it directly (HUD, sheet, API without a source);
 * - `key: 'effect:<effect id>'` — another condition on the same actor brought it (Prone → Slowed);
 * - `key: 'item:<item id>'` — an item on the same actor caused it (an injury).
 * The condition ends when its last source goes away.
 *
 * As in PF2e, a condition another source holds can't be removed by hand while that source is there (Slowed
 * while Prone; an injury's Exhausted). On a stackable condition (Exhausted), a source also records how many
 * stacks it holds (`stacks`, default 1). The rest are "free" stacks, applied by hand: only those go down by
 * hand or with a long rest, and a source's stacks go when the source does.
 */

export const MANUAL = Object.freeze({ key: 'manual', label: 'manual' });

const positiveInt = (n) => Number.isInteger(n) && n > 0;

/**
 * Normalize a stored sources value. Missing or malformed data means "applied by hand".
 * @param {unknown} stored
 * @returns {{key: string, label: string, stacks?: number}[]}
 */
export function readSources(stored) {
    if (!Array.isArray(stored)) return [{ ...MANUAL }];
    const valid = stored.filter((s) => s && typeof s.key === 'string' && s.key);
    if (!valid.length) return [{ ...MANUAL }];
    return valid.map((s) => {
        const out = { key: s.key, label: String(s.label ?? s.key) };
        if (positiveInt(s.stacks) && s.key !== MANUAL.key) out.stacks = s.stacks;
        return out;
    });
}

/**
 * Add a source. Returns a new list; a source with the same key is not added twice, but stacks it brings are
 * added to the ones it already holds.
 * @param {{key: string, label: string, stacks?: number}[]} sources
 * @param {{key: string, label: string, stacks?: number}} source
 */
export function addSource(sources, source) {
    const extra = source.key !== MANUAL.key && positiveInt(source.stacks) ? source.stacks : 0;
    if (sources.some((s) => s.key === source.key)) {
        if (!extra) return [...sources];
        return sources.map((s) => (s.key === source.key ? { ...s, stacks: (s.stacks ?? 1) + extra } : s));
    }
    const added = { key: source.key, label: source.label ?? source.key };
    if (extra) added.stacks = extra;
    return [...sources, added];
}

/**
 * Stacks held by sources other than a hand-applied one; a source that is gone holds none.
 * @param {{key: string, stacks?: number}[]} sources
 * @param {(key: string) => boolean} [isGone]
 */
export function heldStacks(sources, isGone = () => false) {
    return sources.filter((s) => s.key !== MANUAL.key && !isGone(s.key)).reduce((n, s) => n + (s.stacks ?? 1), 0);
}

/**
 * What holds a condition, for removal by hand.
 * @param {{key: string, label: string}[]} sources
 * @param {(key: string) => boolean} isGone
 * @returns {{held: string[], manual: boolean}} held: labels of the sources still there (empty: free to remove)
 */
export function holders(sources, isGone) {
    return {
        held: sources.filter((s) => s.key !== MANUAL.key && !isGone(s.key)).map((s) => s.label),
        manual: sources.some((s) => s.key === MANUAL.key),
    };
}

/**
 * A long rest takes up to `n` free stacks off a condition (the table's `longRest`). Stacks a source holds stay.
 * A condition that doesn't stack has one stack.
 * @param {number} total current stacks
 * @param {{key: string, label: string, stacks?: number}[]} sources
 * @param {number} [n] stacks a long rest takes off
 * @returns {{action: 'keep' | 'update' | 'delete', stacks: number, held: number,
 *   sources?: {key: string, label: string}[]}} sources: given when the hand-applied source should go (no free stack left)
 */
export function planLongRest(total, sources, n = 1) {
    const held = heldStacks(sources);
    const free = total - held;
    if (free <= 0) return { action: 'keep', stacks: total, held };
    const stacks = total - Math.min(n, free);
    if (stacks <= 0) return { action: 'delete', stacks: 0, held };
    const plan = { action: 'update', stacks, held };
    if (stacks <= held && sources.some((s) => s.key === MANUAL.key)) {
        plan.sources = sources.filter((s) => s.key !== MANUAL.key);
    }
    return plan;
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

/** The longest chain of links the engine follows (the effect that started it counts as the first). The table's own
 * chains are three deep (Unconscious → Prone → Slowed); anything longer is a loop or a mistake. */
export const MAX_LINK_DEPTH = 6;

/**
 * Which of an effect's links to apply now. The table is checked for cycles when it loads, but an effect's own rules
 * can link to a condition whose own rules link back, so the engine also guards at run time: a link whose condition
 * is already being applied higher up the chain is not followed (it would make two effects hold each other), and a
 * chain stops at `maxDepth`.
 * @param {string[]} chain what the engine is applying right now, root first, ending with the effect whose links
 *   these are: a table condition's id, or `effect:<id>` for any other effect
 * @param {string[]} links condition ids from the effect's resolved rules
 * @param {number} [maxDepth]
 * @returns {{apply: string[], skipped: {id: string, reason: 'loop' | 'depth'}[]}}
 */
export function planLinks(chain, links, maxDepth = MAX_LINK_DEPTH) {
    const apply = [];
    const skipped = [];
    for (const id of [...new Set(links ?? [])]) {
        if (chain.includes(id)) skipped.push({ id, reason: 'loop' });
        else if (chain.length >= maxDepth) skipped.push({ id, reason: 'depth' });
        else apply.push(id);
    }
    return { apply, skipped };
}

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
 * On a stackable condition (`stacks` given), the stacks a gone source held go with it.
 * @param {{id: string, sources: unknown, stacks?: number}[]} effects effects with their stored sources
 *   (non-array = not ours) and, for a stackable condition, its current stacks
 * @param {(key: string) => boolean} isGone
 * @returns {{id: string, action: 'delete' | 'update', sources: {key: string, label: string}[], stacks?: number}[]}
 */
export function planSourceRemoval(effects, isGone) {
    const plan = [];
    for (const effect of effects) {
        if (!Array.isArray(effect.sources)) continue; // never touched by the engine: leave it alone
        const current = readSources(effect.sources);
        const next = current.filter((s) => !isGone(s.key));
        if (next.length === current.length) continue;
        if (!next.length) {
            plan.push({ id: effect.id, action: 'delete', sources: next });
            continue;
        }
        if (!positiveInt(effect.stacks)) {
            plan.push({ id: effect.id, action: 'update', sources: next });
            continue;
        }
        const stacks = effect.stacks - (heldStacks(current) - heldStacks(next));
        plan.push(stacks > 0 ? { id: effect.id, action: 'update', sources: next, stacks } : { id: effect.id, action: 'delete', sources: next });
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
