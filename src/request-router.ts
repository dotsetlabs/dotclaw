import { loadRuntimeConfig } from './runtime-config.js';

export type RoutingDecision = {
  model: string;
  fallbacks: string[];
  maxOutputTokens: number;
  maxToolSteps: number;
  temperature?: number;
  recallMaxResults: number;
  recallMaxTokens: number;
};

export function routeRequest(): RoutingDecision {
  const r = loadRuntimeConfig().host.routing;
  return {
    model: r.model,
    fallbacks: r.fallbacks,
    maxOutputTokens: r.maxOutputTokens,
    maxToolSteps: r.maxToolSteps,
    temperature: r.temperature,
    recallMaxResults: r.recallMaxResults,
    recallMaxTokens: r.recallMaxTokens,
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function routePrompt(_prompt: string): RoutingDecision {
  return routeRequest();
}
