/**
 * Durations with Cosmere's turn rules. Pure functions, no Foundry globals.
 *
 * A duration is a list of kinds; the effect ends when the first of them triggers ("until used or until the end
 * of your next turn"). The stored state is plain data kept in the effect's flags:
 *
 *   { kinds: string[], turnOf: string | null, combatId: string | null, round: number | null,
 *     phase: number | null, turnStarted: boolean, days: number | null }
 *
 * Events (built by the Foundry glue):
 *   { type: 'turnStart' | 'turnEnd', combatId, round, phase, actorUuid }
 *   { type: 'roundStart', combatId, round }
 *   { type: 'combatEnd', combatId }   // the encounter is over
 *   { type: 'sceneEnd' }              // the GM ended the scene (or combat ended, when that counts as a scene end)
 *   { type: 'longRest' }
 *   { type: 'days', n }
 *   { type: 'used' }
 */

export const KINDS = Object.freeze({
    /** Until the start of the same phase next round (the phase it was applied in). */
    PHASE_NEXT_ROUND: 'phaseNextRound',
    /** Until the start of the owner's next turn. */
    START_OF_NEXT_TURN: 'startOfNextTurn',
    /** Until the end of the owner's turn: the current one if it is their turn, else their next. */
    END_OF_TURN: 'endOfTurn',
    /** Until the end of the owner's next turn (a turn that starts after the effect was applied). */
    END_OF_NEXT_TURN: 'endOfNextTurn',
    /** Until the end of the scene. */
    END_OF_SCENE: 'endOfScene',
    /** Until the owner's next long rest. */
    LONG_REST: 'longRest',
    /** For a number of days. */
    DAYS: 'days',
    /** Until a trigger uses it up. */
    UNTIL_USED: 'untilUsed',
});

const ALL_KINDS = new Set(Object.values(KINDS));

/** Kinds measured in combat turns and rounds: they also end when the encounter ends. */
export const COMBAT_KINDS = Object.freeze([
    KINDS.PHASE_NEXT_ROUND,
    KINDS.START_OF_NEXT_TURN,
    KINDS.END_OF_TURN,
    KINDS.END_OF_NEXT_TURN,
]);

/** Combat phases in turn order (handbook: fast PCs, fast NPCs, slow PCs, slow NPCs). */
export const PHASES = Object.freeze(['fastPC', 'fastNPC', 'slowPC', 'slowNPC']);

/**
 * Phase index of a turn.
 * @param {{fast: boolean, pc: boolean}} turn
 */
export function phaseIndex({ fast, pc }) {
    return (fast ? 0 : 2) + (pc ? 0 : 1);
}

/**
 * Normalize what a caller passes as a duration.
 * Accepts a kind, a list of kinds, or {kinds, days}. 'none' / 'untilRemoved' / empty mean no duration.
 * @param {unknown} spec
 * @returns {{ok: true, kinds: string[], days: number | null} | {ok: false, error: string}}
 */
export function parseDurationSpec(spec) {
    if (spec == null || spec === '' || spec === 'none' || spec === 'untilRemoved') return { ok: true, kinds: [], days: null };
    let kinds;
    let days = null;
    if (typeof spec === 'string') kinds = [spec];
    else if (Array.isArray(spec)) kinds = spec;
    else if (typeof spec === 'object') {
        kinds = Array.isArray(spec.kinds) ? spec.kinds : typeof spec.kinds === 'string' ? [spec.kinds] : [];
        if (spec.days != null) days = Number(spec.days);
    } else return { ok: false, error: 'duration must be a kind, a list of kinds or {kinds, days}' };

    kinds = kinds.filter((k) => k !== 'none' && k !== 'untilRemoved');
    for (const kind of kinds) if (!ALL_KINDS.has(kind)) return { ok: false, error: `unknown duration kind "${kind}"` };
    kinds = [...new Set(kinds)];
    if (kinds.includes(KINDS.DAYS)) {
        if (!Number.isInteger(days) || days < 1) return { ok: false, error: 'a duration in days needs days ≥ 1' };
    } else days = null;
    return { ok: true, kinds, days };
}

/**
 * The stored state for a new duration.
 * @param {{kinds: string[], days?: number | null}} spec parsed spec
 * @param {{turnOf: string | null, combat: {id: string, round: number, phase: number | null} | null}} context
 *   turnOf: uuid of the actor whose turns count (usually the affected actor);
 *   combat: the encounter running when it was applied, with the phase of the turn in progress (or the last one)
 * @returns {object | null} null when there is nothing to track
 */
export function newDuration(spec, { turnOf = null, combat = null } = {}) {
    let kinds = [...(spec?.kinds ?? [])];
    if (!kinds.length) return null;
    // "Same phase next round" needs an encounter; outside one it lasts until the end of the scene.
    if (kinds.includes(KINDS.PHASE_NEXT_ROUND) && !combat) {
        kinds = kinds.filter((k) => k !== KINDS.PHASE_NEXT_ROUND);
        if (!kinds.includes(KINDS.END_OF_SCENE)) kinds.push(KINDS.END_OF_SCENE);
    }
    return {
        kinds,
        turnOf,
        combatId: combat?.id ?? null,
        round: combat?.round ?? null,
        phase: combat ? (combat.phase ?? 0) : null,
        turnStarted: false,
        days: kinds.includes(KINDS.DAYS) ? spec.days : null,
    };
}

/**
 * Apply an event to a duration.
 * @param {object} state
 * @param {object} event
 * @returns {{state: object, expired: boolean, kind: string | null, changed: boolean}}
 *   kind: the kind that ended it; changed: the state needs saving (when not expired)
 */
export function advance(state, event) {
    const done = (kind) => ({ state, expired: true, kind, changed: false });
    if (!state?.kinds?.length) return { state, expired: false, kind: null, changed: false };
    const has = (kind) => state.kinds.includes(kind);
    const isOwner = event.actorUuid != null && event.actorUuid === state.turnOf;
    let next = state;

    switch (event.type) {
        case 'turnStart': {
            if (has(KINDS.PHASE_NEXT_ROUND) && state.combatId === event.combatId && state.round != null) {
                if (event.round > state.round + 1 || (event.round === state.round + 1 && event.phase >= state.phase)) {
                    return done(KINDS.PHASE_NEXT_ROUND);
                }
            }
            if (isOwner && has(KINDS.START_OF_NEXT_TURN)) return done(KINDS.START_OF_NEXT_TURN);
            if (isOwner && has(KINDS.END_OF_NEXT_TURN) && !state.turnStarted) next = { ...state, turnStarted: true };
            break;
        }
        case 'turnEnd': {
            if (isOwner && has(KINDS.END_OF_TURN)) return done(KINDS.END_OF_TURN);
            if (isOwner && has(KINDS.END_OF_NEXT_TURN) && state.turnStarted) return done(KINDS.END_OF_NEXT_TURN);
            break;
        }
        case 'roundStart': {
            if (has(KINDS.PHASE_NEXT_ROUND) && state.combatId === event.combatId && state.round != null) {
                // The first phase starts with the round; a later phase that nobody acted in is over once the round after starts.
                if (event.round > state.round + 1 || (event.round === state.round + 1 && state.phase === 0)) {
                    return done(KINDS.PHASE_NEXT_ROUND);
                }
            }
            break;
        }
        case 'combatEnd': {
            const kind = state.kinds.find((k) => COMBAT_KINDS.includes(k));
            if (kind) return done(kind);
            break;
        }
        case 'sceneEnd': {
            if (has(KINDS.END_OF_SCENE)) return done(KINDS.END_OF_SCENE);
            const kind = state.kinds.find((k) => COMBAT_KINDS.includes(k));
            if (kind) return done(kind);
            break;
        }
        case 'longRest': {
            if (has(KINDS.LONG_REST)) return done(KINDS.LONG_REST);
            break;
        }
        case 'days': {
            if (has(KINDS.DAYS)) {
                const days = (state.days ?? 0) - Math.max(0, Math.floor(event.n ?? 1));
                if (days <= 0) return done(KINDS.DAYS);
                next = { ...state, days };
            }
            break;
        }
        case 'used': {
            if (has(KINDS.UNTIL_USED)) return done(KINDS.UNTIL_USED);
            break;
        }
        default:
            break;
    }
    return { state: next, expired: false, kind: null, changed: next !== state };
}

const PHASE_LABELS = Object.freeze({
    fastPC: 'fast PC',
    fastNPC: 'fast NPC',
    slowPC: 'slow PC',
    slowNPC: 'slow NPC',
});

/**
 * Readable description: "until the end of Kal's next turn or until used".
 * @param {object | null} state
 * @param {{owner?: string}} [names] owner: the name of the actor whose turns count
 */
export function describeDuration(state, { owner } = {}) {
    if (!state?.kinds?.length) return 'until removed';
    const whose = owner ? `${owner}'s` : 'its';
    const parts = state.kinds.map((kind) => {
        switch (kind) {
            case KINDS.PHASE_NEXT_ROUND:
                return `until the start of the ${PHASE_LABELS[PHASES[state.phase ?? 0]]} phase next round`;
            case KINDS.START_OF_NEXT_TURN:
                return `until the start of ${whose} next turn`;
            case KINDS.END_OF_TURN:
                return `until the end of ${whose} turn`;
            case KINDS.END_OF_NEXT_TURN:
                return `until the end of ${whose} next turn`;
            case KINDS.END_OF_SCENE:
                return 'until the end of the scene';
            case KINDS.LONG_REST:
                return 'until a long rest';
            case KINDS.DAYS:
                return `for ${state.days} more day${state.days === 1 ? '' : 's'}`;
            case KINDS.UNTIL_USED:
                return 'until used';
            default:
                return kind;
        }
    });
    return parts.join(' or ');
}
