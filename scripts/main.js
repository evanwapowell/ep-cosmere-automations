/**
 * EP Cosmere Automations: entry point. Registers settings and hooks, exposes the API.
 */
import { CONDITIONS } from '../data/conditions.js';
import { buildApi } from './api.js';
import { registerConditionHooks } from './conditions.js';
import { registerDurationHooks } from './durations.js';
import { MODULE_ID, SYSTEM_ID } from './constants.js';
import { validateTable } from './logic/table.js';
import { registerMechanics } from './mechanics.js';
import { registerSettings } from './settings.js';
import { registerStanceHooks } from './stances.js';
import { log, warn } from './util.js';

Hooks.once('init', () => {
    if (game.system?.id !== SYSTEM_ID) {
        warn(`This module needs the ${SYSTEM_ID} system; it stays inactive.`);
        return;
    }

    const errors = validateTable(CONDITIONS);
    if (errors.length) {
        console.error(`${MODULE_ID} | condition table is invalid; the module stays inactive`, errors);
        return;
    }

    registerSettings();
    registerMechanics();
    registerConditionHooks();
    registerStanceHooks();
    registerDurationHooks();

    const module = game.modules.get(MODULE_ID);
    if (module) module.api = buildApi();
    log('ready to automate conditions');
});
