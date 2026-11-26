import { CONDITIONS, CONDITIONS_BY_ID } from '../data/conditions.js';
import { MODULE_ID, MODES } from './constants.js';
import { isAutomated } from './logic/table.js';
import { t } from './util.js';

export const SETTINGS = Object.freeze({
    ENABLED: 'enabled',
    CHAT: 'chatLines',
    NPC_GM_ONLY: 'npcChatGmOnly',
    STANCES: 'stances',
    conditionKey: (id) => `condition.${id}`,
});

/** Conditions that have a mode setting in this release. */
export const AUTOMATED_CONDITIONS = CONDITIONS.filter((entry) => isAutomated(entry, 1));

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
    if (!engineEnabled() || !isAutomated(CONDITIONS_BY_ID[id], 1)) return MODES.OFF;
    try {
        return game.settings.get(MODULE_ID, SETTINGS.conditionKey(id)) ?? MODES.OFF;
    } catch {
        return MODES.OFF;
    }
}

export function stanceMode() {
    if (!engineEnabled()) return MODES.OFF;
    try {
        return game.settings.get(MODULE_ID, SETTINGS.STANCES) ?? MODES.OFF;
    } catch {
        return MODES.OFF;
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

/** Re-prepare every actor so derived adjustments follow a settings change at once. */
function refreshActors() {
    const actors = [...(game.actors ?? [])];
    for (const scene of game.scenes ?? []) {
        for (const token of scene.tokens ?? []) if (!token.actorLink && token.actor) actors.push(token.actor);
    }
    for (const actor of actors) {
        try {
            actor.reset();
            actor.sheet?.rendered && actor.sheet.render();
        } catch (err) {
            console.error(`${MODULE_ID} | refresh failed for ${actor?.name}`, err);
        }
    }
}
