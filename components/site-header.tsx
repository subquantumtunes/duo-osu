import Link from 'next/link'

export function SiteHeader({ children }: { children?: React.ReactNode }) {
  return (
    <header className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 md:px-6">
      <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
        <span
          aria-hidden="true"
          className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground"
        >
          2P
        </span>
        <span>
          osu! <span className="text-primary">co-op</span>
        </span>
      </Link>
      {children}
    </header>
  )
}
