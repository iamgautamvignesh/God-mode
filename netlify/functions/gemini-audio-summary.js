// netlify/functions/gemini-audio-summary.js
//
// "Ask about this video" style feature for Wisdom Audio Library & Epiphany
// posts. Given a Cloudinary-hosted audio/video URL, this function:
//   1) downloads the media server-side (so the phone never has to),
//   2) uploads it to Gemini's Files API (built for larger media than the
//      inline_data path used by gemini-proxy.js for short voice notes),
//   3) asks Gemini to listen to the whole thing and return a DETAILED,
//      timestamped summary in Tamil, English and Kannada.
//
// Separate file from gemini-proxy.js on purpose — that one stays untouched
// so nothing you already rely on (voice notes, chat, Habit Buddy, etc.)
// is put at risk by this new feature.
//
// ⚠️ TIMEOUT NOTE: Netlify's default synchronous function limit is ~10s
// (configurable up to 26s on paid plans via `functions.timeout` in
// netlify.toml). A short clip (a few minutes) will usually finish well
// inside that. A long 30-60+ minute talk may not — if members see timeout
// errors on long recordings, either raise the timeout in netlify.toml or
// convert this to a Background Function (suffix `-background`) and have
// the app poll a Firestore doc for the result instead of waiting on the
// HTTP response.

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

    const { audioUrl, title } = body;
    if (typeof audioUrl !== "string" || !audioUrl.trim()) {
        return { statusCode: 400, body: JSON.stringify({ error: "'audioUrl' is required." }) };
    }
    // Only allow Cloudinary URLs through — this function fetches whatever
    // URL it's given server-side, so keep it scoped to media we trust.
    if (!/^https:\/\/res\.cloudinary\.com\//i.test(audioUrl.trim())) {
        return { statusCode: 400, body: JSON.stringify({ error: "Only Cloudinary-hosted media can be summarized." }) };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error("GEMINI_API_KEY is missing from environment variables.");
        return { statusCode: 500, body: JSON.stringify({ error: "Server misconfiguration: API key missing." }) };
    }

    try {
        // ---------- 1) Fetch the audio/video bytes from Cloudinary ----------
        const mediaRes = await fetch(audioUrl);
        if (!mediaRes.ok) {
            return { statusCode: 400, body: JSON.stringify({ error: `Could not fetch the recording from Cloudinary (${mediaRes.status}).` }) };
        }
        const arrayBuffer = await mediaRes.arrayBuffer();
        const bytes = Buffer.from(arrayBuffer);

        // Cap at ~60MB so we don't hang forever on a huge file.
        if (bytes.length > 60 * 1024 * 1024) {
            return { statusCode: 400, body: JSON.stringify({ error: "This recording is too large to auto-summarize (over 60MB)." }) };
        }

        let mimeType = mediaRes.headers.get("content-type") || "";
        if (!mimeType || mimeType === "application/octet-stream") {
            mimeType = /\.(mp4|mov|webm|mkv|avi)(\?|$)/i.test(audioUrl) ? "video/mp4" : "audio/mpeg";
        }

        // ---------- 2) Upload it to Gemini's Files API ----------
        const uploadRes = await fetch(
            `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
            {
                method: "POST",
                headers: {
                    "X-Goog-Upload-Protocol": "raw",
                    "X-Goog-Upload-Command": "upload, finalize",
                    "X-Goog-Upload-Header-Content-Length": String(bytes.length),
                    "X-Goog-Upload-Header-Content-Type": mimeType,
                    "Content-Type": mimeType
                },
                body: bytes
            }
        );
        const uploadData = await uploadRes.json();
        if (uploadData.error) {
            console.error("Gemini file upload error:", JSON.stringify(uploadData.error));
            return { statusCode: 500, body: JSON.stringify({ error: uploadData.error.message || "Could not upload the recording to the AI service." }) };
        }
        const fileUri = uploadData.file && uploadData.file.uri;
        const fileName = uploadData.file && uploadData.file.name;
        if (!fileUri || !fileName) {
            return { statusCode: 500, body: JSON.stringify({ error: "AI service did not return a file reference." }) };
        }

        // Gemini needs a moment to finish processing an uploaded file before
        // it can be referenced in generateContent. Poll briefly (short clips
        // are usually ready almost instantly).
        let fileState = uploadData.file.state;
        let attempts = 0;
        while (fileState === "PROCESSING" && attempts < 10) {
            await new Promise(resolve => setTimeout(resolve, 1500));
            const checkRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`);
            const checkData = await checkRes.json();
            fileState = checkData.state;
            attempts++;
        }
        if (fileState === "FAILED") {
            return { statusCode: 500, body: JSON.stringify({ error: "AI service failed to process this recording." }) };
        }

        // ---------- 3) Ask Gemini for a detailed, timestamped, tri-lingual summary ----------
        const safeTitle = (typeof title === "string" && title.trim()) ? title.trim() : "this recording";
        const instruction = `You are helping members of a spiritual/business community app understand a Wisdom & Epiphany audio talk titled "${safeTitle}".

Listen to the attached audio/video in full and produce a DETAILED, timestamped summary of the wisdom and epiphanies shared — the same spirit as YouTube's "Ask about this video" summaries, but more thorough.

Write the summary in THREE languages, each in its own native script (not a romanized transliteration), naturally code-switching with English words the way a real speaker in that community would (Tanglish for Tamil, Kanglish for Kannada) — but keep every point clear and complete.

Reply in EXACTLY this format, with these section markers alone on their own line, nothing before ###EN### and nothing after the final section:

###EN###
A 2-3 sentence overview of the talk.

Key points (with timestamps):
- [mm:ss] Point one, as a complete sentence.
- [mm:ss] Point two, as a complete sentence.
(continue for every significant point or epiphany in the talk, in chronological order — be thorough, not brief)

###TA###
(Same structure and same level of detail, fully in Tamil script, a natural equivalent rather than a literal translation)

###KN###
(Same structure and same level of detail, fully in Kannada script)

Use plain "[mm:ss]" (e.g. [04:12]) at the very start of each bullet, matching real timestamps from the audio, so a listener can jump straight to that moment.`;

        const genRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            { text: instruction },
                            { file_data: { mime_type: mimeType, file_uri: fileUri } }
                        ]
                    }]
                })
            }
        );
        const genData = await genRes.json();

        if (genData.error) {
            console.error("Gemini API error:", JSON.stringify(genData.error));
            return { statusCode: 500, body: JSON.stringify({ error: genData.error.message || "AI service error." }) };
        }

        const text = genData && genData.candidates && genData.candidates[0]
            && genData.candidates[0].content && genData.candidates[0].content.parts
            && genData.candidates[0].content.parts[0] && genData.candidates[0].content.parts[0].text;

        if (!text) {
            console.error("Gemini API returned no text. Full response:", JSON.stringify(genData));
            return { statusCode: 500, body: JSON.stringify({ error: "AI service returned an empty response." }) };
        }

        return { statusCode: 200, body: JSON.stringify({ text: text.trim() }) };
    } catch (err) {
        console.error("Function crash:", err.message);
        return { statusCode: 500, body: JSON.stringify({ error: "Could not summarize this recording." }) };
    }
};
