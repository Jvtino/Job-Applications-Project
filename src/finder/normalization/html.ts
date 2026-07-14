/**
 * Minimal HTML → text for job descriptions (v0). Full sanitize-html pipeline
 * lands in M6; connectors like Greenhouse return HTML (sometimes
 * entity-escaped) and the skeleton needs a readable description_clean.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  hellip: '…',
};

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

const BLOCK_TAGS = /<\/(p|div|li|ul|ol|h[1-6]|tr|table|br)\s*>|<(br|hr)\s*\/?>/gi;

export function htmlToText(html: string): string {
  // Greenhouse double-escapes content ("&lt;p&gt;…&amp;amp;…") — decode until
  // no entities remain (bounded; each pass strictly shrinks entity count).
  let source = html;
  for (let i = 0; i < 3 && /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/.test(source); i++) {
    source = decodeHtmlEntities(source);
  }
  return source
    .replace(BLOCK_TAGS, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
