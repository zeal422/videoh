import type { MetadataRoute } from 'next'

import { INDEXABLE_ROUTES, canonicalUrl } from '@/lib/seo'

export default function sitemap(): MetadataRoute.Sitemap {
  return INDEXABLE_ROUTES.map((route) => ({
    url: canonicalUrl(route.path),
    lastModified: route.lastModified,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }))
}
