import { config } from './config';

// An unset ADMIN_PASSWORD disables admin actions entirely rather than
// defaulting to open — see config.ts.
export function checkAdminPassword(password: string | undefined): boolean {
  return config.adminPassword.length > 0 && password === config.adminPassword;
}
