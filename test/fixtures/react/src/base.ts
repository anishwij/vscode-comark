export interface Base {
  /** The card heading. */
  title: string
  shared?: string
  className?: string
  titleText?: 'short' | 'long'
  'title-text'?: 'hyphen'
  defaultOpen?: boolean
}
