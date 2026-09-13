export class ReportAuthorizationChangedError extends Error {
  constructor() {
    super('项目权限已变更，请刷新后重试。')
    this.name = 'ReportAuthorizationChangedError'
  }
}
