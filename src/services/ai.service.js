import { aiConfig } from "../ai/ai.config.js";
import { createAIProvider } from "../ai/ai.factory.js";

export const generateAIResponse = async ({
    messages,
    provider,
    temperature,
    maxTokens,
    jsonMode = false,
}) => {
    if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error("messages debe ser un array no vacío");
    }
    const aiProvider = createAIProvider(provider || aiConfig.provider);
    return aiProvider.chat({
        messages,
        temperature: temperature ?? aiConfig.temperature,
        maxTokens: maxTokens ?? aiConfig.maxTokens,
        jsonMode,
    });
};
