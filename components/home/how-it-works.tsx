const STEPS = [
  {
    title: 'Host shares the game',
    body: 'The host shares their whole monitor (with system audio) from Chrome or Edge. Video goes directly to the partner over WebRTC — no server in the middle.',
  },
  {
    title: 'Bridge injects input',
    body: 'Browsers cannot control your mouse or keyboard, so the host runs a small bridge (one double-click on Windows, nothing to install) that turns the partner’s input into real cursor moves and key presses.',
  },
  {
    title: 'Split the controls',
    body: 'The host picks who aims and who taps. The local player uses their own mouse or keys as normal; the remote player’s half arrives over the network.',
  },
]

export function HowItWorks() {
  return (
    <section className="flex flex-col gap-6" aria-labelledby="how-heading">
      <h2 id="how-heading" className="text-2xl font-semibold tracking-tight">
        How it works
      </h2>
      <ol className="grid gap-4 md:grid-cols-3">
        {STEPS.map((step, i) => (
          <li key={step.title} className="flex flex-col gap-2 border-t border-border pt-4">
            <span className="font-mono text-sm text-primary">0{i + 1}</span>
            <h3 className="font-medium">{step.title}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">{step.body}</p>
          </li>
        ))}
      </ol>
      <p className="rounded-xl border border-border bg-card p-4 text-sm leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">Heads up on latency:</span> the remote player sees the game a
        little late and their input arrives a little late, so expect roughly one round-trip of delay on their half.
        Wired connections and nearby partners feel best. In osu!, turn off <span className="text-foreground">Raw input</span>{' '}
        so injected cursor movement is picked up.
      </p>
    </section>
  )
}
