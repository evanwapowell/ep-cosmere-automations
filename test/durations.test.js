import { test } from 'node:test';
import assert from 'node:assert/strict';

import { advance, describeDuration, KINDS, newDuration, parseDurationSpec, phaseIndex } from '../scripts/logic/durations.js';

const KAL = 'Actor.kal';
const OTHER = 'Actor.other';
const FAST_PC = phaseIndex({ fast: true, pc: true });
const FAST_NPC = phaseIndex({ fast: true, pc: false });
const SLOW_PC = phaseIndex({ fast: false, pc: true });
const SLOW_NPC = phaseIndex({ fast: false, pc: false });

const combat = (round, phase) => ({ id: 'c1', round, phase });
const make = (kinds, ctx = {}) => newDuration(parseDurationSpec(kinds), { turnOf: KAL, combat: combat(1, SLOW_PC), ...ctx });
const turnStart = (actorUuid, round, phase) => ({ type: 'turnStart', combatId: 'c1', round, phase, actorUuid });
const turnEnd = (actorUuid, round, phase) => ({ type: 'turnEnd', combatId: 'c1', round, phase, actorUuid });
const roundStart = (round) => ({ type: 'roundStart', combatId: 'c1', round });

/** Run events in order; return the index of the event that ended it, or -1. */
function run(state, events) {
    let s = state;
    for (let i = 0; i < events.length; i++) {
        const r = advance(s, events[i]);
        if (r.expired) return i;
        s = r.state;
    }
    return -1;
}

test('phase order: fast PC, fast NPC, slow PC, slow NPC', () => {
    assert.deepEqual([FAST_PC, FAST_NPC, SLOW_PC, SLOW_NPC], [0, 1, 2, 3]);
});

test('parseDurationSpec', () => {
    assert.deepEqual(parseDurationSpec(undefined), { ok: true, kinds: [], days: null });
    assert.deepEqual(parseDurationSpec('none'), { ok: true, kinds: [], days: null });
    assert.deepEqual(parseDurationSpec('endOfNextTurn'), { ok: true, kinds: ['endOfNextTurn'], days: null });
    assert.deepEqual(parseDurationSpec(['untilUsed', 'endOfNextTurn', 'untilUsed']), {
        ok: true,
        kinds: ['untilUsed', 'endOfNextTurn'],
        days: null,
    });
    assert.deepEqual(parseDurationSpec({ kinds: 'days', days: 3 }), { ok: true, kinds: ['days'], days: 3 });
    assert.equal(parseDurationSpec({ kinds: 'days' }).ok, false);
    assert.equal(parseDurationSpec('tomorrow').ok, false);
    assert.equal(parseDurationSpec(42).ok, false);
});

test('no kinds: nothing to track', () => {
    assert.equal(newDuration(parseDurationSpec('none'), { turnOf: KAL }), null);
});

test('same phase next round: applied in the slow-PC phase of round 1', () => {
    const state = make('phaseNextRound');
    assert.equal(state.phase, SLOW_PC);
    // Later turns in round 1, then round 2's fast phases don't end it; the first slow-PC turn of round 2 does.
    const events = [
        turnStart(OTHER, 1, SLOW_NPC),
        roundStart(2),
        turnStart(OTHER, 2, FAST_PC),
        turnStart(OTHER, 2, FAST_NPC),
        turnStart(OTHER, 2, SLOW_PC),
    ];
    assert.equal(run(state, events), 4);
});

test('same phase next round: if nobody acts in that phase, it ends when the round after starts', () => {
    const state = make('phaseNextRound', { combat: combat(1, SLOW_NPC) });
    assert.equal(run(state, [roundStart(2), turnStart(OTHER, 2, FAST_PC), turnStart(OTHER, 2, SLOW_PC), roundStart(3)]), 3);
});

test('same phase next round: the fast-PC phase starts with the round', () => {
    const state = make('phaseNextRound', { combat: combat(1, FAST_PC) });
    assert.equal(run(state, [turnStart(OTHER, 1, SLOW_NPC), roundStart(2)]), 1);
});

test('same phase next round: another encounter does not count', () => {
    const state = make('phaseNextRound');
    assert.equal(advance(state, { type: 'roundStart', combatId: 'c2', round: 5 }).expired, false);
});

test('same phase next round, applied outside combat, lasts until the end of the scene', () => {
    const state = newDuration(parseDurationSpec('phaseNextRound'), { turnOf: KAL, combat: null });
    assert.deepEqual(state.kinds, ['endOfScene']);
});

test('end of next turn, applied during its own turn: the current turn does not count', () => {
    const state = make('endOfNextTurn');
    const events = [turnEnd(KAL, 1, SLOW_PC), turnStart(OTHER, 2, FAST_PC), turnStart(KAL, 2, SLOW_PC), turnEnd(KAL, 2, SLOW_PC)];
    assert.equal(run(state, events), 3);
});

test('end of next turn, applied before its turn (Surprised at the start of combat)', () => {
    const state = make('endOfNextTurn', { combat: combat(1, FAST_PC) });
    assert.equal(run(state, [roundStart(1), turnStart(KAL, 1, SLOW_PC), turnEnd(KAL, 1, SLOW_PC)]), 2);
});

test('end of next turn: other actors\' turns do not count', () => {
    const state = make('endOfNextTurn');
    assert.equal(run(state, [turnStart(OTHER, 2, FAST_PC), turnEnd(OTHER, 2, FAST_PC)]), -1);
});

test('end of next turn: saving the state matters (turn started)', () => {
    const r = advance(make('endOfNextTurn'), turnStart(KAL, 2, SLOW_PC));
    assert.equal(r.changed, true);
    assert.equal(r.state.turnStarted, true);
});

test('start of next turn', () => {
    const state = make('startOfNextTurn');
    assert.equal(run(state, [turnEnd(KAL, 1, SLOW_PC), turnStart(OTHER, 2, FAST_PC), turnStart(KAL, 2, SLOW_PC)]), 2);
});

test('end of turn: the current turn', () => {
    const state = make('endOfTurn');
    assert.equal(run(state, [turnEnd(OTHER, 1, SLOW_PC), turnEnd(KAL, 1, SLOW_PC)]), 1);
});

test('combat kinds end with the encounter; scene kinds with the scene', () => {
    for (const kind of ['phaseNextRound', 'startOfNextTurn', 'endOfTurn', 'endOfNextTurn']) {
        assert.equal(advance(make(kind), { type: 'combatEnd', combatId: 'c1' }).expired, true, kind);
        assert.equal(advance(make(kind), { type: 'sceneEnd' }).expired, true, kind);
    }
    assert.equal(advance(make('endOfScene'), { type: 'combatEnd', combatId: 'c1' }).expired, false);
    assert.equal(advance(make('endOfScene'), { type: 'sceneEnd' }).kind, KINDS.END_OF_SCENE);
    assert.equal(advance(make('longRest'), { type: 'sceneEnd' }).expired, false);
});

test('long rest, days, until used', () => {
    assert.equal(advance(make('longRest'), { type: 'longRest' }).expired, true);
    const days = make({ kinds: 'days', days: 3 });
    const after2 = advance(days, { type: 'days', n: 2 });
    assert.equal(after2.expired, false);
    assert.equal(after2.state.days, 1);
    assert.equal(advance(after2.state, { type: 'days', n: 1 }).expired, true);
    assert.equal(advance(make('untilUsed'), { type: 'used' }).expired, true);
    assert.equal(advance(make('untilUsed'), { type: 'longRest' }).expired, false);
});

test('whichever comes first: until used or the end of the next turn (Decisive Command)', () => {
    const state = make(['untilUsed', 'endOfNextTurn']);
    assert.equal(advance(state, { type: 'used' }).kind, KINDS.UNTIL_USED);
    assert.equal(run(state, [turnStart(KAL, 2, SLOW_PC), turnEnd(KAL, 2, SLOW_PC)]), 1);
});

test('describeDuration', () => {
    assert.equal(describeDuration(null), 'until removed');
    assert.equal(describeDuration(make('phaseNextRound')), 'until the start of the slow PC phase next round');
    assert.equal(describeDuration(make(['untilUsed', 'endOfNextTurn']), { owner: 'Kal' }), "until used or until the end of Kal's next turn");
    assert.equal(describeDuration(make({ kinds: 'days', days: 1 })), 'for 1 more day');
});
