/**
 * A very small stand-in for the Foundry globals the module touches, enough to load it in Node and drive
 * its hooks. Not a Foundry emulator: it checks that the glue code is wired and does the expected document
 * operations. Behavior in the real Foundry still needs a live test.
 */

const pending = new Set();
const track = (value) => {
    if (value && typeof value.then === 'function') {
        pending.add(value);
        value.finally(() => pending.delete(value));
    }
    return value;
};

/** Wait until every hook handler started so far (and any it started) has finished. */
export async function flush() {
    for (let i = 0; i < 100; i++) {
        if (!pending.size) {
            await new Promise((r) => setTimeout(r, 0));
            if (!pending.size) return;
        }
        await Promise.allSettled([...pending]);
    }
    throw new Error('hooks did not settle');
}

const handlers = new Map();
export const Hooks = {
    on(name, fn) {
        if (!handlers.has(name)) handlers.set(name, []);
        handlers.get(name).push(fn);
    },
    once(name, fn) {
        this.on(name, fn);
    },
    callAll(name, ...args) {
        for (const fn of handlers.get(name) ?? []) track(fn(...args));
        return true;
    },
    call(name, ...args) {
        for (const fn of handlers.get(name) ?? []) if (track(fn(...args)) === false) return false;
        return true;
    },
};

function setProperty(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (const part of parts.slice(0, -1)) cur = cur[part] ??= {};
    cur[parts.at(-1)] = value;
}
function getProperty(obj, path) {
    return path.split('.').reduce((cur, part) => (cur == null ? undefined : cur[part]), obj);
}
const hasProperty = (obj, path) => getProperty(obj, path) !== undefined;
let counter = 0;
const randomID = (n = 16) => (`r${(counter++).toString(36)}`.padEnd(n, 'x')).slice(0, n);

class Collection extends Map {
    get contents() {
        return [...this.values()];
    }
    find(fn) {
        return this.contents.find(fn);
    }
    filter(fn) {
        return this.contents.filter(fn);
    }
    some(fn) {
        return this.contents.some(fn);
    }
    [Symbol.iterator]() {
        return this.values();
    }
}

export class Actor {}

/**
 * The system's item, reduced to `use()`: like cosmere-rpg 3.1.2, it returns null for anything that is not an
 * action (talents included). Actions record the call and return a marker.
 */
export class FakeItem {
    constructor(data) {
        Object.assign(this, data);
    }
    async use(options = {}) {
        if (this.type !== 'action') return null;
        this.useCalls = [...(this.useCalls ?? []), options];
        return 'used';
    }
}

const actorsByUuid = new Map();

/**
 * The system's D20Roll, reduced to what the module touches: `options.advantageMode`, `configureModifiers()` and a
 * dialog that, like the system's, starts from `data.skillTest.advantageMode` and overwrites the mode with the
 * player's choice (`globalThis.__dialogChoice`, else whatever it started with).
 */
export class D20Roll {
    constructor(options = {}, mod = 2) {
        this.options = { ...options };
        // Like the system's d20 roll: [d20, '+', modifier, ...extra terms].
        this.terms = [{ faces: 20 }, { operator: '+' }, { number: mod }];
        this.configureModifiers();
    }
    configureModifiers() {
        const mode = this.options.advantageMode;
        this.formula = mode === 'advantage' ? '2d20kh' : mode === 'disadvantage' ? '2d20kl' : '1d20';
    }
    resetFormula() {
        this.extra = this.terms.slice(3).map((t) => t.operator ?? String(t.number)).join(' ');
    }
    async configureDialog(data) {
        globalThis.__dialogPreset = data?.skillTest?.advantageMode;
        this.options.advantageMode = globalThis.__dialogChoice ?? data?.skillTest?.advantageMode ?? 'none';
        // Another attribute picked in the dialog: the system replaces the modifier term (rank + attribute only).
        if (globalThis.__dialogAttribute) this.terms[2] = { number: 1 };
        this.configureModifiers();
        return this;
    }
}

/** Foundry's Roll, reduced to parsing "0 - 2" into terms. */
export class Roll {
    constructor(formula) {
        this.terms = String(formula)
            .split(' ')
            .map((part) => (/^[-+*/]$/.test(part) ? { operator: part } : { number: Number(part) }));
    }
}

/** The system's skill test flow: pre-roll hook, dialog unless fast-forwarded, post-roll hook. */
export async function rollSkill(actor, skill, { fastForward = false, advantageMode = 'none', attribute } = {}) {
    const roll = new D20Roll({ advantageMode });
    const config = { data: { context: 'Skill', skill: { id: skill }, source: actor }, ...(attribute ? { attribute } : {}) };
    Hooks.call('cosmere-rpg.preSkillRoll', roll, actor, config);
    if (!fastForward) await roll.configureDialog({ skillTest: { data: config.data, parts: [] } });
    Hooks.callAll('cosmere-rpg.skillRoll', roll, actor, config);
    await flush();
    return roll;
}

/** The system's attack flow: its own dialog (unless fast-forwarded), then a test rolled without a dialog. */
export async function rollAttack(actor, item, { fastForward = false } = {}) {
    const options = { actor, skillTest: {} };
    if (!fastForward) {
        Hooks.call('cosmere-rpg.preAttackRollConfiguration', options, item);
        globalThis.__dialogPreset = options.skillTest.advantageMode;
        if (globalThis.__cancelDialog) return null;
        options.skillTest.advantageMode = globalThis.__dialogChoice ?? options.skillTest.advantageMode ?? 'none';
        Hooks.callAll('cosmere-rpg.attackRollConfiguration', options, item);
    }
    const roll = new D20Roll({ advantageMode: options.skillTest.advantageMode ?? 'none' });
    const config = { actor, data: { context: 'Attack', skill: { id: item.system.skill }, source: item } };
    Hooks.call('cosmere-rpg.preAttackRoll', roll, item, config);
    Hooks.callAll('cosmere-rpg.attackRoll', roll, item, config);
    await flush();
    return roll;
}

export class FakeEffect {
    constructor(data, parent) {
        this.parent = parent;
        this._source = structuredClone(data);
        this.#sync();
    }
    #sync() {
        const d = this._source;
        this.id = d._id;
        this.name = d.name;
        this.img = d.img;
        this.disabled = !!d.disabled;
        this.isSuppressed = false;
        this.statuses = new Set(d.statuses ?? []);
        this.flags = d.flags ?? {};
        this.system = d.system ?? {};
        this.changes = d.changes ?? [];
    }
    get documentName() {
        return 'ActiveEffect';
    }
    get isOwner() {
        return this.parent?.isOwner ?? true;
    }
    getFlag(scope, key) {
        return getProperty(this.flags, `${scope}.${key}`);
    }
    async setFlag(scope, key, value) {
        return this.update({ [`flags.${scope}.${key}`]: value });
    }
    updateSource(changes) {
        for (const [k, v] of Object.entries(changes)) {
            const last = k.split('.').at(-1);
            if (last.startsWith('-=')) {
                const parent = getProperty(this._source, k.split('.').slice(0, -1).join('.'));
                if (parent) delete parent[last.slice(2)];
            } else if (k.includes('.')) setProperty(this._source, k, v);
            else if (v && typeof v === 'object' && !Array.isArray(v) && typeof this._source[k] === 'object') {
                this._source[k] = deepMerge(this._source[k] ?? {}, v);
            } else this._source[k] = v;
        }
        this.#sync();
    }
    async update(changes) {
        this.updateSource(changes);
        this.parent?.reset?.();
        return this;
    }
    async delete(options) {
        return this.parent.deleteEmbeddedDocuments('ActiveEffect', [this.id], options);
    }
    toObject() {
        return structuredClone(this._source);
    }
    static async fromStatusEffect(id) {
        const status = globalThis.CONFIG.statusEffects.find((s) => s.id === id);
        const { id: _id, ...rest } = structuredClone(status);
        // Foundry localizes the name; the fake "localizes" to the system's label.
        rest.name = globalThis.CONFIG.COSMERE.statuses[id].label;
        return new FakeEffect({ ...rest, statuses: [id] }, null);
    }
    static async create(data, { parent, ...options } = {}) {
        const [created] = await parent.createEmbeddedDocuments('ActiveEffect', [data], options);
        return created;
    }
}

function deepMerge(a, b) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) {
        out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(out[k] ?? {}, v) : v;
    }
    return out;
}

const SPEED_RATES = [20, 25, 30, 40, 60, 80];

export class FakeActor extends Actor {
    constructor({ name, type = 'character', speed = 2, skills = ['ath', 'agi', 'per'], items = [], hasPlayerOwner = true }) {
        super();
        this.name = name;
        this.type = type;
        this.id = randomID();
        this.uuid = `Actor.${this.id}`;
        this.hasPlayerOwner = hasPlayerOwner;
        this.isOwner = true;
        actorsByUuid.set(this.uuid, this);
        this.speed = speed;
        this.skillIds = skills;
        this.effects = new Collection();
        this.items = new Collection();
        this.flags = {};
        for (const item of items) {
            item.parent = item.actor = this;
            item.uuid = `${this.uuid}.Item.${item.id}`;
            item.effects ??= new Collection();
            this.items.set(item.id, item);
        }
        this.reset();
    }
    getFlag(scope, key) {
        return getProperty(this.flags, `${scope}.${key}`);
    }
    async setFlag(scope, key, value) {
        setProperty(this.flags, `${scope}.${key}`, value);
        Hooks.callAll('updateActor', this, { flags: { [scope]: { [key.split('.')[0]]: getProperty(this.flags, `${scope}.${key.split('.')[0]}`) } } }, {}, globalThis.game.user.id);
    }
    async unsetFlag(scope, key) {
        // cosmere-rpg 3.1.2: the system's preUpdateActor reads {mode: {'-=stance': null}} as a modality named
        // "-=stance", writes `meta.update.mode.-=stance: undefined`, and Foundry rejects the update.
        if (scope === 'cosmere-rpg' && key.startsWith('mode.')) {
            throw new Error('Removing a key using the -= deletion syntax requires the value of that deletion key to be null');
        }
        const parts = key.split('.');
        const parent = getProperty(this.flags, [scope, ...parts.slice(0, -1)].join('.'));
        if (parent) delete parent[parts.at(-1)];
        Hooks.callAll('updateActor', this, { flags: { [scope]: { [`-=${key}`]: null } } }, {}, globalThis.game.user.id);
    }
    /** The system's applyDamage, reduced to recording the instances. */
    async applyDamage(instances) {
        this.damageCalls = [...(this.damageCalls ?? []), instances];
    }
    async setMode(modality, mode) {
        this.modeCalls = [...(this.modeCalls ?? []), [modality, mode]];
        await this.setFlag('cosmere-rpg', `mode.${modality}`, mode);
    }
    /** The system's derived step, simplified: walking speed from Speed, skill mods 0 + bonus. */
    prepareDerivedData() {
        const attrBonus = { spd: 0 };
        for (const e of this.effects.contents) {
            if (e.disabled) continue;
            for (const c of e.changes) {
                if (c.key === 'system.attributes.spd.bonus') attrBonus.spd += Number(c.value);
            }
        }
        const speed = this.speed + attrBonus.spd;
        const rate = (base) => ({ derived: base, bonus: 0, useOverride: false, override: null, get value() { return (this.useOverride ? this.override : this.derived) + this.bonus; } });
        this.system = {
            immunities: { condition: {} },
            movement: { walk: { rate: rate(SPEED_RATES[Math.min(Math.ceil(speed / 2), 5)]) }, fly: { rate: rate(0) } },
            skills: Object.fromEntries(this.skillIds.map((id) => [id, { mod: rate(2) }])),
        };
    }
    reset() {
        this.prepareDerivedData();
    }
    async createEmbeddedDocuments(type, list, options = {}) {
        const userId = globalThis.game.user.id;
        const created = [];
        for (const data of list) {
            // cosmere-rpg 3.1.2's ActiveEffect._preCreate reads `this.id.startsWith(...)` for an effect with exactly
            // one status; the id is null there unless the caller chose it and kept it.
            if ((data.statuses ?? []).length === 1 && !(options.keepId && data._id)) {
                throw new TypeError("Cannot read properties of null (reading 'startsWith')");
            }
            const effect = new FakeEffect({ _id: data._id && options.keepId ? data._id : randomID(), ...data, ...(options.keepId ? {} : { _id: randomID() }) }, this);
            if (Hooks.call('preCreateActiveEffect', effect, data, options, userId) === false) continue;
            if (this.effects.has(effect.id)) throw new Error(`duplicate id ${effect.id}`);
            this.effects.set(effect.id, effect);
            created.push(effect);
        }
        this.reset();
        for (const effect of created) Hooks.callAll('createActiveEffect', effect, options, userId);
        return created;
    }
    async updateEmbeddedDocuments(type, updates) {
        for (const { _id, ...changes } of updates) {
            const effect = this.effects.get(_id);
            if (!effect) throw new Error(`no effect ${_id}`);
            effect.updateSource(changes);
        }
        this.reset();
    }
    async deleteEmbeddedDocuments(type, ids, options = {}) {
        const deleted = [];
        for (const id of ids) {
            const effect = this.effects.get(id);
            if (!effect) throw new Error(`no effect ${id} to delete`);
            this.effects.delete(id);
            deleted.push(effect);
        }
        this.reset();
        for (const effect of deleted) Hooks.callAll('deleteActiveEffect', effect, options, globalThis.game.user.id);
        return deleted;
    }
}

/**
 * A combat whose turn pointer moves like Advanced Encounters moves it: a turn starts when the pointer is set to
 * a combatant and ends when it is set back to nobody. Each move fires `updateCombat(combat, changed)`.
 */
export class FakeCombat {
    constructor(entries) {
        this.id = randomID();
        this.round = 0;
        this.turn = null;
        this.combatants = new Collection();
        for (const { actor, fast = false, isBoss = false } of entries) {
            const id = randomID();
            const flags = { 'cosmere-rpg': { turnSpeed: fast ? 'fast' : 'slow' } };
            const combatant = {
                id,
                actor,
                isBoss,
                get turnSpeed() {
                    return getProperty(flags, 'cosmere-rpg.turnSpeed') ?? 'slow';
                },
                getFlag: (sc, k) => getProperty(flags, `${sc}.${k}`),
                async setFlag(sc, k, v) {
                    setProperty(flags, `${sc}.${k}`, v);
                    Hooks.callAll('updateCombatant', combatant, { flags: { [sc]: { [k]: v } } }, {}, globalThis.game.user.id);
                },
            };
            this.combatants.set(id, combatant);
        }
        this.turns = this.combatants.contents;
        this.previous = null;
    }
    get started() {
        return this.round > 0;
    }
    #state() {
        const c = this.turn == null ? null : this.turns[this.turn];
        return { round: this.round, turn: this.turn, combatantId: c?.id ?? null };
    }
    async #move(update) {
        const prior = this.#state();
        Object.assign(this, update);
        this.previous = prior;
        Hooks.callAll('updateCombat', this, { ...update }, {}, globalThis.game.user.id);
        await flush();
    }
    combatantOf(actor) {
        return this.turns.find((c) => c.actor === actor);
    }
    start() {
        globalThis.game.combat = this;
        return this.#move({ round: 1, turn: null });
    }
    startTurn(actor) {
        return this.#move({ turn: this.turns.indexOf(this.combatantOf(actor)) });
    }
    endTurn() {
        return this.#move({ turn: null });
    }
    nextRound() {
        return this.#move({ round: this.round + 1, turn: null });
    }
    async end() {
        if (globalThis.game.combat === this) globalThis.game.combat = null;
        Hooks.callAll('deleteCombat', this, {}, globalThis.game.user.id);
        await flush();
    }
}

const STATUS_IDS = [
    'afflicted', 'enhanced', 'exhausted', 'immobilized', 'prone', 'restrained', 'slowed', 'unconscious', 'stunned',
    'surprised', 'empowered', 'disoriented', 'flying', 'blind', 'hidden', 'invisible',
];

/** Install the globals. Returns handles the tests use. */
export function installFakeFoundry({ settings: overrides = {} } = {}) {
    const settings = new Map();
    const chat = [];
    const warnings = [];
    const module = { id: 'ep-cosmere-automations' };

    const socket = { emitted: [], handlers: [], on(ch, fn) { this.handlers.push(fn); }, emit(ch, msg) { this.emitted.push(msg); } };
    Object.assign(globalThis, {
        Hooks,
        Actor,
        Roll,
        fromUuidSync: (uuid) => actorsByUuid.get(uuid) ?? null,
        CONFIG: {
            Dice: { rolls: [D20Roll] },
            Actor: { documentClass: FakeActor },
            Item: { documentClass: FakeItem },
            ActiveEffect: { documentClass: FakeEffect },
            statusEffects: STATUS_IDS.map((id) => ({
                id,
                name: `COSMERE.Status.${id}`,
                img: `${id}.svg`,
                _id: `cond${id}`.padEnd(16, '0'),
                ...(id === 'exhausted' ? { system: { isStackable: true, count: 1 } } : {}),
            })),
            COSMERE: {
                statuses: Object.fromEntries(STATUS_IDS.map((id) => [id, { label: id[0].toUpperCase() + id.slice(1) }])),
                damageTypes: { keen: { label: 'Keen' }, impact: { label: 'Impact' } },
                attributes: { str: { label: 'Strength' }, spd: { label: 'Speed' } },
            },
        },
        foundry: {
            utils: { setProperty, getProperty, hasProperty, randomID },
            applications: {
                api: {
                    DialogV2: {
                        prompt: async () => {
                            globalThis.__dialogCount = (globalThis.__dialogCount ?? 0) + 1;
                            return globalThis.__dialogAnswer ?? null;
                        },
                        confirm: async () => true,
                    },
                },
                ux: { FormDataExtended: class { constructor() { this.object = {}; } } },
            },
        },
        ui: { notifications: { warn: (m) => warnings.push(m), info: () => {} } },
        ChatMessage: {
            create: async (data) => chat.push(data),
            getSpeaker: () => ({}),
            getWhisperRecipients: () => [{ id: 'gm' }],
        },
        game: {
            system: { id: 'cosmere-rpg' },
            user: { id: 'u1', isGM: true, targets: new Set() },
            release: { generation: 13 },
            socket,
            users: [],
            actors: [],
            scenes: [],
            i18n: { has: () => false, localize: (s) => s, format: (s) => s },
            modules: { get: (id) => (id === module.id ? module : undefined) },
            settings: {
                register(scope, key, config) {
                    settings.set(key, overrides[key] ?? config.default);
                },
                get(scope, key) {
                    if (!settings.has(key)) throw new Error(`setting ${key} not registered`);
                    return settings.get(key);
                },
                set(scope, key, value) {
                    settings.set(key, value);
                },
            },
        },
    });

    return { settings, chat, warnings, module, socket };
}
