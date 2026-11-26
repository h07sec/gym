import { Hono } from 'hono';
import { verifyIdToken } from './auth';

type Bindings = {
  PROJECT_ID: string;
  RESEND_API_KEY: string;
  EMAIL_FROM: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Health
app.get('/api/health', (c) => c.json({ status: 'ok' }));

// Auth Middleware
app.use('/api/*', async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  try {
    const user = await verifyIdToken(authHeader.split(' ')[1], c.env.PROJECT_ID);
    if (!user.email_verified) throw new Error('Email not verified');
    c.set('user', user);
    await next();
  } catch (e) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
});

// Admin Bootstrap Placeholder
app.post('/api/admin/bootstrap', async (c) => {
  return c.json({ ok: true, msg: 'Bootstrap migrated to Worker' });
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    console.log('Cron trigger executed');
  }
};
