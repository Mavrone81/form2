import { randomBytes } from 'node:crypto';

const MIN_SECRET = 32;

export function resolveConfig(env = process.env) {
  const secret = env.SESSION_SECRET ?? '';
  if (secret && secret.length < MIN_SECRET)
    throw new Error(`SESSION_SECRET must be at least ${MIN_SECRET} characters.`);
  return {
    port: Number(env.PORT ?? 30000),
    dbPath: env.DB_PATH ?? 'data/pm.sqlite',
    formsDir: env.FORMS_DIR ?? '',
    // Unset means a fresh secret each boot: sessions do not survive a restart,
    // which is acceptable locally but wrong for a deployment. compose.yaml sets it.
    sessionSecret: secret || randomBytes(32).toString('hex')
  };
}
