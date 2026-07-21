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

// Source-root tokens: a path is canonicalized to the suffix starting at the first of these,
// so "/Users/.../peon-mcp/src/daemon.ts", "peon-mcp/src/daemon.ts" and "src/daemon.ts" all
// collapse to "src/daemon.ts".
const SRC_ROOTS = new Set(["src", "lib", "scripts", "test", "tests", "app", "apps", "packages", "dist", "bin"]);
const FILE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|html|css|scss|py|ipynb|pdf|txt|yml|yaml|toml|sh|sql|rs|go|java|rb|c|cpp|h)$/i;
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*(?:[.#][A-Za-z_$][\w$]*)*$/;

/** Canonicalize one raw entity string. Returns null for junk (empty, too long, pure noise). */
export function canonicalizeEntity(raw: string): CanonicalEntity | null {
  const s = (raw ?? "").trim().replace(/^[`'"]+|[`'"]+$/g, "").trim();
  if (s.length < 2 || s.length > 200) return null;

  const pathLike = s.includes("/") || s.includes("\\") || FILE_EXT_RE.test(s);
  if (pathLike) {
    // Normalize separators, drop a leading "./" and a leading truncation marker ("..."/"…src/…").
    // NOTE: we deliberately do NOT blind-strip a leading numeric segment — the SRC_ROOT slice and
    // parent/basename fallback below already collapse the "2/" phantom from "Project_x 2" WITHOUT
    // eating real numeric directories like "2024/notes.md".
    const p = s.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^(?:\.{3}|…)\/?/, "");
    const segs = p.split("/").filter((seg) => seg && seg !== "." && seg !== "..");
    if (segs.length === 0) return null;
    const rootIdx = segs.findIndex((seg) => SRC_ROOTS.has(seg));
    // With a known source root, key from there (so all prefixes of src/daemon.ts collapse).
    // Without one, keep parent/basename — NOT bare basename — so two different DESIGN.md /
    // SKILL.md in different dirs stay DISTINCT entities (avoid merging unrelated files).
    const key = rootIdx >= 0
      ? segs.slice(rootIdx).join("/")
      : segs.length >= 2 ? segs.slice(-2).join("/") : segs[segs.length - 1];
    if (!key) return null;
    return { key, name: key, kind: "file", namespace: "code" };
  }

  if (IDENTIFIER_RE.test(s)) {
    // A product/acronym (starts-uppercase or all-caps, with internal caps or a digit — MaskSQL,
    // BIRD, NL2SQL) is a DOMAIN concept, keyed lowercase so the backtick `MaskSQL` and the prose
    // "MaskSQL" (via extractDomainEntities) collapse to ONE node. A lowercase-initial camelCase
    // identifier (rankMemoryRecords) is a code symbol.
    const internalCaps = /[A-Z]{2,}/.test(s) || /[a-z][A-Z]/.test(s) || /\d/.test(s);
    const productLike = internalCaps && (/^[A-Z]/.test(s) || s === s.toUpperCase());
    if (productLike) return { key: s.toLowerCase(), name: s, kind: "concept", namespace: "domain" };
    if (/[A-Z_]/.test(s.slice(1))) return { key: s, name: s, kind: "symbol", namespace: "code" };
    // lowercase single token (e.g. "vllm", "ollama") — treat as a domain concept
    return { key: s.toLowerCase(), name: s, kind: "concept", namespace: "domain" };
  }

  // Multi-word phrase / proper noun → domain concept.
  return { key: s.toLowerCase(), name: s, kind: "concept", namespace: "domain" };
}

// Common capitalized words that START sentences / clauses — not domain entities.
const PROPER_NOUN_STOP = new Set([
  "the", "this", "that", "these", "those", "a", "an", "it", "we", "i", "you", "he", "she", "they",
  "if", "when", "then", "for", "and", "but", "or", "so", "to", "in", "on", "of", "at", "by", "as",
  "use", "used", "using", "add", "added", "fix", "fixed", "make", "made", "set", "run", "build",
  "now", "also", "after", "before", "while", "since", "because", "however", "note", "todo",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"
]);
// Acronyms/keywords that are too generic to be useful domain entities.
const ACRONYM_STOP = new Set(["OK", "ID", "TODO", "FIXME", "JSON", "HTTP", "HTTPS", "URL", "API", "CLI", "UI", "MD", "PDF", "CSV", "YAML", "AM", "PM", "EST", "IST", "UTC"]);

/**
 * Extract DOMAIN entities from prose: products/acronyms with internal capitals or digits
 * (MaskSQL, NL2SQL, BIRD, DTS-SQL, GPT-5) and short proper-noun sequences (Shantanu Sharma).
 * Conservative — single sentence-initial Capitalized words are NOT entities (avoids noise) —
 * so the 83% of beliefs that are prose finally get graph-linkable concepts.
 */
export function extractDomainEntities(content: string): CanonicalEntity[] {
  const out: CanonicalEntity[] = [];
  const add = (name: string) => {
    const key = name.toLowerCase();
    out.push({ key, name, kind: "concept", namespace: "domain" });
  };
  // products/acronyms: a token with an internal run of ≥2 capitals or a digit (MaskSQL, BIRD, NL2SQL, GPT-5, DTS-SQL)
  for (const m of content.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*\b/g)) {
    const tok = m[0];
    if (tok.length < 3 || tok.length > 40) continue;
    if (ACRONYM_STOP.has(tok.toUpperCase())) continue;
    const hasInternalCaps = /[A-Z]{2,}/.test(tok) || /[a-z][A-Z]/.test(tok) || /[A-Za-z]\d|\d[A-Za-z]/.test(tok);
    if (hasInternalCaps) add(tok);
  }
  // proper-noun sequences: 2-3 Capitalized words (Shantanu Sharma, Master Project)
  for (const m of content.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g)) {
    const phrase = m[1];
    if (PROPER_NOUN_STOP.has(phrase.split(/\s+/)[0].toLowerCase())) continue; // drop "The Death ...", "When Foo ..."
    add(phrase);
  }
  return out;
}

/**
 * Resolve the entities mentioned in a piece of content (file paths + backtick spans + domain
 * proper nouns/products), deduped to canonical entities. Replaces the old regex-only `inferEntities`.
 */
export function resolveEntities(content: string, extra: readonly string[] = []): CanonicalEntity[] {
  const raw: string[] = [...extra];
  // file-like spans (anchored on a real extension so we don't grab prose)
  for (const m of content.matchAll(/[\w./\\-]*\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|html|css|scss|py|ipynb|pdf|txt|yml|yaml|toml|sh|sql)\b/gi)) {
    raw.push(m[0]);
  }
  // backtick-quoted spans
  for (const m of content.matchAll(/`([^`]+)`/g)) raw.push(m[1]);

  const byKey = new Map<string, CanonicalEntity>();
  for (const r of raw) {
    const c = canonicalizeEntity(r);
    if (c && !byKey.has(c.key)) byKey.set(c.key, c);
  }
  // domain entities from prose (the bulk of beliefs that have no files/backticks) — already
  // classified domain, added after so file/symbol classification of any overlap wins.
  for (const c of extractDomainEntities(content)) {
    if (!byKey.has(c.key)) byKey.set(c.key, c);
  }
  // Separate quotas so a long file list can't crowd domain concepts out of the cap entirely
  // (domain entities are the associative-recall signal; they were appended last and got sliced).
  const all = [...byKey.values()];
  const code = all.filter((c) => c.namespace === "code").slice(0, 10);
  const domain = all.filter((c) => c.namespace === "domain").slice(0, 8);
  return [...code, ...domain];
}

/** Back-compat: canonical entity KEYS for the string[] `entities` field on records. */
export function inferCanonicalEntities(content: string, extra: readonly string[] = []): string[] {
  return resolveEntities(content, extra).map((e) => e.key);
}

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
export function buildEntityRegistry(entityKeys: readonly string[]): { entities: RegistryEntity[]; canonical: Map<string, string> } {
  const canonOf = new Map<string, CanonicalEntity>(); // rawKey -> its CanonicalEntity
  for (const raw of entityKeys) {
    if (canonOf.has(raw)) continue;
    const c = canonicalizeEntity(raw);
    if (c) canonOf.set(raw, c);
  }
  // basename -> set of distinct path keys that end in it
  const basenameToPaths = new Map<string, Set<string>>();
  for (const c of canonOf.values()) {
    if (!c.key.includes("/")) continue;
    const base = c.key.split("/").pop()!;
    (basenameToPaths.get(base) ?? basenameToPaths.set(base, new Set()).get(base)!).add(c.key);
  }
  const aliasTarget = (c: CanonicalEntity): string => {
    if (c.kind === "file" && !c.key.includes("/")) {
      const matches = basenameToPaths.get(c.key);
      if (matches && matches.size === 1) return [...matches][0]; // unique → fold in
    }
    return c.key;
  };

  const canonical = new Map<string, string>();
  for (const [raw, c] of canonOf) canonical.set(raw, aliasTarget(c));

  const merged = new Map<string, RegistryEntity>();
  for (const raw of entityKeys) {
    const c = canonOf.get(raw);
    if (!c) continue;
    const finalKey = canonical.get(raw)!;
    const entry = merged.get(finalKey) ?? { key: finalKey, name: finalKey, kind: c.kind, namespace: c.namespace, aliases: [], salience: 0 };
    entry.salience += 1; // one mention occurrence
    for (const form of [raw, c.key]) if (form !== finalKey && !entry.aliases.includes(form)) entry.aliases.push(form);
    merged.set(finalKey, entry);
  }
  return { entities: [...merged.values()].sort((a, b) => b.salience - a.salience), canonical };
}
