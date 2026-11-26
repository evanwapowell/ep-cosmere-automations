/**
 * Derived adjustments: mechanics applied after the system has derived the actor's values
 * (movement from Speed, skill modifiers from attributes and ranks). Pure functions, no Foundry globals.
 *
 * Why after derivation: the system computes walking speed and skill modifiers in
 * `prepareSecondaryDerivedData`, after active effects. "Half your movement" needs that derived
 * number, and doing Exhausted here avoids relying on how a stacked change string is evaluated.
 */
import { MECHANICS } from '../../data/conditions.js';

/**
 * Which adjustments apply, from the actor's active conditions.
 * @param {{id: string, stacks?: number}[]} active active condition effects (one per effect)
 * @param {Record<string, object>} byId the condition table by id
 * @param {(id: string) => boolean} isFull whether a condition is in "full" mode
 * @returns {{noMovement: string[], halfMovement: string[], skillPenalty: number, penaltySources: string[]}}
 */
export function planAdjustments(active, byId, isFull) {
    const plan = { noMovement: [], halfMovement: [], skillPenalty: 0, penaltySources: [] };
    for (const { id, stacks } of active) {
        const entry = byId[id];
        if (!entry || !isFull(id)) continue;
        const mechanics = entry.mechanics ?? [];
        if (mechanics.includes(MECHANICS.NO_MOVEMENT) && !plan.noMovement.includes(id)) plan.noMovement.push(id);
        if (mechanics.includes(MECHANICS.HALF_MOVEMENT) && !plan.halfMovement.includes(id)) plan.halfMovement.push(id);
        if (mechanics.includes(MECHANICS.SKILL_PENALTY_PER_STACK)) {
            const n = Number.isFinite(stacks) && stacks > 0 ? Math.floor(stacks) : 1;
            plan.skillPenalty += n;
            if (!plan.penaltySources.includes(id)) plan.penaltySources.push(id);
        }
    }
    return plan;
}

/**
 * New movement rate after the plan. Halving rounds down; several halving conditions halve once.
 * @param {number} rate the rate after the system and other effects
 * @param {{noMovement: string[], halfMovement: string[]}} plan
 */
export function adjustedRate(rate, plan) {
    if (!Number.isFinite(rate)) return rate;
    if (plan.noMovement.length) return 0;
    if (plan.halfMovement.length) return Math.floor(Math.max(rate, 0) / 2);
    return rate;
}

/**
 * The bonus change that turns `rate` into `adjustedRate(rate, plan)`.
 * The system computes `value = base + bonus`, so adjusting `bonus` moves `value` by the same amount.
 * @param {number} rate
 * @param {object} plan
 */
export function rateBonusDelta(rate, plan) {
    const target = adjustedRate(rate, plan);
    return Number.isFinite(target) ? target - rate : 0;
}
