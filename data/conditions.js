/**
 * The condition table: one entry per status the Cosmere RPG system defines.
 * Plain data, no Foundry globals, so it can be validated with `node --test`.
 *
 * Rule summaries are our own words (Stormlight Handbook ch. 9–10), never book text.
 *
 * Fields
 * - id          the system's status id (CONFIG.COSMERE.statuses key)
 * - name        English fallback label (the system's localized label is used in Foundry)
 * - summary     the rule in a sentence or two, our words
 * - value       null | 'damage' (type + amount) | 'attribute' (attribute + amount)
 * - multiInstance  several effects of this status may coexist on one actor (each its own value)
 * - stackable   the system stacks it (system.stacks)
 * - mechanics   what the engine changes, by name (see MECHANICS)
 * - links       conditions this one brings with it (removed with it unless something else applied them)
 * - longRest    stacks a long rest takes off (one ends a condition that doesn't stack); stacks a source holds stay
 * - duration    default duration kinds (see scripts/logic/durations.js), used when none is given
 * - rolls       roll modifiers (see ROLL_RULE below)
 * - phase       the release that automates it; entries for later phases are listed but do nothing yet
 * - handledBy   another module or Foundry core already covers part of it (informational)
 * - outOfScope  not part of the Stormlight rules
 */

/** Mechanic names the engine understands. */
export const MECHANICS = Object.freeze({
    /** Every movement rate becomes 0. */
    NO_MOVEMENT: 'noMovement',
    /** Every movement rate is halved (rounded down), after all other effects. */
    HALF_MOVEMENT: 'halfMovement',
    /** −1 to every skill modifier per stack. */
    SKILL_PENALTY_PER_STACK: 'skillPenaltyPerStack',
    /** +X to one attribute's bonus (skills, movement, senses; not defenses or max resources). Needs a value. */
    ATTRIBUTE_BONUS: 'attributeBonus',
});

/**
 * A roll rule: { who, mode, tests }
 * - who:   'self'   the roller has the condition;
 *          'target' the roller's (single) target has it.
 * - mode:  'advantage' | 'disadvantage'
 * - tests: 'all' | 'attack' | 'melee' | 'ranged' | { skills: [skill ids] }
 * - beyondSenses: (who: 'self' only) only when the target's token is farther than the roller's senses range
 *          (Senseblind: within that range it still senses things); skipped when that can't be measured.
 * - when:  further conditions, as a list of facts about the test that must all hold, with { or: [...] } and
 *          { not: ... } (scripts/logic/predicates.js lists the facts). `tests` and `beyondSenses` are shorthand
 *          for the common ones, and `tests` may be left out of a rule that has a `when`.
 * Situational effects (data/situational.js) add:
 * - vsTarget: only on a test against the target stored in the effect's value;
 * - consume:  the effect is used up by the test.
 */
export const ROLL_WHO = Object.freeze(['self', 'target']);
export const ROLL_MODES = Object.freeze(['advantage', 'disadvantage']);
export const ROLL_TESTS = Object.freeze(['all', 'attack', 'melee', 'ranged']);

export const VALUE_TYPES = Object.freeze({
    DAMAGE: 'damage',
    ATTRIBUTE: 'attribute',
});

export const CONDITIONS = Object.freeze([
    {
        id: 'afflicted',
        name: 'Afflicted',
        summary: 'Takes the listed damage at the end of each of its turns. Several instances can apply; each is resolved on its own.',
        value: VALUE_TYPES.DAMAGE,
        multiInstance: true,
        mechanics: [],
        links: [],
        phase: 1,
    },
    {
        id: 'blind',
        name: 'Senseblind',
        summary:
            'Its primary sense is obscured: it senses things only within its senses range. Its attacks against a target beyond that range gain a disadvantage and cannot graze.',
        mechanics: [],
        links: [],
        rolls: [{ who: 'self', mode: 'disadvantage', tests: 'attack', beyondSenses: true }],
        phase: 3,
        handledBy: 'Foundry core (vision)',
    },
    {
        id: 'burrowing',
        name: 'Burrowing',
        summary: 'Moving through the ground. A movement mode marker.',
        mechanics: [],
        links: [],
        phase: null,
    },
    {
        id: 'dead',
        name: 'Dead',
        summary: 'Marker.',
        mechanics: [],
        links: [],
        phase: null,
    },
    {
        id: 'depleted',
        name: 'Depleted',
        summary: 'Not part of the Stormlight rules.',
        mechanics: [],
        links: [],
        phase: null,
        outOfScope: true,
    },
    {
        id: 'determined',
        name: 'Determined',
        summary: 'When it fails a test, it can add an Opportunity to the result; the condition then ends.',
        mechanics: [],
        links: [],
        duration: ['untilUsed'],
        phase: 4,
    },
    {
        id: 'diminished',
        name: 'Diminished',
        summary: 'Not part of the Stormlight rules.',
        mechanics: [],
        links: [],
        phase: null,
        outOfScope: true,
    },
    {
        id: 'disoriented',
        name: 'Disoriented',
        summary: 'Cannot take reactions, its senses are obscured, and Perception tests gain a disadvantage.',
        mechanics: [],
        links: [],
        rolls: [{ who: 'self', mode: 'disadvantage', tests: { skills: ['prc'] } }],
        phase: 3,
        handledBy: 'Cosmere Advanced Encounters (reactions)',
    },
    {
        id: 'empowered',
        name: 'Empowered',
        summary: 'Gains an advantage on every test and refills its Investiture at the start of each of its turns. Ends at the end of the scene.',
        mechanics: [],
        links: [],
        rolls: [{ who: 'self', mode: 'advantage', tests: 'all' }],
        duration: ['endOfScene'],
        phase: 3,
    },
    {
        id: 'enhanced',
        name: 'Enhanced',
        summary: 'One attribute counts as higher for skill tests, movement and senses, but not for defenses or maximum resources.',
        value: VALUE_TYPES.ATTRIBUTE,
        multiInstance: true,
        mechanics: [MECHANICS.ATTRIBUTE_BONUS],
        links: [],
        phase: 1,
        handledBy: 'Cosmere Automated Actions (the Enhance action)',
    },
    {
        id: 'exhausted',
        name: 'Exhausted',
        summary: 'Each stack is a −1 penalty on every skill test. A long rest removes one stack.',
        stackable: true,
        mechanics: [MECHANICS.SKILL_PENALTY_PER_STACK],
        links: [],
        longRest: 1,
        phase: 1,
        handledBy: 'Cosmere Automated Actions ("Let conditions modify rolls"): keep one of the two on',
    },
    {
        id: 'flying',
        name: 'Flying',
        summary: 'Ranged attacks against it gain a disadvantage. If it is knocked Prone while flying, it falls.',
        mechanics: [],
        links: [],
        rolls: [{ who: 'target', mode: 'disadvantage', tests: 'ranged' }],
        phase: 3,
    },
    {
        id: 'focused',
        name: 'Focused',
        summary: 'Abilities that cost focus cost 1 less.',
        mechanics: [],
        links: [],
        phase: 4,
    },
    {
        id: 'hidden',
        name: 'Hidden',
        summary:
            'Others cannot sense it until they find it. Attacks against it from someone who cannot sense it gain a disadvantage and cannot graze (drop it in the roll dialog for someone who has spotted it).',
        mechanics: [],
        links: [],
        rolls: [{ who: 'target', mode: 'disadvantage', tests: 'attack' }],
        phase: 3,
        handledBy: 'Foundry core (detection)',
    },
    {
        id: 'immobilized',
        name: 'Immobilized',
        summary: 'Its movement rate is 0. It cannot move and cannot be moved.',
        mechanics: [MECHANICS.NO_MOVEMENT],
        links: [],
        phase: 1,
    },
    {
        id: 'invisible',
        name: 'Invisible',
        summary:
            'Cannot be seen. Attacks against it from someone who cannot sense it gain a disadvantage and cannot graze (drop it in the roll dialog for someone who senses it another way).',
        mechanics: [],
        links: [],
        rolls: [{ who: 'target', mode: 'disadvantage', tests: 'attack' }],
        phase: 3,
        handledBy: 'Foundry core (detection)',
    },
    {
        id: 'prone',
        name: 'Prone',
        summary: 'Slowed; melee attacks against it gain an advantage. Standing up is free, but its movement is 5 feet lower until its next turn.',
        mechanics: [],
        links: ['slowed'],
        rolls: [{ who: 'target', mode: 'advantage', tests: 'melee' }],
        phase: 1,
    },
    {
        id: 'restrained',
        name: 'Restrained',
        summary: 'Its movement rate is 0, and it has a disadvantage on every test except tests to escape.',
        mechanics: [MECHANICS.NO_MOVEMENT],
        links: [],
        rolls: [{ who: 'self', mode: 'disadvantage', tests: 'all' }],
        phase: 1,
    },
    {
        id: 'slowed',
        name: 'Slowed',
        summary: 'Its movement rate is halved.',
        mechanics: [MECHANICS.HALF_MOVEMENT],
        links: [],
        phase: 1,
    },
    {
        id: 'stunned',
        name: 'Stunned',
        summary: 'Loses its reactions; on its turn it has 2 fewer actions and no reaction.',
        mechanics: [],
        links: [],
        phase: 2,
        handledBy: 'Cosmere Advanced Encounters (actions)',
    },
    {
        id: 'surprised',
        name: 'Surprised',
        summary: 'Loses its reactions, has 1 fewer action and cannot take a fast turn. Ends after its next turn.',
        mechanics: [],
        links: [],
        duration: ['endOfNextTurn'],
        phase: 2,
        handledBy: 'Cosmere Advanced Encounters (actions)',
    },
    {
        id: 'unconscious',
        name: 'Unconscious',
        summary: 'Prone, movement 0, drops what it holds, and takes no actions or reactions. A character wakes at the end of a turn or when healed.',
        mechanics: [MECHANICS.NO_MOVEMENT],
        links: ['prone'],
        phase: 1,
    },
]);

/** The table as a map by id. */
export const CONDITIONS_BY_ID = Object.freeze(
    Object.fromEntries(CONDITIONS.map((entry) => [entry.id, entry])),
);
