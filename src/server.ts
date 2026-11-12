import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { createApp } from './app.js';
import { createGeminiIdentifier } from './gemini.js';
import { getSupabaseClient } from './supabase.js';

const apiKey = process.env.GEMINI_API_KEY?.trim();
if (!apiKey) {
  throw new Error('GEMINI_API_KEY is required. Set it in backend/.env before starting the server.');
}

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid port number.');
}

const client = new GoogleGenAI({ apiKey });
const app = createApp({
  identifyPhoto: createGeminiIdentifier(client, process.env.GEMINI_MODEL ?? 'gemini-flash-latest'),
  corsOrigins: process.env.CORS_ORIGIN,
  ebird: {
    apiKey: process.env.EBIRD_API_KEY,
  },
  admin: {
    getSupabase: getSupabaseClient,
    adminUserIds: process.env.ADMIN_USER_IDS,
  },
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Wingdex identification backend listening on port ${port}.`);
});