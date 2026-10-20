#!/usr/bin/env node
/** Offline source discovery. Ranking is a retrieval aid, not an artistic decision. */
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../assets/motion-library/case-index.json', import.meta.url));
const options = { limit: 6 };
const seenOptions = new Set();
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i], value = process.argv[i + 1];
  if (!['--query', '--category', '--recipe', '--limit'].includes(flag) || value === undefined || value.startsWith('--')) {
    throw new Error('Usage: search-motion.mjs --query "口播 流程" [--recipe flow-steps] [--category explainer] [--limit 6]');
  }
  const key = flag.slice(2);
  if (seenOptions.has(key)) throw new Error(`Duplicate option: ${flag}`);
  seenOptions.add(key);
  options[key] = value;
}
options.limit = Number(options.limit);
if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 30) throw new Error('limit must be 1..30');
if (options.category && !['motion', 'explainer', '3d', 'interactive'].includes(options.category)) throw new Error('Unknown category');
const recipes = ['title-reveal', 'photo-pan', 'flow-steps', 'comparison', 'checklist', 'metric-bars', 'quote-focus', 'lower-third'];
if (options.recipe && !recipes.includes(options.recipe)) throw new Error('Unknown recipe');
if (!options.query?.trim() && !options.category && !options.recipe) throw new Error('Provide query, category or recipe');
const catalog = JSON.parse(await fs.readFile(file, 'utf8'));
const query = (options.query ?? '').toLocaleLowerCase().trim();
const words = query.split(/[\s,，、;；]+/).filter(Boolean);
const matches = catalog.cases.flatMap((entry) => {
  if (options.category && entry.category !== options.category) return [];
  if (options.recipe && !(entry.relatedRecipes ?? []).includes(options.recipe)) return [];
  const searchable = [entry.slug, entry.author, entry.category, ...(entry.remakeTechTags ?? []), entry.studyNote ?? '', ...(entry.searchTerms ?? []), ...(entry.relatedRecipes ?? [])].join(' ').toLocaleLowerCase();
  const matchedWords = words.filter((word) => searchable.includes(word));
  // A sentence query can also contain our compact Chinese topic aliases.
  const matchedAliases = (entry.searchTerms ?? []).filter((word) => query.includes(word.toLocaleLowerCase()));
  if (words.length && !matchedWords.length && !matchedAliases.length) return [];
  const score = matchedWords.length * 3 + matchedAliases.length * 2 + (entry.studyNote ? 1 : 0);
  return [{ ...entry, retrievalScore: score, matchedTerms: [...new Set([...matchedWords, ...matchedAliases])] }];
}).sort((a, b) => b.retrievalScore - a.retrievalScore || a.slug.localeCompare(b.slug));
console.log(JSON.stringify({
  kind: catalog.kind, query: options.query ?? null, sourceCommit: catalog.commit,
  snapshotCount: catalog.count, matchedCount: matches.length,
  caveat: catalog.caveat, results: matches.slice(0, options.limit),
}, null, 2));
