import dotenv from "dotenv";
dotenv.config();

export const aiConfig = {
    provider: process.env.AI_PROVIDER || "gemini",

    temperature: Number(process.env.AI_TEMPERATURE || 0.7),

    maxTokens: Number(process.env.AI_MAX_TOKENS || 1500),

    providers: {
        gemini: {
            apiKey: process.env.GEMINI_API_KEY,
            model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
        },

        deepseek: {
            apiKey: process.env.DEEPSEEK_API_KEY,
            model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
            baseUrl:
                process.env.DEEPSEEK_BASE_URL ||
                "https://api.deepseek.com",
        },
    },
};