import type { Metadata } from 'next'
import { HostRoom } from '@/components/host/host-room'

export const metadata: Metadata = {
  title: 'Host — duosu',
  description: 'Share your osu! screen and let a partner aim or tap for you.',
}

export default function HostPage() {
  return <HostRoom />
}
