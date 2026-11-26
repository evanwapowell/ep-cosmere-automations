export const MODULE_ID = 'ep-cosmere-automations';
export const SYSTEM_ID = 'cosmere-rpg';

/** Flags this module stores on effects (under flags[MODULE_ID]). */
export const FLAGS = Object.freeze({
    /** The condition's value, e.g. {type, amount} or {attribute, amount}. */
    VALUE: 'value',
    /** Why the condition is on the actor: [{key, label}]. */
    SOURCES: 'sources',
    /** Marks the stance marker effect; holds the talent's system id. */
    STANCE_MARKER: 'stanceMarker',
});

/** Options this module passes through document operations (under options[MODULE_ID]). */
export const OPTION_KEYS = Object.freeze({
    /** Created or deleted by the engine; carries {reason} for the chat line. */
    ENGINE: 'engine',
});

/** Per-feature modes. */
export const MODES = Object.freeze({ FULL: 'full', REMIND: 'remind', OFF: 'off' });

/** Status id given to the stance marker so it shows on the token. */
export const STANCE_STATUS = 'ep-stance';
