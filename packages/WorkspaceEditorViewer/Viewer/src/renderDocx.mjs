import { renderAsync as renderDocxDocument } from 'docx-preview'
import { DocxViewport } from './docxViewport.mjs'

export const responsiveDocxOptions = Object.freeze({
  breakPages: true,
  ignoreHeight: false,
  ignoreWidth: false,
  renderAltChunks: false,
  renderChanges: false,
  renderComments: false,
  useBase64URL: false,
})

export async function renderDocx(container, resourceURL, {
  fetchResource = globalThis.fetch,
  renderDocument = renderDocxDocument,
  createViewport = (scroller, host, options) => new DocxViewport(scroller, host, options),
  initialZoom = 1,
  signal,
} = {}) {
  if (!resourceURL) throw new Error('DOCX content URL is missing')

  const scroller = document.createElement('div')
  scroller.className = 'docx-scroll'
  const documentHost = document.createElement('div')
  documentHost.className = 'docx-document'
  scroller.appendChild(documentHost)
  container.replaceChildren(scroller)

  const response = await fetchResource(resourceURL, { signal })
  if (!response.ok) throw new Error(`DOCX content request failed (${response.status})`)
  const bytes = await response.arrayBuffer()
  await renderDocument(bytes, documentHost, undefined, responsiveDocxOptions)
  return createViewport(scroller, documentHost, { initialZoom })
}
