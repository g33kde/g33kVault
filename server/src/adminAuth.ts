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
