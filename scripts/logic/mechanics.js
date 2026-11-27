/**
 * Derived adjustments: mechanics applied after the system has derived the actor's values
 * (movement from Speed, skill modifiers from attributes and ranks). Pure functions, no Foundry globals.
 *
 * Why after derivation: the system computes walking speed and skill modifiers in
 * `prepareSecondaryDerivedData`, after active effects. "Half your movement" needs that derived
 * number, and doing Exhausted here avoids relying on how a stacked change string is evaluated.
 *
 * Fixed attribute bonuses are the exception: they must be in place *before* the system derives skills, movement and
 * senses from the attribute, so the glue adds them right after the actor's active effects are applied.
 */
import { defaultRules, MECHANIC_KINDS } from './rules.js';

/**
 * One effect the mechanics layer reads.
 * @typedef {object} MechanicRow
 * @property {string} key what the plan lists the effect as (a condition's id, so two Slowed count once; else
 *   the effect's uuid)
 * @property {object} rules the effect's resolved rules (scripts/rules.js)
 * @property {number} [stacks] `system.stacks`
 * @property {object | null} [value] the effect's `value` flag
 */

/**
 * @typedef {object} Plan
 * @property {string[]} noMovement keys of the effects that set movement to 0
 * @property {string[]} halfMovement keys of the effects that halve movement
 * @property {number} skillPenalty what the all-skills `skillModifier` records take off every skill (a penalty is a
 *   positive number; a net bonus is negative)
 * @property {string[]} penaltySources keys of the effects with an all-skills `skillModifier` record
 * @property {Record<string, number>} skillModifiers what listed-skills `skillModifier` records add, by skill id
 *   (signed; on top of `skillPenalty`)
 * @property {Record<string, number>} attributeBonuses what fixed `attributeBonus` records add, by attribute id
 */

/** How many times a `perStack` record counts: the effect's stacks, at least 1. */
const stackCount = (stacks) => (Number.isFinite(stacks) && stacks > 0 ? Math.floor(stacks) : 1);

const addTo = (record, id, amount) => {
    record[id] = (record[id] ?? 0) + amount;
};

/**
 * Which adjustments apply, from the effects that apply to the actor.
 *
 * Stacking: several `half` sources halve once and `zero` beats `half` (see `adjustedRate`); skill modifiers and
 * attribute bonuses add up; `perStack` multiplies by the effect's stacks. `attributeBonus` with `from: 'value'` is
 * not planned here: the value path writes it as a real effect change when the effect is created (Enhanced), and
 * counting it again would apply it twice.
 *
 * Two forms:
 * - `planAdjustments(rows, isFull)`: `rows` are {@link MechanicRow}s; `isFull(row)` says whether that effect's
 *   rules are in "full" mode (default: all are).
 * - `planAdjustments(active, byId, isFull)`, the table form: `active` are `{id, stacks?, rules?}` for condition
 *   effects, `rules` defaulting to the table's for `id`; `isFull(id)` is by condition id.
 *
 * @param {MechanicRow[] | {id: string, stacks?: number, rules?: object}[]} rows
 * @param {((row: MechanicRow) => boolean) | Record<string, object>} [isFullOrTable]
 * @param {(id: string) => boolean} [isFullById] the table form's mode check
 * @returns {Plan}
 */
export function planAdjustments(rows, isFullOrTable, isFullById) {
    const tableForm = isFullOrTable != null && typeof isFullOrTable !== 'function';
    const isFull = tableForm ? (row) => isFullById(row.key) : (isFullOrTable ?? (() => true));
    const plan = {
        noMovement: [],
        halfMovement: [],
        skillPenalty: 0,
        penaltySources: [],
        skillModifiers: {},
        attributeBonuses: {},
    };
    for (const input of rows ?? []) {
        const row = tableForm
            ? { ...input, key: input.id, rules: input.rules ?? (isFullOrTable[input.id] ? defaultRules(isFullOrTable[input.id]) : null) }
            : input;
        if (!row?.rules?.mechanics?.length || !isFull(row)) continue;
        const { key, rules, stacks } = row;
        for (const record of rules.mechanics) {
            if (record.kind === MECHANIC_KINDS.MOVEMENT) {
                const list = record.op === 'zero' ? plan.noMovement : plan.halfMovement;
                if (!list.includes(key)) list.push(key);
            } else if (record.kind === MECHANIC_KINDS.SKILL_MODIFIER) {
                const amount = record.amount * (record.perStack ? stackCount(stacks) : 1);
                if (record.skills === 'all' || record.skills == null) {
                    plan.skillPenalty -= amount;
                    if (!plan.penaltySources.includes(key)) plan.penaltySources.push(key);
                } else {
                    for (const skill of record.skills) addTo(plan.skillModifiers, skill, amount);
                }
            } else if (record.kind === MECHANIC_KINDS.ATTRIBUTE_BONUS && record.attribute) {
                addTo(plan.attributeBonuses, record.attribute, record.amount);
            }
        }
    }
    return plan;
}

/**
 * The total a plan adds to one skill's modifier: the all-skills part and that skill's listed part.
 * @param {Plan} plan
 * @param {string} skill
 */
export function skillDelta(plan, skill) {
    return (plan?.skillModifiers?.[skill] ?? 0) - (plan?.skillPenalty ?? 0);
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
