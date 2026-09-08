function encodeContentDispositionFilename(fileName: string) {
  return encodeURIComponent(fileName).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

export function contentDispositionHeader(fileName: string, download = false) {
  return `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeContentDispositionFilename(fileName)}`
}
