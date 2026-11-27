/**
 * Layer 2: mechanics.
 * - Derived adjustments read from the rules of every effect that applies to the actor (its own effects and those
 *   its items transfer): movement 0 or half, skill modifiers (Exhausted), fixed attribute bonuses.
 * - Value-driven effect changes (Enhanced) written when the effect is created.
 */
import { CONDITIONS_BY_ID } from '../data/conditions.js';
import { FLAGS, MODES, MODULE_ID } from './constants.js';
import { planAdjustments, rateBonusDelta, skillDelta } from './logic/mechanics.js';
import { conditionIdOf } from './logic/table.js';
import { normalizeValue, valueEffectData } from './logic/values.js';
import { ruleEffects, rulesOf } from './rules.js';
import { conditionMode, effectRulesMode, engineEnabled } from './settings.js';
import { safe, statusLabel, systemChoices, warn } from './util.js';

let wrapped = false;

/**
 * Wrap one method of the actor class so `after(actor)` runs after it. A failure in `after` is logged and never
 * breaks the actor's preparation.
 */
function wrapAfter(cls, method, label, after) {
    const original = cls.prototype[method];
    cls.prototype[method] = function (...args) {
        const result = original.apply(this, args);
        try {
            after(this);
        } catch (err) {
            console.error(`${MODULE_ID} | ${label} failed for ${this?.name}`, err);
        }
        return result;
    };
}

/** Wrap the actor's derived-data step. Called at init, after the system has set CONFIG.Actor.documentClass. */
export function registerMechanics() {
    const cls = CONFIG.Actor?.documentClass;
    if (!cls?.prototype?.prepareDerivedData) {
        warn('No actor class to wrap; derived adjustments are off.');
    } else if (!wrapped) {
        // cosmere-rpg 3.1.x calls applyActiveEffects() inside prepareDerivedData, then derives skills, movement and
        // senses from the attributes: an attribute bonus has to be in place between the two.
        if (typeof cls.prototype.applyActiveEffects === 'function') {
            wrapAfter(cls, 'applyActiveEffects', 'attribute bonuses', applyAttributeBonuses);
        } else {
            warn('No applyActiveEffects to wrap; fixed attribute bonuses from effect rules are off.');
        }
        wrapAfter(cls, 'prepareDerivedData', 'derived adjustments', applyDerivedAdjustments);
        wrapped = true;
    }

    Hooks.on('preCreateActiveEffect', safe('preCreateActiveEffect', onPreCreate));
}

/** Active condition effects on an actor, one entry per effect, each with its resolved rules. */
export function activeConditions(actor) {
    return ruleEffects(actor, { includeEmpty: true })
        .filter((row) => row.conditionId)
        .map(({ conditionId, stacks, effect, rules }) => ({ id: conditionId, stacks, effect, rules }));
}

/**
 * Every effect that applies to the actor and has mechanics, as rows for `planAdjustments`: the actor's own
 * effects and those its items transfer to it, enabled and unsuppressed.
 * @param {Actor} actor
 * @returns {(import('./logic/mechanics.js').MechanicRow & {conditionId: string | null, effect: ActiveEffect})[]}
 */
export function mechanicRows(actor) {
    return ruleEffects(actor, { transferred: true })
        .filter((row) => row.rules.mechanics?.length)
        .map(({ effect, rules, stacks, value, conditionId }) => ({
            key: conditionId ?? effect.uuid ?? effect.id,
            rules,
            stacks,
            value,
            conditionId,
            effect,
        }));
}

/**
 * What the engine changes on an actor now, or null when the engine is off. Each effect's rules count only in full
 * mode: a condition's own setting, or "Rules on other effects" for the rest (`effectRulesMode`).
 * @param {Actor} actor
 * @returns {import('./logic/mechanics.js').Plan | null}
 */
export function planFor(actor) {
    if (!engineEnabled()) return null;
    const modes = new Map();
    const isFull = (row) => {
        const id = row.conditionId ?? null;
        if (!modes.has(id)) modes.set(id, effectRulesMode(id) === MODES.FULL);
        return modes.get(id);
    };
    return planAdjustments(mechanicRows(actor), isFull);
}

/**
 * The penalty the engine puts on an actor's skill modifiers (Exhausted stacks at full), or 0: what the roll layer
 * adds back when the system leaves the skill's bonus out. A net bonus is negative.
 * @param {Actor} actor
 * @param {string} [skill] also count the modifiers for this skill only (rules with listed skills)
 */
export function skillPenalty(actor, skill) {
    const plan = planFor(actor);
    if (!plan) return 0;
    return skill ? -skillDelta(plan, skill) || 0 : plan.skillPenalty || 0;
}

/** Add fixed attribute bonuses, after the actor's active effects and before the system derives from them. */
function applyAttributeBonuses(actor) {
    const attributes = actor?.system?.attributes;
    if (!attributes) return;
    const plan = planFor(actor);
    for (const [id, amount] of Object.entries(plan?.attributeBonuses ?? {})) {
        const attribute = attributes[id];
        if (attribute && typeof attribute.bonus === 'number') attribute.bonus += amount;
    }
}

/**
 * Change the derived values in place. Runs on every client whenever the actor is prepared,
 * so it needs no stored data and follows setting changes at once.
 */
function applyDerivedAdjustments(actor) {
    const system = actor?.system;
    if (!system) return;
    const plan = planFor(actor);
    if (!plan) return;

    if (plan.noMovement.length || plan.halfMovement.length) {
        for (const movement of Object.values(system.movement ?? {})) {
            const rate = movement?.rate;
            if (!rate || typeof rate.bonus !== 'number') continue;
            const delta = rateBonusDelta(Number(rate.value), plan);
            if (delta) rate.bonus += delta;
        }
    }

    if (plan.skillPenalty || Object.keys(plan.skillModifiers).length) {
        for (const [id, skill] of Object.entries(system.skills ?? {})) {
            const mod = skill?.mod;
            const delta = skillDelta(plan, id);
            if (delta && mod && typeof mod.bonus === 'number') mod.bonus += delta;
        }
    }
}

/**
 * Before a condition effect is created: if it carries a value (API path), set its name and changes now.
 * The dialog path sets them after creation instead (see values.js).
 */
function onPreCreate(effect, data, options, userId) {
    if (userId !== game.user.id) return;
    if (!(effect.parent instanceof Actor)) return;
    const id = conditionIdOf(effect.statuses, CONDITIONS_BY_ID);
    if (!id) return;
    const entry = CONDITIONS_BY_ID[id];
    const mode = conditionMode(id);
    if (!entry.value || mode === MODES.OFF) return;

    const raw = effect.getFlag?.(MODULE_ID, FLAGS.VALUE) ?? data?.flags?.[MODULE_ID]?.[FLAGS.VALUE];
    if (!raw) return;
    const choices = systemChoices();
    const checked = normalizeValue(entry, raw, {
        damageTypes: Object.keys(choices.damageTypes),
        attributes: Object.keys(choices.attributes),
    });
    if (!checked.ok) {
        ui.notifications?.warn(checked.error);
        return;
    }
    effect.updateSource(
        valueEffectData(entry, checked.value, {
            baseName: statusLabel(id, entry.name),
            full: mode === MODES.FULL,
            rules: rulesOf(effect),
            labels: choices,
            flagScope: MODULE_ID,
        }),
    );
}
