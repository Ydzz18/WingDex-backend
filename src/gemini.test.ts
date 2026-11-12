import { describe, expect, it, vi } from 'vitest';
import type { GoogleGenAI } from '@google/genai';
import { createGeminiIdentifier, parseGeminiResponse } from './gemini.js';

describe('Gemini response validation', () => {
  it('accepts a bird outside the local catalog and finite confidence', () => {
    expect(parseGeminiResponse(JSON.stringify({
      commonName: 'Atlantic Puffin',
      scientificName: 'Fratercula arctica',
      description: 'A seabird with a colorful bill that nests in coastal burrows.',
      confidence: 0.82,
      regions: ['Europe', 'North America'],
    }))).toEqual({
      commonName: 'Atlantic Puffin',
      scientificName: 'Fratercula arctica',
      description: 'A seabird with a colorful bill that nests in coastal burrows.',
      confidence: 0.82,
      regions: ['Europe', 'North America'],
    });
  });

  it('maps an unknown result to the mobile API contract', () => {
    expect(parseGeminiResponse(JSON.stringify({
      commonName: 'Unknown',
      scientificName: 'Unknown',
      description: 'Unknown',
      confidence: 0,
      regions: ['Unknown'],
    }))).toEqual({ commonName: null, scientificName: null, description: null, confidence: 0, regions: [] });
  });

  it.each([
    '{invalid json',
    JSON.stringify({ commonName: 'Owl', scientificName: 'Strigidae', description: 'An owl.', confidence: 1.2, regions: ['Asia'] }),
    JSON.stringify({ commonName: 'Owl', scientificName: 'Strigidae', description: 'An owl.', confidence: 0.8, regions: ['Mars'] }),
    JSON.stringify({ commonName: 'Owl', scientificName: 'Strigidae', description: 'An owl.', confidence: 'high', regions: ['Asia'] }),
  ])('rejects invalid model output: %s', (text) => {
    expect(() => parseGeminiResponse(text)).toThrow();
  });

  it('sends inline image bytes and a global bird response schema to Gemini', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        commonName: 'Keel-billed Toucan',
        scientificName: 'Ramphastos sulfuratus',
        description: 'A rainforest toucan with a large, colorful bill.',
        confidence: 0.91,
        regions: ['North America', 'South America'],
      }),
    });
    const client = { models: { generateContent } } as unknown as GoogleGenAI;
    const identify = createGeminiIdentifier(client, 'gemini-flash-latest');

    await expect(identify(Buffer.from('image bytes'), 'image/jpeg')).resolves.toEqual({
      commonName: 'Keel-billed Toucan',
      scientificName: 'Ramphastos sulfuratus',
      description: 'A rainforest toucan with a large, colorful bill.',
      confidence: 0.91,
      regions: ['North America', 'South America'],
    });
    expect(generateContent).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gemini-flash-latest',
      contents: [expect.objectContaining({
        parts: expect.arrayContaining([
          { inlineData: { mimeType: 'image/jpeg', data: Buffer.from('image bytes').toString('base64') } },
        ]),
      })],
      config: expect.objectContaining({ responseMimeType: 'application/json' }),
    }));
  });
});