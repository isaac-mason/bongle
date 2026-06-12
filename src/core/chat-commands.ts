/**
 * shared slash-command primitives: arg types, command specs, parser,
 * suggestion engine, listener registry, local dispatch. side-agnostic — both
 * client and server compose this into their own per-side chat module
 * (`client/chat.ts` ChatClient, `server/chat.ts` ChatServer) which add
 * transport + lines/UI as appropriate.
 *
 * scripts reach this indirectly via `api/chat.ts`. `chat.command(ctx, spec)`
 * registers a CommandSpec on whichever side runs (both for a shared script);
 * `chat.listen(ctx, handle, fn)` attaches a runtime handler on the side that
 * should execute.
 *
 * world-edit naming convention: a command whose name starts with '/' reads
 * as '//set' (one chat-opener '/' + the literal '/set' name). bare names
 * like 'help' read as '/help'.
 */

import type { Client } from 'bongle/interface';
import { registry } from './registry';
import { fuzzyRank } from './utils/fuzzy';
import { parseKey } from './voxels/block-registry';

// ── arg types ───────────────────────────────────────────────────

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type Suggestion = {
    /** inserted in place of the current token */
    text: string;
    /** shown in dropdown (defaults to text) */
    label?: string;
    /** right-side dim text */
    detail?: string;
};

export type ArgType<T> = {
    name: string;
    parse: (input: string) => ParseResult<T>;
    suggest?: (partial: string) => Suggestion[];
    describe: () => string;
};

const argTypes = new Map<string, ArgType<unknown>>();

export function defineArgType<T>(t: ArgType<T>): ArgType<T> {
    argTypes.set(t.name, t as ArgType<unknown>);
    return t;
}

export function getArgType(name: string): ArgType<unknown> | undefined {
    return argTypes.get(name);
}

/** inline factory — one-off enums don't pollute the global registry. */
export function enumType<T extends string>(values: T[]): ArgType<T> {
    const set = new Set<string>(values);
    return {
        name: `enum(${values.join('|')})`,
        parse: (s) =>
            set.has(s) ? { ok: true, value: s as T } : { ok: false, error: `expected one of: ${values.join(', ')}` },
        suggest: (partial) => values.filter((v) => v.startsWith(partial)).map((v) => ({ text: v })),
        describe: () => values.join(' | '),
    };
}

// built-ins
defineArgType<string>({
    name: 'string',
    parse: (s) => ({ ok: true, value: s }),
    describe: () => 'any text',
});

defineArgType<number>({
    name: 'number',
    parse: (s) => {
        const n = Number(s);
        if (!Number.isFinite(n)) return { ok: false, error: `not a number: ${s}` };
        return { ok: true, value: n };
    },
    describe: () => 'a number',
});

defineArgType<string>({
    name: 'block',
    parse: (s) => {
        const handle = registry.blockRegistry.idToHandle.get(s);
        if (handle) return { ok: true, value: handle.defaultKey() };
        // fully-qualified key (`oak_log[axis=y]`) — accept verbatim if its id is known
        const parsed = parseKey(s);
        if (parsed && registry.blockRegistry.defs.some((d) => d.id === parsed.blockId)) {
            return { ok: true, value: s };
        }
        return { ok: false, error: `unknown block: ${s}` };
    },
    suggest: (partial) => {
        const defs = registry.blockRegistry.defs.filter((d) => d.id !== 'air');
        return fuzzyRank(partial, defs, (d) => d.id).map(({ item: d }) => ({
            text: d.id,
            detail: d.name !== d.id ? d.name : undefined,
        }));
    },
    describe: () => 'a block id (e.g. stone, oak_log)',
});

// ── command specs ───────────────────────────────────────────────

export type ArgSpec =
    | { name: string; type: string; optional?: boolean }
    | { name: string; type: ArgType<unknown>; optional?: boolean };

export type FlagSpec = { name: string; short?: string; description: string };

export type CommandSpec = {
    /** raw name as it appears after the chat-opener '/'. world-edit
     *  convention: name starts with '/' so the user types '//set'. */
    name: string;
    description: string;
    args: ArgSpec[];
    flags?: FlagSpec[];
};

/** opaque handle returned from chat.command; chat.listen keys off `name`. */
export type CommandHandle = {
    name: string;
};

export type CommandInvocation = {
    args: Record<string, unknown>;
    flags: Record<string, boolean>;
    /** originating client on the server side; undefined on the client side. */
    from?: Client;
};

export type CommandHandler = (inv: CommandInvocation) => void | Promise<void>;

// ── command registry ────────────────────────────────────────────

/**
 * per-room command registry. lives on ChatClient.commands and
 * ChatServer.commands as a normal nested struct.
 */
export type ChatCommands = {
    specs: Map<string, CommandSpec>;
    listeners: Map<string, Set<CommandHandler>>;
};

export function init(): ChatCommands {
    return {
        specs: new Map(),
        listeners: new Map(),
    };
}

export function register(cmds: ChatCommands, spec: CommandSpec): void {
    cmds.specs.set(spec.name, spec);
}

export function unregister(cmds: ChatCommands, name: string): void {
    cmds.specs.delete(name);
}

export function addListener(cmds: ChatCommands, name: string, fn: CommandHandler): () => void {
    let set = cmds.listeners.get(name);
    if (!set) {
        set = new Set();
        cmds.listeners.set(name, set);
    }
    set.add(fn);
    return () => {
        const s = cmds.listeners.get(name);
        if (!s) return;
        s.delete(fn);
        if (s.size === 0) cmds.listeners.delete(name);
    };
}

export function hasLocalListener(cmds: ChatCommands, name: string): boolean {
    const set = cmds.listeners.get(name);
    return !!set && set.size > 0;
}

// ── parser ──────────────────────────────────────────────────────

export type Token = { value: string; start: number; end: number; isFlag: boolean };

export type ParseState = {
    cmdName: string;
    cmd: CommandSpec | null;
    argValues: Record<string, unknown>;
    argErrors: Record<string, string>;
    flagValues: Record<string, boolean>;
    activeArgIndex: number;
    activeFlagName: string | null;
    tokens: Token[];
    cursorTokenStart: number;
    cursorTokenEnd: number;
    cursorTokenIsFlag: boolean;
    /** cursor sits on the second word of a compound command (e.g. `/select box`)
     *  whose head has subcommands registered. suggestAt returns subcommand
     *  suffixes for this state; the chat UI inserts them without a leading `/`. */
    cursorIsSubcommand: boolean;
};

/** does any registered command name start with `<head> `? compound lookup
 *  hits this when token 0 is the head of a subcommand family. */
function hasCompoundHead(cmds: ChatCommands, head: string): boolean {
    const prefix = head + ' ';
    for (const name of cmds.specs.keys()) {
        if (name.startsWith(prefix)) return true;
    }
    return false;
}

/** strips exactly one leading '/' — `//set` keeps the second '/' as part of
 *  the command name. quoting is intentionally not supported yet. */
export function tokenize(input: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    if (input.charAt(0) === '/') i = 1;
    while (i < input.length) {
        while (i < input.length && input.charAt(i) === ' ') i++;
        if (i >= input.length) break;
        const start = i;
        while (i < input.length && input.charAt(i) !== ' ') i++;
        const value = input.slice(start, i);
        // a leading '-' followed by a digit or '.' is a negative number/coord,
        // not a flag (flags are '--word' or '-letter').
        const isFlag = value.startsWith('-') && !/^-[\d.]/.test(value);
        tokens.push({ value, start, end: i, isFlag });
    }
    return tokens;
}

function argTypeOf(spec: ArgSpec): ArgType<unknown> | undefined {
    if (typeof spec.type === 'string') return argTypes.get(spec.type);
    return spec.type;
}

export function parseLine(cmds: ChatCommands | null, input: string, cursor: number): ParseState {
    const tokens = tokenize(input);

    let cursorTokenStart = cursor;
    let cursorTokenEnd = cursor;
    let cursorTokenIsFlag = false;
    let cursorTokenIndex = -1;
    for (let t = 0; t < tokens.length; t++) {
        const tok = tokens[t]!;
        if (cursor >= tok.start && cursor <= tok.end) {
            cursorTokenStart = tok.start;
            cursorTokenEnd = tok.end;
            cursorTokenIsFlag = tok.isFlag;
            cursorTokenIndex = t;
            break;
        }
    }
    if (cursorTokenIndex === -1 && tokens.length > 0 && cursor > tokens[tokens.length - 1]!.end) {
        cursorTokenIndex = tokens.length;
    }

    const cmdToken = tokens[0];
    const headName = cmdToken?.value ?? '';

    // try compound (`<tok0> <tok1>`) first, then fall back to flat. cmdTokenCount
    // is how many leading tokens belong to the command name itself — args start
    // counting from there.
    let cmdName = headName;
    let cmd: CommandSpec | null = null;
    let cmdTokenCount = 1;
    if (cmds && headName) {
        const compoundName = tokens[1] && !tokens[1].isFlag ? headName + ' ' + tokens[1].value : null;
        if (compoundName && cmds.specs.has(compoundName)) {
            cmdName = compoundName;
            cmd = cmds.specs.get(compoundName)!;
            cmdTokenCount = 2;
        } else {
            cmd = cmds.specs.get(headName) ?? null;
        }
    }
    const headIsCompound = !!(cmds && headName && hasCompoundHead(cmds, headName));

    const argValues: Record<string, unknown> = {};
    const argErrors: Record<string, string> = {};
    const flagValues: Record<string, boolean> = {};

    const argTokens: Token[] = [];
    const flagTokens: Token[] = [];
    for (let i = cmdTokenCount; i < tokens.length; i++) {
        const tok = tokens[i]!;
        if (tok.isFlag) flagTokens.push(tok);
        else argTokens.push(tok);
    }

    let activeFlagName: string | null = null;

    if (cmd) {
        for (const tok of flagTokens) {
            const raw = tok.value.replace(/^-+/, '');
            const spec = cmd.flags?.find((f) => f.name === raw || f.short === raw);
            if (spec) flagValues[spec.name] = true;
        }

        for (let i = 0; i < cmd.args.length; i++) {
            const spec = cmd.args[i]!;
            const tok = argTokens[i];
            if (!tok) continue;
            const ty = argTypeOf(spec);
            if (!ty) {
                argErrors[spec.name] = `unknown arg type: ${typeof spec.type === 'string' ? spec.type : '(inline)'}`;
                continue;
            }
            const res = ty.parse(tok.value);
            if (res.ok) argValues[spec.name] = res.value;
            else argErrors[spec.name] = res.error;
        }
    }

    // cursor on the second word of a compound-head command (whether or not
    // the compound has fully resolved yet) → subcommand-suffix suggestion mode.
    const cursorIsSubcommand = headIsCompound && cursorTokenIndex === 1 && !cursorTokenIsFlag;

    let activeArgIndex = -1;
    if (cursorTokenIndex === 0 || cursorIsSubcommand) {
        activeArgIndex = -1;
    } else if (cursorTokenIndex > 0) {
        if (cursorTokenIsFlag) {
            activeArgIndex = -1;
            const raw = tokens[cursorTokenIndex]?.value.replace(/^-+/, '') ?? '';
            activeFlagName = raw || null;
        } else {
            // count positional non-flag tokens starting after the command name
            let positional = -1;
            for (let i = cmdTokenCount; i <= cursorTokenIndex && i < tokens.length; i++) {
                if (!tokens[i]!.isFlag) positional++;
            }
            if (cursorTokenIndex >= tokens.length) positional++;
            activeArgIndex = positional;
        }
    }

    return {
        cmdName,
        cmd,
        argValues,
        argErrors,
        flagValues,
        activeArgIndex,
        activeFlagName,
        tokens,
        cursorTokenStart,
        cursorTokenEnd,
        cursorTokenIsFlag,
        cursorIsSubcommand,
    };
}

export function suggestAt(cmds: ChatCommands | null, state: ParseState): Suggestion[] {
    if (state.cursorIsSubcommand && cmds) {
        // suggest the second word of a compound command (e.g. `/select <here>`).
        // `text` is just the suffix — the chat UI replaces the current token
        // without a leading '/', so the result is `/select box`.
        const head = state.tokens[0]?.value ?? '';
        const prefix = head + ' ';
        const partial = state.tokens[1]?.value ?? '';
        const subs = [...cmds.specs.values()].filter((c) => c.name.startsWith(prefix));
        return fuzzyRank(partial, subs, (c) => c.name.slice(prefix.length)).map(({ item: cmd }) => ({
            text: cmd.name.slice(prefix.length),
            label: `/${cmd.name}`,
            detail: cmd.description,
        }));
    }
    if (state.activeArgIndex === -1 && !state.cursorTokenIsFlag) {
        if (!cmds) return [];
        const partial = state.cmdName;
        const specs = [...cmds.specs.values()];
        return fuzzyRank(partial, specs, (c) => c.name).map(({ item: cmd }) => ({
            text: cmd.name,
            label: `/${cmd.name}`,
            detail: cmd.description,
        }));
    }
    if (state.cursorTokenIsFlag && state.cmd) {
        const partial = state.activeFlagName ?? '';
        const flags = state.cmd.flags ?? [];
        return fuzzyRank(partial, flags, (f) => f.name).map(({ item: f }) => ({
            text: `--${f.name}`,
            detail: f.description,
        }));
    }
    if (state.cmd && state.activeArgIndex >= 0 && state.activeArgIndex < state.cmd.args.length) {
        const spec = state.cmd.args[state.activeArgIndex]!;
        const ty = argTypeOf(spec);
        if (!ty?.suggest) return [];
        const partial = state.tokens.find((t) => t.start === state.cursorTokenStart)?.value ?? '';
        return ty.suggest(partial);
    }
    return [];
}

// ── dispatch ────────────────────────────────────────────────────

export type ParsedCommand = {
    cmd: CommandSpec;
    argValues: Record<string, unknown>;
    flagValues: Record<string, boolean>;
};

export type ParseError = { cmd: CommandSpec; error: string };

/** parse a line against `cmds`. returns the resolved command + args, an
 *  error struct, or null if the line did not begin with '/' or no command
 *  was found. */
export function tryParseCommand(cmds: ChatCommands, line: string): ParsedCommand | ParseError | null {
    if (line.charAt(0) !== '/') return null;
    const state = parseLine(cmds, line, line.length);
    if (!state.cmd) return null;
    const errs = Object.entries(state.argErrors);
    if (errs.length > 0) {
        return { cmd: state.cmd, error: errs.map(([k, v]) => `${k}: ${v}`).join(', ') };
    }
    for (const spec of state.cmd.args) {
        if (spec.optional) continue;
        if (!(spec.name in state.argValues)) {
            return { cmd: state.cmd, error: `missing arg: ${spec.name}` };
        }
    }
    return { cmd: state.cmd, argValues: state.argValues, flagValues: state.flagValues };
}

/**
 * fire every listener registered against `cmd.name`. async handlers are
 * fire-and-forget; rejections are surfaced via `onError` (each side wires
 * this to append an error line to its lines buffer / log).
 */
export function dispatchLocal(
    cmds: ChatCommands,
    cmd: CommandSpec,
    inv: CommandInvocation,
    onError: (text: string) => void,
): void {
    const handlers = cmds.listeners.get(cmd.name);
    if (!handlers) return;
    for (const fn of handlers) {
        try {
            const ret = fn(inv);
            if (ret && typeof (ret as Promise<void>).then === 'function') {
                (ret as Promise<void>).catch((e) => {
                    onError(e instanceof Error ? e.message : String(e));
                });
            }
        } catch (e) {
            onError(e instanceof Error ? e.message : String(e));
        }
    }
}
