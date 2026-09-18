import { config } from './config';

// An unset ADMIN_PASSWORD disables admin actions entirely rather than
// defaulting to open — see config.ts.
export function checkAdminPassword(password: string | undefined): boolean {
  return config.adminPassword.length > 0 && password === config.adminPassword;
}

// Deliberately separate from checkAdminPassword — a valid admin password
// never satisfies this, and vice versa. See config.ts's trashPassword.
export function checkTrashPassword(password: string | undefined): boolean {
  return config.trashPassword.length > 0 && password === config.trashPassword;
}

// Same independence as checkTrashPassword, gating GET /backup specifically.
// See config.ts's backupPassword.
export function checkBackupPassword(password: string | undefined): boolean {
  return config.backupPassword.length > 0 && password === config.backupPassword;
}
