import {join} from 'node:path'
import {writeFile} from 'node:fs/promises'
import {createOrUpdateUser} from '../../lib/auth/session'
import {createPreviewableDocxBuffer} from '../../scripts/deployment-fixtures.mjs'
const root=process.env.P4_BROWSER_ROOT!
createOrUpdateUser({username:'browser-admin',displayName:'浏览器验收管理员',password:'browser-test-password',role:'admin'})
await writeFile(join(root,'研究报告.docx'),createPreviewableDocxBuffer('研究报告。研究目标是建立可验证的研究证据。通过访谈与数据分析提出可执行的建议，并评估预算、风险和时间安排。'))
