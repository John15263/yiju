// The prompts, by file name without .txt. The local server reads them from prompts/ the first time each is
// needed; the browser extension hands over a bundled copy with usePrompts before anything runs.
const PROMPTS = new Map();

export function usePrompts(texts) {
  for (const [name, value] of Object.entries(texts)) PROMPTS.set(name, value);
}

export function prompt(name) {
  if (!PROMPTS.has(name)) {
    // Asked for at run time rather than imported, so this module also loads where there is no Node.
    const fs = globalThis.process?.getBuiltinModule?.('node:fs');
    if (fs) PROMPTS.set(name, fs.readFileSync(new URL(`../prompts/${name}.txt`, import.meta.url), 'utf8'));
  }
  const value = PROMPTS.get(name);
  if (value === undefined) throw new Error(`Missing prompt: ${name}`);
  return value;
}
