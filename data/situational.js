/**
 * Situational effects: not system statuses, but short-lived effects created by actions (Dodge, Brace,
 * Gain Advantage) or by a stance, read by the roll layer. Plain data, no Foundry globals.
 * Rule summaries are our own words.
 *
 * Fields
 * - id        effect id; the effect carries the status `ep-<id>` so it shows on the token
 * - name      English label
 * - summary   the rule, our words
 * - img       icon (Foundry core icons; the used action's icon wins when there is one)
 * - action    the system id of the action that creates it (`item.system.id`)
 * - stance    instead of an effect: applies while the actor is in this stance (system id of the stance talent)
 * - needsTarget  the action needs exactly one target, stored in the effect's value
 * - needsSuccess the effect is only created when the player confirms the test succeeded (chat button)
 * - rolls     roll rules (see data/conditions.js)
 * - duration  duration kinds (see scripts/logic/durations.js)
 * - endsWhen  ['attack', 'move']: ends when its bearer makes an attack test or moves
 */
export const SITUATIONAL = Object.freeze([
    {
        id: 'dodging',
        name: 'Dodging',
        summary: 'The next attack test against it gains a disadvantage.',
        img: 'icons/svg/wing.svg',
        action: 'dodge',
        rolls: [{ who: 'target', mode: 'disadvantage', tests: 'attack', consume: true }],
        duration: ['untilUsed', 'endOfCurrentTurn'],
    },
    {
        id: 'bracing',
        name: 'Bracing',
        summary: 'Attacks against it gain a disadvantage while it stays behind cover (from the other side of that cover). Ends if it moves or attacks.',
        img: 'icons/svg/shield.svg',
        action: 'brace',
        rolls: [{ who: 'target', mode: 'disadvantage', tests: 'attack' }],
        duration: ['endOfScene'],
        endsWhen: ['attack', 'move'],
    },
    {
        id: 'advantage',
        name: 'Advantage gained',
        summary: 'Its next test against that enemy gains an advantage, if it uses a different skill from the test that gained it.',
        img: 'icons/svg/upgrade.svg',
        action: 'gain_advantage',
        needsTarget: true,
        needsSuccess: true,
        rolls: [{ who: 'self', mode: 'advantage', tests: 'all', vsTarget: true, consume: true }],
        duration: ['untilUsed', 'endOfScene'],
    },
    {
        id: 'flamestance',
        name: 'Flamestance',
        summary: 'In Flamestance, Intimidation tests gain an advantage.',
        stance: 'flamestance',
        rolls: [{ who: 'self', mode: 'advantage', tests: { skills: ['inm'] } }],
    },
]);

export const SITUATIONAL_BY_ID = Object.freeze(Object.fromEntries(SITUATIONAL.map((e) => [e.id, e])));

/** The status id a situational effect carries. */
export const situationalStatus = (id) => `ep-${id}`;
