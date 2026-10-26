import { EditorBoot } from '@/components/editor/EditorBoot'
import { pageMetadata } from '@/lib/seo'

export const metadata = pageMetadata({
  title: 'Editor',
  path: '/editor',
  robots: { index: false, follow: true },
})

export default function EditorPage() {
  return <EditorBoot />
}
