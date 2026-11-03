import { scanTree } from '../shared/file-application/target.js';
import { object, string } from '../../shared/json.js';

export async function validateSkills(directory: string): Promise<void> {
  const files = await scanTree(directory);
  for (const [path, file] of Object.entries(files)) {
    if (!path.includes('/skills/') || !path.endsWith('/SKILL.md')) continue;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.from(file.content, 'base64'),
    );
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match) throw new Error(`Skill frontmatter is missing: ${path}`);
    const { parseDocument } = await import('yaml');
    const document = parseDocument(match[1], { uniqueKeys: true });
    if (document.errors.length)
      throw new Error(`Skill frontmatter is invalid: ${path}`);
    const frontmatter = object(document.toJS({ maxAliasCount: 0 }), path);
    string(frontmatter.name, `${path}.name`);
    string(frontmatter.description, `${path}.description`);
    if (!text.slice(match[0].length).trim())
      throw new Error(`Skill body is empty: ${path}`);
  }
}
