import { cva, type VariantProps } from 'class-variance-authority'
import type { Base } from './base'
const styles = cva('', { variants: { variant: { outline: '', muted: '' } } })
export interface Props extends Base, VariantProps<typeof styles> { children?: unknown; slotHeader?: unknown; slotFooter?: unknown }
export function ActualFileName(props: Props) { return null }
