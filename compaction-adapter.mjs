import { expandInsertions, supportsKB } from "./core.mjs";
const ACTIVE = Symbol.for("pi-kb.compaction-adapter");

// Compact calls provider.stream directly, without before_provider_request.
// Expand anchors BEFORE its onPayload captures the input being compacted.
export function attachCompactionAdapter(runtime, getBranch) {
  // SDK sessions can dispose without session_shutdown and reuse their runtime.
  // Retire the previous owner before capturing the base method.
  runtime[ACTIVE]?.();
  const original = runtime.getProvider;
  const cache = new WeakMap();
  function getProvider(...args) {
    const provider = original.apply(this, args);
    if (!provider || typeof provider.stream !== "function") return provider;
    if (!cache.has(provider)) {
      cache.set(provider, new Proxy(provider, {
        get(target, key, receiver) {
          if (key !== "stream") return Reflect.get(target, key, receiver);
          return (model, context, options) => {
            if (!supportsKB(model)) return target.stream(model, context, options);
            return target.stream(model, context, {
              ...options,
              onPayload: async (payload, ...args) => {
                const expanded = expandInsertions(payload, getBranch());
                return (await options?.onPayload?.(expanded, ...args)) ?? expanded;
              },
            });
          };
        },
      }));
    }
    return cache.get(provider);
  }
  runtime.getProvider = getProvider;
  const detach = () => {
    if (runtime.getProvider === getProvider) runtime.getProvider = original;
    if (runtime[ACTIVE] === detach) delete runtime[ACTIVE];
  };
  runtime[ACTIVE] = detach;
  return detach;
}
