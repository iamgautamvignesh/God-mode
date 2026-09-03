// netlify/functions/generate-cover-image.js
//
// Called from index.html's generateAndApplyCoverImage():
//   POST { summary: string, title: string }  ->  { coverImageUrl: string }
//
// Firestore is NOT touched here — the frontend already saves
// aiCoverImageUrl itself right after this returns. This function's only
// job is: prompt -> Gemini image -> Cloudinary upload -> return the URL.

const crypto = require('crypto');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

// "Nano Banana" — Gemini's image-output model. Must request both
// TEXT and IMAGE modalities or the API rejects the call.
const GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { summary, title } = JSON.parse(event.body || '{}');

    if (!summary || !summary.trim()) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'summary is required' }),
      };
    }

    const prompt = buildCoverPrompt(summary, title);
    const base64Image = await generateImage(prompt);
    const coverImageUrl = await uploadToCloudinary(base64Image);

    return {
      statusCode: 200,
      body: JSON.stringify({ coverImageUrl }),
    };
  } catch (err) {
    console.error('generate-cover-image error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || 'Image generation failed' }),
    };
  }
};

function buildCoverPrompt(summary, title) {
  const trimmed = summary.slice(0, 400);
  const titlePart = title ? `Title: "${title}". ` : '';
  return (
    `${titlePart}A serene, symbolic album-cover illustration representing this idea: ` +
    `"${trimmed}". Warm gold and deep earth tones, minimal, spiritual, ` +
    'abstract — no text, no words, no letters, no human faces.'
  );
}

async function generateImage(prompt) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${GEMINI_IMAGE_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini image request failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p) => p.inlineData?.data);

  if (!imagePart) {
    throw new Error('Gemini response did not include an image');
  }

  return imagePart.inlineData.data; // base64, no "data:" prefix
}

async function uploadToCloudinary(base64Image) {
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `brahma-wisdom/covers/${timestamp}-${crypto.randomBytes(4).toString('hex')}`;

  // Signed upload from the server — no need for an unsigned preset.
  const signature = signParams({ public_id: publicId, timestamp }, CLOUDINARY_API_SECRET);

  const form = new URLSearchParams();
  form.append('file', `data:image/png;base64,${base64Image}`);
  form.append('public_id', publicId);
  form.append('timestamp', String(timestamp));
  form.append('api_key', CLOUDINARY_API_KEY);
  form.append('signature', signature);

  const uploadUrl = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;
  const res = await fetch(uploadUrl, { method: 'POST', body: form });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cloudinary upload failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.secure_url;
}

function signParams(params, secret) {
  const sorted = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  return crypto.createHash('sha1').update(sorted + secret).digest('hex');
}
