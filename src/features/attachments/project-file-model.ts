/** Keep the current draft intact and avoid reinserting paths already on their own line. */
export function appendProjectFilePaths(prompt: string, paths: string[]) {
  const existing = new Set(prompt.split(/\r?\n/).map((line) => line.trim()));
  const additions = [...new Set(paths)].filter((file) => !existing.has(file));
  if (!additions.length) return prompt;
  return (
    prompt +
    (prompt.trim() ? (prompt.endsWith('\n\n') ? '' : prompt.endsWith('\n') ? '\n' : '\n\n') : '') +
    additions.join('\n')
  );
}
