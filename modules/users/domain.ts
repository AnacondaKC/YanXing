export type UserRole = 'admin' | 'researcher'
export type UserStatus = 'active' | 'disabled'

export interface SessionUser {
  id: string
  username: string
  displayName: string
  role: UserRole
  avatar?: string
}

export interface ManagedUser extends SessionUser {
  status: UserStatus
  createdAt: string
  updatedAt: string
  lastLoginAt?: string
}
