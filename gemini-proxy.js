exports.handler = async function (event) {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method Not Allowed" };
    }

    let body;
    try {
        body = JSON.parse(event.body);
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
    }

    const { prompt, audio, mimeType } = body;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error("GEMINI_API_KEY is missing from environment variables.");
        return { statusCode: 500, body: JSON.stringify({ error: "Server misconfiguration: API key missing." }) };
    }

    // ---------- Build the "contents" payload for Gemini ----------
    let parts;

    if (typeof audio === "string" && audio.trim()) {
        // ===== Audio transcription / voice-note mode =====
        if (typeof mimeType !== "string" || !mimeType.trim()) {
            return { statusCode: 400, body: JSON.stringify({ error: "A 'mimeType' string is required alongside 'audio' (e.g. 'audio/webm')." }) };
        }
        // Rough sanity check: base64 audio over ~15MB is rejected before we
        // even call Gemini (Netlify's own body-size limit is ~6MB anyway,
        // so this mostly guards against obviously malformed payloads).
        if (audio.length > 20 * 1024 * 1024) {
            return { statusCode: 400, body: JSON.stringify({ error: "Audio payload too large." }) };
        }

        const instruction = (typeof prompt === "string" && prompt.trim())
            ? prompt.trim()
            : "Transcribe this audio exactly as spoken, in the original language and script the speaker used (Tamil, Kannada, Telugu, Malayalam, English, or a mix/code-switched speech such as Tanglish — detect automatically, do not translate). Return only the transcription text, with no extra commentary.";

        parts = [
            { text: instruction },
            { inline_data: { mime_type: mimeType, data: audio } }
        ];
    } else if (typeof prompt === "string" && prompt.trim()) {
        // ===== Existing text-only mode (unchanged behaviour) =====
        if (prompt.length > 12000) {
            return { statusCode: 400, body: JSON.stringify({ error: "Prompt too long (max 12000 characters)." }) };
        }
        parts = [{ text: prompt }];
    } else {
        return { statusCode: 400, body: JSON.stringify({ error: "Either a non-empty 'prompt' string, or 'audio' + 'mimeType', is required." }) };
    }

    // Using 3.5 flash-lite: much higher free-tier daily quota
    // compared to gemini-3.6-flash (only 20/day on free tier).
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`;

    try {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts }] })
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
