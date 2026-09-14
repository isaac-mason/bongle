import { createContext, useContext } from 'react';
import type { EngineClient } from '../../client/client';

export const EngineClientContext = createContext<EngineClient | null>(null);

export function useEngineClient(): EngineClient {
    const state = useContext(EngineClientContext);
    if (!state) throw new Error('[editor] useEngineClient called outside mountEditUI');
    return state;
}
