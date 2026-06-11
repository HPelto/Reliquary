import { Fragment } from 'react'

/** Minimal **bold** renderer for mock content — TipTap replaces this later. */
export function Md({ text }: { text: string }): React.JSX.Element {
  const parts = text.split(/\*\*(.+?)\*\*/g)
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <strong key={i} className="font-semibold text-hi">
            {part}
          </strong>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        )
      )}
    </>
  )
}
