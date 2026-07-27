type InteractionDelivery = {
  type?: string;
  payload?: unknown;
};

type DeliveryHandler = (payload: unknown) => void;

const handlersByType = new Map<string, Set<DeliveryHandler>>();
let installed = false;

function installDispatcher(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.__interactionDeliver = (delivery: unknown) => {
    const value = delivery as InteractionDelivery;
    if (typeof value?.type !== "string" || value.payload === undefined) return;
    const handlers = handlersByType.get(value.type);
    if (!handlers) return;
    for (const handler of handlers) handler(value.payload);
  };
}

export function subscribeInteractionDelivery<T>(
  type: string,
  handler: (payload: T) => void,
): () => void {
  installDispatcher();
  const wrapped: DeliveryHandler = (payload) => handler(payload as T);
  const handlers = handlersByType.get(type) ?? new Set<DeliveryHandler>();
  handlers.add(wrapped);
  handlersByType.set(type, handlers);
  return () => {
    handlers.delete(wrapped);
    if (handlers.size === 0) handlersByType.delete(type);
  };
}

declare global {
  interface Window {
    __interactionDeliver?: (payload: unknown) => void;
  }
}
