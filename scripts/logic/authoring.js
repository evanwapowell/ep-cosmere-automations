/**
 * The Rules dialog's pure parts: reading what was typed into the JSON editor, and the rows of the "what it does
 * now" table. No Foundry globals.
 */

/**
 * Read the editor's text as rules. Blank text means "no rules of its own" (the table's defaults apply).
 * @param {string} text
 * @param {(rules: unknown) => string[]} check the validator (`validateRules` with the ids it knows)
 * @returns {{ok: boolean, rules: unknown, problems: string[]}} rules: the parsed value (null for blank text)
 */
export function parseRulesText(text, check) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return { ok: true, rules: null, problems: [] };
    let rules;
    try {
        rules = JSON.parse(trimmed);
    } catch (err) {
        return { ok: false, rules: null, problems: [`not valid JSON: ${err.message}`] };
    }
    if (rules === null) return { ok: true, rules: null, problems: [] };
    const problems = check(rules);
    return { ok: problems.length === 0, rules, problems };
}

/**
 * The editor's starting text: the effect's stored rules, pretty-printed; blank when it has none.
 * @param {unknown} stored
 */
export function rulesText(stored) {
    if (stored == null) return '';
    try {
        return JSON.stringify(stored, null, 2) ?? '';
    } catch {
        return '';
    }
}

/**
 * One row per field the resolved rules have (besides `schema`): the field, where it comes from and its value as
 * compact JSON.
 * @param {{rules: object, from: Record<string, string>}} report as `explainRules` gives it
 * @returns {{field: string, from: string, json: string}[]}
 */
export function rulesRows({ rules, from }) {
    return Object.keys(from ?? {}).map((field) => ({ field, from: from[field], json: JSON.stringify(rules[field]) }));
}
