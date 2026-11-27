/**
 * The condition dialog: its value (Afflicted: damage type and amount; Enhanced: attribute and amount) and/or
 * how long it lasts. Opened on the client of the user who turned the condition on.
 */
import { CONDITIONS_BY_ID, VALUE_TYPES } from '../data/conditions.js';
import { FLAGS, MODES, MODULE_ID } from './constants.js';
import { buildDuration } from './durations.js';
import { KINDS } from './logic/durations.js';
import { defaultDuration } from './logic/rules.js';
import { normalizeValue, valueEffectData } from './logic/values.js';
import { rulesOf } from './rules.js';
import { conditionMode } from './settings.js';
import { esc, statusLabel, systemChoices, t } from './util.js';

function options(map, selected) {
    return Object.entries(map)
        .map(([id, label]) => `<option value="${esc(id)}"${id === selected ? ' selected' : ''}>${esc(label)}</option>`)
        .join('');
}

/** Duration choices offered in the dialog (days and "until used" come from the API or triggers). */
function durationChoices() {
    return {
        none: t('duration.none', null, 'Until removed'),
        [KINDS.PHASE_NEXT_ROUND]: t('duration.phaseNextRound', null, 'Until the start of this phase next round'),
        [KINDS.START_OF_NEXT_TURN]: t('duration.startOfNextTurn', null, 'Until the start of its next turn'),
        [KINDS.END_OF_TURN]: t('duration.endOfTurn', null, 'Until the end of its turn'),
        [KINDS.END_OF_NEXT_TURN]: t('duration.endOfNextTurn', null, 'Until the end of its next turn'),
        [KINDS.END_OF_SCENE]: t('duration.endOfScene', null, 'Until the end of the scene'),
        [KINDS.LONG_REST]: t('duration.longRest', null, 'Until a long rest'),
    };
}

/**
 * Ask for a condition's value and/or duration.
 * @param {object} entry
 * @param {string} actorLabel
 * @param {{askValue: boolean, askDuration: boolean, rules?: object}} what
 *   rules: the effect's resolved rules; their default duration is what the dialog starts on
 * @returns {Promise<object | null>} raw form values ({type, attribute, amount, duration}), or null if cancelled
 */
export async function promptDetails(entry, actorLabel, { askValue, askDuration, rules }) {
    const choices = systemChoices();
    let fields = '';
    if (askValue && entry.value === VALUE_TYPES.DAMAGE) {
        fields += `
            <div class="form-group"><label>${esc(t('dialog.amount', null, 'Damage'))}</label>
                <input type="number" name="amount" value="1" min="1" step="1" autofocus></div>
            <div class="form-group"><label>${esc(t('dialog.damageType', null, 'Damage type'))}</label>
                <select name="type">${options(choices.damageTypes)}</select></div>`;
    } else if (askValue && entry.value === VALUE_TYPES.ATTRIBUTE) {
        fields += `
            <div class="form-group"><label>${esc(t('dialog.attribute', null, 'Attribute'))}</label>
                <select name="attribute">${options(choices.attributes)}</select></div>
            <div class="form-group"><label>${esc(t('dialog.bonus', null, 'Amount'))}</label>
                <input type="number" name="amount" value="1" step="1" autofocus></div>`;
    }
    if (askDuration) {
        const own = defaultDuration(rules);
        const preset = Array.isArray(own) && own.length === 1 ? own[0] : 'none';
        fields += `
            <div class="form-group"><label>${esc(t('dialog.duration', null, 'Lasts'))}</label>
                <select name="duration">${options(durationChoices(), preset)}</select></div>`;
    }
    if (!fields) return null;

    const FormDataExtended = foundry.applications?.ux?.FormDataExtended ?? globalThis.FormDataExtended;
    try {
        return await foundry.applications.api.DialogV2.prompt({
            window: { title: `${statusLabel(entry.id, entry.name)}: ${actorLabel}` },
            content: `<p>${esc(entry.summary)}</p>${fields}`,
            ok: {
                label: t('dialog.apply', null, 'Apply'),
                callback: (event, button) => new FormDataExtended(button.form).object,
            },
            rejectClose: false,
        });
    } catch {
        return null;
    }
}

/**
 * After a condition was turned on by hand (HUD, sheet): ask for what it still needs and update the effect.
 * Cancelling keeps the condition as it is (no value, table default duration if any).
 * @param {ActiveEffect} effect
 * @param {string} id condition id
 * @param {string} actorLabel
 * @param {{askValue: boolean, askDuration: boolean}} what
 */
export async function askDetails(effect, id, actorLabel, { askValue, askDuration }) {
    const entry = CONDITIONS_BY_ID[id];
    const rules = rulesOf(effect);
    const raw = await promptDetails(entry, actorLabel, { askValue, askDuration, rules });
    if (!effect.parent?.effects?.has(effect.id)) return;

    const update = {};
    if (raw && askValue) {
        const choices = systemChoices();
        const checked = normalizeValue(entry, raw, {
            damageTypes: Object.keys(choices.damageTypes),
            attributes: Object.keys(choices.attributes),
        });
        if (checked.ok) {
            Object.assign(
                update,
                valueEffectData(entry, checked.value, {
                    baseName: statusLabel(id, entry.name),
                    full: conditionMode(id) === MODES.FULL,
                    rules,
                    labels: choices,
                    flagScope: MODULE_ID,
                }),
            );
        } else ui.notifications.warn(checked.error);
    }

    const spec = raw && askDuration ? raw.duration : defaultDuration(rules);
    const duration = spec ? buildDuration(effect.parent, spec) : null;
    if (duration) {
        update.flags ??= {};
        update.flags[MODULE_ID] = { ...(update.flags[MODULE_ID] ?? {}), [FLAGS.DURATION]: duration };
    }
    if (Object.keys(update).length) await effect.update(update);
}
