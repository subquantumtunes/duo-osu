export function Panel({ step, title, children }: { step: number; title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <span className="flex size-5 items-center justify-center rounded-full bg-secondary font-mono text-[11px] text-primary">
          {step}
        </span>
        {title}
      </h2>
      {children}
    </section>
  )
}
