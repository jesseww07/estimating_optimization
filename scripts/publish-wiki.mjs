#!/usr/bin/env node
// Publishes the generated `openwiki/` pages to the repository's GitHub Wiki,
// so the docs are readable from the Wiki tab instead of only by browsing three
// directories deep in the repo.
//
// The wiki is a separate git repo (<repo>.wiki.git) with a FLAT page namespace,
// so nested source paths are flattened into hyphenated page names:
//
//   openwiki/engine/eval-harness.md  ->  Engine-Eval-Harness.md
//
// Page names are derived from the file PATH, not the front-matter title, on
// purpose: OpenWiki rewrites titles as the code changes, and a title-derived
// name would silently move the page (breaking every bookmark and inbound link)
// every time it did. Paths are stable.
//
// Usage: node scripts/publish-wiki.mjs <output-dir>
//   <output-dir> is a checkout of the wiki repo. Existing top-level *.md files
//   are removed first so deleted source pages don't linger as orphans.

import { readdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

const SOURCE_DIR = 'openwiki'
const REPO = process.env.GITHUB_REPOSITORY || 'jesseww07/estimating_optimization'
const BLOB = `https://github.com/${REPO}/blob/main`

// Sections are listed in reading order, not alphabetically: a newcomer wants
// the quickstart, then the shape of the app, before the engine internals.
const SECTION_ORDER = ['', 'architecture', 'engine', 'data', 'workflows', 'operations']
const SECTION_LABELS = {
  '': 'Start here',
  architecture: 'Architecture',
  engine: 'Engine',
  data: 'Data',
  workflows: 'Workflows',
  operations: 'Operations',
}

const ACRONYMS = new Map([['ci', 'CI'], ['api', 'API'], ['ve', 'VE'], ['pdf', 'PDF'], ['ui', 'UI']])
const MINOR_WORDS = new Set(['and', 'or', 'the', 'of', 'to', 'a', 'an', 'for', 'in', 'on', 'with'])

function titleCaseWord(word, isFirst) {
  const lower = word.toLowerCase()
  if (ACRONYMS.has(lower)) return ACRONYMS.get(lower)
  if (!isFirst && MINOR_WORDS.has(lower)) return lower
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

// 'engine/eval-harness.md' -> 'Engine-Eval-Harness'
function wikiPageName(relPath) {
  const words = relPath.replace(/\.md$/, '').split('/').flatMap((s) => s.split('-'))
  return words.map((w, i) => titleCaseWord(w, i === 0)).join('-')
}

function walk(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir).sort()) {
    // Skip OpenWiki's own state (.claims/, .page-manifest.json, .last-update.json).
    if (entry.startsWith('.')) continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, base))
    // index.md files are OpenWiki's auto-generated directory listings; the
    // wiki gets a generated Home page and sidebar instead.
    else if (entry.endsWith('.md') && entry !== 'index.md') out.push(path.relative(base, full))
  }
  return out
}

function splitFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { meta: {}, body: text }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    // Only the scalar keys matter here; nested `sources:`/`verified:` lists are
    // indented and correctly ignored by this anchored pattern.
    const kv = /^([a-z_]+):\s*(.+)$/.exec(line)
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return { meta, body: text.slice(match[0].length) }
}

const unresolved = []

function rewriteLinks(body, sourceRel, nameByPath) {
  return body.replace(/\]\((\S+?\.md)(#[^)\s]*)?\)/g, (whole, target, anchor) => {
    let key
    if (target.startsWith('/openwiki/')) key = target.slice('/openwiki/'.length)
    else if (target.startsWith('openwiki/')) key = target.slice('openwiki/'.length)
    else key = path.posix.normalize(path.posix.join(path.posix.dirname(sourceRel), target))
    const name = nameByPath.get(key)
    if (!name) {
      unresolved.push(`${sourceRel} -> ${target}`)
      return whole
    }
    return `](${name}${anchor || ''})`
  })
}

const outputDir = process.argv[2]
if (!outputDir) {
  console.error('usage: node scripts/publish-wiki.mjs <output-dir>')
  process.exit(1)
}

const sources = walk(SOURCE_DIR)
const nameByPath = new Map(sources.map((rel) => [rel, wikiPageName(rel)]))

// Clear stale pages so a source page that was deleted or renamed doesn't
// survive as an orphan. Only top-level *.md — never .git.
for (const entry of readdirSync(outputDir)) {
  if (entry.endsWith('.md')) rmSync(path.join(outputDir, entry))
}

const pages = []
for (const rel of sources) {
  const { meta, body } = splitFrontmatter(readFileSync(path.join(SOURCE_DIR, rel), 'utf8'))
  const name = nameByPath.get(rel)
  const footer =
    `\n\n---\n\n<sub>Generated from [\`${SOURCE_DIR}/${rel}\`](${BLOB}/${SOURCE_DIR}/${rel}) by the ` +
    `OpenWiki workflow. Edits made here are overwritten on the next run — change the source instead.</sub>\n`
  writeFileSync(path.join(outputDir, `${name}.md`), rewriteLinks(body.trim(), rel, nameByPath) + footer)
  pages.push({
    rel,
    name,
    section: rel.includes('/') ? rel.split('/')[0] : '',
    title: meta.title || name.replace(/-/g, ' '),
    description: meta.description || '',
  })
}

function bySection() {
  const sections = [...new Set(pages.map((p) => p.section))].sort((a, b) => {
    const ai = SECTION_ORDER.indexOf(a)
    const bi = SECTION_ORDER.indexOf(b)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.localeCompare(b)
  })
  return sections.map((s) => [s, pages.filter((p) => p.section === s)])
}

const home = [
  '# VE Estimator',
  '',
  "Premier Lighting's internal estimating substitution finder. These pages are generated from the",
  `code by [OpenWiki](https://github.com/langchain-ai/openwiki) and refreshed automatically — see`,
  `[\`openwiki/\`](${BLOB}/${SOURCE_DIR}) for the source markdown.`,
  '',
]
for (const [section, group] of bySection()) {
  home.push(`## ${SECTION_LABELS[section] || titleCaseWord(section, true)}`, '')
  for (const p of group) home.push(`- **[${p.title}](${p.name})**${p.description ? ` — ${p.description}` : ''}`)
  home.push('')
}
home.push(
  '---',
  '',
  '<sub>This wiki is generated. Edits made here are overwritten on the next run — change the code or',
  `the [\`openwiki/\`](${BLOB}/${SOURCE_DIR}) source instead.</sub>`,
  ''
)
writeFileSync(path.join(outputDir, 'Home.md'), home.join('\n'))

const sidebar = ['**[VE Estimator](Home)**', '']
for (const [section, group] of bySection()) {
  sidebar.push(`**${SECTION_LABELS[section] || titleCaseWord(section, true)}**`, '')
  // Subtitles after a colon are too long for the sidebar rail; the full
  // title still heads the page itself.
  for (const p of group) sidebar.push(`- [${p.title.split(':')[0]}](${p.name})`)
  sidebar.push('')
}
writeFileSync(path.join(outputDir, '_Sidebar.md'), sidebar.join('\n'))

console.log(`Published ${pages.length} pages + Home + _Sidebar to ${outputDir}`)
for (const p of pages) console.log(`  ${SOURCE_DIR}/${p.rel}  ->  ${p.name}`)
if (unresolved.length) {
  console.error(`\nUnresolved links (left as-is):`)
  for (const u of unresolved) console.error(`  ${u}`)
  process.exit(1)
}
