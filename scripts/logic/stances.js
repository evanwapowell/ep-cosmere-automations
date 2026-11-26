/**
 * Stance helpers. Pure functions, no Foundry globals.
 *
 * In the system, a stance is a talent with `system.modality: 'stance'`. In some data its activation cost sits
 * on an action the talent grants (e.g. action `stone-stance` from talent `stonestance`); using that action does
 * not call `actor.setMode`, so the stance's effects never switch on. These helpers find the talent behind an
 * action. In other data (the Stormlight Handbook talents in a live world, 2026-11-25) there is no such action
 * and the talent itself is listed as usable on the sheet: see `talentMode`.
 */

/** Lowercase, letters and digits only: `stone-stance` and `Stonestance` both become `stonestance`. */
export function normalizeId(id) {
    return String(id ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The relationships stored on an item, as a plain array (the system keeps them in a collection field).
 * @param {unknown} relationships
 */
export function relationshipList(relationships) {
    if (!relationships) return [];
    if (Array.isArray(relationships)) return relationships;
    if (Array.isArray(relationships.contents)) return relationships.contents;
    if (typeof relationships[Symbol.iterator] === 'function') return [...relationships];
    if (typeof relationships === 'object') return Object.values(relationships);
    return [];
}

/**
 * Find the modality talent an action belongs to.
 * First by the system's item relationship (the granting talent is the action's parent),
 * then by matching ids (`stone-stance` ↔ `stonestance`).
 * @param {{system: {id?: string, modality?: string, relationships?: unknown}}} action
 * @param {{id: string, uuid?: string, type: string, system: {id?: string, modality?: string}}[]} items the actor's items
 * @returns {object | null} the talent, or null
 */
export function findModalityTalent(action, items) {
    if (!action?.system || action.system.modality) return null; // the system handles items with their own modality
    const talents = items.filter((item) => item?.type === 'talent' && item.system?.modality);
    if (!talents.length) return null;

    for (const rel of relationshipList(action.system.relationships)) {
        if (rel?.type !== 'parent') continue;
        const uuid = String(rel.uuid ?? '');
        const talent = talents.find((t) => (t.uuid && t.uuid === uuid) || (t.id && uuid.endsWith(`Item.${t.id}`)));
        if (talent) return talent;
    }

    const actionId = normalizeId(action.system.id);
    if (!actionId) return null;
    return talents.find((t) => normalizeId(t.system.id) === actionId) ?? null;
}

/**
 * The mode a talent switches on when it is used itself: `{modality, id}`, or null for anything that is not a
 * talent with a modality and an id. The system's `item.use()` returns null for every non-action, so a stance
 * talent used from the sheet (the Stormlight Handbook data has no separate stance actions) does nothing unless
 * the module handles it.
 * @param {{type?: string, system?: {id?: string, modality?: string}}} item
 */
export function talentMode(item) {
    if (item?.type !== 'talent') return null;
    const modality = item.system?.modality;
    const id = item.system?.id;
    return modality && id ? { modality, id } : null;
}

/** Whether a mode id means "no stance" (the handbook's End Stance talent). */
export function isEndStance(modeId) {
    return normalizeId(modeId) === 'endstance';
}
