import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';

const photo = Buffer.from('test image data');

describe('POST /identify', () => {
  it('sends an uploaded image to the identifier and returns its result', async () => {
    const identifyPhoto = vi.fn().mockResolvedValue({
      commonName: 'Atlantic Puffin',
      scientificName: 'Fratercula arctica',
      description: 'A seabird with a colorful bill that nests in coastal burrows.',
      confidence: 0.91,
      regions: ['Europe', 'North America'],
    });
    let fetchCount = 0;
    const fetch: typeof globalThis.fetch = async () => {
      fetchCount += 1;
      return new Response(JSON.stringify([
        {
          speciesCode: 'atlpuf',
          comName: 'Atlantic Puffin',
          sciName: 'Fratercula arctica',
          category: 'species',
          familyComName: 'Auks, Murres, and Puffins',
        },
      ]));
    };

    const response = await request(createApp({ identifyPhoto, ebird: { apiKey: 'test-key', fetch } }))
      .post('/identify')
      .attach('photo', photo, { filename: 'bird.jpg', contentType: 'image/jpeg' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      commonName: 'Atlantic Puffin',
      scientificName: 'Fratercula arctica',
      description: 'A seabird with a colorful bill that nests in coastal burrows.',
      confidence: 0.91,
      regions: ['Europe', 'North America'],
      ebirdSpecies: {
        speciesCode: 'atlpuf',
        comName: 'Atlantic Puffin',
        sciName: 'Fratercula arctica',
        category: 'species',
        familyComName: 'Auks, Murres, and Puffins',
      },
    });
    expect(identifyPhoto).toHaveBeenCalledWith(photo, 'image/jpeg');
    expect(fetchCount).toBe(1);
  });

  it('starts the eBird taxonomy lookup after Gemini identifies a bird', async () => {
    let taxonomyFetchStarted = false;
    const identifyPhoto = vi.fn().mockImplementation(async () => {
      expect(taxonomyFetchStarted).toBe(false);
      return {
        commonName: 'Atlantic Puffin',
        scientificName: 'Fratercula arctica',
        description: 'A seabird with a colorful bill.',
        confidence: 0.91,
        regions: ['Europe'],
      };
    });
    const fetch: typeof globalThis.fetch = async () => {
      taxonomyFetchStarted = true;
      return new Response(JSON.stringify([
        {
          speciesCode: 'atlpuf',
          comName: 'Atlantic Puffin',
          sciName: 'Fratercula arctica',
          category: 'species',
        },
      ]));
    };

    const response = await request(createApp({ identifyPhoto, ebird: { apiKey: 'test-key', fetch } }))
      .post('/identify')
      .attach('photo', photo, { filename: 'bird.jpg', contentType: 'image/jpeg' });

    expect(response.status).toBe(200);
    expect(response.body.ebirdSpecies.speciesCode).toBe('atlpuf');
    expect(taxonomyFetchStarted).toBe(true);
  });

  it('returns an identification without waiting for a slow eBird taxonomy lookup', async () => {
    let resolveTaxonomy!: (response: Response) => void;
    const taxonomyResponse = new Promise<Response>((resolve) => {
      resolveTaxonomy = resolve;
    });
    const response = await request(createApp({
      identifyPhoto: vi.fn().mockResolvedValue({
        commonName: 'Atlantic Puffin',
        scientificName: 'Fratercula arctica',
        description: 'A seabird with a colorful bill.',
        confidence: 0.91,
        regions: ['Europe'],
      }),
      ebird: { apiKey: 'test-key', fetch: () => taxonomyResponse },
    }))
      .post('/identify')
      .attach('photo', photo, { filename: 'bird.jpg', contentType: 'image/jpeg' });

    expect(response.status).toBe(200);
    expect(response.body.commonName).toBe('Atlantic Puffin');
    expect(response.body.ebirdSpecies).toBeNull();
    resolveTaxonomy(new Response(JSON.stringify([])));
  });

  it('returns a clear timeout when the identifier exceeds its deadline', async () => {
    const timeoutError = new Error('request aborted');
    timeoutError.name = 'AbortError';
    const response = await request(createApp({
      identifyPhoto: vi.fn().mockRejectedValue(timeoutError),
    }))
      .post('/identify')
      .attach('photo', photo, { filename: 'bird.jpg', contentType: 'image/jpeg' });

    expect(response.status).toBe(504);
    expect(response.body.error).toContain('timed out');
  });

  it('keeps a successful identification when eBird is unavailable', async () => {
    const identifyPhoto = vi.fn().mockResolvedValue({
      commonName: 'Atlantic Puffin',
      scientificName: 'Fratercula arctica',
      description: 'A seabird with a colorful bill.',
      confidence: 0.91,
      regions: ['Europe'],
    });

    const response = await request(createApp({
      identifyPhoto,
      ebird: { apiKey: 'test-key', fetch: vi.fn().mockRejectedValue(new Error('network unavailable')) },
    }))
      .post('/identify')
      .attach('photo', photo, { filename: 'bird.jpg', contentType: 'image/jpeg' });

    expect(response.status).toBe(200);
    expect(response.body.commonName).toBe('Atlantic Puffin');
    expect(response.body.ebirdSpecies).toBeNull();
    expect(response.body.ebirdLookupError).toContain('Could not reach eBird');
  });

  it('rejects requests without a photo', async () => {
    const response = await request(createApp({ identifyPhoto: vi.fn() })).post('/identify');

    expect(response.status).toBe(400);
  });

  it('rejects unsupported image types before calling Gemini', async () => {
    const identifyPhoto = vi.fn();
    const response = await request(createApp({ identifyPhoto }))
      .post('/identify')
      .attach('photo', photo, { filename: 'bird.gif', contentType: 'image/gif' });

    expect(response.status).toBe(415);
    expect(identifyPhoto).not.toHaveBeenCalled();
  });

  it('returns a no-match result without inventing a species', async () => {
    const response = await request(createApp({
      identifyPhoto: vi.fn().mockResolvedValue({
        commonName: null,
        scientificName: null,
        description: null,
        confidence: 0,
        regions: [],
      }),
    }))
      .post('/identify')
      .attach('photo', photo, { filename: 'unknown.webp', contentType: 'image/webp' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ commonName: null, scientificName: null, description: null, confidence: 0, regions: [] });
  });

  it('limits image size and hides upstream errors', async () => {
    const identifyPhoto = vi.fn().mockRejectedValue(new Error('provider error'));
    const app = createApp({ identifyPhoto });
    const tooLarge = await request(app)
      .post('/identify')
      .attach('photo', Buffer.alloc(10 * 1024 * 1024 + 1), {
        filename: 'large.jpg',
        contentType: 'image/jpeg',
      });
    const failedProvider = await request(app)
      .post('/identify')
      .attach('photo', photo, { filename: 'bird.jpg', contentType: 'image/jpeg' });

    expect(tooLarge.status).toBe(413);
    expect(identifyPhoto).toHaveBeenCalledTimes(1);
    expect(failedProvider.status).toBe(502);
    expect(failedProvider.body.error).not.toContain('provider error');
  });
});