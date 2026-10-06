import { aiConfig } from "./ai.config.js";

import { GeminiProvider } from "./providers/gemini.provider.js";

import { DeepSeekProvider } from "./providers/deepseek.provider.js";

export const createAIProvider = (
    providerName = aiConfig.provider
) => {
    const provider = providerName.toLowerCase();

    switch (provider) {
        case "gemini":
            return new GeminiProvider(
                aiConfig.providers.gemini
            );

        case "deepseek":
            return new DeepSeekProvider(
                aiConfig.providers.deepseek
            );

        default:
            throw new Error(
                `Proveedor de AI no soportado: ${provider}`
            );
    }
};