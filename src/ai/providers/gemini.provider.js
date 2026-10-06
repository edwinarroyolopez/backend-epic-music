export class GeminiProvider {
    constructor(config) {
        this.apiKey = config.apiKey;
        this.model = config.model;
    }

    validateConfig() {
        if (!this.apiKey) {
            throw new Error(
                "GEMINI_API_KEY no está configurada"
            );
        }
    }

    async chat({
        messages,
        temperature = 0.7,
        maxTokens = 1500,
    }) {
        this.validateConfig();

        const url =
            `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

        const contents = messages
            .filter((message) => message.role !== "system")
            .map((message) => ({
                role:
                    message.role === "assistant"
                        ? "model"
                        : "user",
                parts: [
                    {
                        text: message.content,
                    },
                ],
            }));

        const systemMessage = messages.find(
            (message) => message.role === "system"
        );

        const body = {
            contents,
            generationConfig: {
                temperature,
                maxOutputTokens: maxTokens,
            },
        };

        if (systemMessage) {
            body.systemInstruction = {
                parts: [
                    {
                        text: systemMessage.content,
                    },
                ],
            };
        }

        const response = await fetch(url, {
            method: "POST",

            headers: {
                "Content-Type": "application/json",
            },

            body: JSON.stringify(body),
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(
                data?.error?.message ||
                "Error consultando Gemini"
            );
        }

        const text =
            data?.candidates?.[0]?.content?.parts
                ?.map((part) => part.text || "")
                .join("") || "";

        return {
            provider: "gemini",
            model: this.model,
            content: text,
            raw: data,
        };
    }
}