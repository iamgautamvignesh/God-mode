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

    // `quality: "high"` is optional. Only the Pattern Maker sends it. Everything else behaves as before.
    const { prompt, audio, mimeType, quality } = body;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error("GEMINI_API_KEY is missing from environment variables.");
        return { statusCode: 500, body: JSON.stringify({ error: "Server misconfiguration: API key missing." }) };
    }

    // ---------- Build the "contents" payload for Gemini ----------
    let parts;

    if (typeof audio === "string" && audio.trim()) {
        // ===== Audio / image inline-data mode =====
        if (typeof mimeType !== "string" || !mimeType.trim()) {
            return { statusCode: 400, body: JSON.stringify({ error: "A 'mimeType' string is required alongside 'audio' (e.g. 'audio/webm')." }) };
        }
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

    // Default model: flash-lite (much higher free-tier daily quota).
    // quality "high": try the stronger model first, then fall back to flash-lite automatically
    // (quota used up, error, or too slow). Override names/time with Netlify environment variables.
    const FAST_MODEL = "gemini-3.5-flash-lite";
    const STRONG_MODEL = process.env.GEMINI_STRONG_MODEL || "gemini-3.6-flash";
    const STRONG_MS = parseInt(process.env.STRONG_TIMEOUT_MS, 10) || 8000;
    const models = quality === "high" ? [STRONG_MODEL, FAST_MODEL] : [FAST_MODEL];

    function extractText(data) {
        const p = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
        if (!Array.isArray(p)) return "";
        return p.filter(x => typeof x.text === "string" && !x.thought).map(x => x.text).join("").trim();
    }

    let lastError = "AI service error.";
    for (let i = 0; i < models.length; i++) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), (i === 0 && models.length > 1) ? STRONG_MS : 25000);
        try {
            const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${models[i]}:generateContent?key=${apiKey}`;
            const response = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                signal: ctl.signal,
                body: JSON.stringify({ contents: [{ parts }] })
            });
            const data = await response.json();

            if (data.error) {
                console.error("Gemini API error (" + models[i] + "):", JSON.stringify(data.error));
                lastError = data.error.message || lastError;
                continue;
            }
            const text = extractText(data);
            if (!text) {
                console.error("Gemini API returned no text (" + models[i] + "). Full response:", JSON.stringify(data));
                lastError = "AI service returned an empty response.";
                continue;
            }
            return { statusCode: 200, body: JSON.stringify({ text: text, model: models[i] }) };
        } catch (err) {
            console.error("Function crash (" + models[i] + "):", err.message);
            lastError = "Could not reach the AI service.";
        } finally {
            clearTimeout(timer);
        }
    }
    return { statusCode: 500, body: JSON.stringify({ error: lastError }) };
};
