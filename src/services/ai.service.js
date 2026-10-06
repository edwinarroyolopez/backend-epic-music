import { aiConfig } from "../ai/ai.config.js";
import { createAIProvider } from "../ai/ai.factory.js";

export const generateAIResponse = async ({
    messages,
    provider,
    temperature,
    maxTokens,
}) => {
    if (!Array.isArray(messages)) {
        throw new Error(
            "messages debe ser un array"
        );
    }

    if (messages.length === 0) {
        throw new Error(
            "Debes enviar al menos un mensaje"
        );
    }

    const aiProvider = createAIProvider(
        provider || aiConfig.provider
    );

    const response = await aiProvider.chat({
        messages,
        temperature:
            temperature ?? aiConfig.temperature,
        maxTokens:
            maxTokens ?? aiConfig.maxTokens,
    });

    return response;
};