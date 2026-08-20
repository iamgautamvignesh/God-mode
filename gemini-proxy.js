exports.handler = async function (event) {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method Not Allowed" };
    }

    let prompt;
    try {
        const body = JSON.parse(event.body);
        prompt = body.prompt;
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
    }

    if (typeof prompt !== "string" || !prompt.trim()) {
        return { statusCode: 400, body: JSON.stringify({ error: "A non-empty 'prompt' string is required." }) };
    }
    if (prompt.length > 12000) {
        return { statusCode: 400, body: JSON.stringify({ error: "Prompt too long (max 12000 characters)." }) };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error("GEMINI_API_KEY is missing from environment variables.");
        return { statusCode: 500, body: JSON.stringify({ error: "Server misconfiguration: API key missing." }) };
    }

    // Using 3.5 flash-lite: much higher free-tier daily quota
    // compared to gemini-3.6-flash (only 20/day on free tier).
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`;

    try {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const data = await response.json();

        if (data.error) {
            console.error("Gemini API error:", JSON.stringify(data.error));
            return { statusCode: 500, body: JSON.stringify({ error: data.error.message || "AI service error." }) };
        }

        const text = data && data.candidates && data.candidates[0]
            && data.candidates[0].content && data.candidates[0].content.parts
            && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;

        if (!text) {
            console.error("Gemini API returned no text. Full response:", JSON.stringify(data));
            return { statusCode: 500, body: JSON.stringify({ error: "AI service returned an empty response." }) };
        }

        return { statusCode: 200, body: JSON.stringify({ text: text.trim() }) };
    } catch (err) {
        console.error("Function crash:", err.message);
        return { statusCode: 500, body: JSON.stringify({ error: "Could not reach the AI service." }) };
    }
};
