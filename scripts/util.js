import { MODULE_ID } from './constants.js';

export function log(...args) {
    console.log(`${MODULE_ID} |`, ...args);
}

export function warn(...args) {
    console.warn(`${MODULE_ID} |`, ...args);
}

/**
 * Wrap a hook handler so an error logs and skips instead of breaking the caller (a roll, a sheet, a toggle).
 * Async handlers are covered too.
 * @param {string} label
 * @param {Function} fn
 */
export function safe(label, fn) {
    return function (...args) {
        try {
            const result = fn.apply(this, args);
            if (result && typeof result.catch === 'function') {
                result.catch((err) => console.error(`${MODULE_ID} | ${label} failed`, err));
            }
            return result;
        } catch (err) {
            console.error(`${MODULE_ID} | ${label} failed`, err);
            return undefined;
        }
    };
}

/**
 * Create effects that carry one status of their own (the stance marker, Dodging, Bracing, Advantage gained).
 * The system's `ActiveEffect._preCreate` reads `this.id` for every effect with exactly one status, and the id is
 * still null at that point unless it is chosen by the caller and kept: such an effect created without `keepId`
 * throws in cosmere-rpg 3.1.2 (seen live 2026-11-25). So the id is chosen here.
 * @param {Actor} actor
 * @param {object[]} list effect data
 * @param {object} [options] passed on to `createEmbeddedDocuments`
 */
export function createOwnEffects(actor, list, options = {}) {
    const data = list.map((d) => ({ ...d, _id: d._id ?? foundry.utils.randomID(16) }));
    return actor.createEmbeddedDocuments('ActiveEffect', data, { ...options, keepId: true });
}

/** Localize with an English fallback when the key is missing. */
export function t(key, data, fallback) {
    const full = `${MODULE_ID}.${key}`;
    const i18n = globalThis.game?.i18n;
    if (i18n?.has?.(full)) return data ? i18n.format(full, data) : i18n.localize(full);
    let text = fallback ?? key;
    for (const [k, v] of Object.entries(data ?? {})) text = text.replaceAll(`{${k}}`, String(v));
    return text;
}

/** Escape text for HTML. */
export function esc(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

/** The localized label of a system status, or the table's English name. */
export function statusLabel(id, fallback) {
    const label = globalThis.CONFIG?.COSMERE?.statuses?.[id]?.label;
    return label ? game.i18n.localize(label) : (fallback ?? id);
}

/** The name players see for an actor (its token's name when it is a token actor). */
export function actorName(actor) {
    return actor?.token?.name ?? actor?.name ?? '?';
}

/** Choices for the value dialog and API checks, from the system's config. */
export function systemChoices() {
    const cosmere = globalThis.CONFIG?.COSMERE ?? {};
    const loc = (label) => (label ? game.i18n.localize(label) : '');
    const damageTypes = Object.fromEntries(
        Object.entries(cosmere.damageTypes ?? {}).map(([id, c]) => [id, loc(c.label) || id]),
    );
    const attributes = Object.fromEntries(
        Object.entries(cosmere.attributes ?? {}).map(([id, c]) => [id, loc(c.label) || id]),
    );
    return { damageTypes, attributes };
}

/** Whether this client is the active GM, which handles world-level work (turn events, expiry). */
export function isActiveGM() {
    const gm = game.users?.activeGM;
    return gm ? gm.id === game.user.id : !!game.user?.isGM;
}

const queues = new Map();

/**
 * Run async work one at a time per key (e.g. per actor), so handlers for a batch of changes
 * don't edit the same documents at once.
 * @param {string} key
 * @param {() => Promise<unknown>} fn
 */
export function serial(key, fn) {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    queues.set(key, tail);
    tail.then(() => {
        if (queues.get(key) === tail) queues.delete(key);
    });
    return next;
}
