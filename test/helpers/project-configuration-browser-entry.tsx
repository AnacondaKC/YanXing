import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import WorkspaceApp from '../../components/workspace-app'

const container = document.createElement('div')
document.body.append(container)
createRoot(container).render(createElement(WorkspaceApp))
