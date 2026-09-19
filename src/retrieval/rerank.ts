export interface Chunk {
  text: string;
  source: string;
}

export interface Reranker {
  rerank(query: string, chunks: Chunk[], topN: number): Promise<Chunk[]>;
}

/**
 * v1 reranker: no real scoring, just truncates to topN in retrieval order.
 * Carter design target: bge-reranker-v2-m3 run locally against all pooled
 * chunks before truncation — see docs/WhatsNext.md.
 */
export class NoOpReranker implements Reranker {
  async rerank(_query: string, chunks: Chunk[], topN: number): Promise<Chunk[]> {
    return chunks.slice(0, topN);
  }
}
