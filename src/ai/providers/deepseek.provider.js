export class DeepSeekProvider {
    constructor(config) {
        this.apiKey = config.apiKey;
        this.model = config.model;
        this.baseUrl = config.baseUrl;
    }

    validateConfig() {
        if (!this.apiKey) {
            throw new Error(
                "DEEPSEEK_API_KEY no está configurada"
            );
        }
    }

    async chat({
        messages,
        temperature = 0.7,
        maxTokens = 1500,
    }) {
        this.validateConfig();

        const response = await fetch(
            `${this.baseUrl}/chat/completions`,
            {
                method: "POST",
                signal: AbortSignal.timeout(45000),

                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${this.apiKey}`,
                },

                body: JSON.stringify({
                    model: this.model,
                    messages,
                    temperature,
                    max_tokens: maxTokens,
                    stream: false,
                }),
            }
        );

        const data = await response.json();

        if (!response.ok) {
            throw new Error(
                data?.error?.message ||
                "Error consultando DeepSeek"
            );
        }

        return {
            provider: "deepseek",
            model: this.model,
            content:
                data?.choices?.[0]?.message?.content || "",
            usage: data?.usage || null,
            raw: data,
        };
    }
}
