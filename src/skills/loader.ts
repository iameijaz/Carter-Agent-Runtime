import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export interface Skill {
  name: string;
  description: string;
  triggers: string[];
  body: string;
}

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: "", body: raw };
  return { frontmatter: match[1], body: match[2].trim() };
}

export async function loadSkills(skillsDir: string): Promise<Skill[]> {
  let entries: string[];
  try {
    entries = await readdir(skillsDir, { withFileTypes: true }).then((dirents) =>
      dirents.filter((d) => d.isDirectory()).map((d) => d.name)
    );
  } catch {
    return [];
  }

  const skills: Skill[] = [];
  for (const dir of entries) {
    const skillPath = path.join(skillsDir, dir, "SKILL.md");
    let raw: string;
    try {
      raw = await readFile(skillPath, "utf-8");
    } catch {
      continue;
    }
    const { frontmatter, body } = splitFrontmatter(raw);
    let meta: Record<string, unknown> = {};
    try {
      meta = frontmatter ? parseYaml(frontmatter) : {};
    } catch (err) {
      console.warn(`[skills] bad frontmatter in ${skillPath}:`, (err as Error).message);
    }
    const name = (meta.name as string) ?? dir;
    const description = (meta.description as string) ?? "";
    const triggers = Array.isArray(meta.triggers)
      ? (meta.triggers as string[])
      : description.toLowerCase().split(/\W+/).filter(Boolean);

    skills.push({ name, description, triggers, body });
  }
  return skills;
}

export function matchSkills(skills: Skill[], userMessage: string): Skill[] {
  const lower = userMessage.toLowerCase();
  return skills.filter((skill) => skill.triggers.some((t) => t && lower.includes(t.toLowerCase())));
}
