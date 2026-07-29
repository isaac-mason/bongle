// editor/env-plugin.ts — the vite adapter for the editor's OWN build (vite.config.ts).
//
// Thin wrapper over lib/build's `replaceEnv` (the pure, host-neutral `env.<key>` →
// boolean-literal pass, shared with the in-browser dev transform). Each realm
// build applies its own env values (server worker = {server:true}, …) so the
// bundler DCEs the other realms' branches. `applyToEnvironment` scopes each
// instance to one env's module graph, so multiple envPlugins can coexist.

import type { Plugin } from 'vite';
// import the module directly, NOT the '../build' barrel: vite 8's config bundler
// resolves file imports but not bare directory-index imports (`../build` →
// build/index.ts), so it fails in the website Dockerfile's `vite build`. This also
// keeps the whole build barrel out of the editor's config bundle.
import { type EnvValues, replaceEnv } from '../build/env-replace';

export function envPlugin(values: EnvValues, applyToEnvironmentName?: string): Plugin {
    return {
        name: applyToEnvironmentName ? `bongle-env:${applyToEnvironmentName}` : 'bongle-env',
        applyToEnvironment: applyToEnvironmentName ? (environment) => environment.name === applyToEnvironmentName : undefined,
        transform(code) {
            const out = replaceEnv(code, values);
            return out === code ? null : out;
        },
    };
}
