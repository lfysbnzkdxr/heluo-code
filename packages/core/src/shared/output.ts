export function truncateLines(lines: string[], head: number, tail: number): string[] {
  if (head + tail <= 0) return lines
  if (lines.length <= head + tail) return lines
  const keptHead = lines.slice(0, head)
  const keptTail = lines.slice(lines.length - tail)
  return [...keptHead, `...[truncated ${lines.length - head - tail} lines]...`, ...keptTail]
}
