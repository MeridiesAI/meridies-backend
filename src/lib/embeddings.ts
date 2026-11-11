/**
 * Text embeddings for the college-matching work, computed in this process (no API call, no cost per text).
 *
 * The vectors go into `college_opportunities.embedding` (`vector(384)`, cosine index) and are compared with vectors
 * made later for a student, so every vector must come from the same model at the same precision. Changing
 * EMBEDDING_MODEL, EMBEDDING_DIM or EMBEDDING_DTYPE means re-embedding every stored row.
 *
 * The model (about 130 MB, held in memory once loaded) is downloaded from the Hugging Face Hub on first use and
 * cached on disk; on Railway that cache doesn't survive a deploy, so call warmEmbeddings() at boot to pay the
 * download before a request does.
 */

import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

export const EMBEDDING_MODEL = "Supabase/gte-small";
export const EMBEDDING_DIM = 384;
/**
 * Full precision. The 8-bit model is a quarter the size, but its vectors shift slightly with whatever else is in
 * the batch (cosine about 0.998 to the same text embedded alone); fp32 gives a text the same vector every time.
 */
const EMBEDDING_DTYPE = "fp32";

let extractor: Promise<FeatureExtractionPipeline> | null = null;

function loadExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractor) {
    extractor = pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: EMBEDDING_DTYPE }).catch((err: unknown) => {
      // A failed load (no network, Hub down) isn't kept, so the next call tries again.
      extractor = null;
      throw err;
    });
  }
  return extractor;
}

/**
 * One unit-length vector (EMBEDDING_DIM numbers, mean-pooled) per text, in input order; cosine similarity of two is
 * their dot product.
 *
 * Warning: the model reads at most 512 tokens, about 400 English words. Anything past that is cut off without an
 * error, so a long text is embedded from its beginning only: embed a short description, not a whole page.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const model = await loadExtractor();
  const output = await model(texts, { pooling: "mean", normalize: true });
  const vectors = output.tolist() as number[][];
  if (vectors.length !== texts.length || vectors.some((v) => v.length !== EMBEDDING_DIM)) {
    throw new Error(`embed: expected ${texts.length} vectors of ${EMBEDDING_DIM}`);
  }
  return vectors;
}

/**
 * Loads the model so the first embed() doesn't wait for the download. Never throws: the server boots without it,
 * and embed() tries the load again. Resolves true when the model is ready.
 */
export async function warmEmbeddings(onError?: (err: unknown) => void): Promise<boolean> {
  try {
    await loadExtractor();
    return true;
  } catch (err) {
    onError?.(err);
    return false;
  }
}
