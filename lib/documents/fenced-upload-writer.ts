import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

export type UploadMutationFence = <T>(write:()=>T)=>T
const WRITE_CHUNK_BYTES = 64 * 1024

/** No open writable descriptor survives an await, so reclamation cannot free quota beneath a paused writer. */
export function openFencedUpload(path:string, fence:UploadMutationFence) {
  fence(()=>{
    if(lstatSync(dirname(path)).isSymbolicLink()) throw new Error('Upload temporary directory is a symbolic link.')
    const descriptor=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600)
    closeSync(descriptor)
  })
  return {
    async write(buffer:Buffer) {
      return fence(()=>{
        const descriptor=openSync(path,constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW)
        try {return {bytesWritten:writeSync(descriptor,buffer,0,Math.min(buffer.length,WRITE_CHUNK_BYTES))}}
        finally {closeSync(descriptor)}
      })
    },
    async sync(){fence(()=>syncPath(path))},
    async close(){},
  }
}

export function createFencedUploadDirectory(path:string,fence:UploadMutationFence) {fence(()=>mkdirSync(path))}
export function finalizeFencedUpload(input:{temporaryPath:string;finalPath:string;fence:UploadMutationFence}) {
  input.fence(()=>{
    renameSync(input.temporaryPath,input.finalPath)
    syncPath(input.finalPath)
    syncPath(dirname(input.finalPath))
    syncPath(dirname(dirname(input.finalPath)))
  })
}
function syncPath(path:string) {
  const descriptor=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW)
  try {fsyncSync(descriptor)} finally {closeSync(descriptor)}
}
