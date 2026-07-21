/**
 * Deterministic entity resolution for the knowledge graph.
 *
 * The old `inferEntities` (file-extension regex + backtick spans) produced a broken graph:
 *  - PHANTOM nodes: the space in a path like ".../Project_x 2/peon-mcp/src/daemon.ts" let the
 *    regex start mid-path, yielding "2/peon-mcp/src/daemon.ts".
 *  - ALIAS FRAGMENTATION: one file appeared under up to 7 surface forms (daemon.ts,
 *    src/daemon.ts, peon-mcp/src/daemon.ts, /Users/.../daemon.ts, worktree paths, ...),
 *    each a distinct node — so spreading activation never connected them.
 *
 * This module canonicalizes a raw entity string to a stable key + classifies it into a
 * NAMESPACE (code vs domain) so retrieval can keep file/symbol co-occurrence from drowning
 * domain concepts. Fully deterministic — no model, no network.
 */
export type EntityNamespace = "code" | "domain";
export type EntityKind = "file" | "symbol" | "concept";
export interface CanonicalEntity {
    /** Stable dedup key (canonical form). */
    key: string;
    /** Display name (canonical form, original-ish casing). */
    name: string;
    kind: EntityKind;
    namespace: EntityNamespace;
}
/** Canonicalize one raw entity string. Returns null for junk (empty, too long, pure noise). */
export declare function canonicalizeEntity(raw: string): CanonicalEntity | null;
/**
 * Extract DOMAIN entities from prose: products/acronyms with internal capitals or digits
 * (MaskSQL, NL2SQL, BIRD, DTS-SQL, GPT-5) and short proper-noun sequences (Shantanu Sharma).
 * Conservative — single sentence-initial Capitalized words are NOT entities (avoids noise) —
 * so the 83% of beliefs that are prose finally get graph-linkable concepts.
 */
export declare function extractDomainEntities(content: string): CanonicalEntity[];
/**
 * Resolve the entities mentioned in a piece of content (file paths + backtick spans + domain
 * proper nouns/products), deduped to canonical entities. Replaces the old regex-only `inferEntities`.
 */
export declare function resolveEntities(content: string, extra?: readonly string[]): CanonicalEntity[];
/** Back-compat: canonical entity KEYS for the string[] `entities` field on records. */
export declare function inferCanonicalEntities(content: string, extra?: readonly string[]): string[];
export interface RegistryEntity {
    key: string;
    name: string;
    kind: EntityKind;
    namespace: EntityNamespace;
    /** Surface forms that fold into this canonical entity. */
    aliases: string[];
    /** Mention count across the brain (graph salience / hub indicator). */
    salience: number;
}
/**
 * Build the canonical entity registry from every entity occurrence across all records.
 * Performs cross-form ALIAS MERGE: a bare basename ("daemon.ts") folds into the unique
 * path key that shares it ("src/daemon.ts") — finishing the de-fragmentation 1a starts.
 * Ambiguous basenames (two distinct paths share it) are left alone. Returns the registry
 * plus a `canonical(rawKey) -> finalKey` map for rewriting record entities and graph nodes.
 */
export declare function buildEntityRegistry(entityKeys: readonly string[]): {
    entities: RegistryEntity[];
    canonical: Map<string, string>;
};
