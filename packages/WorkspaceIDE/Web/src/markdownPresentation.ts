// Tailwind Typography owns semantic Markdown presentation in both webview documents. Keep the
// shared prose contract here so full documents and notebook fragments cannot drift apart.
const prose = [
  'prose',
  'prose-neutral',
  'dark:prose-invert',
  '[font-size:calc(var(--markdown-font-size)*1.125)]',
  'prose-h1:text-[1.75em]',
].join(' ')

export const markdownDocumentClassName = [
  prose,
  'h-full',
  'overflow-auto',
  'max-w-[860px]',
  'mx-auto',
  'px-7',
  'pt-6',
  'pb-16',
].join(' ')

export const markdownFragmentClassName = [
  prose,
  'max-w-none',
  'm-0',
  'px-1.5',
  'py-1',
].join(' ')
