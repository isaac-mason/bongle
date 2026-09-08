// the engine client the editor UI is mounted on. Provided once by mountEditUI;
// components reach the engine (session verbs, the renderer) through it instead
// of a module global.

import { createContext, useContext } from 'react';
import type { EngineClient } from '../../client/client';

export const EngineClientContext = createContext<EngineClient | null>(null);

export function useEngineClient(): EngineClient {
    const state = useContext(EngineClientContext);
    if (!state) throw new Error('[editor] useEngineClient called outside mountEditUI');
    return state;
}
