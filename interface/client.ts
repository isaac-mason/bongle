export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export type ClientDriver = {
    matchmake(opts: {
        gameOptions: Record<string, string | number | boolean>;
        joinData?: Record<string, JsonValue>;
    }): void;
};

export type ClientApp<S = any> = {
    init: (driver: ClientDriver) => S;
    load: (state: S) => Promise<void>;
    update: (state: S, dt: number) => void;
    dispose?: (state: S) => void;

    getDomElement: (state: S) => HTMLElement;

    getInbox: (state: S) => Uint8Array[];
    getOutbox: (state: S) => Uint8Array[];
    clearOutbox: (state: S) => void;
};

export function client<S>(app: ClientApp<S>): ClientApp<S> {
    return app;
}
