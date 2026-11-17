'use client'

import { useState } from 'react'
import { RefreshCw, VideoOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { detectBrowser, isOpera } from '@/lib/browser'
import type { VideoIssue as Issue } from '@/lib/protocol'

function tipsFor(issue: Exclude<Issue, 'connecting'>, opera: boolean) {
  if (issue === 'host-capture') {
    return {
      title: 'The host’s screen capture is blank',
      tips: [
        'Host: set osu! to Borderless in its settings. Exclusive Fullscreen often captures as black.',
        'Host: don’t minimize osu!, and share the monitor it’s actually on.',
        'Host: if it still fails, stop sharing and start again.',
      ],
    }
  }
  if (issue === 'decode') {
    return {
      title: 'Video arrives but can’t be shown',
      tips: [
        opera
          ? 'In Opera, open Settings, search for “hardware acceleration”, turn it on and restart Opera.'
          : 'Turn on hardware acceleration in your browser settings and restart the browser.',
        'Update your browser and graphics driver.',
      ],
    }
  }
  return {
    title: 'The video can’t get through',
    tips: [
      ...(opera
        ? [
            'Turn off Opera’s VPN (the VPN badge in the address bar) on both PCs.',
            'In Opera, open Settings, search for “WebRTC”, choose “Default public and private interfaces”, and reload.',
          ]
        : []),
      'Turn off any VPN or proxy on both PCs.',
      'Some school, work or hotel networks block video calls. Try another network or a phone hotspot.',
    ],
  }
}

export function VideoIssueOverlay({ issue, onRetry }: { issue: Exclude<Issue, 'connecting'>; onRetry: () => void }) {
  const [opera] = useState(() => isOpera(detectBrowser()))
  const { title, tips } = tipsFor(issue, opera)
  return (
    <div
      role="alert"
      className="relative flex max-w-md flex-col gap-3 rounded-xl border border-border bg-card/95 p-5 text-left"
    >
      <div className="flex items-center gap-2">
        <VideoOff className="size-5 text-destructive" aria-hidden="true" />
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      <ul className="flex list-disc flex-col gap-1 pl-4 text-xs leading-relaxed text-muted-foreground">
        {tips.map((tip) => (
          <li key={tip}>{tip}</li>
        ))}
      </ul>
      <Button size="sm" variant="secondary" className="w-fit" onClick={onRetry}>
        <RefreshCw aria-hidden="true" />
        Retry video
      </Button>
    </div>
  )
}
