import { Router } from 'express';
import { checkAdminPassword } from '../adminAuth';

export const adminRouter = Router();

adminRouter.post('/verify', (req, res) => {
  const password = req.header('x-admin-password');
  if (checkAdminPassword(password)) {
    res.status(204).end();
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});
