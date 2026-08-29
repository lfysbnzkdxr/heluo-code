import type { JSX } from 'react'
import type { FileDiff } from '@heluo-code/core'

type DiffLineKind = 'ctx' | 'add' | 'del'

interface DiffLine {
  kind: DiffLineKind
  text: string
}

// 分行并丢弃尾随换行产生的末尾空元素（中间空行是真实内容，保留）
function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

// 行级 diff（v1 简化）：前缀/后缀相同行 → 中间区域贪婪逐行匹配。
// 纯文本渲染，满足 CSP；无第三方依赖。
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before)
  const b = splitLines(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const lines: DiffLine[] = []
  for (let i = 0; i < start; i++) lines.push({ kind: 'ctx', text: a[i]! })
  const middleA = a.slice(start, endA)
  const middleB = b.slice(start, endB)
  let bi = 0
  for (const la of middleA) {
    const idx = middleB.indexOf(la, bi)
    if (idx >= 0) {
      while (bi < idx) {
        lines.push({ kind: 'add', text: middleB[bi]! })
        bi++
      }
      lines.push({ kind: 'ctx', text: la })
      bi++
    } else {
      lines.push({ kind: 'del', text: la })
    }
  }
  while (bi < middleB.length) {
    lines.push({ kind: 'add', text: middleB[bi]! })
    bi++
  }
  for (let i = endA; i < a.length; i++) lines.push({ kind: 'ctx', text: a[i]! })
  return lines
}

export default function DiffView({ diff }: { diff: FileDiff }): JSX.Element {
  const lines = diffLines(diff.before, diff.after)
  return (
    <div className="diff-view" data-testid="diff-view">
      <div className="diff-path">{diff.path}</div>
      <pre className="diff-content">
        {lines.map((l, i) => (
          <div key={i} className={`diff-line diff-${l.kind}`}>
            {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '} {l.text}
          </div>
        ))}
      </pre>
    </div>
  )
}