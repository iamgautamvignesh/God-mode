// netlify/functions/generate-cover-art.js
//
// Takes a recording's AI summary text + title, asks Gemini's image model for
// a small symbolic cover-art image, and returns it as a base64 data URL.
// The front end (generateCoverArtForRecording in index.html) then uploads
// that image to Cloudinary and saves the resulting URL on the Firestore doc
// as `coverImageUrl`.
//
// Setup on Netlify:
//   1. Site settings -> Environment variables -> add GEMINI_API_KEY
//      (same key already used by gemini-audio-summary.js works fine here too)
//   2. Deploy — no other config needed.

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    let summaryText = '', title = '';
    try {
        const body = JSON.parse(event.body || '{}');
        summaryText = body.summaryText || '';
        title = body.title || '';
    } catch (e) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
    }

    if (!summaryText && !title) {
        return { statusCode: 400, body: JSON.stringify({ error: 'summaryText or title is required.' }) };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return { statusCode: 500, body: JSON.stringify({ error: 'GEMINI_API_KEY is not configured on the server.' }) };
    }

    // Keep the prompt short — image models don't need the full transcript,
    // just enough of the summary to capture the mood/theme.
    const trimmedSummary = summaryText.slice(0, 1200);
    const prompt = `Create a calm, symbolic square cover-art illustration for a spiritual/wisdom audio talk. ` +
        `No text, no letters, no words anywhere in the image. ` +
        `Title: "${title || 'Untitled'}". ` +
        `Summary of the talk: ${trimmedSummary}. ` +
        `Style: soft abstract shapes, warm gentle gradient, minimal, serene — suitable to crop into a circular album-art thumbnail.`;

    try {
        const response = await fetch(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': apiKey
                },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { responseModalities: ['IMAGE'] }
                })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            return {
                statusCode: response.status,
                body: JSON.stringify({ error: (data && data.error && data.error.message) || 'Gemini image generation failed.' })
            };
        }

        const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
        const imagePart = parts.find(p => p.inlineData || p.inline_data);
        const inline = imagePart ? (imagePart.inlineData || imagePart.inline_data) : null;

        if (!inline || !inline.data) {
            return { statusCode: 502, body: JSON.stringify({ error: 'Gemini did not return an image for this recording.' }) };
        }

        const mimeType = inline.mimeType || inline.mime_type || 'image/png';
        return {
            statusCode: 200,
            body: JSON.stringify({ imageBase64: `data:${mimeType};base64,${inline.data}` })
        };
    } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
};
