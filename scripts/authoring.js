/**
 * Authoring: a "Rules" control on the Active Effect sheet (GM only) that opens a dialog to read and edit the
 * effect's own rules.
 *
 * cosmere-rpg 3.1.2 registers no sheet of its own for Active Effects (src/index.ts registers actor and item sheets
 * only), so effects open in Foundry v13's core `ActiveEffectConfig`, an ApplicationV2 sheet. ApplicationV2 calls
 * `getHeaderControls<Class>` for each class in the sheet's chain when it builds the header's controls menu, so the
 * control is added from `getHeaderControlsActiveEffectConfig`. Not yet seen in a live world (docs/LIVE-PASS.md).
 */
import { MODULE_ID } from './constants.js';
import { parseRulesText, rulesRows, rulesText } from './logic/authoring.js';
import { checkRules, explainEffect, setOwnRules } from './rules.js';
import { esc, safe, t } from './util.js';

const ACTION = `${MODULE_ID}-rules`;

/** Open dialogs by effect uuid, so a second click brings the open one forward instead of opening another. */
const open = new Map();

export function registerAuthoringHooks() {
    Hooks.on('getHeaderControlsActiveEffectConfig', safe('rules control', addRulesControl));
}

/**
 * Add the Rules entry to an effect sheet's header controls.
 * @param {ApplicationV2} app the ActiveEffectConfig
 * @param {object[]} controls the header control entries, changed in place
 */
export function addRulesControl(app, controls) {
    if (!game.user?.isGM) return;
    const effect = app?.document;
    if (effect?.documentName !== 'ActiveEffect' || !Array.isArray(controls)) return;
    if (controls.some((c) => c?.action === ACTION)) return;
    const handler = safe('rules dialog', () => openRulesDialog(app.document));
    // A control's `action` is dispatched through the sheet's `options.actions`; `onClick` is the v13 shortcut.
    // Either may be the one Foundry calls; the dialog opens once (see `open`).
    try {
        if (app.options?.actions && !app.options.actions[ACTION]) app.options.actions[ACTION] = handler;
    } catch {
        // A frozen actions map: onClick still works.
    }
    controls.push({
        action: ACTION,
        icon: 'fa-solid fa-scale-balanced',
        label: t('rules.control', null, 'Rules (EP Cosmere Automations)'),
        visible: true,
        onClick: handler,
    });
}

const fromLabel = (from) => (from === 'effect' ? t('rules.fromEffect', null, 'this effect') : t('rules.fromDefault', null, 'default'));

function defaultsNote(defaultsFrom) {
    if (!defaultsFrom) return t('rules.noDefaults', null, 'This effect has no defaults from the module\'s tables.');
    const [kind, id] = Object.entries(defaultsFrom)[0];
    return t('rules.defaultsFrom', { kind, id }, 'Defaults: the module\'s table entry for {kind} "{id}".');
}

function nowTable(report) {
    const rows = rulesRows(report);
    if (!rows.length) return `<p>${esc(t('rules.nothing', null, 'Nothing: this effect has no rules.'))}</p>`;
    const body = rows
        .map((r) => `<tr><td><code>${esc(r.field)}</code></td><td>${esc(fromLabel(r.from))}</td><td><code>${esc(r.json)}</code></td></tr>`)
        .join('');
    return `<table class="ep-rules-now"><thead><tr><th>${esc(t('rules.field', null, 'Field'))}</th><th>${esc(
        t('rules.from', null, 'From'),
    )}</th><th>${esc(t('rules.value', null, 'Value'))}</th></tr></thead><tbody>${body}</tbody></table>`;
}

const problemList = (problems) => problems.map((p) => `<li>${esc(p)}</li>`).join('');

function content(report) {
    const ignored = report.problems.length
        ? `<div class="notification warning"><p>${esc(
              t('rules.ignored', null, 'The rules saved on this effect are ignored (the defaults apply) because:'),
          )}</p><ul>${problemList(report.problems)}</ul></div>`
        : '';
    return `
<section class="ep-rules">
  <h3>${esc(t('rules.now', null, 'What it does now'))}</h3>
  <p class="hint">${esc(defaultsNote(report.defaultsFrom))}</p>
  ${nowTable(report)}
  ${ignored}
  <h3>${esc(t('rules.own', null, 'Its own rules (JSON)'))}</h3>
  <p class="hint">${esc(
      t('rules.ownHint', null, 'A field set here replaces the default as a whole; a field left out keeps the default. Blank: no rules of its own.'),
  )}</p>
  <textarea name="rules" rows="12" spellcheck="false" style="width: 100%; font-family: monospace;">${esc(rulesText(report.stored))}</textarea>
  <ul class="ep-rules-problems" style="color: var(--color-level-error, #c00);"></ul>
</section>`;
}

/**
 * Open the Rules dialog for an effect.
 * @param {ActiveEffect} effect
 */
export async function openRulesDialog(effect) {
    if (!game.user?.isGM || effect?.documentName !== 'ActiveEffect') return null;
    const key = effect.uuid ?? effect.id;
    const existing = open.get(key);
    if (existing?.rendered) {
        existing.bringToFront?.();
        return existing;
    }
    const report = explainEffect(effect);
    const { DialogV2 } = foundry.applications.api;
    const dialog = new DialogV2({
        window: { title: t('rules.title', { effect: effect.name ?? '' }, 'Rules: {effect}'), resizable: true },
        position: { width: 620 },
        content: content(report),
        buttons: [
            {
                action: 'save',
                label: t('rules.save', null, 'Save'),
                icon: 'fa-solid fa-floppy-disk',
                default: true,
                callback: (event, button) => ({ action: 'save', text: button.form?.elements?.rules?.value ?? '' }),
            },
            {
                action: 'reset',
                label: t('rules.reset', null, 'Reset to defaults'),
                icon: 'fa-solid fa-rotate-left',
                callback: () => ({ action: 'reset' }),
            },
            { action: 'cancel', label: t('rules.cancel', null, 'Cancel'), callback: () => null },
        ],
        submit: safe('rules dialog submit', (result) => submit(effect, result)),
    });
    open.set(key, dialog);
    dialog.addEventListener?.('close', () => open.delete(key));
    await dialog.render({ force: true });
    wireValidation(dialog.element);
    return dialog;
}

/** Check the editor's text as it is typed: problems listed under it, Save disabled while there are any. */
export function wireValidation(root) {
    const area = root?.querySelector?.('textarea[name="rules"]');
    const list = root?.querySelector?.('.ep-rules-problems');
    const save = root?.querySelector?.('button[data-action="save"]');
    if (!area || !list || !save) return;
    const check = () => {
        const { ok, problems } = parseRulesText(area.value, checkRules);
        list.innerHTML = problemList(problems);
        save.disabled = !ok;
    };
    area.addEventListener('input', check);
    check();
}

async function submit(effect, result) {
    const key = effect.uuid ?? effect.id;
    open.delete(key);
    if (!result?.action) return;
    if (result.action === 'reset') {
        await setOwnRules(effect, null);
        ui.notifications?.info?.(t('rules.wasReset', { effect: effect.name }, '{effect}: rules reset to the defaults.'));
        return;
    }
    const parsed = parseRulesText(result.text, checkRules);
    if (!parsed.ok) {
        ui.notifications?.warn?.(t('rules.notSaved', { problems: parsed.problems.join('; ') }, 'Rules not saved: {problems}'));
        return;
    }
    const saved = await setOwnRules(effect, parsed.rules);
    if (!saved.ok) {
        ui.notifications?.warn?.(t('rules.notSaved', { problems: saved.problems.join('; ') }, 'Rules not saved: {problems}'));
        return;
    }
    ui.notifications?.info?.(t('rules.saved', { effect: effect.name }, '{effect}: rules saved.'));
}
