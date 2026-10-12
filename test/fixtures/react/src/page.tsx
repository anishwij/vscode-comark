import { MarkdownDocument as Renderer } from '@comark/react'
import { ActualFileName as Card } from '@/card'
const components = { Card } as const
export const page = <Renderer components={components} />
