/** Chat lines: what started, what ended, and reminders in remind-only mode. */
import { MODULE_ID } from './constants.js';
import { chatSetting } from './settings.js';
import { esc } from './util.js';

/**
 * Post a short line about an actor.
 * @param {Actor} actor
 * @param {string} html already-escaped HTML
 * @param {{reminder?: string, detail?: string}} [options] plain text: reminder in italics under the line;
 *   detail (e.g. the duration) in small text under the line
 */
export async function postLine(actor, html, { reminder, detail } = {}) {
    const { mode, npcGmOnly } = chatSetting();
    if (mode === 'off') return null;

    const gmOnly = mode === 'gm' || (npcGmOnly && !actor?.hasPlayerOwner);
    const content = `<div class="${MODULE_ID}-line"><p>${html}</p>${
        detail ? `<p class="${MODULE_ID}-detail"><small>${esc(detail)}</small></p>` : ''
    }${reminder ? `<p class="${MODULE_ID}-reminder"><em>${esc(reminder)}</em></p>` : ''}</div>`;

    const data = {
        content,
        speaker: ChatMessage.getSpeaker({ actor }),
        flags: { [MODULE_ID]: { line: true } },
    };
    if (gmOnly) data.whisper = ChatMessage.getWhisperRecipients('GM').map((u) => u.id);
    return ChatMessage.create(data);
}
