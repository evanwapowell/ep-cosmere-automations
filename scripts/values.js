/** The value dialog: Afflicted (damage type and amount), Enhanced (attribute and amount). */
import { CONDITIONS_BY_ID, VALUE_TYPES } from '../data/conditions.js';
import { MODES, MODULE_ID } from './constants.js';
import { normalizeValue, valueEffectData } from './logic/values.js';
import { conditionMode } from './settings.js';
import { esc, statusLabel, systemChoices, t } from './util.js';

function options(map, selected) {
    return Object.entries(map)
        .map(([id, label]) => `<option value="${esc(id)}"${id === selected ? ' selected' : ''}>${esc(label)}</option>`)
        .join('');
}

/**
 * Ask for a condition's value.
 * @param {object} entry
 * @param {string} actorLabel
 * @returns {Promise<object | null>} the raw form values, or null if cancelled
 */
export async function promptValue(entry, actorLabel) {
    const choices = systemChoices();
    const title = `${statusLabel(entry.id, entry.name)}: ${actorLabel}`;
    let fields;
    if (entry.value === VALUE_TYPES.DAMAGE) {
        fields = `
            <div class="form-group"><label>${esc(t('dialog.amount', null, 'Damage'))}</label>
                <input type="number" name="amount" value="1" min="1" step="1" autofocus></div>
            <div class="form-group"><label>${esc(t('dialog.damageType', null, 'Damage type'))}</label>
                <select name="type">${options(choices.damageTypes)}</select></div>`;
    } else if (entry.value === VALUE_TYPES.ATTRIBUTE) {
        fields = `
            <div class="form-group"><label>${esc(t('dialog.attribute', null, 'Attribute'))}</label>
                <select name="attribute">${options(choices.attributes)}</select></div>
            <div class="form-group"><label>${esc(t('dialog.bonus', null, 'Amount'))}</label>
                <input type="number" name="amount" value="1" step="1" autofocus></div>`;
    } else {
        return null;
    }

    const FormDataExtended = foundry.applications?.ux?.FormDataExtended ?? globalThis.FormDataExtended;
    try {
        return await foundry.applications.api.DialogV2.prompt({
            window: { title },
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
 * After a value condition was created without a value (HUD, sheet): ask for it and update the effect.
 * If the dialog is cancelled the condition stays, without a value.
 * @param {ActiveEffect} effect
 * @param {string} id condition id
 * @param {string} actorLabel
 */
export async function askAndSetValue(effect, id, actorLabel) {
    const entry = CONDITIONS_BY_ID[id];
    const raw = await promptValue(entry, actorLabel);
    if (!raw || !effect.parent?.effects?.has(effect.id)) return null;

    const choices = systemChoices();
    const checked = normalizeValue(entry, raw, {
        damageTypes: Object.keys(choices.damageTypes),
        attributes: Object.keys(choices.attributes),
    });
    if (!checked.ok) {
        ui.notifications.warn(checked.error);
        return null;
    }
    const data = valueEffectData(entry, checked.value, {
        baseName: statusLabel(id, entry.name),
        full: conditionMode(id) === MODES.FULL,
        labels: choices,
        flagScope: MODULE_ID,
    });
    await effect.update(data);
    return checked.value;
}
