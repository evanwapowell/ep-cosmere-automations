import { CONDITIONS, CONDITIONS_BY_ID } from '../data/conditions.js';
import { MODULE_ID, MODES } from './constants.js';
import { isAutomated } from './logic/table.js';
import { t } from './util.js';

export const SETTINGS = Object.freeze({
    ENABLED: 'enabled',
    CHAT: 'chatLines',
    NPC_GM_ONLY: 'npcChatGmOnly',
    STANCES: 'stances',
    DURATIONS: 'durations',
    ASK_DURATION: 'askDuration',
    COMBAT_ENDS_SCENE: 'combatEndsScene',
    SCENE_RECHARGE: 'sceneRecharge',
    ROLLS: 'rolls',
    ACTION_EFFECTS: 'actionEffects',
    OTHER_EFFECTS: 'otherEffects',
    conditionKey: (id) => `condition.${id}`,
});

/** Conditions that have a mode setting in this release. */
export const AUTOMATED_CONDITIONS = CONDITIONS.filter((entry) => isAutomated(entry));

function modeChoices() {
    return {
        [MODES.FULL]: t('settings.mode.full', null, 'Full: apply its mechanics'),
        [MODES.REMIND]: t('settings.mode.remind', null, 'Remind only: a chat reminder, no changes'),
        [MODES.OFF]: t('settings.mode.off', null, 'Off'),
    };
}

export function registerSettings() {
    game.settings.register(MODULE_ID, SETTINGS.ENABLED, {
        name: t('settings.enabled.name', null, 'Conditions engine'),
        hint: t('settings.enabled.hint', null, 'Master switch. Off: the module changes nothing and posts nothing.'),
        scope: 'world',
        config: true,
        type: Boolean,
        default: true,
        onChange: refreshActors,
    });

    game.settings.register(MODULE_ID, SETTINGS.CHAT, {
        name: t('settings.chat.name', null, 'Chat lines'),
        hint: t('settings.chat.hint', null, 'Post a line when a condition starts or ends.'),
        scope: 'world',
        config: true,
        type: String,
        choices: {
            all: t('settings.chat.all', null, 'Everyone'),
            gm: t('settings.chat.gm', null, 'GM only'),
            off: t('settings.chat.off', null, 'Off'),
        },
        default: 'all',
    });

    game.settings.register(MODULE_ID, SETTINGS.NPC_GM_ONLY, {
        name: t('settings.npcGmOnly.name', null, 'NPC lines to the GM only'),
        hint: t('settings.npcGmOnly.hint', null, 'Whisper chat lines about actors no player owns to the GM.'),
        scope: 'world',
        config: true,
        type: Boolean,
        default: true,
    });

    game.settings.register(MODULE_ID, SETTINGS.STANCES, {
        name: t('settings.stances.name', null, 'Stances'),
        hint: t(
            'settings.stances.hint',
            null,
            "Full: using a stance's action switches the stance on (its effects apply) and shows it on the token. Remind: a chat line only.",
        ),
        scope: 'world',
        config: true,
        type: String,
        choices: modeChoices(),
        default: MODES.REMIND,
    });

    game.settings.register(MODULE_ID, SETTINGS.DURATIONS, {
        name: t('settings.durations.name', null, 'Durations'),
        hint: t(
            'settings.durations.hint',
            null,
            'Full: effects end by themselves when their duration runs out (turns follow Foundry\'s turn order, as Advanced Encounters sets it). Remind: a chat line says it would end now.',
        ),
        scope: 'world',
        config: true,
        type: String,
        choices: modeChoices(),
        default: MODES.REMIND,
    });

    game.settings.register(MODULE_ID, SETTINGS.ASK_DURATION, {
        name: t('settings.askDuration.name', null, 'Ask for a duration'),
        hint: t('settings.askDuration.hint', null, 'When a condition is turned on from the token or sheet, ask how long it lasts.'),
        scope: 'world',
        config: true,
        type: String,
        choices: {
            combat: t('settings.askDuration.combat', null, 'During combat'),
            always: t('settings.askDuration.always', null, 'Always'),
            never: t('settings.askDuration.never', null, 'Never'),
        },
        default: 'combat',
    });

    game.settings.register(MODULE_ID, SETTINGS.COMBAT_ENDS_SCENE, {
        name: t('settings.combatEndsScene.name', null, 'Ending combat ends the scene'),
        hint: t(
            'settings.combatEndsScene.hint',
            null,
            'When an encounter is ended, also do the end of the scene for its combatants (effects that last until the end of the scene, stances, per-scene uses).',
        ),
        scope: 'world',
        config: true,
        type: Boolean,
        default: true,
    });

    game.settings.register(MODULE_ID, SETTINGS.SCENE_RECHARGE, {
        name: t('settings.sceneRecharge.name', null, 'Recharge per-scene uses at the end of a scene'),
        hint: t('settings.sceneRecharge.hint', null, 'Items whose uses recharge per scene (such as Recover) get them back.'),
        scope: 'world',
        config: true,
        type: String,
        choices: modeChoices(),
        default: MODES.REMIND,
    });

    game.settings.register(MODULE_ID, SETTINGS.ROLLS, {
        name: t('settings.rolls.name', null, 'Advantage and disadvantage on tests'),
        hint: t(
            'settings.rolls.hint',
            null,
            "Full: conditions and situational effects (yours and your target's) set the test's advantage or disadvantage; the roll dialog starts with it selected, so the player can change it. Remind: the chat card lists them, the roll is unchanged. Each condition's own setting must also be full.",
        ),
        scope: 'world',
        config: true,
        type: String,
        choices: modeChoices(),
        default: MODES.REMIND,
    });

    game.settings.register(MODULE_ID, SETTINGS.ACTION_EFFECTS, {
        name: t('settings.actionEffects.name', null, 'Effects from Dodge, Brace and Gain Advantage'),
        hint: t(
            'settings.actionEffects.hint',
            null,
            'Full: using these actions puts their effect on the token (Gain Advantage after the player confirms success), and the roll layer reads it. Remind: a chat line only.',
        ),
        scope: 'world',
        config: true,
        type: String,
        choices: modeChoices(),
        default: MODES.REMIND,
    });

    game.settings.register(MODULE_ID, SETTINGS.OTHER_EFFECTS, {
        name: t('settings.otherEffects.name', null, 'Rules on other effects'),
        hint: t(
            'settings.otherEffects.hint',
            null,
            "Rules carried by effects that are not one of the module's conditions (a talent's, a stance's, an item's or a homebrew effect's). Full: their movement and skill changes apply. Remind: they change nothing. A condition's rules follow that condition's own setting.",
        ),
        scope: 'world',
        config: true,
        type: String,
        choices: modeChoices(),
        default: MODES.REMIND,
        onChange: refreshActors,
    });

    for (const entry of AUTOMATED_CONDITIONS) {
        game.settings.register(MODULE_ID, SETTINGS.conditionKey(entry.id), {
            name: t('settings.condition.name', { name: entry.name }, `Condition: ${entry.name}`),
            hint: entry.summary + (entry.handledBy ? ` (${t('settings.condition.alsoBy', null, 'Also handled by')}: ${entry.handledBy})` : ''),
            scope: 'world',
            config: true,
            type: String,
            choices: modeChoices(),
            default: MODES.REMIND,
            onChange: refreshActors,
        });
    }
}

/** Whether the engine as a whole is on. */
export function engineEnabled() {
    try {
        return game.settings.get(MODULE_ID, SETTINGS.ENABLED) !== false;
    } catch {
        return false;
    }
}

/**
 * A condition's mode: 'full' | 'remind' | 'off'. Off when the engine is off or the condition has no setting.
 * @param {string} id
 */
export function conditionMode(id) {
    if (!engineEnabled() || !isAutomated(CONDITIONS_BY_ID[id])) return MODES.OFF;
    try {
        return game.settings.get(MODULE_ID, SETTINGS.conditionKey(id)) ?? MODES.OFF;
    } catch {
        return MODES.OFF;
    }
}

/**
 * The mode an effect's rules follow: a condition's own setting when the condition has one, else the world setting
 * "Rules on other effects" (effects that are not conditions, and conditions the module doesn't automate, whose
 * rules can only come from the effect itself).
 * @param {string | null | undefined} conditionId the table condition the effect stands for, if any
 */
export function effectRulesMode(conditionId) {
    if (conditionId && isAutomated(CONDITIONS_BY_ID[conditionId])) return conditionMode(conditionId);
    return featureMode(SETTINGS.OTHER_EFFECTS);
}

export function stanceMode() {
    return featureMode(SETTINGS.STANCES);
}

const MODE_ORDER = [MODES.OFF, MODES.REMIND, MODES.FULL];

/** The weaker of two modes (off < remind < full). */
export function weakerMode(a, b) {
    return MODE_ORDER[Math.min(MODE_ORDER.indexOf(a), MODE_ORDER.indexOf(b))] ?? MODES.OFF;
}

/** Mode of a world-level feature setting ('durations', 'sceneRecharge'). */
export function featureMode(key) {
    if (!engineEnabled()) return MODES.OFF;
    try {
        return game.settings.get(MODULE_ID, key) ?? MODES.OFF;
    } catch {
        return MODES.OFF;
    }
}

/**
 * Long-rest steps another module already does, by condition id. Cosmere Automated Actions takes a stack of
 * Exhausted off itself when its "decrementExhaustion" setting is on (under its master switch). Both doing it race:
 * seen live 2026-11-25, at one stack both delete the effect and one of the deletes fails.
 */
const OTHER_MODULE_LONG_REST = {
    exhausted: { module: 'cosmere-automated-actions', setting: 'decrementExhaustion', master: 'useAutomations' },
};

/** Whether another module does this condition's long-rest step itself (so the engine skips it). */
export function longRestDoneElsewhere(conditionId) {
    const other = OTHER_MODULE_LONG_REST[conditionId];
    if (!other || !game.modules?.get(other.module)?.active) return false;
    try {
        return game.settings.get(other.module, other.master) !== false && game.settings.get(other.module, other.setting) === true;
    } catch {
        return false;
    }
}

export function setting(key, fallback) {
    try {
        return game.settings.get(MODULE_ID, key);
    } catch {
        return fallback;
    }
}

export function chatSetting() {
    try {
        return {
            mode: game.settings.get(MODULE_ID, SETTINGS.CHAT),
            npcGmOnly: game.settings.get(MODULE_ID, SETTINGS.NPC_GM_ONLY),
        };
    } catch {
        return { mode: 'off', npcGmOnly: true };
    }
}

/** World actors plus the actors of unlinked tokens on every scene. */
export function allActors() {
    const actors = [...(game.actors ?? [])];
    for (const scene of game.scenes ?? []) {
        for (const token of scene.tokens ?? []) if (!token.actorLink && token.actor) actors.push(token.actor);
    }
    return actors;
}

/** Re-prepare every actor so derived adjustments follow a settings change at once. */
function refreshActors() {
    for (const actor of allActors()) {
        try {
            actor.reset();
            actor.sheet?.rendered && actor.sheet.render();
        } catch (err) {
            console.error(`${MODULE_ID} | refresh failed for ${actor?.name}`, err);
        }
    }
}
