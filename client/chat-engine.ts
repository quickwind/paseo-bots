interface EngineProvider {
  provider: string;
  label?: string | null;
  models?: readonly { id: string; label?: string | null; isDefault?: boolean }[];
}

/**
 * The provider and model a chat runs on, as the chat's header shows it ("Claude Code · Sonnet 5.5"). A chat without a
 * recorded model runs the provider's default. Until the provider list is loaded (or when it doesn't know the ids) the raw
 * ids are shown. Null when there is no provider.
 */
export function chatEngineLabel(engine: { provider: string; model: string | null }, providers: readonly EngineProvider[] | undefined): string | null {
  if (!engine.provider) return null;
  const entry = providers?.find((candidate) => candidate.provider === engine.provider);
  const providerName = entry?.label || engine.provider;
  const models = entry?.models ?? [];
  const model = engine.model ? models.find((candidate) => candidate.id === engine.model) : models.find((candidate) => candidate.isDefault);
  const modelName = model ? model.label || model.id : engine.model;
  return modelName ? `${providerName} · ${modelName}` : providerName;
}
