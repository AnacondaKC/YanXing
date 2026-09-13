import { pathToFileURL } from 'node:url'

export const RELOCATION_USAGE='storage:relocate 已关闭。原生提交使用不可变文件身份与绑定的私有存储目录，不支持旧版绝对路径改写。请使用全新独立目录初始化；已有原生目录的离线搬迁需要单独审核，不会自动迁移或覆盖任何数据。'

export function runRelocateStorageCli(argv:string[],io:{log:(message:string)=>void;error:(message:string)=>void}=console) {
  if(argv.length===1&&argv[0]==='--help'){io.log(RELOCATION_USAGE);return 0}
  io.error(RELOCATION_USAGE)
  return 1
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url) {
  process.exitCode=runRelocateStorageCli(process.argv.slice(2))
}
