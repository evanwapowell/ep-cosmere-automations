/**
 * The roll layer's logic: which advantages and disadvantages apply to a test, and the mode they net to.
 * Pure functions, no Foundry globals.
 *
 * Advantages and disadvantages cancel one for one (handbook ch. 9); the system models one advantage mode on the
 * d20, so whatever is left over decides the mode.
 */
import { ROLL_MODES, ROLL_TESTS, ROLL_WHO } from '../../data/conditions.js';

export const ADV = 'advantage';
export const DIS = 'disadvantage';
export const NONE = 'none';

/**
 * Check one roll rule. Returns an error string or null.
 * @param {object} rule
 */
export function ruleError(rule) {
    if (!rule || typeof rule !== 'object') return 'rule must be an object';
    if (!ROLL_WHO.includes(rule.who)) return `unknown "who" ${JSON.stringify(rule.who)}`;
    if (!ROLL_MODES.includes(rule.mode)) return `unknown mode ${JSON.stringify(rule.mode)}`;
    const tests = rule.tests;
    const okTests =
        ROLL_TESTS.includes(tests) ||
        (tests && typeof tests === 'object' && Array.isArray(tests.skills) && tests.skills.length > 0);
    if (!okTests) return `unknown tests ${JSON.stringify(tests)}`;
    if (rule.vsTarget && rule.who !== 'self') return 'vsTarget only makes sense for who: self';
    return null;
}

/**
 * Melee or ranged, for an attack rolled from an item. In cosmere-rpg 3.1.2 (seen live 2026-11-25) the item the
 * attack hooks get is often not the weapon:
 * - a character's attack is the weapon's "Strike: X" action, an item embedded in the weapon; the type is on the
 *   parent weapon (`system.attack.type`);
 * - an adversary's "Strike: X" is a plain action with no attack data; its description says "Reach 5 ft." (melee)
 *   or "Range 80/120 ft." (ranged).
 * Unknown (or both words) → null, and melee/ranged rules don't apply.
 * @param {{system?: {attack?: {type?: string}, description?: {value?: string}}, parent?: unknown}} item
 * @returns {'melee' | 'ranged' | null}
 */
export function attackTypeOf(item) {
    const own = item?.system?.attack?.type ?? item?.parent?.system?.attack?.type;
    if (own === 'melee' || own === 'ranged') return own;
    const text = String(item?.system?.description?.value ?? '').replace(/<[^>]*>/g, ' ');
    const reach = /\breach\b/i.test(text);
    const range = /\brange\b/i.test(text);
    if (reach === range) return null;
    return reach ? 'melee' : 'ranged';
}

/**
 * Whether a rule's `tests` covers a test.
 * @param {object} rule
 * @param {{context: string, skill?: string | null, attackType?: string | null}} test
 *   context: the system's roll context ('Skill', 'Item', 'Attack')
 */
export function ruleMatchesTest(rule, test) {
    const tests = rule.tests;
    const isAttack = test.context === 'Attack';
    if (tests === 'all') return true;
    if (tests === 'attack') return isAttack;
    if (tests === 'melee' || tests === 'ranged') return isAttack && test.attackType === tests;
    if (tests && Array.isArray(tests.skills)) return !!test.skill && tests.skills.includes(test.skill);
    return false;
}

/**
 * Collect the modifiers that apply to a test.
 *
 * @param {object} input
 * @param {Side} input.roller
 * @param {Side | null} input.target  the roller's single target, or null
 * @param {{context: string, skill?: string | null, attackType?: string | null}} input.test
 * @param {object} sources
 * @param {Record<string, object>} sources.conditions  condition table by id
 * @param {Record<string, object>} sources.situational situational table by id
 * @param {(key: string) => 'full' | 'remind' | 'off'} sources.modeOf  mode of a condition id or 'situational:<id>'
 * @returns {Modifier[]}
 *
 * @typedef {{ uuid: string, name: string, conditions: string[],
 *   situational: {id: string, effectId: string, value?: object}[], stance?: string | null }} Side
 * @typedef {{ key: string, label: string, mode: string, active: boolean, side: 'self' | 'target',
 *   consume?: {actorUuid: string, effectId: string} }} Modifier
 *   active: false when the source is in remind-only mode (shown, not applied)
 */
export function collectModifiers({ roller, target, test }, { conditions, situational, modeOf }) {
    const out = [];
    const add = (key, label, rule, side, owner, effectId) => {
        const mode = modeOf(key);
        if (mode === 'off') return;
        const mod = { key, label, mode: rule.mode, active: mode === 'full', side };
        if (rule.consume && effectId) mod.consume = { actorUuid: owner.uuid, effectId };
        out.push(mod);
    };

    const sides = [
        ['self', roller],
        ['target', target],
    ];
    for (const [who, side] of sides) {
        if (!side) continue;
        const seen = new Set();
        for (const id of side.conditions ?? []) {
            if (seen.has(id)) continue; // several instances of a condition count once
            seen.add(id);
            for (const rule of conditions[id]?.rolls ?? []) {
                if (rule.who !== who || !ruleMatchesTest(rule, test)) continue;
                add(id, conditions[id].name, rule, who, side);
            }
        }
        for (const effect of side.situational ?? []) {
            const entry = situational[effect.id];
            for (const rule of entry?.rolls ?? []) {
                if (rule.who !== who || !ruleMatchesTest(rule, test)) continue;
                if (rule.vsTarget && (!target || effect.value?.targetUuid !== target.uuid)) continue;
                const label = rule.vsTarget && effect.value?.targetName ? `${entry.name} (${effect.value.targetName})` : entry.name;
                add(`situational:${entry.id}`, label, rule, who, side, effect.effectId);
            }
        }
        if (side.stance) {
            for (const entry of Object.values(situational)) {
                if (entry.stance !== side.stance) continue;
                for (const rule of entry.rolls ?? []) {
                    if (rule.who !== who || !ruleMatchesTest(rule, test)) continue;
                    add(`situational:${entry.id}`, entry.name, rule, who, side);
                }
            }
        }
    }
    return out;
}

/**
 * Net the roller's own choice and the active modifiers into one mode.
 * @param {string} base the mode chosen by the caller (keyboard, macro, dialog default): counts as one
 * @param {{mode: string, active: boolean}[]} modifiers
 */
export function netMode(base, modifiers) {
    let score = base === ADV ? 1 : base === DIS ? -1 : 0;
    for (const mod of modifiers) {
        if (!mod.active) continue;
        score += mod.mode === ADV ? 1 : -1;
    }
    return score > 0 ? ADV : score < 0 ? DIS : NONE;
}

/**
 * A short line for the chat card: "Disadvantage: Restrained. Advantage: target Prone (melee). Reminder only: …"
 * @param {{label: string, mode: string, active: boolean, side: string}[]} modifiers
 */
export function describeModifiers(modifiers) {
    const fmt = (m) => (m.side === 'target' ? `target ${m.label}` : m.label);
    const parts = [];
    const adv = modifiers.filter((m) => m.active && m.mode === ADV).map(fmt);
    const dis = modifiers.filter((m) => m.active && m.mode === DIS).map(fmt);
    const remind = modifiers.filter((m) => !m.active).map((m) => `${fmt(m)} (${m.mode})`);
    if (adv.length) parts.push(`Advantage: ${adv.join(', ')}.`);
    if (dis.length) parts.push(`Disadvantage: ${dis.join(', ')}.`);
    if (remind.length) parts.push(`Not applied (remind only): ${remind.join(', ')}.`);
    return parts.join(' ');
}
