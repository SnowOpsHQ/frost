import { INTENT_BARE_DOMAIN_WEIGHT, INTENT_CUES, INTENT_LABELS, INTENT_TEMPERATURE, type IntentLabel, type IntentResult } from '@app/specs/intent-classifier.spec';

// The prototype classifier (spec `intent-classifier.spec.ts`, How a query is classified: Compare,
// Nudge, Confidence; acceptance `intent-classifier.feature.md`, Classifier). Pure. Each label's
// centroid is the normalised mean of its prototype queries' embeddings (embedded once per load); a
// query's raw score per label is its cosine similarity to that centroid; plain cues add their spec
// weights; a softmax at `INTENT_TEMPERATURE` gives the probabilities.

/**
 * frost's own labelled prototype queries, written for frost from SEO practice: typical searches of
 * each intent across many topics (none is taken from another product, a log or a dataset). They
 * stand for the label as a whole, so each list mixes phrasings: questions and fragments, short and
 * long, with and without brand names.
 */
export const INTENT_PROTOTYPES: Readonly<Record<IntentLabel, readonly string[]>> = {
  informational: [
    'how does a heat pump work',
    'what is compound interest',
    'why is the sky blue',
    'how to change a flat tire',
    'what causes migraines',
    'how many ounces in a cup',
    'meaning of the word serendipity',
    'how to grow tomatoes in pots',
    'what is the difference between weather and climate',
    'who invented the telephone',
    'when did the first world war end',
    'how to write a cover letter',
    'what does a project manager do',
    'symptoms of dehydration',
    'how long to boil an egg',
    'history of jazz music',
    'how do vaccines work',
    'what is machine learning',
    'tips for better sleep',
    'how to calculate percentage increase',
    'causes of the french revolution',
    'how to remove a red wine stain',
    'what is the capital of australia',
    'how to train a puppy to sit',
    'benefits of drinking green tea',
    'how do airplanes stay in the air',
    'examples of renewable energy',
    'why do leaves change color in autumn',
    'how to say thank you in japanese',
    'what is a black hole',
  ],
  navigational: [
    'facebook',
    'youtube login',
    'gmail',
    'amazon',
    'netflix sign in',
    'instagram',
    'twitter login',
    'linkedin',
    'outlook email login',
    'paypal login',
    'bank of america online banking',
    'spotify web player',
    'reddit',
    'github',
    'ebay',
    'wells fargo sign on',
    'google maps',
    'icloud login',
    'zoom sign in',
    'dropbox',
    'irs official website',
    'chatgpt',
    'walmart.com',
    'nytimes.com',
    'office 365 portal',
    'whatsapp web',
    'canva login',
    'ups tracking',
    'microsoft teams',
    'pinterest',
  ],
  commercial: [
    'best running shoes for beginners',
    'best laptops for students',
    'iphone vs samsung galaxy',
    'top 10 vacuum cleaners',
    'best noise cancelling headphones',
    'mattress reviews',
    'best credit cards for travel rewards',
    'macbook air vs macbook pro',
    'best project management software',
    'most reliable suv',
    'best budget gaming monitor',
    'kindle paperwhite review',
    'best web hosting for small business',
    'top rated espresso machines',
    'best vpn services compared',
    'which electric car has the best range',
    'best dog food for puppies',
    'shopify vs woocommerce',
    'best home security cameras',
    'peloton bike worth it',
    'best air fryer',
    'alternatives to photoshop',
    'best meal kit delivery services',
    'garmin vs apple watch for running',
    'best online course platforms',
    'top robot lawn mowers',
    'best car insurance companies',
    'sony a7 iv review',
    'best hiking boots for wide feet',
    'cheapest phone plans compared',
  ],
  transactional: [
    'buy iphone 15 pro',
    'order flowers online',
    'cheap flights to london',
    'nike air force 1 sale',
    'pizza delivery near me',
    'book a hotel in new york',
    'buy concert tickets',
    'amazon prime membership price',
    'download microsoft office',
    'adidas promo code',
    'rent a car at the airport',
    'buy running shoes online',
    'netflix subscription plans price',
    'order groceries for delivery',
    'buy ps5 console',
    'discount code for hellofresh',
    'airpods pro best price',
    'buy a used car',
    'reserve a table for dinner tonight',
    'sign up for a free trial of spotify premium',
    'purchase a domain name',
    'ikea sofa for sale',
    'hire a plumber',
    'book a dentist appointment',
    'buy gift card',
    'samsung tv deals',
    'order contact lenses',
    'cheap train tickets to paris',
    'buy bitcoin',
    'install vpn app download',
  ],
};

/** The words of a query or cue: lowercase, accents stripped, anything but letters and digits a separator. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '');
}

/** A bare domain: one host name (two or more labels, a letter TLD), optionally with a scheme, `www.` and a final `/`. */
const BARE_DOMAIN = /^(?:https?:\/\/)?(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\/?$/;

export function isBareDomain(query: string): boolean {
  return BARE_DOMAIN.test(query.trim().toLowerCase());
}

/** Whether `phrase` (its words) occurs in `queryWords` as consecutive whole words. */
function containsPhrase(queryWords: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length === 0 || phrase.length > queryWords.length) return false;
  for (let start = 0; start + phrase.length <= queryWords.length; start += 1) {
    if (phrase.every((word, index) => queryWords[start + index] === word)) return true;
  }
  return false;
}

/** Each label's cue terms, as words. */
const CUE_PHRASES = Object.fromEntries(INTENT_LABELS.map((label) => [label, INTENT_CUES[label].terms.map(words)])) as Record<IntentLabel, string[][]>;

/** Each label's nudge for `query`: its cue weight when any of its terms occurs (once), plus the bare-domain nudge for `navigational`. */
export function cueNudges(query: string): Record<IntentLabel, number> {
  const queryWords = words(query);
  const nudges = Object.fromEntries(INTENT_LABELS.map((label) => [label, CUE_PHRASES[label].some((phrase) => containsPhrase(queryWords, phrase)) ? INTENT_CUES[label].weight : 0])) as Record<IntentLabel, number>;
  if (isBareDomain(query)) nudges.navigational = Math.max(nudges.navigational, INTENT_BARE_DOMAIN_WEIGHT);
  return nudges;
}

/** `exp(x / temperature)`, normalised (shifted by the maximum, so it never overflows). */
export function softmax(logits: readonly number[], temperature: number): number[] {
  const max = Math.max(...logits);
  const exps = logits.map((logit) => Math.exp((logit - max) / temperature));
  const sum = exps.reduce((total, value) => total + value, 0);
  return exps.map((value) => value / sum);
}

/** Cosine similarity (0 when either vector is zero). */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index]! * (b[index] ?? 0);
    normA += a[index]! * a[index]!;
    normB += (b[index] ?? 0) * (b[index] ?? 0);
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

/** The normalised mean of `vectors`. */
export function centroid(vectors: readonly Float32Array[]): Float32Array {
  const dims = vectors[0]?.length ?? 0;
  const mean = new Float32Array(dims);
  for (const vector of vectors) for (let d = 0; d < dims; d += 1) mean[d]! += vector[d]!;
  let norm = 0;
  for (const value of mean) norm += value * value;
  norm = Math.sqrt(norm);
  return norm === 0 ? mean : mean.map((value) => value / norm);
}

export type Centroids = Readonly<Record<IntentLabel, Float32Array>>;

/** Embeds every label's prototypes (one call) and returns each label's centroid. */
export async function buildCentroids(embed: (texts: readonly string[]) => Promise<Float32Array[]>): Promise<Centroids> {
  const texts = INTENT_LABELS.flatMap((label) => INTENT_PROTOTYPES[label]);
  const vectors = await embed(texts);
  if (vectors.length !== texts.length) throw new Error('the embedder skipped prototypes');
  const centroids = {} as Record<IntentLabel, Float32Array>;
  let at = 0;
  for (const label of INTENT_LABELS) {
    const count = INTENT_PROTOTYPES[label].length;
    centroids[label] = centroid(vectors.slice(at, at + count));
    at += count;
  }
  return centroids;
}

/** A result from each label's raw score (`similarities`) for `query`: cue nudges added, then the softmax. */
export function scoreIntent(similarities: Readonly<Record<IntentLabel, number>>, query: string, model: IntentResult['model']): IntentResult {
  const nudges = cueNudges(query);
  const probabilities = softmax(
    INTENT_LABELS.map((label) => similarities[label] + nudges[label]),
    INTENT_TEMPERATURE,
  );
  const scores = Object.fromEntries(INTENT_LABELS.map((label, index) => [label, probabilities[index]!])) as Record<IntentLabel, number>;
  // The first label wins a tie (display order).
  const label = INTENT_LABELS.reduce((best, candidate) => (scores[candidate] > scores[best] ? candidate : best), INTENT_LABELS[0]);
  return { label, confidence: scores[label], scores, model };
}

/** A query's result from its embedding `vector` and the centroids. */
export function classifyVector(vector: Float32Array, centroids: Centroids, query: string, model: IntentResult['model']): IntentResult {
  const similarities = Object.fromEntries(INTENT_LABELS.map((label) => [label, cosine(vector, centroids[label])])) as Record<IntentLabel, number>;
  return scoreIntent(similarities, query, model);
}
