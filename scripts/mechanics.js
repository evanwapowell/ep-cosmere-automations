/**
 * Layer 2: mechanics.
 * - Derived adjustments (movement 0, half movement, Exhausted penalty) applied after the system derives values.
 * - Value-driven effect changes (Enhanced) written when the effect is created.
 */
import { CONDITIONS_BY_ID } from '../data/conditions.js';
import { FLAGS, MODES, MODULE_ID } from './constants.js';
import { planAdjustments, rateBonusDelta } from './logic/mechanics.js';
import { conditionIdOf } from './logic/table.js';
import { normalizeValue, valueEffectData } from './logic/values.js';
import { ruleEffects, rulesOf } from './rules.js';
import { conditionMode, engineEnabled } from './settings.js';
import { safe, statusLabel, systemChoices, warn } from './util.js';

let wrapped = false;

/** Wrap the actor's derived-data step. Called at init, after the system has set CONFIG.Actor.documentClass. */
export function registerMechanics() {
    const cls = CONFIG.Actor?.documentClass;
    if (!cls?.prototype?.prepareDerivedData) {
        warn('No actor class to wrap; derived adjustments are off.');
    } else if (!wrapped) {
        const original = cls.prototype.prepareDerivedData;
        cls.prototype.prepareDerivedData = function (...args) {
            const result = original.apply(this, args);
            try {
                applyDerivedAdjustments(this);
            } catch (err) {
                console.error(`${MODULE_ID} | derived adjustments failed for ${this?.name}`, err);
            }
            return result;
        };
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

/** The skill penalty the engine puts on an actor's skill modifiers (Exhausted stacks at full), or 0. */
export function skillPenalty(actor) {
    if (!engineEnabled()) return 0;
    return planAdjustments(activeConditions(actor), CONDITIONS_BY_ID, (id) => conditionMode(id) === MODES.FULL).skillPenalty || 0;
}

/**
 * Change the derived values in place. Runs on every client whenever the actor is prepared,
 * so it needs no stored data and follows setting changes at once.
 */
function applyDerivedAdjustments(actor) {
    if (!engineEnabled()) return;
    const system = actor?.system;
    if (!system) return;

    const plan = planAdjustments(activeConditions(actor), CONDITIONS_BY_ID, (id) => conditionMode(id) === MODES.FULL);

    if (plan.noMovement.length || plan.halfMovement.length) {
        for (const movement of Object.values(system.movement ?? {})) {
            const rate = movement?.rate;
            if (!rate || typeof rate.bonus !== 'number') continue;
            const delta = rateBonusDelta(Number(rate.value), plan);
            if (delta) rate.bonus += delta;
        }
    }

    if (plan.skillPenalty) {
        for (const skill of Object.values(system.skills ?? {})) {
            const mod = skill?.mod;
            if (mod && typeof mod.bonus === 'number') mod.bonus -= plan.skillPenalty;
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
