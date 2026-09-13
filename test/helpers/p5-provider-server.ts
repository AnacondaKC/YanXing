import { createServer, type Server } from 'node:http'

export interface P5ProviderServer {
  baseUrl: string
  requestCount: () => number
  waitForFirstRequest: () => Promise<void>
  close: () => Promise<void>
}

export function startP5HangProvider(): Promise<P5ProviderServer> {
  let requestCount = 0
  let firstRequest = Promise.withResolvers<void>()
  const server: Server = createServer((request, response) => {
    requestCount += 1
    firstRequest.resolve()
    request.resume()
    void response
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('controlled provider did not bind a TCP port'))
        return
      }
      resolve({
        baseUrl: 'http://127.0.0.1:' + address.port,
        requestCount: () => requestCount,
        waitForFirstRequest: () => firstRequest.promise,
        close: () => new Promise((closeResolve, closeReject) => {
          server.close((error) => error ? closeReject(error) : closeResolve())
        }),
      })
    })
  })
}
