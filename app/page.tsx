import Link from 'next/link'
import { Crosshair, Download, Keyboard, MonitorUp } from 'lucide-react'
import { SiteHeader } from '@/components/site-header'
import { JoinForm } from '@/components/home/join-form'
import { HowItWorks } from '@/components/home/how-it-works'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export default function Page() {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-14 px-4 py-12 md:px-6 md:py-20">
        <section className="flex flex-col gap-5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Crosshair className="size-4 text-accent" aria-hidden="true" />
            <span>one aims</span>
            <span aria-hidden="true">·</span>
            <Keyboard className="size-4 text-primary" aria-hidden="true" />
            <span>one taps</span>
          </div>
          <h1 className="max-w-3xl text-balance text-4xl font-semibold tracking-tight md:text-6xl">
            Split one osu! map between two players, anywhere.
          </h1>
          <p className="max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground">
            The host streams their game straight to a friend over a peer-to-peer connection. Your friend either moves the
            cursor or hits the keys, and their input lands in your game in real time.
          </p>
        </section>

        <section className="grid gap-4 md:grid-cols-2" aria-label="Start playing">
          <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-6">
            <MonitorUp className="size-6 text-primary" aria-hidden="true" />
            <div className="flex flex-col gap-1.5">
              <h2 className="text-xl font-semibold">Host a session</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                You run osu! on your PC. Install duosu, start{' '}
                <a
                  href="https://github.com/tosuapp/tosu/releases/latest"
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground underline underline-offset-2"
                >
                  tosu
                </a>
                , and send the room code duosu gives you to your partner.
              </p>
            </div>
            <div className="mt-auto flex flex-col gap-2">
              <a href="/download" className={cn(buttonVariants({ size: 'lg' }), 'w-fit px-4')}>
                <Download aria-hidden="true" />
                Download duosu for Windows
              </a>
              <p className="text-xs text-muted-foreground">
                {'Windows 10 or 11. If SmartScreen appears, click More info, then Run anyway. '}
                <Link href="/host" className="underline underline-offset-2 hover:text-foreground">
                  Host from the browser instead
                </Link>
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-6">
            <Crosshair className="size-6 text-accent" aria-hidden="true" />
            <div className="flex flex-col gap-1.5">
              <h2 className="text-xl font-semibold">Join a partner</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                No install needed. Enter the code from the host, watch their game, and play your half of the map.
              </p>
            </div>
            <JoinForm />
          </div>
        </section>

        <HowItWorks />
      </main>
    </div>
  )
}
