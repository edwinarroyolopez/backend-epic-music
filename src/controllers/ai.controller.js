import { generateAIResponse } from "../services/ai.service.js";

export const chatController = async (
    req,
    res
) => {
    try {
        const {
            messages,
            provider,
            temperature,
            maxTokens,
        } = req.body;

        const response =
            await generateAIResponse({
                messages,
                provider,
                temperature,
                maxTokens,
            });

        return res.status(200).json({
            success: true,
            data: response,
        });
    } catch (error) {
        console.error(
            "AI Controller Error:",
            error
        );

        return res.status(500).json({
            success: false,
            error: error.message,
        });
    }
};