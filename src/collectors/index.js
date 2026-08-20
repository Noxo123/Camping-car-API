import { collectCampingCarPark } from './campingCarPark.js';

export async function collectAll() {
  const results = [];
  try {
    results.push(await collectCampingCarPark());
  } catch (error) {
    results.push({
      source: 'Camping-Car Park',
      sourceId: 'camping-car-park',
      method: 'public-html-scraping',
      error: error.message,
      records: []
    });
  }
  return results;
}
