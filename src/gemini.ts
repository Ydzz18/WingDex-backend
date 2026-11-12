import { GoogleGenAI, Type } from '@google/genai';
import { z } from 'zod';
import { birdRegions, type BirdRegion } from '../../src/data/regions.ts';

export type IdentificationResult = {
  commonName: string | null;
  scientificName: string | null;
  description: string | null;
  confidence: number;
  regions: BirdRegion[];
};

const responseSchema = z.object({
  commonName: z.string().trim().min(1).max(120),
  scientificName: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(400),
  confidence: z.number().finite().min(0).max(1),
  regions: z.array(z.enum(birdRegions)).max(7),
}).strict();

const modelSchema = {
  type: Type.OBJECT,
  properties: {
    commonName: { type: Type.STRING },
    scientificName: { type: Type.STRING },
    description: { type: Type.STRING },
    confidence: { type: Type.NUMBER },
    regions: {
      type: Type.ARRAY,
      items: { type: Type.STRING, enum: [...birdRegions] },
    },
  },
  required: ['commonName', 'scientificName', 'description', 'confidence', 'regions'],
};

export function parseGeminiResponse(text: string | undefined): IdentificationResult {
  if (!text) {
    throw new Error('Gemini returned an empty response.');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error('Gemini returned invalid JSON.');
  }

  const result = responseSchema.safeParse(decoded);
  if (!result.success) {
    throw new Error('Gemini returned an invalid identification.');
  }

  if (
    result.data.commonName.toLowerCase() === 'unknown' ||
    result.data.commonName.toLowerCase() === 'no_match' ||
    result.data.confidence === 0
  ) {
    return { commonName: null, scientificName: null, description: null, confidence: 0, regions: [] };
  }

  return result.data;
}

export function createGeminiIdentifier(
  client: GoogleGenAI,
  model: string
): (image: Buffer, mimeType: string) => Promise<IdentificationResult> {
  return async (image, mimeType) => {
    const response = await client.models.generateContent({
      model,
      contents: [{
        role: 'user',
        parts: [
          {
            text: [
              'Identify any bird species visible in this photo, anywhere in the world.',
              'Do not restrict your answer to a supplied catalog.',
              'If no bird is clearly visible or the image is not a bird, set both names to "Unknown", confidence to 0, and regions to ["Unknown"].',
              'Be conservative and do not guess when identifying features are insufficient.',
              'For a confident match, add a concise factual description of the species (one or two sentences, at most 400 characters), focusing on distinguishing traits and typical habitat. Do not describe details that cannot be reliably known from the photo.',
              'For an unknown result, set description to "Unknown".',
              'Give a confidence estimate from 0 to 1 based on visible identifying features; this is an estimate, not a calibrated probability.',
              'List the broad continents in the species native/wild range. Use multiple continents for migratory or widespread species; use ["Unknown"] when the range is unclear. Do not infer where the photo was taken.',
              'Return only values supported by the requested JSON schema.',
            ].join('\n'),
          },
          { inlineData: { mimeType, data: image.toString('base64') } },
        ],
      }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: modelSchema,
      },
    });

    return parseGeminiResponse(response.text);
  };
}