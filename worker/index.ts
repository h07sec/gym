import { Hono } from 'hono';

const app = new Hono();

app.get('/api/health', (c) => {
  return c.json({ status: 'ok', service: 'GymOS Worker' });
});

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
  async scheduled(event: ScheduledEvent, env: any, ctx: ExecutionContext) {
    // Cron trigger placeholder
    console.log('Cron trigger executed');
  }
};
