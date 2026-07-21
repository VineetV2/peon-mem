import { type EmbeddingClient, type EmbeddingVector } from "./embeddings.js";
import type { MemoryRecord } from "./types.js";
/**
 * Sidecar vector store for memory embeddings.
 *
 * Vectors live in `<memoryDir>/brain/embeddings.jsonl`, keyed by record id, kept
 * OUT of memories.jsonl so the structured brain stays human-readable. Each entry
 * carries the content hash + model it was computed from, so a vector is only
 * recomputed when the record's content changes or the embedding model changes.
 */
export interface StoredEmbedding {
    id: string;
    model: string;
    hash: string;
    vector: EmbeddingVector;
}
export interface SyncResult {
    vectorById: Map<string, EmbeddingVector>;
    computed: number;
    reused: number;
    pruned: number;
}
export declare class EmbeddingStore {
    private readonly filePath;
    private cache?;
    private constructor();
    static open(memoryDir: string): Promise<EmbeddingStore>;
    load(): Promise<Map<string, StoredEmbedding>>;
    /**
     * Ensure every record has a current embedding. Recomputes only what changed,
     * prunes vectors for deleted records, persists the result, and returns the
     * id → vector map ready for hybrid ranking. Embedding failures degrade to an
     * empty map rather than throwing (retrieval falls back to lexical-only).
     */
    sync(records: MemoryRecord[], client: EmbeddingClient | null): Promise<SyncResult>;
    /** Read vectors without recomputing — used by read-only retrieval paths. */
    vectorById(): Promise<Map<string, EmbeddingVector>>;
    private persist;
}
/** Serialize a vector as base64 of its float32 bytes — ~4x smaller + faster to parse than JSON float64. */
export declare function encodeVector(vector: EmbeddingVector): string;
/** Decode a base64 float32 vector back to number[]; null on malformed/misaligned input. */
export declare function decodeVector(b64: string): number[] | null;
